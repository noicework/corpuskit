import { expect } from '@std/expect'
import { AuditWriteError, createAuditEvent } from './audit.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { type RbacDatabase, RbacState } from './rbac-state.ts'

/** Real SQLite fixture for subsequent guarded-service and fake-clock tests. */
export function rbacFixture() {
  let at = Date.UTC(2026, 8, 12)
  const database = new LocalRbacDatabase(':memory:')
  const now = () => at
  const state = new RbacState(database, now)
  state.migrate()
  return {
    database,
    state,
    now,
    advance: (ms: number) => {
      at += ms
    },
    close: () => database.close(),
  }
}

export function insertAssignment(
  database: LocalRbacDatabase,
  overrides: Record<string, string | number | null> = {},
) {
  const row = {
    id: 'assignment-1',
    tenant_id: 'tenant-1',
    subject_kind: 'active-oid',
    subject_id: 'oid-1',
    scope_kind: 'platform',
    scope_slug: '',
    role: 'owner',
    email_provenance: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
  const columns = [
    'id',
    'tenant_id',
    'subject_kind',
    'subject_id',
    'scope_kind',
    'scope_slug',
    'role',
    'email_provenance',
    'created_at',
    'updated_at',
  ]
  database.exec(
    `INSERT INTO role_assignments (${columns.join(',')}) VALUES (${
      columns.map(() => '?').join(',')
    })`,
    ...columns.map((column) => row[column as keyof typeof row]),
  )
}

export function fixtureEvent() {
  return createAuditEvent(
    {
      requestId: 'request-1',
      actor: { kind: 'user', id: 'oid-1' },
      action: 'assignment.create',
      scope: { kind: 'platform' },
      target: { kind: 'assignment', id: 'assignment-1' },
      outcome: 'success',
      detail: { role: 'owner' },
    },
    () => 1,
    () => 'audit-1',
  )
}

Deno.test('RBAC migrations are additive and idempotent with exact audit columns', () => {
  const f = rbacFixture()
  try {
    f.database.exec('CREATE TABLE unrelated (value TEXT)')
    f.database.exec('INSERT INTO unrelated VALUES (?)', 'preserved')
    insertAssignment(f.database)
    f.state.audit.append(fixtureEvent())
    f.state.migrate()
    f.state.migrate()
    expect(f.database.all('SELECT * FROM unrelated')).toEqual([{ value: 'preserved' }])
    expect(f.database.all('SELECT count(*) AS n FROM role_assignments')).toEqual([{ n: 1 }])
    expect(f.database.all('SELECT count(*) AS n FROM rbac_migrations')).toEqual([{ n: 2 }])
    expect(
      f.database.all<{ name: string }>('PRAGMA table_info(audit_events)').map((row) => row.name),
    ).toEqual(Object.keys(fixtureEvent()))
    expect(f.state.audit.read({ scope: { kind: 'platform' } })).toEqual([fixtureEvent()])
    expect(f.state.audit.read({ scope: { kind: 'portal', slug: 'other' } })).toEqual([])
    expect(Object.keys(f.state.audit).sort()).toEqual(['append', 'read'])
  } finally {
    f.close()
  }
})

/** Independently frozen pre-phase-3 schema, shared by both actual SQL adapters. */
export function checkAuditUpgrade(database: RbacDatabase): void {
  database.exec(`CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, request_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('anonymous','user','break-glass','legacy-key','system')),
    actor_id TEXT, actor_label TEXT, action TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('platform','portal')), scope_slug TEXT,
    target_kind TEXT NOT NULL, target_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('intent','success','denied','failure','uncertain')),
    detail_json TEXT NOT NULL,
    CHECK((scope_kind = 'platform' AND scope_slug IS NULL) OR
      (scope_kind = 'portal' AND length(scope_slug) > 0)))`)
  const historical = ['anonymous', 'user', 'break-glass', 'legacy-key', 'system'].map((
    actor_kind,
    i,
  ) => ({
    ...fixtureEvent(),
    id: `old-${i}`,
    actor_kind,
  }))
  for (const event of historical) {
    database.exec(
      'INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ...Object.values(event),
    )
  }
  const before = database.all('SELECT * FROM audit_events ORDER BY id')
  const oldSchema = database.all("SELECT sql FROM sqlite_master WHERE name = 'audit_events'")
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('CREATE TABLE migration_parent (id INTEGER PRIMARY KEY)')
  database.exec(
    'CREATE TABLE migration_commit_failure (id INTEGER REFERENCES migration_parent(id) DEFERRABLE INITIALLY DEFERRED)',
  )
  for (const failure of ['copy', 'marker', 'commit']) {
    const failing: RbacDatabase = {
      all: database.all.bind(database),
      exec(query, ...bindings) {
        if (
          (failure === 'copy' && query.startsWith('INSERT INTO audit_events_v2')) ||
          (failure === 'marker' && bindings.includes('rbac-audit-actors-v2'))
        ) throw new Error('injected migration failure')
        database.exec(query, ...bindings)
      },
      transactionSync(callback) {
        return database.transactionSync(() => {
          const result = callback()
          if (failure === 'commit') {
            database.exec('INSERT INTO migration_commit_failure VALUES (123)')
          }
          return result
        })
      },
    }
    expect(() => new RbacState(failing).migrate()).toThrow()
    expect(database.all('SELECT * FROM audit_events ORDER BY id')).toEqual(before)
    expect(database.all("SELECT sql FROM sqlite_master WHERE name = 'audit_events'")).toEqual(
      oldSchema,
    )
    expect(
      database.all(
        "SELECT name FROM sqlite_master WHERE name IN ('audit_events_v2','rbac_migrations')",
      ),
    ).toEqual([])
  }
  let state = new RbacState(database)
  state.migrate()
  state.migrate()
  state = new RbacState(database)
  state.migrate()
  expect(database.all('SELECT * FROM audit_events ORDER BY id')).toEqual(before)
  expect(
    database.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'audit_events_by_%' ORDER BY name",
    ).map((row) => row.name),
  ).toEqual(['audit_events_by_at', 'audit_events_by_request', 'audit_events_by_scope'])
  for (const actor_kind of ['key', 'legacy-key'] as const) {
    const event = { ...fixtureEvent(), id: `new-${actor_kind}`, actor_kind }
    database.exec(
      "CREATE TRIGGER fail_new_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(() => database.transactionSync(() => state.audit.append(event))).toThrow(AuditWriteError)
    expect(database.all('SELECT * FROM audit_events ORDER BY id')).toEqual(before)
    database.exec('DROP TRIGGER fail_new_audit')
    state.audit.append(event)
    before.push(...database.all('SELECT * FROM audit_events WHERE id = ?', event.id))
    before.sort((a, b) =>
      String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))
    )
  }
}

