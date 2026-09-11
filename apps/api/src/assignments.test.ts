import { expect } from '@std/expect'
import {
  AssignmentService,
  coarseAdminEligibility,
  resolveEffectiveRoles,
  type VerifiedAssignmentSession,
} from './assignments.ts'
import { AuditWriteError } from './audit.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { DurableState, type SqlStorageLike } from '../../cloudflare/src/state.ts'

const context = { requestId: 'request-1', actor: { kind: 'user' as const, id: 'operator' } }
const owner = (subjectId: string) => ({
  subjectKind: 'active-oid' as const,
  subjectId,
  role: 'owner' as const,
  scope: { kind: 'platform' as const },
})
const start = Date.UTC(2026, 8, 12)

Deno.test('resolver reads current grants, preserves scope and orders provenance without lowering roles', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const state = new RbacState(db, () => start)
    state.migrate()
    const service = state.assignmentService('tenant-1', 'corpuskit')
    const portals = [{ slug: 'a' }, { slug: 'b' }]
    const stores = { rbac: state, tenants: { list: () => portals }, audience: 'corpuskit' }
    db.exec(
      "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
      start,
    )
    service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'a' },
      role: 'analyst',
    }, context)
    const local = service.create({
      subjectKind: 'active-oid',
      subjectId: 'oid-1',
      scope: { kind: 'portal', slug: 'a' },
      role: 'curator',
    }, context)
    expect(local.ok).toBe(true)
    const user = session('oid-1', { groups: ['group-1'] })
    const initial = await resolveEffectiveRoles(user, stores, 'tenant-1', start)
    expect(initial.effectiveRoles).toEqual({ portalRoles: [{ slug: 'a', role: 'curator' }] })
    expect(initial.provenance.map((p) => p.source)).toEqual(['group', 'local'])
    expect(coarseAdminEligibility(initial.effectiveRoles)).toBe(false)
    if (local.ok) service.change(local.value.id, { role: 'viewer' }, context)
    expect(
      (await resolveEffectiveRoles(user, stores, 'tenant-1', start)).effectiveRoles.portalRoles,
    )
      .toEqual([{ slug: 'a', role: 'analyst' }])
    service.create(owner('oid-1'), context)
    const elevated = await resolveEffectiveRoles(
      session('oid-1', { roles: ['CorpusKit.Admin'], groups: ['group-1'] }),
      stores,
      'tenant-1',
      start,
    )
    expect(elevated.effectiveRoles.platformRole).toBe('owner')
    expect(elevated.provenance.map((p) => p.source)).toEqual([
      'app-role',
      'group',
      'local',
      'local',
    ])
    expect(elevated.effectiveRoles.portalRoles).toEqual([{ slug: 'a', role: 'portal-admin' }, {
      slug: 'b',
      role: 'portal-admin',
    }])
    portals.push({ slug: 'new' })
    expect(
      (await resolveEffectiveRoles(user, stores, 'tenant-1', start)).effectiveRoles.portalRoles,
    ).toHaveLength(3)
    expect(coarseAdminEligibility(elevated.effectiveRoles)).toBe(true)
  } finally {
    db.close()
  }
})

Deno.test('resolver rejects wrong or stale identity and all unavailable group states', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const state = new RbacState(db, () => start)
    state.migrate()
    state.assignmentService('tenant-1').create(
      { ...owner('group-1'), subjectKind: 'group' },
      context,
    )
    const stores = { rbac: state, tenants: { list: () => [{ slug: 'a' }] }, audience: 'corpuskit' }
    const user = session('oid-1', { groups: ['group-1'] })
    expect((await resolveEffectiveRoles(user, stores, 'tenant-1', start)).groupCapability).toBe(
      'disabled',
    )
    db.exec(
      "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
      start,
    )
    for (const status of ['absent', 'malformed', 'overage', 'unverified'] as const) {
      const result = await resolveEffectiveRoles(
        { ...user, groupStatus: status },
        stores,
        'tenant-1',
        start,
      )
      expect(result.effectiveRoles).toEqual({ portalRoles: [] })
      expect(result.groupCapability).toBe(status)
    }
    expect(
      (await resolveEffectiveRoles({ ...user, groups: ['bad group'] }, stores, 'tenant-1', start))
        .groupCapability,
    ).toBe('malformed')
    expect(
      (await resolveEffectiveRoles(
        user,
        { ...stores, audience: 'corpuskit-demo' },
        'tenant-1',
        start,
      )).effectiveRoles,
    ).toEqual({ portalRoles: [] })
    expect(
      (await resolveEffectiveRoles(user, stores, 'tenant-1', start)).effectiveRoles.platformRole,
    ).toBe('owner')
    for (
      const overrides of [
        { tenantId: 'other' },
        { verified: false as never },
        { expiresAt: start },
        { claimIssuedAt: start + 30_001 },
      ]
    ) {
      expect(
        (await resolveEffectiveRoles(
          { ...user, roles: ['CorpusKit.Owner'], ...overrides },
          stores,
          'tenant-1',
          start,
        )).effectiveRoles,
      ).toEqual({ portalRoles: [] })
    }
    expect((await resolveEffectiveRoles(null, stores, 'tenant-1', start)).effectiveRoles).toEqual({
      portalRoles: [],
    })
    expect(coarseAdminEligibility({ portalRoles: [{ slug: 'a', role: 'portal-admin' }] })).toBe(
      false,
    )
  } finally {
    db.close()
  }
})

