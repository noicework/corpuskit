import { expect } from '@std/expect'
import { DurableState, type SqlStorageLike } from '../../cloudflare/src/state.ts'
import { resolveEffectiveRoles, type VerifiedAssignmentSession } from './assignments.ts'
import { AuditWriteError } from './audit.ts'
import { resolveCreatorAuthority } from './creator-authority.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState, type SqlValue } from './rbac-state.ts'

const start = Date.UTC(2026, 8, 25)
const context = { requestId: 'source-test', actor: { kind: 'system' as const } }
const pending = {
  subjectKind: 'pending-email' as const,
  subjectId: 'person@example.test',
  scope: { kind: 'portal' as const, slug: 'marine' },
  role: 'curator' as const,
}
const session = (patch: Partial<VerifiedAssignmentSession> = {}): VerifiedAssignmentSession => ({
  verified: true,
  tenantId: 'external',
  provenance: 'external',
  oid: 'ext:person 人',
  email: 'person@example.test',
  roles: [],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: start,
  createdAt: start,
  expiresAt: start + 28_800_000,
  ...patch,
})

for (const adapter of ['local', 'durable'] as const) {
  const fixture = (legacy = false) => {
    let at = start
    const local = new LocalRbacDatabase(':memory:')
    if (legacy) {
      local.exec(`CREATE TABLE role_assignments (
        id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,scope_kind TEXT NOT NULL,scope_slug TEXT NOT NULL,
        role TEXT NOT NULL,email_provenance TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id,subject_kind,subject_id,scope_kind,scope_slug))`)
      local.exec(`INSERT INTO role_assignments VALUES
        ('old','tenant-1','pending-email','person@example.test','portal','marine','viewer',
        'person@example.test',1,2)`)
    }
    const sql: SqlStorageLike = {
      exec: <T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: unknown[]
      ) => {
        let rows: T[] = []
        if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
          rows = local.all<T>(query, ...bindings as SqlValue[])
        } else local.exec(query, ...bindings as SqlValue[])
        return { toArray: () => rows, one: () => rows[0]! }
      },
    }
    const now = () => at
    const durable = adapter === 'durable' ? new DurableState(sql, local, now) : undefined
    const database = durable?.rbacDatabase ?? local
    let state = durable?.rbac ?? new RbacState(database, now)
    state.migrate()
    return {
      database,
      get state() {
        return state
      },
      get service() {
        return state.assignmentService('tenant-1', 'corpuskit', true)
      },
      stores: () => ({
        rbac: state,
        audience: 'corpuskit',
        externalLoginEnabled: true,
        tenants: { list: () => [] },
      }),
      restart: () => {
        state = new RbacState(database, now)
        state.migrate()
      },
      now,
      advance: (ms: number) => at += ms,
      close: () => local.close(),
    }
  }

  Deno.test(`${adapter} external assignment migration preserves old rows as Entra and is repeatable`, () => {
    const f = fixture(true)
    try {
      expect(f.service.list()).toEqual([{
        id: 'old',
        tenantId: 'tenant-1',
        source: 'entra',
        ...pending,
        role: 'viewer',
        emailProvenance: pending.subjectId,
        createdAt: 1,
        updatedAt: 2,
      }])
      expect(f.service.create({ ...pending, source: 'external' }, context).ok).toBe(true)
      expect(f.service.create(pending, context)).toEqual({ ok: false, code: 'invalid_input' })
      f.restart()
      f.restart()
      expect(f.service.list().map((row) => row.source).sort()).toEqual(['entra', 'external'])
      expect(f.database.all('PRAGMA index_list(role_assignments)')).toHaveLength(3)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} pending email claims are source-bound in both directions`, async () => {
    const f = fixture()
    try {
      const entra = f.service.create(pending, context)
      const external = f.service.create({ ...pending, source: 'external' }, context)
      expect(entra.ok && external.ok).toBe(true)
      const activated = f.service.activate(session(), context)
      expect(activated.ok).toBe(true)
      if (!activated.ok) throw new Error('activation failed')
      expect(activated.value).toHaveLength(1)
      expect(activated.value[0]).toMatchObject({ source: 'external', subjectId: session().oid })
      expect(f.service.list().find((row) => row.source === 'entra')?.subjectKind).toBe(
        'pending-email',
      )
      expect(
        f.service.activate(
          session({
            tenantId: 'tenant-1',
            provenance: 'entra',
            oid: 'entra-person',
          }),
          context,
        ).ok,
      ).toBe(true)
      expect(f.service.list().find((row) => row.source === 'entra')?.subjectId).toBe('entra-person')
      expect(f.service.change(activated.value[0]!.id, { source: 'entra' }, context).ok).toBe(false)
      const opaque = session({ oid: `ext:${'🧬'.repeat(128)}`, email: 'opaque@example.test' })
      expect(
        f.service.create(
          { ...pending, subjectId: 'opaque@example.test', source: 'external' },
          context,
        ).ok,
      ).toBe(true)
      expect(f.service.activate(opaque, context).ok).toBe(true)
      expect(f.state.creatorEvidence('external', opaque.oid)?.oid).toBe(opaque.oid)
      expect(
        (await resolveEffectiveRoles(opaque, f.stores(), 'tenant-1', f.now())).effectiveRoles
          .portalRoles,
      ).toHaveLength(1)
      expect(f.service.activate({ ...opaque, oid: `${opaque.oid}🧬` }, context).ok).toBe(false)
      expect(
        f.service.create({
          ...pending,
          subjectKind: 'active-oid',
          subjectId: opaque.oid,
          source: 'entra',
        }, context).ok,
      ).toBe(false)
      const roles = await resolveEffectiveRoles(session(), f.stores(), 'tenant-1', f.now())
      expect(roles.effectiveRoles).toEqual({ portalRoles: [{ slug: 'marine', role: 'curator' }] })
      expect(roles.provenance.map((grant) => grant.source)).toEqual(['local'])
      f.restart()
      expect(f.service.list().filter((row) => row.subjectKind === 'active-oid')).toHaveLength(3)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} external identity cannot claim Entra bootstrap or elevate from app roles or groups`, async () => {
    const f = fixture()
    try {
      f.service.bootstrapAdminEmails(pending.subjectId)
      f.service.create({
        ...pending,
        subjectKind: 'group',
        subjectId: 'owners',
        role: 'owner',
        scope: { kind: 'platform' },
      }, context)
      f.database.exec(
        "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
        start,
      )
      const asserted = session({
        roles: ['CorpusKit.Owner', 'CorpusKit.Admin'],
        groups: ['owners'],
        groupStatus: 'complete',
      })
      expect(f.service.activate(asserted, context)).toEqual({ ok: true, value: [] })
      expect(f.service.list().find((row) => row.subjectKind === 'pending-email')?.source).toBe(
        'entra',
      )
      const roles = await resolveEffectiveRoles(asserted, f.stores(), 'tenant-1', f.now())
      expect(roles.effectiveRoles).toEqual({ portalRoles: [] })
      expect(roles.provenance).toEqual([])
      expect(f.state.creatorEvidence('external', asserted.oid)).toMatchObject({
        roles: [],
        groups: [],
      })
      const assigned = f.service.create({
        ...pending,
        subjectKind: 'active-oid',
        subjectId: asserted.oid,
        source: 'external',
      }, context)
      expect(assigned.ok).toBe(true)
      const creator = { tenantId: 'external', oid: asserted.oid, slug: 'marine' }
      expect(await resolveCreatorAuthority(creator, f.stores(), 'tenant-1', f.now())).toMatchObject(
        { proven: true, role: 'curator' },
      )
      expect(
        await resolveCreatorAuthority(
          creator,
          { ...f.stores(), externalLoginEnabled: false },
          'tenant-1',
          f.now(),
        ),
      ).toMatchObject({ proven: false, role: null })
      f.advance(28_800_000)
      f.restart()
      expect(await resolveCreatorAuthority(creator, f.stores(), 'tenant-1', f.now())).toMatchObject(
        { proven: true, role: 'curator' },
      )
      if (assigned.ok) f.service.remove(assigned.value.id, context)
      expect(await resolveCreatorAuthority(creator, f.stores(), 'tenant-1', f.now())).toMatchObject(
        { proven: true, role: null },
      )
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} external activation and resolution fail closed when disabled or provenance is wrong`, async () => {
    const f = fixture()
    try {
      f.service.create({ ...pending, source: 'external' }, context)
      expect(f.state.assignmentService('tenant-1').activate(session(), context)).toEqual({
        ok: false,
        code: 'invalid_principal',
      })
      for (
        const invalid of [
          session({ provenance: 'entra' }),
          session({ provenance: undefined }),
          session({ tenantId: 'tenant-1' }),
          session({ oid: 'normal-id' }),
          session({ createdAt: undefined }),
        ]
      ) {
        expect(f.service.activate(invalid, context)).toEqual({
          ok: false,
          code: 'invalid_principal',
        })
        expect(
          (await resolveEffectiveRoles(invalid, f.stores(), 'tenant-1', f.now())).effectiveRoles,
        ).toEqual({ portalRoles: [] })
      }
      expect(
        (await resolveEffectiveRoles(
          session(),
          { ...f.stores(), externalLoginEnabled: false },
          'tenant-1',
          f.now(),
        )).effectiveRoles,
      ).toEqual({ portalRoles: [] })
      expect(f.service.list()[0]?.subjectKind).toBe('pending-email')
      expect(f.service.create({ ...pending, source: 'unknown' as never }, context).ok).toBe(false)
      expect(
        f.service.create({
          ...pending,
          subjectKind: 'group',
          subjectId: 'group',
          source: 'external',
        }, context).ok,
      ).toBe(false)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} external sessions retain eight hours from exchange and audit failures roll back claims`, async () => {
    const f = fixture()
    try {
      f.service.create({ ...pending, source: 'external' }, context)
      f.database.exec(
        "CREATE TRIGGER fail_external BEFORE INSERT ON audit_events WHEN NEW.action='assignment.activate' BEGIN SELECT RAISE(ABORT,'fixture'); END",
      )
      expect(() => f.service.activate(session(), context)).toThrow(AuditWriteError)
      expect(f.service.list()[0]?.subjectKind).toBe('pending-email')
      expect(f.state.creatorEvidence('external', session().oid)).toBeNull()
      f.database.exec('DROP TRIGGER fail_external')
      const exchanged = session({ claimIssuedAt: start - 120_000 })
      expect(f.service.activate(exchanged, context).ok).toBe(true)
      f.advance(28_800_000 - 1)
      expect(
        (await resolveEffectiveRoles(exchanged, f.stores(), 'tenant-1', f.now())).effectiveRoles
          .portalRoles,
      ).toHaveLength(1)
      expect(f.state.creatorEvidence('external', exchanged.oid)?.claimIssuedAt).toBe(
        start - 120_000,
      )
      f.advance(1)
      expect(
        (await resolveEffectiveRoles(exchanged, f.stores(), 'tenant-1', f.now())).effectiveRoles
          .portalRoles,
      ).toHaveLength(0)
    } finally {
      f.close()
    }
  })
}

Deno.test('assignment source migration rolls back the complete legacy table when copying fails', () => {
  const local = new LocalRbacDatabase(':memory:')
  try {
    local.exec(`CREATE TABLE role_assignments (
      id TEXT PRIMARY KEY,tenant_id TEXT,subject_kind TEXT,subject_id TEXT,
      scope_kind TEXT,scope_slug TEXT,role TEXT,email_provenance TEXT,
      created_at INTEGER,updated_at INTEGER)`)
    local.exec(
      "INSERT INTO role_assignments VALUES ('old','tenant-1','pending-email','person@example.test','portal','marine','viewer',NULL,1,2)",
    )
    const state = new RbacState({
      transactionSync: (callback) => local.transactionSync(callback),
      all: (query, ...bindings) => local.all(query, ...bindings),
      exec: (query, ...bindings) => {
        if (query.startsWith('INSERT INTO role_assignments_v2')) {
          throw new Error('fixture migration failure')
        }
        local.exec(query, ...bindings)
      },
    })
    expect(() => state.migrate()).toThrow('fixture migration failure')
    expect(
      local.all<{ name: string }>('PRAGMA table_info(role_assignments)').some((column) =>
        column.name === 'source'
      ),
    ).toBe(false)
    expect(local.all('SELECT id,subject_id FROM role_assignments')).toEqual([{
      id: 'old',
      subject_id: 'person@example.test',
    }])
    expect(local.all("SELECT name FROM sqlite_master WHERE name='role_assignments_v2'")).toEqual([])
  } finally {
    local.close()
  }
})

Deno.test('disabled external owners cannot permit removing the final active Entra owner', () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const state = new RbacState(db, () => start)
    state.migrate()
    const service = state.assignmentService('tenant-1')
    const owner = service.create({
      subjectKind: 'active-oid',
      subjectId: 'entra-owner',
      scope: { kind: 'platform' },
      role: 'owner',
    }, context)
    service.create({
      subjectKind: 'active-oid',
      subjectId: 'ext:owner',
      source: 'external',
      scope: { kind: 'platform' },
      role: 'owner',
    }, context)
    if (!owner.ok) throw new Error('seed failed')
    expect(service.remove(owner.value.id, context)).toEqual({ ok: false, code: 'last_owner' })
    expect(service.create({ ...pending, source: null as never }, context)).toEqual({
      ok: false,
      code: 'invalid_input',
    })
  } finally {
    db.close()
  }
})
