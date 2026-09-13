import { expect } from '@std/expect'
import { resolveCreatorAuthority } from './creator-authority.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import type { VerifiedAssignmentSession } from './assignments.ts'
import { resolveRoleGrants } from './assignments.ts'

const start = Date.UTC(2026, 8, 12)
const creator = { tenantId: 'tenant-1', oid: 'creator', slug: 'marine' }
const context = { requestId: 'creator-test', actor: { kind: 'system' as const } }
function fixture() {
  let at = start
  const database = new LocalRbacDatabase(':memory:')
  const now = () => at
  let state = new RbacState(database, now)
  state.migrate()
  const service = state.assignmentService(creator.tenantId, 'corpuskit')
  const session = (patch: Partial<VerifiedAssignmentSession> = {}): VerifiedAssignmentSession => ({
    verified: true,
    tenantId: creator.tenantId,
    oid: creator.oid,
    roles: [],
    groups: [],
    groupStatus: 'complete',
    claimIssuedAt: start,
    expiresAt: start + 28_800_000,
    ...patch,
  })
  return {
    database,
    service,
    session,
    now,
    get state() {
      return state
    },
    restart: () => {
      state = new RbacState(database, now)
      state.migrate()
    },
    advance: (ms: number) => at += ms,
    resolve: async (input = creator) => {
      const stores = { rbac: state, audience: 'corpuskit' }
      const result = await resolveCreatorAuthority(input, stores, creator.tenantId, at)
      // Compare every fixture resolution with the original authorisation outcome.
      const evidence = state.creatorEvidence(input.tenantId, input.oid)
      let role = null
      const proven = input.tenantId === creator.tenantId && !!evidence &&
        evidence.observedAt <= at && evidence.claimIssuedAt <= at + 30_000
      if (proven && evidence) {
        const fresh = Math.min(evidence.expiresAt, evidence.claimIssuedAt + 28_800_000) > at
        const grants = await resolveRoleGrants(evidence, fresh ? evidence : null, stores)
        role = grants.effectiveRoles.platformRole
          ? 'portal-admin'
          : grants.effectiveRoles.portalRoles.find((grant) => grant.slug === input.slug)?.role ??
            null
      }
      expect({ proven: result.proven, role: result.role }).toEqual({ proven, role })
      return result
    },
    close: () => database.close(),
  }
}

Deno.test('creator local authority survives claim expiry and restart but removal applies immediately', async () => {
  const f = fixture()
  try {
    const local = f.service.create({
      subjectKind: 'active-oid',
      subjectId: creator.oid,
      scope: { kind: 'portal', slug: 'marine' },
      role: 'curator',
    }, context)
    expect(local.ok).toBe(true)
    expect(await f.resolve()).toEqual({ proven: false, role: null, reason: 'unproven_creator' })
    f.service.observeSession(f.session({ roles: ['CorpusKit.Owner'] }))
    expect(await f.resolve()).toEqual({ proven: true, role: 'portal-admin', reason: 'active' })
    f.advance(28_800_000)
    f.restart()
    expect(await f.resolve()).toEqual({ proven: true, role: 'curator', reason: 'active' })
    expect(await f.resolve({ ...creator, slug: 'grains' })).toEqual({
      proven: true,
      role: null,
      reason: 'creator_claims_expired',
    })
    if (local.ok) expect(f.service.remove(local.value.id, context).ok).toBe(true)
    expect(await f.resolve()).toEqual({
      proven: true,
      role: null,
      reason: 'creator_claims_expired',
    })
  } finally {
    f.close()
  }
})

