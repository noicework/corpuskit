import { expect } from '@std/expect'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { buildApp } from './app.ts'
import {
  externalLoginConfig,
  externalLoginConfigured,
  ExternalLoginReplayStore,
} from './external-login.ts'
import { LocalIngress } from './local-ingress.ts'
import { OPERATOR_FAILURE_LIMIT_PER_MIN, operatorRequestContext } from './operator.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import type { TrustedSessionFacts } from './principal.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'

const operatorKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const owner = (): TrustedSessionFacts => ({
  verified: true,
  tenantId: 'tenant-1',
  oid: 'owner-1',
  email: 'owner@example.test',
  roles: ['CorpusKit.Owner'],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: Date.now(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
})

function fixture(overrides: Record<string, string | undefined> = {}) {
  const directory = Deno.makeTempDirSync({ prefix: 'local-operator-' })
  const database = new LocalRbacDatabase(`${directory}/rbac.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  const env = {
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-test',
    ...overrides,
  }
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  const externalReplays = new ExternalLoginReplayStore(database)
  const ingress = new LocalIngress({ rbac, tenants, env, externalReplays })
  // The same identity configuration the local server derives from its environment.
  const externalLoginEnabled = externalLoginConfigured(externalLoginConfig(env))
  const initialAuditIds = new Set(
    rbac.audit.read({ scope: { kind: 'platform' } }).map((event) => event.id),
  )
  const app = buildApp({
    ...owned,
    rbac,
    tenants,
    configuredTenantId: env.ENTRA_TENANT_ID || (externalLoginEnabled ? 'external' : undefined),
    externalLoginEnabled,
    audience: 'corpuskit',
    provider: new DoubleProvider(),
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
  })
  const invoke = (
    path: string,
    init: RequestInit = {},
    session: TrustedSessionFacts | null = null,
  ) => {
    const headers = new Headers(init.headers)
    if (!headers.has('authorization')) headers.set('authorization', `Operator ${operatorKey}`)
    return ingress.handle(
      new Request(`http://localhost${path}`, { ...init, headers }),
      (request) => app.fetch(request),
      undefined,
      session,
    )
  }
  return {
    app,
    database,
    rbac,
    tenants,
    ingress,
    invoke,
    events: () =>
      rbac.audit.read({ scope: { kind: 'platform' } }).filter((event) =>
        !initialAuditIds.has(event.id)
      ),
    dispose() {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('local operator uses a signed principal without credentials, a session or assignment activation', async () => {
  const f = fixture()
  try {
    const assignment = f.rbac.assignmentService('tenant-1').create({
      subjectKind: 'pending-email',
      subjectId: 'owner@example.test',
      role: 'owner',
      scope: { kind: 'platform' },
    }, { requestId: 'setup', actor: { kind: 'system' } })
    expect(assignment.ok).toBe(true)
    const response = await f.ingress.handle(
      new Request('http://localhost/api/admin/t/marine/members', {
        headers: {
          authorization: `Operator ${operatorKey}`,
          'x-corpuskit-principal': 'forged',
          'x-sso-user-id': 'forged-owner',
        },
      }),
      (request) => {
        expect(request.headers.has('authorization')).toBe(false)
        expect(request.headers.has('x-corpuskit-principal')).toBe(false)
        expect(request.headers.has('x-sso-user-id')).toBe(false)
        const context = f.ingress.requestContext(request)
        expect(context?.operator).toEqual({ id: 'hosting-test' })
        expect(context?.session).toBeNull()
        expect(context?.user).toBeNull()
        expect(context?.effectiveRoles).toEqual({
          platformRole: 'platform-admin',
          portalRoles: [],
        })
        expect(context?.coarseAdminEligible).toBe(true)
        // The Worker's Durable Object builds its operator context with the same helper.
        expect(context).toEqual(operatorRequestContext('hosting-test', context!.requestId))
        return new Response('ok')
      },
      undefined,
      owner(),
    )
    expect(response.status).toBe(200)
    expect(f.rbac.assignments.list('tenant-1')[0]?.subjectKind).toBe('pending-email')
    expect(f.database.all('SELECT * FROM rbac_owner_evidence')).toEqual([])
  } finally {
    f.dispose()
  }
})

Deno.test('local operator manages portal access and email members with its audit actor', async () => {
  const f = fixture()
  try {
    const created = await f.invoke(
      '/api/admin/t/marine/members',
      json('POST', {
        subjectKind: 'pending-email',
        subjectId: 'reader@example.test',
        role: 'viewer',
      }),
    )
    expect(created.status).toBe(201)
    const member = await created.json()
    expect(member.subjectKind).toBe('pending-email')
    const list = await f.invoke('/api/admin/t/marine/members')
    expect(list.status).toBe(200)
    expect((await list.json()).items).toHaveLength(1)
    const access = await f.invoke(
      '/api/admin/t/marine/access',
      json('PATCH', {
        accessMode: 'restricted',
      }),
    )
    expect(access.status).toBe(200)
    expect(f.tenants.get('marine')?.accessMode).toBe('restricted')
    expect(
      (await f.invoke(`/api/admin/t/marine/members/${member.id}`, {
        method: 'DELETE',
      })).status,
    ).toBe(200)
    const events = f.events()
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events.every((event) => event.actor_kind === 'operator')).toBe(true)
    expect(events.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(events.filter((event) => event.action === 'request.privileged')).toHaveLength(8)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
    expect(JSON.stringify(events)).not.toContain('Authorization')
  } finally {
    f.dispose()
  }
})

Deno.test('local operator reads and sets portal lifecycle and reads usage with its audit actor', async () => {
  const f = fixture()
  try {
    const initial = await f.invoke('/api/admin/t/marine/lifecycle')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ status: 'active', limits: null })
    const set = await f.invoke(
      '/api/admin/t/marine/lifecycle',
      json('PUT', {
        status: 'suspended',
        limits: { asksPerDay: 5, agentsEnabled: false },
        note: 'Paused by hosting automation',
      }),
    )
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({
      ok: true,
      lifecycle: { status: 'suspended', limits: { asksPerDay: 5, agentsEnabled: false } },
    })
    // Platform-level authority is never paused out of the portal's hosting state.
    const read = await f.invoke('/api/admin/t/marine/lifecycle')
    expect(read.status).toBe(200)
    expect((await read.json()).status).toBe('suspended')
    const usage = await f.invoke('/api/admin/t/marine/usage')
    expect(usage.status).toBe(200)
    expect(await usage.json()).toMatchObject({
      status: 'suspended',
      limits: { asksPerDay: 5, agentsEnabled: false },
      resources: 0,
      bytes: 0,
      asksToday: 0,
      members: 0,
    })
    // The flags open these routes only: portal deletion and platform administration stay shut.
    for (
      const [method, path] of [
        ['DELETE', '/api/admin/tenants/marine'],
        ['GET', '/api/admin/people'],
        ['GET', '/api/admin/overview'],
        ['POST', '/api/admin/t/marine/enable'],
      ] as const
    ) {
      const refused = await f.invoke(path, { method })
      expect([method, path, refused.status]).toEqual([method, path, 403])
      expect(await refused.json()).toEqual({ error: 'operator_not_allowed' })
    }
    expect(f.tenants.get('marine')).not.toBeNull()
    const events = f.events()
    const update = events.filter((event) => event.action === 'portal.lifecycle.update')
    // The route's intent and success records, and the named record committed with the write.
    expect(update.map((event) => event.outcome).sort()).toEqual(['intent', 'success', 'success'])
    for (const event of update) {
      expect(event).toMatchObject({
        actor_kind: 'operator',
        actor_id: 'operator:hosting-test',
        scope_kind: 'platform',
        target_kind: 'portal',
        target_id: 'marine',
      })
    }
    expect(JSON.parse(update[0]!.detail_json)).toMatchObject({
      lifecycleStatus: 'suspended',
      asksPerDay: 5,
      agentsEnabled: false,
      note: 'Paused by hosting automation',
    })
    expect(events.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(operatorKey)
  } finally {
    f.dispose()
  }
})

Deno.test('local operator refuses malformed, wrong, missing, disabled and conflicting credentials without fallback', async () => {
  const cases: [Record<string, string | undefined>, HeadersInit][] = [
    [{}, { authorization: `Operator ${'Ag'.repeat(22)}` }],
    [{}, { authorization: 'Operator' }],
    [{}, { authorization: 'Operator invalid' }],
    [{ OPERATOR_API_KEY: undefined }, { authorization: `Operator ${operatorKey}` }],
    [{ OPERATOR_API_KEY: '' }, { authorization: `Operator ${operatorKey}` }],
    [{ OPERATOR_API_KEY: 'short' }, { authorization: 'Operator short' }],
    [{ OPERATOR_ID: '\ninvalid' }, { authorization: `Operator ${operatorKey}` }],
    [{}, { authorization: `Bearer ${operatorKey}` }],
    [{ ADMIN_PASSCODE: 'fixture' }, {
      authorization: `Operator ${operatorKey}`,
      'x-admin-passcode': 'fixture',
    }],
  ]
  for (const [env, headers] of cases) {
    const f = fixture(env)
    try {
      const response = await f.invoke('/api/admin/t/marine/members', { headers }, owner())
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_operator' })
      const events = f.events()
      expect(events.some((event) => event.action === 'request.denied')).toBe(true)
      expect(JSON.stringify(events)).not.toContain(operatorKey)
      expect(f.rbac.assignments.list('tenant-1')).toEqual([])
    } finally {
      f.dispose()
    }
  }
})

Deno.test('local operator refuses public, data-plane, unflagged and owner-only routes', async () => {
  const f = fixture()
  try {
    const cases: [string, string][] = [
      ['GET', '/api/health'],
      ['GET', '/api/t/marine/config'],
      ['GET', '/api/t/marine/search?query=evidence'],
      ['POST', '/api/t/marine/ask'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/t/marine/groups'],
      ['PATCH', '/api/admin/t/marine/members/unknown'],
      ['GET', '/api/admin/people'],
      ['DELETE', '/api/admin/tenants/marine'],
      ['GET', '/api/admin/unmatched'],
      ['GET', '/auth/me'],
      ['GET', '/'],
      ['GET', '/__corpuskit/private'],
    ]
    for (const [method, path] of cases) {
      const response = await f.invoke(path, { method }, owner())
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
    }
    const events = f.events()
    expect(events.filter((event) => event.action === 'request.denied')).toHaveLength(cases.length)
    expect(events.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(f.tenants.get('marine')).not.toBeNull()
  } finally {
    f.dispose()
  }
})

Deno.test('local operator defaults its audit id and leaves requests without credentials anonymous', async () => {
  const f = fixture({ OPERATOR_ID: undefined })
  try {
    expect((await f.invoke('/api/admin/t/marine/members')).status).toBe(200)
    expect(
      f.events().every((event) => event.actor_id === 'operator:operator'),
    ).toBe(true)
    const anonymous = await f.ingress.handle(
      new Request('http://localhost/api/health'),
      (request) => {
        expect(f.ingress.requestContext(request)?.operator).toBeUndefined()
        expect(f.ingress.requestContext(request)?.effectiveRoles?.platformRole).toBeUndefined()
        return new Response('ok')
      },
    )
    expect(anonymous.status).toBe(200)
  } finally {
    f.dispose()
  }
})

Deno.test('local operator fails closed on audit and signing failure without logging credentials', async () => {
  const originalError = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => logs.push(args)
  try {
    for (const path of ['/auth/me', '/api/admin/t/marine/access']) {
      const f = fixture()
      try {
        f.database.exec(
          "CREATE TRIGGER fail_operator_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        )
        const response = await f.invoke(
          path,
          path === '/auth/me' ? {} : json('PATCH', { accessMode: 'restricted' }),
        )
        expect(response.status).toBe(500)
        expect(await response.text()).not.toContain(operatorKey)
        expect(f.tenants.get('marine')?.accessMode).toBe('public')
      } finally {
        f.dispose()
      }
    }
    const f = fixture({ SESSION_SECRET: 'too-short' })
    try {
      const response = await f.invoke('/api/admin/t/marine/members')
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_principal' })
      expect(f.events()[0]?.actor_id).toBe(
        'operator:hosting-test',
      )
    } finally {
      f.dispose()
    }
    expect(JSON.stringify(logs)).not.toContain(operatorKey)
  } finally {
    console.error = originalError
  }
})

Deno.test('local operator rate limits invalid credentials per peer address without limiting verified calls', async () => {
  const f = fixture()
  const peer = (hostname: string) => ({
    remoteAddr: { transport: 'tcp' as const, hostname, port: 40_000 },
  })
  const send = (authorization: string, hostname = '192.0.2.10') =>
    f.ingress.handle(
      new Request('http://localhost/api/admin/t/marine/members', { headers: { authorization } }),
      (request) => f.app.fetch(request),
      peer(hostname),
    )
  const wrong = `Operator ${'Ag'.repeat(22)}`
  const denials = () => f.events().filter((event) => event.action === 'request.denied').length
  try {
    for (let attempt = 0; attempt < OPERATOR_FAILURE_LIMIT_PER_MIN; attempt++) {
      const response = await send(wrong)
      expect(response.status).toBe(401)
      await response.body?.cancel()
    }
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN)
    for (const authorization of [wrong, `Bearer ${operatorKey}`]) {
      const limited = await send(authorization)
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ error: 'rate_limited' })
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN)
    const elsewhere = await send(wrong, '198.51.100.20')
    expect(elsewhere.status).toBe(401)
    expect(await elsewhere.json()).toEqual({ error: 'invalid_operator' })
    expect(denials()).toBe(OPERATOR_FAILURE_LIMIT_PER_MIN + 1)
    expect((await send(`Operator ${operatorKey}`)).status).toBe(200)
    expect(JSON.stringify(f.events())).not.toContain(operatorKey)
  } finally {
    f.dispose()
  }
})

Deno.test('local server warns once at startup without the value when a present operator key is unusable', async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  const operatorWarnings = () => warnings.filter((line) => line.includes('operator credential'))
  try {
    for (
      const [env, variable] of [
        [{ OPERATOR_API_KEY: `${operatorKey}=` }, 'OPERATOR_API_KEY'],
        [{ OPERATOR_ID: 'hosting automation' }, 'OPERATOR_ID'],
      ] as const
    ) {
      warnings.length = 0
      const f = fixture(env)
      try {
        expect(operatorWarnings()).toHaveLength(1)
        expect(operatorWarnings()[0]).toContain(variable)
        const response = await f.invoke('/api/admin/t/marine/members')
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'invalid_operator' })
        expect(operatorWarnings()).toHaveLength(1)
        expect(JSON.stringify(warnings)).not.toContain(operatorKey)
        expect(JSON.stringify(warnings)).not.toContain('hosting automation')
      } finally {
        f.dispose()
      }
    }
    for (const env of [{}, { OPERATOR_API_KEY: undefined }]) {
      warnings.length = 0
      fixture(env).dispose()
      expect(operatorWarnings()).toEqual([])
    }
  } finally {
    console.warn = originalWarn
  }
})