Deno.test('resolver maps exact app aliases and persists bounded unknown identifiers without claim dumps', async () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const state = new RbacState(db, () => start)
    state.migrate()
    const logs: string[] = []
    const stores = {
      rbac: state,
      tenants: { list: () => [] },
      audience: 'corpuskit',
      logUnknownRole: (id: string) => logs.push(id),
    }
    for (
      const [appRole, expected] of [['CorpusKit.Owner', 'owner'], [
        'CorpusKit.PlatformAdmin',
        'platform-admin',
      ], ['CorpusKit.Admin', 'platform-admin']]
    ) {
      expect(
        (await resolveEffectiveRoles(
          session('oid-1', { roles: [appRole!] }),
          stores,
          'tenant-1',
          start,
        )).effectiveRoles.platformRole,
      ).toBe(expected)
    }
    const user = session('oid-1', {
      roles: ['unknown private role', 'CorpusKit.owner', '__proto__'],
    })
    expect((await resolveEffectiveRoles(user, stores, 'tenant-1', start)).effectiveRoles).toEqual({
      portalRoles: [],
    })
    await resolveEffectiveRoles(user, { ...stores, rbac: new RbacState(db) }, 'tenant-1', start)
    expect(logs).toHaveLength(3)
    expect(logs.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true)
    await resolveEffectiveRoles(
      session('oid-1', { roles: Array.from({ length: 300 }, (_, i) => `unknown-${i}`) }),
      stores,
      'tenant-1',
      start,
    )
    expect(logs).toHaveLength(256)
    expect(db.all('SELECT identifier FROM rbac_unknown_roles')).toHaveLength(256)
  } finally {
    db.close()
  }
})
function session(
  oid: string,
  overrides: Partial<VerifiedAssignmentSession> = {},
): VerifiedAssignmentSession {
  return {
    verified: true,
    tenantId: 'tenant-1',
    oid,
    roles: [],
    groups: [],
    groupStatus: 'complete',
    claimIssuedAt: start,
    expiresAt: start + 28_800_000,
    ...overrides,
  }
}

