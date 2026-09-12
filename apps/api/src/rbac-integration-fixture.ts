import { expect } from '@std/expect'
import type { TrustedSessionFacts } from './principal.ts'
import type { RbacState } from './rbac-state.ts'
import type { BuildAppOptions } from './app.ts'
import { signPrincipal } from './principal.ts'

/** Observe the runtime provider instance without adding or replacing any authorisation guard. */
export function trackJourneyProvider(provider: object, calls: string[]): void {
  const names = new Set<string>()
  for (
    let prototype = Object.getPrototypeOf(provider);
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) names.add(name)
  }
  for (const name of names) {
    if (name === 'constructor') continue
    const method = Reflect.get(provider, name)
    if (typeof method === 'function') {
      Reflect.set(provider, name, (...args: unknown[]) => {
        calls.push(name)
        return method.apply(provider, args)
      })
    }
  }
}

export interface EnforcementJourney extends IdentityJourney {
  readonly stores: {
    [K in 'tenants' | 'sessions' | 'watches' | 'investigations' | 'mcpKeys']: NonNullable<
      BuildAppOptions[K]
    >
  }
  readonly calls: string[]
  boundary(header: string): Promise<Response>
}

/** The identical threat script runs through each runtime's actual ingress and mutation stores. */
export async function assertEnforcementJourney(h: EnforcementJourney): Promise<void> {
  const owner = () => fixtureSession({ oid: 'journey-owner', roles: ['CorpusKit.Owner'] })
  const reader = fixtureSession({ oid: 'journey-reader' })
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const service = () => h.rbac.assignmentService('tenant-1', 'corpuskit')
  const count = () => h.calls.length
  const denied = async (path: string, session?: TrustedSessionFacts, init?: RequestInit) => {
    const before = count()
    const oldEvents = new Set(h.rbac.audit.read({ scope: platform, limit: 1000 }).map((e) => e.id))
    const response = await h.invoke(path, session, init)
    expect([401, 403]).toContain(response.status)
    expect(count()).toBe(before)
    const requestId = response.headers.get('x-request-id')
    const added = h.rbac.audit.read({ scope: platform, limit: 1000 }).filter((e) =>
      !oldEvents.has(e.id) && e.outcome === 'denied'
    )
    expect(added.length).toBeGreaterThan(0)
    expect(
      added.every((e) => e.request_id.length > 0 && ['platform', 'portal'].includes(e.scope_kind)),
    ).toBe(true)
    if (requestId) {
      expect(h.rbac.audit.read({ scope: platform, requestId }).some((e) => e.outcome === 'denied'))
        .toBe(true)
    }
    return response
  }
  for (const mode of ['public', 'authenticated', 'restricted'] as const) {
    const changed = await h.invoke(
      '/api/admin/t/marine/access',
      owner(),
      json('PATCH', { accessMode: mode }),
    )
    expect(changed.status).toBe(200)
    expect(h.stores.tenants.get('marine')?.accessMode).toBe(mode)
    if (mode === 'public') expect((await h.invoke('/api/t/marine/catalog')).status).toBe(200)
    else {
      await denied('/api/t/marine/catalog')
      const safe = await (await h.invoke('/api/t/marine/config')).json()
      expect(Object.keys(safe).sort()).toEqual(['accessMode', 'branding', 'slug'])
    }
    if (mode !== 'restricted') {
      const allowed = await h.invoke('/api/t/marine/catalog', reader)
      expect(allowed.status).toBe(200)
      expect((await allowed.json()).items[0].id).toBe('res-1')
    } else await denied('/api/t/marine/catalog', reader)
  }
  const assigned = service().create({
    subjectKind: 'active-oid',
    subjectId: reader.oid,
    scope: { kind: 'portal', slug: 'marine' },
    role: 'viewer',
  }, context)
  if (!assigned.ok) throw new Error('Journey assignment failed')
  expect((await h.invoke('/api/t/marine/catalog', reader)).status).toBe(200)
  expect(service().remove(assigned.value.id, context).ok).toBe(true)
  await denied('/api/t/marine/catalog', reader)

  // Key role remains bounded after creator claims expire, with current local assignment authoritative.
  const creator = fixtureSession({ oid: 'journey-creator', expiresAt: Date.now() + 1000 })
  const assignment = service().create({
    subjectKind: 'active-oid',
    subjectId: creator.oid,
    scope: { kind: 'portal', slug: 'marine' },
    role: 'portal-admin',
  }, context)
  if (!assignment.ok) throw new Error('Journey creator failed')
  const mint = async (expiry?: string) => {
    const response = await h.invoke(
      '/api/t/marine/mcp/keys',
      creator,
      json('POST', {
        label: 'Journey client',
        role: 'analyst',
        ...(expiry ? { expiresAt: expiry } : {}),
      }),
    )
    expect(response.status).toBe(201)
    return response.json()
  }
  const key = await mint()
  const expiring = await mint(new Date(Date.now() + 1000).toISOString())
  const keyed = (token = key.key, method = 'GET', body?: unknown) => ({
    ...json(method, body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  })
  const generate = () =>
    h.invoke(
      '/api/t/marine/summarize',
      undefined,
      keyed(key.key, 'POST', { resourceIds: ['res-1'] }),
    )
  expect((await generate()).status).toBe(200)
  h.advance(1001)
  expect((await generate()).status).toBe(200)
  await denied('/api/t/marine/catalog', owner(), keyed(expiring.key))
  await denied('/api/admin/overview', owner(), keyed())
  await denied('/api/t/grains/catalog', owner(), keyed())
  await denied('/api/t/marine/sessions', owner(), keyed())
  expect(service().change(assignment.value.id, { role: 'viewer' }, context).ok).toBe(true)
  await denied(
    '/api/t/marine/summarize',
    owner(),
    keyed(key.key, 'POST', { resourceIds: ['res-1'] }),
  )
  expect((await h.invoke('/api/t/marine/catalog', undefined, keyed())).status).toBe(200)
  const revoke = await h.invoke(
    `/api/t/marine/mcp/keys/${key.credential.id}`,
    owner(),
    json('DELETE'),
  )
  expect(revoke.status).toBe(200)
  await denied('/api/t/marine/catalog', owner(), keyed())
  // A migrated viewer record without verified creator provenance must remain inert.
  const legacy = h.stores.mcpKeys.list('marine').find((r) => r.id === expiring.credential.id)!
  const legacyToken = `ck_mcp_${'L'.repeat(12)}_${'M'.repeat(43)}`
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyToken)),
  )
  h.stores.mcpKeys.add({
    ...legacy,
    id: crypto.randomUUID(),
    prefix: legacyToken.slice(0, 15),
    hash: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    expiresAt: null,
    creator: null,
    provenance: 'legacy-unproven',
    role: 'viewer',
  })
  await denied('/api/t/marine/catalog', owner(), keyed(legacyToken))

  // Nested IDs never cross signed owners, portals or the anonymous namespace.
  const writer = owner()
  const signed = { kind: 'user' as const, tenantId: writer.tenantId, oid: writer.oid }
  const investigation = h.stores.investigations.create('marine', signed, {
    name: 'Private evidence',
  })
  const evidence = h.stores.investigations.addEvidence('marine', signed, investigation.id, {
    resourceId: 'res-1',
    resourceTitle: 'Evidence',
    passage: 'Private passage',
    score: null,
    question: '',
    verdict: null,
    aiRelevance: null,
    note: '',
    tags: [],
  })!
  const root = `/api/t/marine/investigations/${investigation.id}`
  expect((await h.invoke(root, writer)).status).toBe(200)
  for (const path of [root, root + `/evidence/${evidence.id}`]) {
    const before = count()
    const response = await h.invoke(
      path,
      fixtureSession({ oid: 'other-owner', roles: ['CorpusKit.Owner'] }),
      json(path === root ? 'GET' : 'PATCH', path === root ? undefined : { note: 'stolen' }),
    )
    expect(response.status).toBe(404)
    expect(count()).toBe(before)
    expect(h.stores.investigations.get('marine', signed, investigation.id)?.evidence[0]?.note).toBe(
      '',
    )
  }
  expect((await h.invoke(root.replace('/marine/', '/grains/'), writer)).status).toBe(404)
  await h.invoke('/api/admin/t/marine/access', writer, json('PATCH', { accessMode: 'public' }))
  expect((await h.invoke(root, undefined, { headers: { 'x-rp-client': writer.oid } })).status).toBe(
    404,
  )
  await h.invoke('/api/admin/t/marine/access', writer, json('PATCH', { accessMode: 'restricted' }))

  const payload = {
    v: 1 as const,
    aud: 'corpuskit' as const,
    tid: 'tenant-1',
    oid: writer.oid,
    email: '',
    name: '',
    roles: ['CorpusKit.Owner'],
    groups: [],
    iat: Math.floor(Date.now() / 1000),
  }
  for (
    const header of [
      'forged',
      'x'.repeat(8193),
      await signPrincipal({ ...payload, iat: payload.iat - 61 }, fixtureSecret),
      await signPrincipal({ ...payload, aud: 'corpuskit-demo' }, fixtureSecret),
    ]
  ) {
    const before = count()
    await denied('/api/t/marine/catalog', undefined, {
      headers: {
        'x-corpuskit-principal': header,
        'x-corpuskit-sso-admin': '1',
        'x-sso-user-id': writer.oid,
      },
    })
    expect((await h.boundary(header)).status).toBe(401)
    expect(count()).toBe(before)
  }
  await denied('/api/t/marine/catalog', fixtureSession({ expiresAt: Date.now() - 1 }))

  // Observe real local mutation rollback separately from later request completion withholding.
  for (const failure of ['intent', 'mutation', 'completion', 'commit']) {
    const before = h.stores.tenants.get('marine')
    const condition = failure === 'intent'
      ? "NEW.action = 'request.privileged' AND NEW.outcome = 'intent'"
      : failure === 'completion'
      ? "NEW.action = 'request.privileged' AND NEW.outcome = 'success'"
      : "NEW.action = 'local.mutation'"
    if (failure === 'commit') {
      h.exec(
        'PRAGMA foreign_keys=ON; CREATE TABLE journey_parent(id INTEGER PRIMARY KEY); CREATE TABLE journey_child(id INTEGER REFERENCES journey_parent(id) DEFERRABLE INITIALLY DEFERRED)',
      )
      h.exec(
        `CREATE TRIGGER journey_failure AFTER INSERT ON audit_events WHEN ${condition} BEGIN INSERT INTO journey_child VALUES (1); END`,
      )
    } else {h.exec(
        `CREATE TRIGGER journey_failure BEFORE INSERT ON audit_events WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'journey audit failure'); END`,
      )}
    const response = await h.invoke(
      '/api/admin/t/marine/access',
      owner(),
      json('PATCH', { accessMode: 'authenticated' }),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('"accessMode":"authenticated"')
    expect(h.stores.tenants.get('marine')?.accessMode).toBe(
      failure === 'completion' ? 'authenticated' : before?.accessMode,
    )
    h.exec('DROP TRIGGER journey_failure')
    await h.invoke(
      '/api/admin/t/marine/access',
      owner(),
      json('PATCH', { accessMode: 'restricted' }),
    )
  }
}

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
  expect(
    await me(fixtureSession({
      oid: 'group-overage-admin',
      email: 'admin@example.test',
      roles: ['CorpusKit.Admin'],
      groups: [],
      groupStatus: 'overage',
    })),
  ).toMatchObject({
    authenticated: true,
    user: { roles: ['CorpusKit.Admin'] },
    effectiveRoles: { platformRole: 'platform-admin' },
    groupStatus: 'overage',
    groupMappings: 'disabled',
  })
  const backup = service().create({
    subjectKind: 'active-oid',
    subjectId: 'backup-owner',
    scope: platform,
    role: 'owner',
  }, context)
  if (!backup.ok) throw new Error('Fixture backup owner failed')
  const create = service().create({
    subjectKind: 'active-oid',
    subjectId: session.oid,
    scope: platform,
    role: 'owner',
  }, context)
  expect(create.ok).toBe(true)
  if (!create.ok) throw new Error('Fixture assignment failed')
  expect((await me()).effectiveRoles.platformRole).toBe('owner')
  const overview = await h.invoke('/api/admin/overview', session)
  expect(overview.status).toBe(200)
  expect((await overview.json()).length).toBeGreaterThan(0)
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
  expect(service().remove(backup.value.id, context).ok).toBe(true)
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
  const privileged = fixtureSession({ roles: ['CorpusKit.Owner'] })
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
  const answerEvents = (await answer.text()).split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
  expect(answerEvents.filter((event) => event.type === 'error')).toEqual([])
  expect(answerEvents.find((event) => event.type === 'done')).toMatchObject({
    refused: false,
    text: expect.stringContaining('Abalone populations'),
  })
  expect(answerEvents.some((event) => event.type === 'delta' && event.text.length > 0)).toBe(true)
  expect(answerEvents.find((event) => event.type === 'citation')).toMatchObject({
    citation: { index: 1, resourceId: 'res-1' },
  })
}
