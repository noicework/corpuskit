import { expect } from '@std/expect'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { buildApp } from './app.ts'
import { LocalIngress } from './local-ingress.ts'
import { ExternalLoginReplayStore } from './external-login.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'

const operatorKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

function fixture(
  extra: Record<string, string> = {},
  /** Writes to the registry before the server starts, as an earlier release could have. */
  seed?: (tenants: TenantStore) => void,
) {
  const directory = Deno.makeTempDirSync({ prefix: 'local-aliases-' })
  const database = new LocalRbacDatabase(`${directory}/rbac.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  const env = {
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-test',
    ADMIN_PASSCODE: 'fixture-passcode',
    MAX_PORTAL_ALIASES: '3',
    ...extra,
  }
  seed?.(new TenantStore(env))
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  const ingress = new LocalIngress({
    rbac,
    tenants,
    env,
    externalReplays: new ExternalLoginReplayStore(database),
  })
  const app = buildApp({
    ...owned,
    rbac,
    tenants,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    provider: new DoubleProvider(),
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    maxPortalAliases: 3,
  })
  const request = (host: string, path: string, init: RequestInit = {}, operator = false) => {
    const headers = new Headers(init.headers)
    if (operator) headers.set('authorization', `Operator ${operatorKey}`)
    return ingress.handle(
      new Request(`http://${host}${path}`, { ...init, headers }),
      (clean) => app.fetch(clean),
    )
  }
  return {
    env,
    rbac,
    ingress,
    request,
    events: () => rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }),
    dispose() {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

Deno.test('the local server manages portal host aliases through the operator routes', async () => {
  const f = fixture()
  try {
    let response = await f.request(
      'localhost',
      '/api/admin/t/marine/aliases/Research.Example.org.',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"primary":true}' },
      true,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      aliases: [{ hostname: 'research.example.org', primary: true, createdAt: expect.any(String) }],
      hostname: 'research.example.org',
    })
    // Written to the registry file, where a restarted server finds it.
    expect(new TenantStore(f.env).aliasPortal('research.example.org')).toBe('marine')
    response = await f.request('localhost', '/api/admin/t/grains/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'hostname_taken' })
    for (const name of ['two', 'three']) {
      await f.request('localhost', `/api/admin/t/marine/aliases/${name}.example.org`, {
        method: 'PUT',
      }, true)
    }
    response = await f.request('localhost', '/api/admin/t/marine/aliases/four.example.org', {
      method: 'PUT',
    }, true)
    expect(await response.json()).toEqual({ error: 'alias_limit' })
    response = await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'DELETE',
    }, true)
    expect(response.status).toBe(200)
    expect((await response.json()).hostname).toBe('marine.corpuskit.org')
    const actions = f.events().filter((event) => event.action.startsWith('portal.alias.'))
    expect(actions.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(actions.some((event) => event.action === 'portal.alias.remove')).toBe(true)
  } finally {
    f.dispose()
  }
})

Deno.test('the local server serves an alias host as the Worker does', async () => {
  const f = fixture()
  try {
    await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    const host = 'research.example.org'
    let response = await f.request(host, '/?x=1')
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine?x=1')
    expect(f.ingress.hostPortal(new Request(`http://${host}/t/marine`))).toBe('marine')
    expect(f.ingress.hostPortal(new Request('http://localhost/t/marine'))).toBeUndefined()

    response = await f.request(host, '/api/t/marine/config')
    expect(response.status).toBe(200)
    response = await f.request(host, '/api/tenants')
    expect((await response.json()).map((row: { slug: string }) => row.slug)).toEqual(['marine'])
    for (
      const path of [
        '/api/t/grains/config',
        '/api/admin/overview',
        '/api/admin/t/marine/lifecycle',
        '/api/admin/t/marine/aliases',
      ]
    ) {
      response = await f.request(host, path, {
        headers: { 'x-admin-passcode': 'fixture-passcode' },
      })
      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    for (const path of ['/t/grains', '/about', '/admin', '/docs/']) {
      expect((await f.request(host, path)).status, path).toBe(404)
    }
    response = await f.request(host, '/auth/me?portal=grains')
    expect((await response.json()).portalAccess).toBeNull()

    // Operator credentials are refused on the alias host and audited as the operator.
    response = await f.request(host, '/api/admin/t/marine/aliases', {}, true)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
    expect(
      f.events().some((event) =>
        event.action === 'request.denied' && event.actor_id === 'operator:hosting-test' &&
        JSON.parse(event.detail_json).code === 'operator_not_allowed'
      ),
    ).toBe(true)
    // Other hosts are unchanged.
    expect((await f.request('localhost', '/api/t/grains/config')).status).toBe(200)
    expect((await f.request('other.example.org', '/api/t/grains/config')).status).toBe(200)
  } finally {
    f.dispose()
  }
})

Deno.test('the local server seals an alias host session to that host', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const f = fixture({
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    SESSION_SECRET: 'local-alias-session-secret-longer-than-32-bytes',
  })
  try {
    await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    const issue = async (host: string) => {
      const response = await f.request(
        host,
        `/auth/external?assertion=${await assertion(pair.privateKey, {
          host,
        })}&returnTo=/t/marine`,
      )
      expect(response.status).toBe(303)
      expect(response.headers.get('set-cookie')).not.toContain('Domain=')
      return response.headers.get('set-cookie')!.split(';')[0]!
    }
    const signedIn = async (host: string, cookie: string) =>
      (await (await f.request(host, '/auth/me', { headers: { cookie } })).json()).authenticated
    const alias = await issue('research.example.org')
    expect(await signedIn('research.example.org', alias)).toBe(true)
    expect(await signedIn('localhost', alias)).toBe(false)
    const local = await issue('localhost')
    expect(await signedIn('localhost', local)).toBe(true)
    expect(await signedIn('research.example.org', local)).toBe(false)
    expect((await (await f.request('research.example.org', '/auth/me')).json()).entraEnabled)
      .toBe(false)
  } finally {
    f.dispose()
  }
})

