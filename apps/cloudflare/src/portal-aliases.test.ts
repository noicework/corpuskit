/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { DurableState, type DurableStores } from './state.ts'
import {
  PRINCIPAL_HEADER,
  signPrincipal,
  type TrustedSessionFacts,
} from '../../api/src/principal.ts'
import type { PortalDurableObject } from './worker.ts'

const operatorKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const sessionSecret = 'alias-test-session-secret-longer-than-thirty-two-bytes'
const SHELL =
  '<head><meta name="corpuskit-platform-domain" content="__CORPUSKIT_PLATFORM_DOMAIN__">' +
  '<meta name="corpuskit-host-portal" content="__CORPUSKIT_HOST_PORTAL__"></head>'
const domainCalls: string[] = []
;(globalThis as { __aliasDomainCalls?: string[] }).__aliasDomainCalls = domainCalls
const workerModule = await loadWorker()

type WorkerModule = {
  PortalDurableObject: typeof PortalDurableObject
  default: { fetch(request: Request, env: Env): Promise<Response> }
}

async function fixture(overrides: Record<string, string | undefined> = {}) {
  const database = new DatabaseSync(':memory:')
  const storage: DurableObjectState['storage'] = {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        if (!bindings.length && !/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
          database.exec(query)
          return {
            toArray: () => [],
            one: (): T => {
              throw new Error('No rows')
            },
          }
        }
        const statement = database.prepare(query)
        const parameters = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value
        ) as SQLInputValue[]
        const rows = statement.columns().length
          ? statement.all(...parameters) as T[]
          : (statement.run(...parameters), [])
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error('Expected one row')
            return rows[0]!
          },
        }
      },
    },
    transactionSync<T>(callback: () => T): T {
      database.exec('BEGIN IMMEDIATE')
      try {
        const value = callback()
        database.exec('COMMIT')
        return value
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  const assets: string[] = []
  const lookups: string[] = []
  const env = {
    WORKER_NAME: 'corpuskit',
    SESSION_SECRET: sessionSecret,
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-automation',
    BINDING_KEY: btoa('alias-fixture-binding-key-32byte'),
    ENTRA_TENANT_ID: 'tenant-1',
    ENTRA_CLIENT_ID: 'client-1',
    ENTRA_CLIENT_SECRET: 'client-secret',
    ENTRA_REDIRECT_URI: 'https://corpuskit.org/auth/callback',
    ENVIRONMENT: 'production',
    ADMIN_BREAK_GLASS: 'true',
    ADMIN_PASSCODE: 'fixture-passcode',
    RATE_LIMIT_ASK_PER_MIN: '0',
    RATE_LIMIT_ESTATE_PER_MIN: '0',
    // Most tests register and remove aliases between requests, so the edge keeps no answers.
    ALIAS_CACHE_SECONDS: '0',
    CF_VERSION_METADATA: { id: 'fixture', tag: 'fixture' },
    ASSETS: {
      fetch: (request: Request) => {
        const path = new URL(request.url).pathname
        assets.push(`${new URL(request.url).hostname}${path}`)
        return Promise.resolve(
          path.endsWith('.js')
            ? new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
            : new Response(SHELL, { headers: { 'content-type': 'text/html' } }),
        )
      },
    },
    PORTAL: { getByName: () => object },
    ...overrides,
  } as unknown as Env
  let initialization: Promise<unknown> = Promise.resolve()
  const object = new workerModule.PortalDurableObject({
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const pending = callback()
      initialization = pending
      return pending
    },
  }, env)
  await initialization
  const resolve = object.resolveHostPortal.bind(object)
  object.resolveHostPortal = (hostname: string) => {
    lookups.push(hostname)
    return resolve(hostname)
  }
  const state = new DurableState(storage.sql, storage)
  const stores = (object as unknown as { stores: DurableStores }).stores
  const bootstrap = new Set(
    state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }).map((event) => event.id),
  )
  const request = (
    host: string,
    path: string,
    init: RequestInit = {},
    authorization?: string,
  ) => {
    const headers = new Headers(init.headers)
    if (authorization) headers.set('authorization', authorization)
    if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.1')
    return workerModule.default.fetch(
      new Request(`https://${host}${path}`, { ...init, headers }),
      env,
    )
  }
  return {
    env,
    object,
    stores,
    assets,
    lookups,
    events: () =>
      state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
        .filter((event) => !bootstrap.has(event.id)),
    /** A hosting operator call on the platform domain. */
    operator: (path: string, init: RequestInit = {}) =>
      request('corpuskit.org', path, init, `Operator ${operatorKey}`),
    /** A request on any host, anonymous unless headers say otherwise. */
    request,
    close: () => database.close(),
  }
}