Deno.test('local audit upgrade preserves history and rolls back copy, marker, append and commit failures', () => {
  const database = new LocalRbacDatabase(':memory:')
  try {
    checkAuditUpgrade(database)
  } finally {
    database.close()
  }
})

Deno.test('assignment schema refuses invalid scope roles and non-normalised pending subjects', () => {
  const f = rbacFixture()
  try {
    const invalid: Record<string, string | number | null>[] = [
      { role: 'viewer' },
      { scope_slug: 'grains' },
      { subject_kind: 'system' },
      { scope_kind: 'portal', scope_slug: 'grains' },
      { subject_kind: 'pending-email', subject_id: 'Person@Example.test' },
      { subject_kind: 'pending-email', subject_id: ' person@example.test ' },
    ]
    for (const row of invalid) expect(() => insertAssignment(f.database, row)).toThrow()
    insertAssignment(f.database)
    expect(() => insertAssignment(f.database, { id: 'duplicate' })).toThrow()
    insertAssignment(f.database, { id: 'other-tenant', tenant_id: 'tenant-2' })
    expect(f.database.all('SELECT count(*) AS n FROM role_assignments')).toEqual([{ n: 2 }])
  } finally {
    f.close()
  }
})

Deno.test('audit failure rolls back the accompanying assignment on actual SQLite', () => {
  const f = rbacFixture()
  try {
    f.database.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    )
    expect(() =>
      f.database.transactionSync(() => {
        insertAssignment(f.database)
        f.state.audit.append(fixtureEvent())
      })
    ).toThrow(AuditWriteError)
    expect(f.database.all('SELECT * FROM role_assignments')).toEqual([])
    expect(f.database.all('SELECT * FROM audit_events')).toEqual([])
    f.database.exec('DROP TRIGGER fail_audit')
    f.database.transactionSync(() => {
      insertAssignment(f.database)
      f.state.audit.append(fixtureEvent())
    })
    expect(f.state.audit.read({ scope: { kind: 'platform' }, requestId: 'request-1' }))
      .toHaveLength(1)
  } finally {
    f.close()
  }
})

Deno.test('audit persistence rejects forged detail and read filters fail closed', () => {
  const f = rbacFixture()
  try {
    expect(() =>
      f.state.audit.append({ ...fixtureEvent(), detail_json: '{"body":"private-fixture"}' })
    ).toThrow(AuditWriteError)
    expect(() => f.state.audit.read({ scope: { kind: 'unknown' } as never })).toThrow()
    expect(() => f.state.audit.read({ scope: { kind: 'platform' }, limit: -1 })).toThrow()
    expect(f.state.audit.read({ scope: { kind: 'platform' } })).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('unknown-role persistence accepts only bounded digests and group support defaults disabled', () => {
  const f = rbacFixture()
  try {
    expect(() => f.database.exec('INSERT INTO rbac_unknown_roles VALUES (?,?)', 'raw-claim', 1))
      .toThrow()
    for (let i = 0; i < 257; i++) {
      f.database.exec(
        'INSERT INTO rbac_unknown_roles VALUES (?,?)',
        i.toString(16).padStart(64, '0'),
        i,
      )
    }
    expect(f.database.all('SELECT count(*) AS n FROM rbac_unknown_roles')).toEqual([{ n: 256 }])
    f.database.exec('INSERT INTO rbac_group_capabilities (audience) VALUES (?)', 'corpuskit')
    expect(f.database.all('SELECT status,verified_at FROM rbac_group_capabilities')).toEqual([
      { status: 'disabled', verified_at: null },
    ])
    expect(() =>
      f.database.exec("UPDATE rbac_group_capabilities SET status = 'verified-supported'")
    )
      .toThrow()
  } finally {
    f.close()
  }
})