Deno.test('creator group grants require fresh original claims, current mappings and current capability', async () => {
  const f = fixture()
  try {
    const group = f.service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'analyst',
    }, context)
    f.service.observeSession(f.session({ groups: ['group-1'], expiresAt: start + 1000 }))
    expect((await f.resolve()).role).toBeNull()
    f.database.exec(
      "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
      start,
    )
    expect((await f.resolve()).role).toBe('analyst')
    f.database.exec("UPDATE rbac_group_capabilities SET status = 'disabled'")
    expect((await f.resolve()).role).toBeNull()
    f.database.exec("UPDATE rbac_group_capabilities SET status = 'verified-supported'")
    if (group.ok) f.service.remove(group.value.id, context)
    expect((await f.resolve()).role).toBeNull()
    f.service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'curator',
    }, context)
    expect((await f.resolve()).role).toBe('curator')
    f.advance(1000)
    expect((await f.resolve()).role).toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('creator claims preserve equal-time intersection and ignore older concurrent observations', async () => {
  const f = fixture()
  try {
    f.service.observeSession(f.session({ roles: ['CorpusKit.Owner'], groups: ['group-1'] }))
    f.service.observeSession(f.session())
    f.service.observeSession(f.session({ roles: ['CorpusKit.Owner'] }))
    expect((await f.resolve()).role).toBeNull()
    expect(f.state.creatorEvidence(creator.tenantId, creator.oid)?.roles).toEqual([])
    f.advance(1)
    f.service.observeSession(f.session({ claimIssuedAt: start + 1, roles: ['CorpusKit.Admin'] }))
    f.service.observeSession(f.session())
    expect((await f.resolve()).role).toBe('portal-admin')
    expect(f.state.creatorEvidence(creator.tenantId, creator.oid)?.claimIssuedAt).toBe(start + 1)
  } finally {
    f.close()
  }
})

Deno.test('creator app roles expire exactly at eight hours and only fresh sign-in restores claims', async () => {
  for (const appRole of ['CorpusKit.Owner', 'CorpusKit.PlatformAdmin', 'CorpusKit.Admin']) {
    const f = fixture()
    try {
      f.service.observeSession(f.session({ roles: [appRole] }))
      f.advance(28_799_999)
      expect(await f.resolve()).toEqual({ proven: true, role: 'portal-admin', reason: 'active' })
      f.advance(1)
      expect(await f.resolve()).toEqual({
        proven: true,
        role: null,
        reason: 'creator_claims_expired',
      })
      f.service.observeSession(f.session({ roles: [appRole] }))
      expect((await f.resolve()).reason).toBe('creator_claims_expired')
      f.service.observeSession(f.session({
        roles: [appRole],
        claimIssuedAt: f.now(),
        expiresAt: f.now() + 28_800_000,
      }))
      expect(await f.resolve()).toEqual({ proven: true, role: 'portal-admin', reason: 'active' })
      f.advance(1)
      f.service.observeSession(
        f.session({ claimIssuedAt: f.now(), expiresAt: f.now() + 28_800_000 }),
      )
      f.service.observeSession(f.session({ roles: [appRole] }))
      expect((await f.resolve()).reason).toBe('creator_no_access')
      f.advance(28_800_000)
      expect((await f.resolve()).reason).toBe('creator_no_access')
    } finally {
      f.close()
    }
  }
})

Deno.test('expired group explanation uses current mapping, scope and capability without reviving access', async () => {
  const f = fixture()
  try {
    f.database.exec(
      "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
      start,
    )
    const group = f.service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'analyst',
    }, context)
    expect(group.ok).toBe(true)
    f.service.observeSession(f.session({ groups: ['group-1'] }))
    f.advance(28_799_999)
    expect((await f.resolve()).role).toBe('analyst')
    f.advance(1)
    expect(await f.resolve()).toEqual({
      proven: true,
      role: null,
      reason: 'creator_claims_expired',
    })
    expect((await f.resolve({ ...creator, slug: 'grains' })).reason).toBe('creator_no_access')
    f.database.exec("UPDATE rbac_group_capabilities SET status = 'disabled'")
    expect((await f.resolve()).reason).toBe('creator_no_access')
    f.database.exec("UPDATE rbac_group_capabilities SET status = 'verified-supported'")
    if (group.ok) expect(f.service.remove(group.value.id, context).ok).toBe(true)
    expect((await f.resolve()).reason).toBe('creator_no_access')
    f.service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'viewer',
    }, context)
    expect((await f.resolve()).reason).toBe('creator_claims_expired')
    f.service.observeSession(
      f.session({ groups: ['group-1'], claimIssuedAt: f.now(), expiresAt: f.now() + 28_800_000 }),
    )
    expect((await f.resolve()).role).toBe('viewer')
    f.advance(1)
    f.service.observeSession(f.session({ claimIssuedAt: f.now(), expiresAt: f.now() + 28_800_000 }))
    f.service.observeSession(f.session({ groups: ['group-1'] }))
    f.advance(28_800_000)
    expect((await f.resolve()).reason).toBe('creator_no_access')
  } finally {
    f.close()
  }
})