const body = (method: string, value?: unknown): RequestInit =>
  value === undefined ? { method } : {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  }
const passcode = { headers: { 'x-admin-passcode': 'fixture-passcode' } }
const hostPortalMeta = (html: string) =>
  /<meta name="corpuskit-host-portal" content="([^"]*)">/.exec(html)?.[1]

Deno.test('operators register, list, promote and remove portal host aliases', async () => {
  const f = await fixture()
  try {
    const created = await f.operator('/api/admin/tenants', body('POST', { name: 'Acme Research' }))
    expect(created.status).toBe(200)
    const { slug } = await created.json()
    expect(slug).toBe('acme-research')
    const platformHost = 'acme-research.corpuskit.org'
    const aliases = `/api/admin/t/${slug}/aliases`
    const config = async () =>
      (await (await f.request('corpuskit.org', `/api/t/${slug}/config`)).json()).hostname
    const summary = async () =>
      ((await (await f.request('corpuskit.org', '/api/tenants')).json()) as {
        slug: string
        hostname?: string
      }[]).find((row) => row.slug === slug)?.hostname

    let response = await f.operator(aliases)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ aliases: [], hostname: platformHost })

    response = await f.operator(`${aliases}/research.example.org`, body('PUT'))
    expect(response.status).toBe(200)
    const first = await response.json()
    expect(first).toEqual({
      ok: true,
      aliases: [{
        hostname: 'research.example.org',
        primary: false,
        createdAt: expect.any(String),
      }],
      hostname: platformHost,
    })
    // Idempotent: the same PUT again returns the same record.
    response = await f.operator(`${aliases}/research.example.org`, body('PUT', {}))
    expect(await response.json()).toEqual(first)

    // Normalised, then promoted: the alias becomes the canonical hostname everywhere.
    response = await f.operator(`${aliases}/Docs.Example.ORG.`, body('PUT', { primary: true }))
    expect(response.status).toBe(200)
    expect((await response.json()).hostname).toBe('docs.example.org')
    expect(await config()).toBe('docs.example.org')
    expect(await summary()).toBe('docs.example.org')

    // One primary at a time.
    response = await f.operator(`${aliases}/research.example.org`, body('PUT', { primary: true }))
    const promoted = await response.json()
    expect(promoted.hostname).toBe('research.example.org')
    expect(promoted.aliases.filter((alias: { primary: boolean }) => alias.primary)).toEqual([
      { hostname: 'research.example.org', primary: true, createdAt: first.aliases[0].createdAt },
    ])
    // Clearing the primary flag reverts to the automatic platform hostname.
    response = await f.operator(`${aliases}/research.example.org`, body('PUT', { primary: false }))
    expect((await response.json()).hostname).toBe(platformHost)
    expect(await config()).toBe(platformHost)

    // Deleting the primary alias reverts too.
    await f.operator(`${aliases}/docs.example.org`, body('PUT', { primary: true }))
    response = await f.operator(`${aliases}/docs.example.org`, body('DELETE'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      aliases: [first.aliases[0]],
      hostname: platformHost,
    })
    // Removing a hostname the portal does not have is still a success.
    response = await f.operator(`${aliases}/absent.example.org`, body('DELETE'))
    expect(response.status).toBe(200)
    expect((await response.json()).aliases).toEqual([first.aliases[0]])

    const audited = f.events().filter((event) => event.action.startsWith('portal.alias.'))
    expect(audited.length).toBeGreaterThan(0)
    for (const event of audited) {
      expect(event.actor_kind).toBe('operator')
      expect(event.actor_id).toBe('operator:hosting-automation')
      expect(event.scope_kind).toBe('platform')
      expect(event.target_kind).toBe('portal')
      expect(event.target_id).toBe(slug)
    }
    const details = audited.filter((event) => event.outcome === 'success').map((event) => [
      event.action,
      JSON.parse(event.detail_json),
    ])
    expect(details).toContainEqual([
      'portal.alias.set',
      { permission: 'portal.create', aliasHostname: 'docs.example.org', aliasPrimary: true },
    ])
    expect(details).toContainEqual([
      'portal.alias.remove',
      { permission: 'portal.create', aliasHostname: 'docs.example.org', aliasPrimary: true },
    ])
    expect(details).toContainEqual([
      'portal.alias.remove',
      { permission: 'portal.create', aliasHostname: 'absent.example.org', aliasPrimary: false },
    ])
  } finally {
    f.close()
  }
})