Deno.test('the local server seals unknown-host sessions, denies unknown hosts and narrows roles', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const issuer = {
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    SESSION_SECRET: 'local-alias-session-secret-longer-than-32-bytes',
  }
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (message: string) => warnings.push(message)
  const f = fixture(issuer)
  console.warn = warn
  try {
    expect(warnings.some((message) => message.includes('EXTERNAL_LOGIN_REQUIRE_HOST'))).toBe(true)
    const handoff = (host: string, claims: Record<string, unknown> = { host }) =>
      assertion(pair.privateKey, claims).then((token) =>
        f.request(host, `/auth/external?assertion=${token}`)
      )
    const signedIn = async (host: string, cookie: string) =>
      (await (await f.request(host, '/auth/me', { headers: { cookie } })).json()).authenticated
    // An unknown host: host-less assertions are refused, and its sessions are sealed to it.
    expect((await handoff('pending.example.net', {})).status).toBe(401)
    const pending = await handoff('pending.example.net')
    expect(pending.status).toBe(303)
    const cookie = pending.headers.get('set-cookie')!.split(';')[0]!
    expect(await signedIn('pending.example.net', cookie)).toBe(true)
    expect(await signedIn('corpuskit.org', cookie)).toBe(false)
    // Local development hosts do not need the claim.
    expect((await handoff('localhost', {})).status).toBe(303)

    // Roles described on an alias host are that portal's only.
    const assignments = f.rbac.assignmentService('tenant-1', 'corpuskit', true)
    for (const [slug, role] of [['marine', 'viewer'], ['grains', 'portal-admin']] as const) {
      assignments.create({
        subjectKind: 'pending-email',
        subjectId: 'reader@example.test',
        source: 'external',
        scope: { kind: 'portal', slug },
        role,
      }, { requestId: `grant-${slug}`, actor: { kind: 'system' } })
    }
    await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    const aliasCookie = (await handoff('research.example.org')).headers.get('set-cookie')!
      .split(';')[0]!
    const me = await (await f.request('research.example.org', '/auth/me?portal=marine', {
      headers: { cookie: aliasCookie },
    })).json()
    expect(me.effectiveRoles).toEqual({ portalRoles: [{ slug: 'marine', role: 'viewer' }] })
    expect(me.provenance.map((entry: { scope: { slug: string } }) => entry.scope.slug))
      .toEqual(['marine'])
  } finally {
    f.dispose()
  }
  const g = fixture({ UNKNOWN_HOSTS: 'deny', RESERVED_HOSTNAMES: 'localhost' })
  try {
    for (const path of ['/', '/api/t/grains/config', '/auth/me']) {
      const response = await g.request('pending.example.net', path)
      expect(response.status, path).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    // Reserved hosts, including the local one here, still answer.
    expect((await g.request('localhost', '/api/t/grains/config')).status).toBe(200)
    await g.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    expect((await g.request('research.example.org', '/')).status).toBe(308)
    // A reserved hostname cannot be registered.
    const reserved = await g.request('localhost', '/api/admin/t/marine/aliases/localhost', {
      method: 'PUT',
    }, true)
    expect(reserved.status).toBe(400)
  } finally {
    g.dispose()
  }
})

Deno.test('the local server narrows a reserved host by its alias record and warns at start-up', async () => {
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (message: string) => warnings.push(message)
  let f: ReturnType<typeof fixture>
  try {
    f = fixture(
      { RESERVED_HOSTNAMES: 'shared.example.org' },
      (tenants) => expect(tenants.setAlias('marine', 'shared.example.org', true, 5).ok).toBe(true),
    )
  } finally {
    console.warn = warn
  }
  try {
    expect(warnings.some((message) => message.includes('shared.example.org'))).toBe(true)
    expect(warnings.some((message) => message.includes('UNKNOWN_HOSTS is serve'))).toBe(true)
    expect((await (await f.request('localhost', '/api/t/marine/config')).json()).hostname)
      .toBe('marine.corpuskit.org')
    expect((await f.request('shared.example.org', '/api/t/grains/config')).status).toBe(404)
    expect((await f.request('shared.example.org', '/api/t/marine/config')).status).toBe(200)
    const operator = await f.request('shared.example.org', '/api/admin/t/marine/aliases', {}, true)
    expect(operator.status).toBe(403)
  } finally {
    f.dispose()
  }
  const quiet: string[] = []
  console.warn = (message: string) => quiet.push(message)
  try {
    fixture({ UNKNOWN_HOSTS: 'deny' }).dispose()
  } finally {
    console.warn = warn
  }
  expect(quiet.some((message) => message.includes('UNKNOWN_HOSTS is serve'))).toBe(false)
})

async function assertion(key: CryptoKey, extra: Record<string, unknown> = {}): Promise<string> {
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const now = Math.floor(Date.now() / 1000)
  const content = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${
    part({
      iss: 'https://issuer.example',
      aud: 'corpuskit',
      sub: 'reader-1',
      email: 'reader@example.test',
      email_verified: true,
      iat: now - 5,
      exp: now + 60,
      jti: crypto.randomUUID(),
      ...extra,
    })
  }`
  return `${content}.${
    encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(content))))
  }`
}