for (const adapter of ['local', 'durable'] as const) {
  const fixture = (path = ':memory:') => {
    let at = start
    const local = new LocalRbacDatabase(path)
    const now = () => at
    const sql: SqlStorageLike = {
      exec: <T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: unknown[]
      ) => {
        if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK)\b/i.test(query)) {
          throw new Error('Manual Durable SQL transaction')
        }
        let rows: T[] = []
        if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
          rows = local.all<T>(query, ...bindings as (string | number | null)[])
        } else local.exec(query, ...bindings as (string | number | null)[])
        return { toArray: () => rows, one: () => rows[0]! }
      },
    }
    const durable = adapter === 'durable' ? new DurableState(sql, local, now) : undefined
    const database = durable?.rbacDatabase ?? local
    const state = durable?.rbac ?? new RbacState(database, now)
    state.migrate()
    const service = state.assignmentService('tenant-1', 'corpuskit')
    return {
      database,
      state,
      service,
      now,
      advance: (ms: number) => at += ms,
      close: () => local.close(),
    }
  }

  Deno.test(`${adapter} assignment bootstrap activates once and survives removal and reopen`, () => {
    const dir = Deno.makeTempDirSync({ prefix: 'rbac-assignments-' })
    const path = `${dir}/state.sqlite`
    let f = fixture(path)
    try {
      expect(f.service.bootstrapAdminEmails(' Person@Example.test ,person@example.test')).toEqual({
        created: 1,
        alreadyCompleted: false,
      })
      expect(f.service.list()).toHaveLength(1)
      const pending = f.service.list()[0]!
      expect(pending.subjectKind).toBe('pending-email')
      expect(f.service.activate(session('oid-1', { email: 'PERSON@example.test' }), context).ok)
        .toBe(true)
      expect(f.service.list()[0]!.emailProvenance).toBe('person@example.test')
      f.service.create(owner('second'), context)
      expect(f.service.remove(pending.id, context).ok).toBe(true)
      f.close()
      f = fixture(path)
      expect(f.service.bootstrapAdminEmails('person@example.test')).toEqual({
        created: 0,
        alreadyCompleted: true,
      })
      expect(f.service.list().map((row) => row.subjectId)).toEqual(['second'])
      expect(
        f.state.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
          e.action === 'migration.admin_emails'
        ),
      ).toHaveLength(1)
    } finally {
      f.close()
      Deno.removeSync(dir, { recursive: true })
    }
  })

  Deno.test(`${adapter} assignment activation rejects tenant, stale claims and conflicting identity`, () => {
    const f = fixture()
    try {
      f.service.bootstrapAdminEmails('person@example.test')
      expect(
        f.service.activate(
          session('oid-1', { tenantId: 'other', email: 'person@example.test' }),
          context,
        ).ok,
      ).toBe(false)
      expect(
        f.service.activate(
          session('oid-1', { verified: false as never, email: 'person@example.test' }),
          context,
        ).ok,
      ).toBe(false)
      expect(
        f.service.activate(
          session('oid-1', { expiresAt: start, email: 'person@example.test' }),
          context,
        ).ok,
      ).toBe(false)
      expect(
        f.service.activate(session('oid-1', { preferredUsername: 'PERSON@example.test' }), context)
          .ok,
      ).toBe(true)
      f.service.create({
        ...owner('person@example.test'),
        subjectKind: 'pending-email',
        scope: { kind: 'portal', slug: 'grains' },
        role: 'viewer',
      }, context)
      expect(f.service.activate(session('other-oid', { email: 'person@example.test' }), context))
        .toMatchObject({ ok: false, code: 'email_conflict' })
      const active = f.service.list().find((row) => row.subjectKind === 'active-oid')!
      expect(f.service.change(active.id, { subjectId: 'other-oid' }, context).ok).toBe(false)
      expect(f.service.list().find((row) => row.id === active.id)!.subjectId).toBe('oid-1')
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} final owner changes retain denial audit and rollback on audit failure`, () => {
    const f = fixture()
    try {
      f.service.create(owner('only'), context)
      f.service.bootstrapAdminEmails('pending@example.test')
      const active = f.service.list().find((row) => row.subjectKind === 'active-oid')!
      for (
        const change of [{ role: 'platform-admin' as const }, {
          subjectKind: 'pending-email' as const,
          subjectId: 'new@example.test',
        }, { subjectKind: 'group' as const, subjectId: 'group-1' }]
      ) {
        expect(f.service.change(active.id, change, context)).toMatchObject({
          ok: false,
          code: 'last_owner',
        })
      }
      expect(f.service.remove(active.id, context)).toMatchObject({ ok: false, code: 'last_owner' })
      expect(
        f.state.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
          e.action === 'assignment.denied'
        ),
      ).toHaveLength(4)
      f.database.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
      expect(() => f.service.remove(active.id, context)).toThrow(AuditWriteError)
      expect(() => f.service.create(owner('another'), context)).toThrow(AuditWriteError)
      expect(f.service.list().filter((row) => row.subjectKind === 'active-oid')).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} fresh app evidence counts once and newer contradictory claims invalidate it`, () => {
    const f = fixture()
    try {
      f.service.create(owner('local'), context)
      const id = f.service.list()[0]!.id
      f.service.observeSession(session('app-owner', { roles: ['CorpusKit.Owner'] }))
      f.service.observeSession(session('app-owner', { roles: [], claimIssuedAt: start + 1 }))
      f.service.observeSession(session('app-owner', { roles: ['CorpusKit.Owner'] }))
      expect(f.service.remove(id, context).ok).toBe(false)
      f.advance(2)
      f.service.observeSession(
        session('app-owner', { roles: ['CorpusKit.Owner'], claimIssuedAt: start + 2 }),
      )
      expect(f.service.remove(id, context).ok).toBe(true)
      f.service.create(owner('new-local'), context)
      f.advance(28_800_000)
      expect(f.service.remove(f.service.list()[0]!.id, context).ok).toBe(false)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} effective group owners require verified capability and surviving mappings`, () => {
    const f = fixture()
    try {
      f.service.create(owner('local'), context)
      f.service.create({ ...owner('group-1'), subjectKind: 'group' }, context)
      const localId = f.service.list().find((row) => row.subjectKind === 'active-oid')!.id
      const groupId = f.service.list().find((row) => row.subjectKind === 'group')!.id
      f.service.observeSession(session('member', { groups: ['group-1'] }))
      expect(f.service.remove(localId, context).ok).toBe(false)
      f.database.exec(
        'INSERT INTO rbac_group_capabilities VALUES (?,?,?)',
        'corpuskit',
        'verified-supported',
        start,
      )
      expect(f.service.remove(localId, context).ok).toBe(true)
      expect(f.service.remove(groupId, context)).toMatchObject({ ok: false, code: 'last_owner' })
      expect(f.service.change(groupId, { subjectId: 'empty-group' }, context).ok).toBe(false)
      f.service.observeSession(session('member', { groups: ['group-1'], groupStatus: 'overage' }))
      expect(f.service.remove(groupId, context).ok).toBe(false)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} concurrent owner removals cannot both use an old count`, async () => {
    const f = fixture()
    try {
      f.service.create(owner('first'), context)
      f.service.create(owner('second'), context)
      const staleIds = f.service.list().map((row) => row.id)
      const results = await Promise.all(
        staleIds.map((id) => Promise.resolve().then(() => f.service.remove(id, context))),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(f.service.list()).toHaveLength(1)
      expect(
        f.state.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
          e.action === 'assignment.denied'
        ),
      ).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} audit failure rolls back bootstrap, activation, changes and removals`, () => {
    const f = fixture()
    const failAudit = () =>
      f.database.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
    const restoreAudit = () => f.database.exec('DROP TRIGGER fail_audit')
    try {
      failAudit()
      expect(() => f.service.bootstrapAdminEmails('person@example.test')).toThrow(AuditWriteError)
      expect(f.service.list()).toEqual([])
      expect(f.database.all("SELECT name FROM rbac_migrations WHERE name LIKE 'admin-emails%'"))
        .toEqual([])
      restoreAudit()
      f.service.bootstrapAdminEmails('person@example.test')
      const pendingId = f.service.list()[0]!.id
      failAudit()
      expect(() => f.service.activate(session('first', { email: 'person@example.test' }), context))
        .toThrow(AuditWriteError)
      expect(f.service.list()[0]!.subjectKind).toBe('pending-email')
      expect(f.database.all('SELECT * FROM rbac_owner_evidence')).toEqual([])
      restoreAudit()
      f.service.activate(session('first', { email: 'person@example.test' }), context)
      f.service.create(owner('second'), context)
      const before = f.service.list()
      failAudit()
      expect(() => f.service.change(pendingId, { role: 'platform-admin' }, context)).toThrow(
        AuditWriteError,
      )
      expect(() => f.service.remove(pendingId, context)).toThrow(AuditWriteError)
      expect(f.service.list()).toEqual(before)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} equal-time contradictions and duplicate owner sources cannot invent a survivor`, () => {
    const f = fixture()
    try {
      f.service.create(owner('only'), context)
      const id = f.service.list()[0]!.id
      f.service.observeSession(session('only', { groups: ['owners'] }))
      f.service.create({ ...owner('owners'), subjectKind: 'group' }, context)
      f.database.exec(
        'INSERT INTO rbac_group_capabilities VALUES (?,?,?)',
        'corpuskit',
        'verified-supported',
        start,
      )
      expect(f.service.remove(id, context).ok).toBe(true)
      const mappingId = f.service.list()[0]!.id
      expect(f.service.remove(mappingId, context).ok).toBe(false)
      f.service.observeSession(session('app-owner', { roles: ['CorpusKit.Owner'] }))
      f.service.observeSession(session('app-owner', { roles: [] }))
      f.service.observeSession(session('app-owner', { roles: ['CorpusKit.Owner'] }))
      expect(f.service.remove(mappingId, context).ok).toBe(false)
      f.service.observeSession(
        session('other-tenant', { tenantId: 'other', roles: ['CorpusKit.Owner'] }),
      )
      expect(f.service.remove(mappingId, context).ok).toBe(false)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter} configured tenant and scope validation cannot be bypassed by mutation input`, () => {
    const f = fixture()
    try {
      expect(() => new AssignmentService(f.database, f.state.audit, '')).toThrow()
      expect(f.service.create({ ...owner('person'), role: 'viewer' }, context).ok).toBe(false)
      expect(
        f.service.create({ ...owner('person'), scope: { kind: 'portal', slug: 'grains' } }, context)
          .ok,
      ).toBe(false)
      expect(f.service.create({ ...owner('person'), subjectKind: 'system' as never }, context).ok)
        .toBe(false)
      f.service.create({ ...owner('existing'), role: 'platform-admin' }, context)
      f.service.bootstrapAdminEmails('person@example.test')
      expect(f.service.activate(session('existing', { email: 'person@example.test' }), context))
        .toMatchObject({ ok: false, code: 'email_conflict' })
      expect(f.service.list().find((row) => row.subjectId === 'existing')!.role).toBe(
        'platform-admin',
      )
    } finally {
      f.close()
    }
  })
}