Deno.test('alias routes refuse invalid names, unknown portals, taken names and excess', async () => {
  const f = await fixture({ MAX_PORTAL_ALIASES: '2' })
  try {
    for (
      const hostname of [
        'localhost',
        '192.0.2.1',
        '127.0.0.0x1',
        'example.123',
        '%5B%3A%3A1%5D',
        'example.org:8443',
        '%2A.example.org',
        'example.org%2Fpath',
        'xn--bcher-kva.example',
        'b%C3%BCcher.example',
        'corpuskit.org',
        'marine.corpuskit.org',
        'MARINE.CORPUSKIT.ORG.',
        'corpuskit.account.workers.dev',
        'a..b.org',
        'a_b.example.org',
        `${'a'.repeat(64)}.example.org`,
      ]
    ) {
      for (const method of ['PUT', 'DELETE']) {
        const response = await f.operator(`/api/admin/t/marine/aliases/${hostname}`, body(method))
        expect(response.status, `${method} ${hostname}`).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_hostname' })
      }
    }
    for (
      const [method, path] of [
        ['GET', '/api/admin/t/missing/aliases'],
        ['PUT', '/api/admin/t/missing/aliases/research.example.org'],
        ['DELETE', '/api/admin/t/missing/aliases/research.example.org'],
      ]
    ) {
      const response = await f.operator(path!, body(method!))
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(await response.json()).toEqual({ error: 'unknown_tenant' })
    }
    for (const value of ['{"primary":"yes"}', '{"primary":true,"extra":1}', 'not json', '[]']) {
      const response = await f.operator(
        '/api/admin/t/marine/aliases/research.example.org',
        body('PUT', value),
      )
      expect(response.status, value).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }

    expect(
      (await f.operator('/api/admin/t/marine/aliases/research.example.org', body('PUT'))).status,
    ).toBe(200)
    for (const hostname of ['research.example.org', 'Research.Example.org.']) {
      const response = await f.operator(`/api/admin/t/grains/aliases/${hostname}`, body('PUT'))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'hostname_taken' })
    }
    // Another portal's DELETE never removes it.
    expect(
      (await f.operator('/api/admin/t/grains/aliases/research.example.org', body('DELETE')))
        .status,
    ).toBe(200)
    expect(await f.object.resolveHostPortal('research.example.org')).toBe('marine')

    expect(
      (await f.operator('/api/admin/t/marine/aliases/second.example.org', body('PUT'))).status,
    ).toBe(200)
    let response = await f.operator('/api/admin/t/marine/aliases/third.example.org', body('PUT'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'alias_limit' })
    // Updating an existing alias is not limited.
    response = await f.operator(
      '/api/admin/t/marine/aliases/second.example.org',
      body('PUT', { primary: true }),
    )
    expect(response.status).toBe(200)

    // A refused registration is still audited, as a failure.
    const refused = f.events().filter((event) =>
      event.action === 'portal.alias.set' && event.outcome === 'failure'
    )
    expect(refused.map((event) => [event.target_id, JSON.parse(event.detail_json).aliasHostname]))
      .toEqual(expect.arrayContaining([
        ['grains', 'research.example.org'],
        ['marine', 'third.example.org'],
      ]))
  } finally {
    f.close()
  }
})

