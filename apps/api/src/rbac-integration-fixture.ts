import { expect } from '@std/expect'
import type { TrustedSessionFacts } from './principal.ts'
import type { RbacState } from './rbac-state.ts'

/** Shared assertions only. Each adapter supplies its real ingress and persistent SQLite. */
export interface IdentityJourney {
  readonly rbac: RbacState
  exec(sql: string): void
  restart(): void
  advance(ms: number): void
  invoke(
    path: string,
    session?: TrustedSessionFacts,
    init?: RequestInit,
    peer?: boolean,
  ): Promise<Response>
}

export const fixtureSecret = 'hermetic-session-secret-more-than-thirty-two-bytes'
export const fixtureSession = (patch: Partial<TrustedSessionFacts> = {}): TrustedSessionFacts => ({
  verified: true,
  tenantId: 'tenant-1',
  oid: 'person-1',
  email: 'person@example.test',
  roles: [],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: Date.now() - 120_000,
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() + 3600_000,
  ...patch,
})
const context = { requestId: 'fixture-assignment', actor: { kind: 'system' as const } }
const platform = { kind: 'platform' as const }

export async function assertIdentityJourney(h: IdentityJourney): Promise<void> {
  const session = fixtureSession()
  const me = async (facts = session) => {
    const response = await h.invoke('/auth/me', facts)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    return response.json()
  }
  const service = () => h.rbac.assignmentService('tenant-1', 'corpuskit')
  const first = await me()
  expect(first).toMatchObject({
    authenticated: true,
    coarseAdminEligible: false,
    groupMappings: 'disabled',
    breakGlassEnabled: true,
  })
  expect(first.claimAgeSeconds).toBe(120)
  const create = service().create({
    subjectKind: 'active-oid',
    subjectId: session.oid,
    scope: platform,
    role: 'platform-admin',
  }, context)
  expect(create.ok).toBe(true)
  if (!create.ok) throw new Error('Fixture assignment failed')
  expect((await me()).effectiveRoles.platformRole).toBe('platform-admin')
  expect((await h.invoke('/api/admin/overview', session)).status).toBe(200)
  expect(
    (await me(fixtureSession({ oid: 'another', email: 'another@example.test' })))
      .coarseAdminEligible,
  ).toBe(false)
  expect(
    (await h.invoke('/api/admin/overview', fixtureSession({ tenantId: 'other-tenant' }))).status,
  ).not.toBe(200)
  expect(service().remove(create.value.id, context).ok).toBe(true)
  expect((await me()).coarseAdminEligible).toBe(false)
  expect((await h.invoke('/api/admin/overview', session)).status).toBe(403)
  h.advance(90_000)
  expect((await me()).claimAgeSeconds).toBe(210)

  for (const field of ['email', 'preferredUsername'] as const) {
    const subjectId = `${field}@example.test`.toLowerCase()
    const pending = service().create({
      subjectKind: 'pending-email',
      subjectId,
      scope: { kind: 'portal', slug: 'marine' },
      role: 'curator',
    }, context)
    expect(pending.ok).toBe(true)
    const facts = fixtureSession({
      oid: field,
      email: 'unassigned@example.test',
      [field]: subjectId.toUpperCase(),
    })
    const result = await me(facts)
    expect(result.effectiveRoles.portalRoles).toContainEqual({ slug: 'marine', role: 'curator' })
    expect(result.coarseAdminEligible).toBe(false)
    expect(service().list().find((row) => row.subjectId === field)).toMatchObject({
      subjectKind: 'active-oid',
      emailProvenance: subjectId,
    })
    expect((await me({ ...facts, oid: `other-${field}` })).effectiveRoles.portalRoles).not
      .toContainEqual({ slug: 'marine', role: 'curator' })
  }

  const owner = service().create({
    subjectKind: 'active-oid',
    subjectId: 'last-owner',
    scope: platform,
    role: 'owner',
  }, context)
  if (!owner.ok) throw new Error('Fixture owner failed')
  expect(service().remove(owner.value.id, context)).toMatchObject({ ok: false, code: 'last_owner' })
  const appOwner = fixtureSession({
    oid: 'app-owner',
    roles: ['CorpusKit.Owner'],
    expiresAt: Date.now() + 1000,
  })
  expect((await me(appOwner)).effectiveRoles.platformRole).toBe('owner')
  h.advance(1001)
  expect(service().remove(owner.value.id, context)).toMatchObject({ ok: false, code: 'last_owner' })
  expect(
    h.rbac.audit.read({ scope: platform }).some((e) =>
      e.outcome === 'denied' && e.detail_json.includes('last_owner')
    ),
  ).toBe(true)

  const passcode = (value: string) => ({
    headers: { 'x-admin-passcode': value, 'x-forwarded-for': crypto.randomUUID() },
  })
  expect((await h.invoke('/api/admin/overview', undefined, passcode('fixture'), false)).status)
    .toBe(403)
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await h.invoke('/api/admin/overview', undefined, passcode('wrong'))).status).toBe(
      attempt === 4 ? 403 : 401,
    )
  }
  h.restart()
  const locked = await h.invoke('/api/admin/overview', undefined, passcode('fixture'))
  expect(locked.status).toBe(403)
  expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
  h.advance(600_001)
  expect((await h.invoke('/api/admin/overview', session, passcode('fixture'))).status).toBe(200)
  const events = h.rbac.audit.read({ scope: platform })
  const used = events.filter((e) => e.action === 'break_glass.used')
  expect(used).toHaveLength(1)
  expect(JSON.parse(used[0]!.detail_json)).toEqual({
    sessionOid: session.oid,
    sessionTenantId: session.tenantId,
  })
  expect(events.filter((e) => e.action === 'request.denied').every((e) => e.request_id.length > 0))
    .toBe(true)

  // Both adapters must fail before a response escapes at every mandatory request-audit boundary.
  const privileged = fixtureSession({ roles: ['CorpusKit.PlatformAdmin'] })
  for (
    const condition of [
      "NEW.outcome = 'intent'",
      "NEW.outcome = 'success'",
      "NEW.action = 'request.denied'",
      "NEW.action = 'break_glass.used'",
    ]
  ) {
    h.exec(
      `CREATE TRIGGER fail_journey_audit BEFORE INSERT ON audit_events WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`,
    )
    const denial = condition.includes('request.denied')
    const emergency = condition.includes('break_glass.used')
    expect(
      (await h.invoke(
        '/api/admin/overview',
        denial || emergency ? undefined : privileged,
        emergency ? passcode('fixture') : undefined,
      )).status,
    ).toBe(500)
    h.exec('DROP TRIGGER fail_journey_audit')
  }
  h.exec(
    "CREATE TRIGGER fail_assignment_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'assignment.create' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
  )
  expect(() =>
    service().create({
      subjectKind: 'active-oid',
      subjectId: 'rolled-back',
      scope: platform,
      role: 'platform-admin',
    }, context)
  ).toThrow()
  expect(service().list().some((row) => row.subjectId === 'rolled-back')).toBe(false)
  h.exec('DROP TRIGGER fail_assignment_audit')
  for (
    const path of [
      '/api/t/marine/config',
      '/api/t/marine/catalog',
      '/api/t/marine/search?q=abalone',
    ]
  ) {
    const response = await h.invoke(path)
    expect(response.status).toBe(200)
    await response.text()
  }
  const answer = await h.invoke('/api/t/marine/ask', undefined, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'How are abalone stocks?' }),
  })
  expect(answer.status).toBe(200)
  expect(await answer.text()).toContain('data:')
}