Deno.test('local operator beside an external session cookie never reads or upgrades it, with or without Entra', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const handoffUrl = async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${
      part({
        iss: 'https://issuer.example',
        aud: 'corpuskit',
        sub: 'person-1',
        email: 'person@example.test',
        email_verified: true,
        iat: now - 5,
        exp: now + 60,
        jti: crypto.randomUUID(),
      })
    }`
    const signature = await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(content))
    const assertion = `${content}.${encode(new Uint8Array(signature))}`
    return `http://localhost/auth/external?${new URLSearchParams({
      assertion,
      returnTo: '/t/marine',
    })}`
  }
  const external = {
    SESSION_SECRET: 'local-operator-session-secret-of-32-bytes-or-more',
    WORKER_NAME: 'corpuskit',
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  }
  for (const entra of [true, false]) {
    const f = fixture({ ...external, ...(entra ? {} : { ENTRA_TENANT_ID: undefined }) })
    const tenantId = entra ? 'tenant-1' : 'external'
    const dispatch = (request: Request) => f.app.fetch(request)
    try {
      f.rbac.assignmentService(tenantId, 'corpuskit', true).create({
        subjectKind: 'pending-email',
        subjectId: 'person@example.test',
        source: 'external',
        scope: { kind: 'portal', slug: 'marine' },
        role: 'analyst',
      }, { requestId: 'setup', actor: { kind: 'system' } })
      // The operator credential is decided first: the handoff refuses it and consumes nothing.
      const url = await handoffUrl()
      const operatorHandoff = await f.ingress.handle(
        new Request(url, { headers: { authorization: `Operator ${operatorKey}` } }),
        dispatch,
      )
      expect(operatorHandoff.status).toBe(403)
      expect(await operatorHandoff.json()).toEqual({ error: 'operator_not_allowed' })
      const handoff = await f.ingress.handle(new Request(url), dispatch)
      expect(handoff.status).toBe(303)
      const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
      const call = (path: string, init: RequestInit = {}, operator = true) => {
        const headers = new Headers(init.headers)
        headers.set('cookie', cookie)
        if (operator) headers.set('authorization', `Operator ${operatorKey}`)
        return f.ingress.handle(
          new Request(`http://localhost${path}`, { ...init, headers }),
          dispatch,
        )
      }
      const created = await call('/api/admin/t/marine/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectKind: 'pending-email',
          subjectId: 'reader@example.test',
          source: 'external',
          role: 'viewer',
        }),
      })
      expect(created.status).toBe(201)
      // The session was not read, so its own pending assignment is still unclaimed.
      expect(
        f.rbac.assignments.list(tenantId).map((row) => row.subjectKind),
      ).toEqual(['pending-email', 'pending-email'])
      for (const path of ['/api/t/marine/config', '/auth/me', '/auth/logout']) {
        const refused = await call(path)
        expect([path, refused.status]).toEqual([path, 403])
        expect(await refused.json()).toEqual({ error: 'operator_not_allowed' })
      }
      // Apart from the setup grant, every event so far is the operator's; none is the person's.
      expect(JSON.stringify(f.events())).not.toContain('ext:person-1')
      const operatorEvents = f.events().filter((event) => event.actor_kind !== 'system')
      expect(operatorEvents.length).toBeGreaterThan(0)
      expect(
        operatorEvents.every((event) =>
          event.actor_kind === 'operator' && event.actor_id === 'operator:hosting-test'
        ),
      ).toBe(true)
      // Alone, the cookie is only the external person with only its own portal assignment.
      const me = await (await call('/auth/me?portal=marine', {}, false)).json()
      expect(me).toMatchObject({
        authenticated: true,
        sessionProvenance: 'external',
        entraEnabled: false,
        effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'analyst' }] },
      })
      expect(me.effectiveRoles.platformRole).toBeUndefined()
      const platform = await call('/api/admin/tenants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Not Allowed' }),
      }, false)
      expect(platform.status).toBe(403)
    } finally {
      f.dispose()
    }
  }
})