Deno.test('concurrent registrations admit exactly one portal and respect the limit', async () => {
  const f = await fixture({ MAX_PORTAL_ALIASES: '1' })
  try {
    const race = await Promise.all(
      ['marine', 'grains'].map((slug) =>
        f.operator(`/api/admin/t/${slug}/aliases/contested.example.org`, body('PUT'))
      ),
    )
    expect(race.map((response) => response.status).sort()).toEqual([200, 409])
    const winner = race[0]!.status === 200 ? 'marine' : 'grains'
    expect(await f.object.resolveHostPortal('contested.example.org')).toBe(winner)
    const loser = winner === 'marine' ? 'grains' : 'marine'
    expect(f.stores.tenants.portalAliases(loser)).toEqual([])

    const limit = await Promise.all(
      ['one', 'two'].map((name) =>
        f.operator(`/api/admin/t/${loser}/aliases/${name}.example.org`, body('PUT'))
      ),
    )
    expect(limit.map((response) => response.status).sort()).toEqual([200, 409])
    expect(f.stores.tenants.portalAliases(loser)).toHaveLength(1)
  } finally {
    f.close()
  }
})

Deno.test('an alias host serves its own portal and nothing else', async () => {
  const f = await fixture()
  try {
    await f.operator('/api/admin/t/marine/aliases/research.example.org', body('PUT'))
    const host = 'research.example.org'

    let response = await f.request(host, '/?from=card')
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine?from=card')
    response = await f.request(host, '/', { method: 'HEAD' })
    expect(response.headers.get('location')).toBe('/t/marine')

    response = await f.request(host, '/t/marine/library')
    expect(response.status).toBe(200)
    const shell = await response.text()
    expect(hostPortalMeta(shell)).toBe('marine')
    expect(shell).toContain('content="corpuskit.org"')
    response = await f.request(host, '/app.js')
    expect(response.status).toBe(200)

    for (const path of ['/t/grains', '/t/grains/library', '/about', '/docs/', '/admin', '/home']) {
      const before = f.assets.length
      response = await f.request(host, path)
      expect(response.status, path).toBe(404)
      expect(await response.text()).toBe('Not found')
      expect(f.assets.length, path).toBe(before)
    }

    response = await f.request(host, '/api/t/marine/config')
    expect(response.status).toBe(200)
    expect((await response.json()).slug).toBe('marine')
    response = await f.request(host, '/api/tenants')
    expect((await response.json()).map((row: { slug: string }) => row.slug)).toEqual(['marine'])
    expect((await f.request(host, '/api/health')).status).toBe(200)

    // Other portals and platform-scope routes are not found, even for an owner.
    for (
      const [method, path] of [
        ['GET', '/api/t/grains/config'],
        ['GET', '/api/t/grains/search?q=wheat'],
        ['GET', '/api/admin/t/grains/members'],
        ['GET', '/api/admin/overview'],
        ['GET', '/api/admin/people'],
        ['POST', '/api/admin/tenants'],
        ['POST', '/api/ask-estate'],
        ['GET', '/api/admin/t/marine/lifecycle'],
        ['GET', '/api/admin/t/marine/usage'],
        ['GET', '/api/admin/t/marine/aliases'],
        ['DELETE', '/api/admin/t/marine/aliases/research.example.org'],
        ['DELETE', '/api/admin/tenants/marine'],
        ['PATCH', '/api/admin/tenants/grains'],
      ] as const
    ) {
      response = await f.request(host, path, { method, ...passcode })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    // Portal-scoped administration the SPA needs still works on the alias host.
    response = await f.request(host, '/api/admin/t/marine/members', passcode)
    expect(response.status).toBe(200)
    response = await f.request(host, '/api/admin/tenants/marine', {
      method: 'PATCH',
      headers: { ...passcode.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ tagline: 'Research on this host' }),
    })
    expect(response.status).toBe(200)
    expect(f.stores.tenants.get('marine')?.branding.tagline).toBe('Research on this host')

    // An alias is often a customer's apex, so its answers never force HTTPS on its subdomains.
    for (const path of ['/', '/t/marine', '/t/grains', '/api/t/marine/config', '/api/t/grains/x']) {
      response = await f.request(host, path)
      await response.body?.cancel()
      expect(response.headers.get('strict-transport-security'), path).toBe('max-age=63072000')
    }
    response = await f.request('corpuskit.org', '/api/t/marine/config')
    await response.body?.cancel()
    expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains')
    expect(await f.object.resolveHostPortal(host)).toBe('marine')

    // The platform host keeps serving every portal.
    expect((await f.request('corpuskit.org', '/api/t/grains/config')).status).toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('operator credentials are refused on an alias host, whatever the view of the edge', async () => {
  const f = await fixture()
  try {
    await f.operator('/api/admin/t/marine/aliases/research.example.org', body('PUT'))
    for (
      const [method, path] of [
        ['GET', '/api/admin/t/marine/aliases'],
        ['GET', '/api/admin/t/marine/members'],
        ['GET', '/api/admin/t/marine/lifecycle'],
        ['POST', '/api/admin/tenants'],
        ['GET', '/'],
        ['GET', '/auth/me'],
      ] as const
    ) {
      const seen = new Set(f.events().map((event) => event.id))
      const response = await f.request(
        'research.example.org',
        path,
        { method },
        `Operator ${operatorKey}`,
      )
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
      const denied = f.events().find((event) =>
        !seen.has(event.id) && event.action === 'request.denied'
      )
      expect(denied?.actor_id).toBe('operator:hosting-automation')
      expect(JSON.parse(denied!.detail_json).code).toBe('operator_not_allowed')
    }
    const wrong = await f.request(
      'research.example.org',
      '/api/admin/t/marine/aliases',
      {},
      `Operator ${'B'.repeat(43)}`,
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'invalid_operator' })
    // The same key keeps working on the platform host.
    expect((await f.operator('/api/admin/t/marine/aliases')).status).toBe(200)

    // The Durable Object refuses on its own record, even when the edge has not seen the alias.
    const principal = await signPrincipal({
      v: 1,
      kind: 'operator',
      aud: 'corpuskit',
      id: 'hosting-automation',
      iat: Math.floor(Date.now() / 1000),
    }, sessionSecret)
    const direct = await f.object.handleTrustedRequest(
      new Request('https://research.example.org/api/admin/t/marine/lifecycle', {
        headers: { [PRINCIPAL_HEADER]: principal },
      }),
      { session: null },
    )
    expect(direct.status).toBe(403)
    expect(await direct.json()).toEqual({ error: 'operator_not_allowed' })
  } finally {
    f.close()
  }
})

Deno.test('alias hosts keep sessions host-only, redirects on the host and Entra off', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  const f = await fixture({
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: jwk,
    EXTERNAL_LOGIN_START_URL: 'https://issuer.example/start',
  })
  try {
    await f.operator('/api/admin/t/marine/aliases/research.example.org', body('PUT'))
    const host = 'research.example.org'
    let response = await f.request(host, '/auth/logout')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('set-cookie')).not.toContain('Domain=')
    // The platform host keeps its shared cookie scope.
    response = await f.request('corpuskit.org', '/auth/logout')
    expect(response.headers.get('set-cookie')).toContain('Domain=corpuskit.org')

    for (
      const [returnTo, location] of [
        ['/t/marine/library', '/t/marine/library'],
        ['https://evil.example/steal', '/'],
        ['//evil.example/steal', '/'],
        ['/\\evil.example', '/'],
        ['https://corpuskit.org/t/grains', '/'],
      ]
    ) {
      response = await f.request(
        host,
        `/auth/external?assertion=${await assertion(pair.privateKey)}&returnTo=${
          encodeURIComponent(returnTo!)
        }`,
      )
      expect(response.status, returnTo).toBe(303)
      expect(response.headers.get('location'), returnTo).toBe(location)
      const cookie = response.headers.get('set-cookie')!
      expect(cookie).toContain('__Secure-corpuskit_session=')
      expect(cookie).not.toContain('Domain=')
    }

    // Entra sign-in is not offered on the alias host; the external button is.
    response = await f.request(host, '/auth/login')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'microsoft_sign_in_not_configured' })
    response = await f.request(host, '/auth/me?portal=marine')
    const me = await response.json()
    expect(me.entraEnabled).toBe(false)
    expect(me.externalLoginEnabled).toBe(true)
    expect(me.enabled).toBe(true)
    expect(me.portalAccess.slug).toBe('marine')
    expect((await (await f.request('corpuskit.org', '/auth/me')).json()).entraEnabled).toBe(true)
    // It answers for its own portal only.
    response = await f.request(host, '/auth/me?portal=grains')
    expect((await response.json()).portalAccess).toBeNull()

    // A session issued on the alias host is read there and nowhere else, so a cookie taken from
    // the alias host is worthless on the platform host or another portal's alias.
    await f.operator('/api/admin/t/grains/aliases/other.example.org', body('PUT'))
    const issue = async (on: string) =>
      (await f.request(on, `/auth/external?assertion=${await assertion(pair.privateKey)}`))
        .headers.get('set-cookie')!.split(';')[0]!
    const aliasSession = await issue(host)
    const signedIn = async (on: string, cookie: string) =>
      (await (await f.request(on, '/auth/me', { headers: { cookie } })).json()).authenticated
    expect(await signedIn(host, aliasSession)).toBe(true)
    expect(await signedIn('corpuskit.org', aliasSession)).toBe(false)
    expect(await signedIn('marine.corpuskit.org', aliasSession)).toBe(false)
    expect(await signedIn('other.example.org', aliasSession)).toBe(false)
    expect(await signedIn('unlisted.example.net', aliasSession)).toBe(false)
    const platformSession = await issue('corpuskit.org')
    expect(await signedIn('corpuskit.org', platformSession)).toBe(true)
    expect(await signedIn(host, platformSession)).toBe(false)

    // An Entra session cookie is not read on the alias host.
    const cookie = await entraCookie()
    const platform = await (await f.request('corpuskit.org', '/auth/me', {
      headers: { cookie },
    })).json()
    expect(platform.authenticated).toBe(true)
    const alias = await (await f.request(host, '/auth/me', { headers: { cookie } })).json()
    expect(alias.authenticated).toBe(false)
  } finally {
    f.close()
  }
})

