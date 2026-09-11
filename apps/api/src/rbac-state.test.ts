import { expect } from '@std/expect'
import { AuditWriteError, createAuditEvent } from './audit.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'

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
    expect(f.database.all('SELECT count(*) AS n FROM rbac_migrations')).toEqual([{ n: 1 }])
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
