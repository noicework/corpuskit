import { expect } from '@std/expect'
import { resolveCreatorAuthority } from './creator-authority.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import type { VerifiedAssignmentSession } from './assignments.ts'

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
    resolve: (input = creator) =>
      resolveCreatorAuthority(input, { rbac: state, audience: 'corpuskit' }, creator.tenantId, at),
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
      reason: 'creator_no_access',
    })
    if (local.ok) expect(f.service.remove(local.value.id, context).ok).toBe(true)
    expect(await f.resolve()).toEqual({ proven: true, role: null, reason: 'creator_no_access' })
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