Deno.test('Entra is offered on an alias host only when its redirect URI is on that host', async () => {
  const f = await fixture({ ENTRA_REDIRECT_URI: 'https://research.example.org/auth/callback' })
  try {
    await f.operator('/api/admin/t/marine/aliases/research.example.org', body('PUT'))
    await f.operator('/api/admin/t/grains/aliases/other.example.org', body('PUT'))
    expect((await (await f.request('research.example.org', '/auth/me')).json()).entraEnabled)
      .toBe(true)
    expect((await (await f.request('other.example.org', '/auth/me')).json()).entraEnabled)
      .toBe(false)
  } finally {
    f.close()
  }
})

Deno.test('hosts that are not registered aliases keep exactly their behaviour', async () => {
  const configured = ['wrangler.jsonc', 'wrangler.demo.jsonc'].flatMap((file) =>
    (JSON.parse(Deno.readTextFileSync(new URL(`../../../${file}`, import.meta.url))) as {
      routes?: { pattern: string; custom_domain?: boolean }[]
    }).routes?.filter((route) => route.custom_domain).map((route) => route.pattern) ?? []
  )
  // Every host the deployment configurations route here, plus unlisted and direct hosts.
  const hosts = [
    ...new Set([
      ...configured,
      'demo.corpuskit.org',
      'acmd.corpuskit.org',
      'corpuskit.account.workers.dev',
      'unlisted.example.net',
    ]),
  ]
  expect(hosts).toEqual(expect.arrayContaining(['corpuskit.org', 'www.corpuskit.org']))
  expect(hosts.length).toBeGreaterThan(6)
  const requests: [string, string][] = [
    ['GET', '/'],
    ['GET', '/?from=card'],
    ['GET', '/t/marine'],
    ['GET', '/t/grains/library'],
    ['GET', '/t/demo'],
    ['GET', '/about'],
    ['GET', '/docs/'],
    ['GET', '/admin'],
    ['GET', '/app.js'],
    ['GET', '/.env'],
    ['POST', '/'],
    ['GET', '/api/health'],
    ['GET', '/api/tenants'],
    ['GET', '/api/t/grains/config'],
    ['GET', '/api/t/marine/config'],
    ['GET', '/api/admin/t/marine/aliases'],
    ['GET', '/auth/me?portal=grains'],
    ['GET', '/auth/logout'],
  ]
  const observe = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const seen: unknown[] = []
    for (const host of hosts) {
      for (const [method, path] of requests) {
        const response = await f.request(host, path, { method })
        const text = await response.text()
        seen.push({
          host,
          method,
          path,
          status: response.status,
          location: response.headers.get('location'),
          cookie: response.headers.get('set-cookie'),
          type: response.headers.get('content-type'),
          transport: response.headers.get('strict-transport-security'),
          body: text,
        })
        expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains')
        if (text.includes('corpuskit-host-portal')) expect(hostPortalMeta(text)).toBe('')
      }
    }
    return seen
  }
  const plain = await fixture()
  const aliased = await fixture()
  try {
    for (
      const [slug, hostname] of [['marine', 'research.example.org'], [
        'grains',
        'grain.example.com',
      ]]
    ) {
      expect(
        (await aliased.operator(`/api/admin/t/${slug}/aliases/${hostname}`, body('PUT'))).status,
      ).toBe(200)
    }
    aliased.lookups.length = 0
    expect(await observe(aliased)).toEqual(await observe(plain))
    // Platform hosts are never looked up; other hosts are, and are not aliases.
    const platformHosts = hosts.filter((host) =>
      host === 'corpuskit.org' || host.endsWith('.corpuskit.org')
    )
    expect(platformHosts.length).toBeGreaterThan(3)
    expect(aliased.lookups.filter((host) => platformHosts.includes(host))).toEqual([])
    expect(new Set(aliased.lookups)).toEqual(
      new Set(hosts.filter((host) => !platformHosts.includes(host) && !host.endsWith('.dev'))),
    )
  } finally {
    plain.close()
    aliased.close()
  }
})