Deno.test('unknown expired app claims do not imply access or add role observations', async () => {
  const f = fixture()
  try {
    f.service.observeSession(f.session({ roles: ['Unknown.Role'] }))
    f.advance(28_800_000)
    let observations = 0
    const original = f.state.observeUnknownRole.bind(f.state)
    f.state.observeUnknownRole = (id) => {
      observations++
      return original(id)
    }
    expect((await f.resolve()).reason).toBe('creator_no_access')
    expect(observations).toBe(0)
  } finally {
    f.close()
  }
})

Deno.test('equal-time observations cannot extend expiry or restore contradicted group grants', async () => {
  const f = fixture()
  try {
    f.database.exec(
      "INSERT INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',?)",
      start,
    )
    f.service.create({
      subjectKind: 'group',
      subjectId: 'group-1',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'curator',
    }, context)
    f.service.observeSession(f.session({ groups: ['group-1'], expiresAt: start + 1000 }))
    expect((await f.resolve()).role).toBe('curator')
    f.service.observeSession(f.session({ groups: ['group-1'], groupStatus: 'overage' }))
    f.service.observeSession(f.session({ groups: ['group-1'] }))
    expect((await f.resolve()).role).toBeNull()
    expect(f.state.creatorEvidence(creator.tenantId, creator.oid)).toMatchObject({
      expiresAt: start + 1000,
      groupStatus: 'overage',
    })
  } finally {
    f.close()
  }
})

Deno.test('creator evidence fails closed for malformed and foreign data and excludes pending or implicit grants', async () => {
  const f = fixture()
  try {
    f.service.create({
      subjectKind: 'pending-email',
      subjectId: 'creator@example.test',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'portal-admin',
    }, context)
    f.service.observeSession(f.session())
    expect((await f.resolve()).role).toBeNull()
    expect(await f.resolve({ ...creator, tenantId: 'other' })).toEqual({
      proven: false,
      role: null,
      reason: 'unproven_creator',
    })
    expect(await f.resolve({ ...creator, oid: 'missing' })).toEqual({
      proven: false,
      role: null,
      reason: 'unproven_creator',
    })
    for (
      const [column, value] of [
        ['roles_json', '{broken'],
        ['roles_json', '[123]'],
        ['groups_json', '["bad group"]'],
        ['group_status', 'unknown'],
        ['claim_iat', start + 30_001],
        ['claim_iat', -1],
        ['expires_at', start],
        ['expires_at', start + 28_800_001],
        ['observed_at', start + 1],
      ] as const
    ) {
      f.database.exec('DELETE FROM rbac_owner_evidence')
      f.service.observeSession(f.session({ roles: ['CorpusKit.Owner'] }))
      f.database.exec(`UPDATE rbac_owner_evidence SET ${column} = ?`, value)
      expect(f.state.creatorEvidence(creator.tenantId, creator.oid)).toBeNull()
      expect(await f.resolve()).toEqual({ proven: false, role: null, reason: 'unproven_creator' })
    }
  } finally {
    f.close()
  }
})