Deno.test('deleting a portal removes its aliases, detaches only its own hostname and frees the names', async () => {
  const f = await fixture()
  try {
    const { slug } = await (await f.operator(
      '/api/admin/tenants',
      body('POST', { name: 'Gone Portal' }),
    )).json()
    await f.operator(
      `/api/admin/t/${slug}/aliases/gone.example.org`,
      body('PUT', { primary: true }),
    )
    await f.operator(`/api/admin/t/${slug}/aliases/also-gone.example.org`, body('PUT'))
    expect((await f.request('gone.example.org', '/')).headers.get('location')).toBe(`/t/${slug}`)
    domainCalls.length = 0
    const removed = await f.request('corpuskit.org', `/api/admin/tenants/${slug}`, {
      method: 'DELETE',
      ...passcode,
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({
      ok: true,
      domain: { status: 'removed', hostname: `${slug}.corpuskit.org` },
    })
    expect(domainCalls).toEqual([`detach ${slug}.corpuskit.org`])
    for (const hostname of ['gone.example.org', 'also-gone.example.org']) {
      expect(await f.object.resolveHostPortal(hostname)).toBeNull()
      // The host is now an ordinary unregistered host again.
      const response = await f.request(hostname, '/')
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
    }
    expect(f.stores.tenants.portalAliases(slug)).toEqual([])
    expect(
      (await f.operator('/api/admin/t/grains/aliases/gone.example.org', body('PUT'))).status,
    ).toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('a stale edge lookup narrows requests and never serves another portal', async () => {
  const f = await fixture({ ALIAS_CACHE_SECONDS: '30' })
  try {
    const host = 'stale.example.org'
    await f.operator('/api/admin/t/marine/aliases/stale.example.org', body('PUT'))
    expect((await f.request(host, '/')).headers.get('location')).toBe('/t/marine')
    const lookups = f.lookups.length
    // Moved to another portal at once, against the documented waiting period.
    await f.operator('/api/admin/t/marine/aliases/stale.example.org', body('DELETE'))
    await f.operator('/api/admin/t/grains/aliases/stale.example.org', body('PUT'))
    // The edge still remembers the old portal for up to ALIAS_CACHE_SECONDS...
    expect((await f.request(host, '/')).headers.get('location')).toBe('/t/marine')
    expect(f.lookups.length).toBe(lookups)
    // ...but neither portal's data is served on the host until it forgets.
    for (const path of ['/api/t/marine/config', '/api/t/grains/config']) {
      const response = await f.request(host, path)
      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }

    // A host remembered as unregistered is narrowed by the Durable Object's own record.
    const fresh = 'fresh.example.org'
    expect((await f.request(fresh, '/')).headers.get('location')).toBeNull()
    await f.operator('/api/admin/t/grains/aliases/fresh.example.org', body('PUT'))
    expect((await f.request(fresh, '/')).headers.get('location')).toBeNull()
    expect((await f.request(fresh, '/api/t/marine/config')).status).toBe(404)
    expect(
      (await (await f.request(fresh, '/api/tenants')).json()).map((row: { slug: string }) =>
        row.slug
      ),
    ).toEqual(['grains'])
  } finally {
    f.close()
  }
})

Deno.test('a lookup that does not answer leaves hosts as they were within a second', async () => {
  const f = await fixture({ ALIAS_CACHE_SECONDS: '30' })
  const error = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]) => logged.push(args)
  try {
    f.object.resolveHostPortal = () => new Promise(() => {})
    for (const attempt of [1, 2]) {
      const started = Date.now()
      const response = await f.request('slow-lookup.example.net', '/', {})
      const elapsed = Date.now() - started
      expect(response.status, `attempt ${attempt}`).toBe(200)
      expect(await response.text()).toContain('corpuskit-host-portal" content=""')
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(3000)
    }
    // A timed-out lookup is not remembered, so the next request asks again.
    expect(logged).toEqual([['Portal host lookup failed'], ['Portal host lookup failed']])
    // Platform hosts never wait on a lookup.
    const started = Date.now()
    expect((await f.request('corpuskit.org', '/api/health')).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(900)
  } finally {
    console.error = error
    f.close()
  }
})

async function assertion(key: CryptoKey): Promise<string> {
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
    })
  }`
  return `${content}.${
    encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(content))))
  }`
}

async function entraCookie(): Promise<string> {
  const session: TrustedSessionFacts = {
    verified: true,
    tenantId: 'tenant-1',
    oid: 'entra-user',
    email: 'person@example.test',
    roles: [],
    groups: [],
    groupStatus: 'absent',
    claimIssuedAt: Date.now() - 60_000,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3600_000,
  }
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionSecret)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('__Secure-corpuskit_session') },
    key,
    new TextEncoder().encode(JSON.stringify({
      id: session.oid,
      tenantId: session.tenantId,
      name: 'Person',
      email: session.email,
      roles: session.roles,
      isAdmin: false,
      expiresAt: session.expiresAt,
      sessionFacts: session,
    })),
  )
  return `__Secure-corpuskit_session=v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}

async function loadWorker(): Promise<WorkerModule> {
  const workerUrl = new URL('./worker.ts', import.meta.url)
  const durableObjectShim =
    'data:application/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'
  const source = (await Deno.readTextFile(workerUrl))
    .replace("from 'cloudflare:workers'", `from '${durableObjectShim}'`)
    .replace(
      "import { AragProvider } from '@research-portal/retrieval'",
      `import { DoubleProvider } from '${
        new URL('../../../e2e/support/double-provider.ts', import.meta.url).href
      }'; class AragProvider extends DoubleProvider { invalidate() {} }`,
    )
    .replace(
      'domainProvisioner: createCloudflareDomainProvisioner(bindings),',
      `domainProvisioner: {
        attach: async (hostname) => {
          globalThis.__aliasDomainCalls.push('attach ' + hostname)
          return { hostname, created: true }
        },
        detach: async (hostname) => {
          globalThis.__aliasDomainCalls.push('detach ' + hostname)
          return { hostname, removed: true }
        },
      },`,
    )
    .replaceAll(
      /from '(\.\.?\/[^']+)'/g,
      (_match, specifier: string) => `from '${new URL(specifier, workerUrl).href}'`,
    )
  return await import(`data:application/typescript,${encodeURIComponent(source)}`) as WorkerModule
}
