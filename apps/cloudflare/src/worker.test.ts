/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { expect } from '@std/expect'
import { DOC_PAGES } from '../../../packages/core/src/docs.ts'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DurableState } from './state.ts'
import { BindingCipher } from '../../api/src/binding-crypto.ts'
import {
  type SessionEnvelope,
  signPrincipal,
  type TrustedSessionFacts,
  verifyPrincipal,
} from '../../api/src/principal.ts'
import type { AuthUser } from './auth.ts'
import type { PortalDurableObject } from './worker.ts'
import { AragProvider } from '@research-portal/retrieval'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { LocalIngress } from '../../api/src/local-ingress.ts'
import { ROLES } from '@research-portal/core'
import type { DurableStores } from './state.ts'

Deno.test('Worker and local ingress return identical current selected-scope capabilities', async () => {
  const h = await realHarness()
  try {
    const stores = (h.object as unknown as { stores: DurableStores }).stores
    const local = new LocalIngress({
      rbac: stores.rbac,
      tenants: stores.tenants,
      env: { ENTRA_TENANT_ID: 'entra-tenant-id', SESSION_SECRET: secret },
    })
    const project = (body: Record<string, unknown>) => ({
      platformPermissions: body.platformPermissions,
      portalAccess: body.portalAccess,
    })
    const read = async (identity: TrustedSessionFacts | null, query = '?portal=marine') => {
      const path = `/auth/me${query}`
      const request = identity
        ? await principalRequest(path, identity)
        : new Request(`https://corpuskit.test${path}`)
      const remote = await h.object.handleTrustedRequest(request, { session: identity })
      const own = await local.handle(
        new Request(`http://localhost${path}`),
        () => new Response(),
        undefined,
        identity,
      )
      expect(remote.headers.get('cache-control')).toBe('no-store')
      const body = await remote.json()
      expect(project(body)).toEqual(project(await own.json()))
      return body
    }
    for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
      stores.tenants.patch('marine', { accessMode })
      expect((await read(null)).portalAccess.available).toBe(accessMode === 'public')
      for (const role of ROLES) {
        const identity = { ...facts(), oid: `snapshot-${role}`, roles: [] }
        const service = stores.rbac.assignmentService(identity.tenantId)
        if (!service.list().some((row) => row.subjectId === identity.oid)) {
          const grant = service.create({
            subjectKind: 'active-oid',
            subjectId: identity.oid,
            role,
            scope: role === 'owner' || role === 'platform-admin'
              ? { kind: 'platform' }
              : { kind: 'portal', slug: 'marine' },
          }, { requestId: 'snapshot-grant', actor: { kind: 'system' } })
          expect(grant.ok).toBe(true)
        }
        expect((await read(identity)).portalAccess.available).toBe(true)
      }
    }
    const owner = { ...facts(), roles: ['CorpusKit.Owner'] }
    stores.tenants.setDisabled('marine', true)
    const disabled = await read(owner)
    expect(disabled.portalAccess).toEqual({
      slug: 'marine',
      permissions: [],
      effectiveRole: null,
      available: false,
      canEnable: true,
    })
    expect((await read(null)).portalAccess).toEqual({ ...disabled.portalAccess, canEnable: false })
    for (const query of ['', '?portal=../marine', '?portal=marine&portal=grains']) {
      expect((await read(owner, query)).portalAccess).toBeNull()
    }
    expect((await read(owner, '?portal=missing')).portalAccess).toEqual({
      ...disabled.portalAccess,
      slug: 'missing',
      canEnable: false,
    })
    const enable = await principalRequest('/api/admin/t/marine/enable', owner)
    expect(
      (await h.object.handleTrustedRequest(new Request(enable, { method: 'POST' }), {
        session: owner,
      })).status,
    ).toBe(200)
    expect((await read(owner)).portalAccess.available).toBe(true)
    expect((await read(owner)).portalAccess.canEnable).toBe(false)
  } finally {
    h.database.close()
  }
})

Deno.test('Worker selected snapshot preserves public access without Entra configuration', async () => {
  const h = await realHarness({ ENTRA_TENANT_ID: '' })
  try {
    const response = await worker.fetch(
      new Request('https://corpuskit.test/auth/me?portal=marine'),
      h.env,
    )
    expect(response.status).toBe(200)
    expect((await response.json()).portalAccess).toEqual({
      slug: 'marine',
      permissions: ['portal.read', 'portal.ask'],
      effectiveRole: 'viewer',
      available: true,
      canEnable: false,
    })
  } finally {
    h.database.close()
  }
})

type WorkerHandler = {
  fetch(request: Request, env: Env): Promise<Response>
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>
}

type WorkerModule = {
  PortalDurableObject: typeof PortalDurableObject
  default: WorkerHandler
  marketingHomeRequest(request: Request, domain: string): Request
  forwardPortalRequest(
    request: Request,
    user: AuthUser | null,
    env: Env,
  ): Promise<Request>
}

type WorkerHarness = {
  env: Env
  assetRequests: Request[]
  portalRequests: Request[]
}

const workerModule = await loadWorker()
const worker = workerModule.default

Deno.test('Worker sends each portal custom domain to its tenant route', async () => {
  for (const slug of ['marine', 'grains', 'opax', 'new-portal']) {
    const harness = workerHarness()
    const response = await worker.fetch(
      new Request(`https://${slug}.corpuskit.org/?from=directory`),
      harness.env,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(`/t/${slug}?from=directory`)
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker keeps the apex canonical when www is requested', async () => {
  const harness = workerHarness()
  const response = await worker.fetch(
    new Request('https://www.corpuskit.org/why?ref=www'),
    harness.env,
  )

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('https://corpuskit.org/why?ref=www')
})

Deno.test('Worker redirects and serves platform documents using a non-default domain', async () => {
  for (
    const [input, status, location, path] of [
      [
        'https://www.research.example.org/docs/?q=1',
        308,
        'https://research.example.org/docs/?q=1',
        '',
      ],
      ['https://marine.research.example.org/?q=1', 308, '/t/marine?q=1', ''],
      ['https://research.example.org/about/', 200, null, '/about'],
      ['https://research.example.org/docs/', 200, null, '/docs/'],
      ['https://corpuskit.org/about/', 404, null, ''],
      ['https://marine.research.example.org/about/', 404, null, ''],
    ] as const
  ) {
    const harness = workerHarness()
    Object.assign(harness.env, { PLATFORM_DOMAIN: 'research.example.org' })
    const response = await worker.fetch(new Request(input), harness.env)
    expect(response.status).toBe(status)
    expect(response.headers.get('location')).toBe(location)
    expect(harness.assetRequests.map((request) => new URL(request.url).pathname))
      .toEqual(path ? [path] : [])
    await response.body?.cancel()
  }
})

Deno.test('Worker domain redirects reject unrelated, nested and reserved hostnames and mutations', async () => {
  for (
    const hostname of [
      'marine.corpuskit.org',
      'notresearch.example.org',
      'research.example.org.evil.test',
      'marine.nested.research.example.org',
      'admin.research.example.org',
    ]
  ) {
    const harness = workerHarness()
    Object.assign(harness.env, { PLATFORM_DOMAIN: 'research.example.org' })
    const response = await worker.fetch(new Request(`https://${hostname}/`), harness.env)
    expect(response.headers.get('location')).toBeNull()
    await response.body?.cancel()
  }
  const harness = workerHarness()
  Object.assign(harness.env, { PLATFORM_DOMAIN: 'research.example.org' })
  const response = await worker.fetch(
    new Request('https://marine.research.example.org/', { method: 'POST' }),
    harness.env,
  )
  expect(response.status).toBe(405)
  expect(response.headers.get('location')).toBeNull()
})

Deno.test('Worker injects domain configuration per HTML response without changing the bundle', async () => {
  const shell =
    '<head><meta name="corpuskit-platform-domain" content="__CORPUSKIT_PLATFORM_DOMAIN__"></head>'
  const harness = workerHarness({
    assets: () =>
      new Response(shell, {
        headers: { 'content-type': 'text/html', etag: 'static-body' },
      }),
  })
  for (const domain of [undefined, 'research.example.org', 'other.example.org']) {
    Object.assign(harness.env, { PLATFORM_DOMAIN: domain })
    const response = await worker.fetch(
      new Request('https://research.example.org/t/marine'),
      harness.env,
    )
    expect(await response.text()).toContain(`content="${domain ?? 'corpuskit.org'}"`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('etag')).toBeNull()
  }
})

Deno.test('Worker cookies share only the configured platform domain', async () => {
  for (
    const hostname of [
      'research.example.org',
      'marine.research.example.org',
      'corpuskit.org',
      'research.example.org.evil.test',
    ]
  ) {
    const harness = workerHarness()
    Object.assign(harness.env, {
      PLATFORM_DOMAIN: 'research.example.org',
      ENTRA_CLIENT_SECRET: 'test-only-client-secret',
    })
    const response = await worker.fetch(new Request(`https://${hostname}/auth/logout`), harness.env)
    expect(response.status).toBe(302)
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain('Max-Age=0')
    if (['research.example.org', 'marine.research.example.org'].includes(hostname)) {
      expect(cookie).toContain('Domain=research.example.org')
    } else expect(cookie).not.toContain('Domain=')
    expect(cookie).not.toContain('Domain=corpuskit.org')
  }
})

Deno.test('Worker rejects invalid platform configuration without forwarding or exposing it', async () => {
  const harness = workerHarness()
  const malformed = 'invalid.example.org"><script>alert(1)</script>'
  Object.assign(harness.env, { PLATFORM_DOMAIN: malformed })
  const response = await worker.fetch(new Request('https://corpuskit.org/'), harness.env)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'platform_domain_invalid' })
  expect(harness.assetRequests).toHaveLength(0)
  expect(harness.portalRequests).toHaveLength(0)
})

Deno.test('Worker serves the marketing app at the CorpusKit apex', async () => {
  const harness = workerHarness()
  const response = await worker.fetch(new Request('https://corpuskit.org/'), harness.env)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('asset')
  expect(harness.assetRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/home',
  ])
})

Deno.test('Worker preserves the marketing URL query while selecting the homepage asset', () => {
  const request = workerModule.marketingHomeRequest(
    new Request('https://corpuskit.org/?campaign=launch', { method: 'HEAD' }),
    'corpuskit.org',
  )

  expect(new URL(request.url).pathname).toBe('/home')
  expect(new URL(request.url).search).toBe('?campaign=launch')
  expect(request.method).toBe('HEAD')
})

Deno.test('Worker serves both About URLs with the homepage caching and security headers', async () => {
  const home = await worker.fetch(new Request('https://corpuskit.org/'), workerHarness().env)
  for (const path of ['/about', '/about/', '/about.html']) {
    for (const method of ['GET', 'HEAD']) {
      const harness = workerHarness()
      const response = await worker.fetch(
        new Request(`https://corpuskit.org${path}?from=home`, {
          method,
          headers: { 'accept-language': 'en-AU' },
        }),
        harness.env,
      )
      expect(response.status).toBe(200)
      expect(Object.fromEntries(response.headers)).toEqual(Object.fromEntries(home.headers))
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('location')).toBeNull()
      expect(harness.portalRequests).toHaveLength(0)
      expect(harness.assetRequests).toHaveLength(1)
      const selected = harness.assetRequests[0]!
      expect(selected.url).toBe('https://corpuskit.org/about?from=home')
      expect(selected.method).toBe(method)
      expect(selected.headers.get('accept-language')).toBe('en-AU')
    }
  }
})

Deno.test('Worker keeps About marketing assets off tenant and non-apex hosts', async () => {
  for (const host of ['demo.corpuskit.org', 'marine.corpuskit.org', 'research.example.org']) {
    for (const path of ['/about', '/about/', '/about.html']) {
      const harness = workerHarness()
      const response = await worker.fetch(new Request(`https://${host}${path}`), harness.env)
      expect(response.status).toBe(404)
      expect(harness.assetRequests).toHaveLength(0)
      expect(harness.portalRequests).toHaveLength(0)
    }
  }
  const harness = workerHarness()
  const response = await worker.fetch(
    new Request('https://www.corpuskit.org/about/?from=www'),
    harness.env,
  )
  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('https://corpuskit.org/about/?from=www')
})

Deno.test('About asset selection preserves SPA paths and does not rewrite mutations', async () => {
  for (const path of ['/t/marine/about', '/t/demo/docs', '/about/other', '/docs-other']) {
    const harness = workerHarness()
    await worker.fetch(new Request(`https://corpuskit.org${path}`), harness.env)
    expect(new URL(harness.assetRequests[0]!.url).pathname).toBe(path)
    expect(harness.portalRequests).toHaveLength(0)
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const request = new Request('https://corpuskit.org/about/', { method })
    expect(workerModule.marketingHomeRequest(request, 'corpuskit.org')).toBe(request)
  }
})

Deno.test('Worker serves all public docs aliases without asset redirects and with homepage headers', async () => {
  const home = await worker.fetch(new Request('https://corpuskit.org/'), workerHarness().env)
  const routes = [
    ...['/docs', '/docs/', '/docs/index.html', '/docs/index'].map((path) => ({
      path,
      asset: '/docs/',
    })),
    ...DOC_PAGES.flatMap((page) =>
      ['', '/', '.html', '.html/'].map((suffix) => ({
        path: `/docs/${page.id}${suffix}`,
        asset: `/docs/${page.id}`,
      }))
    ),
    ...['/docs/unknown', '/docs/unknown.html/', '/docs/nested/path', '/docs/unknown/'].map((
      path,
    ) => ({ path, asset: '/docs/' })),
  ]
  const canonicalAssets = new Set(['/docs/', ...DOC_PAGES.map((page) => `/docs/${page.id}`)])
  for (const { path, asset } of routes) {
    for (const method of ['GET', 'HEAD']) {
      const harness = workerHarness()
      // Model Assets' pretty-URL redirects, instead of a mock that accepts any URL.
      harness.env.ASSETS.fetch = (request) => {
        harness.assetRequests.push(request)
        return Promise.resolve(
          canonicalAssets.has(new URL(request.url).pathname)
            ? new Response(method === 'HEAD' ? null : asset, {
              headers: { 'content-type': 'text/html' },
            })
            : new Response(null, {
              status: 307,
              headers: { location: '/unexpected-asset-redirect' },
            }),
        )
      }
      const response = await worker.fetch(
        new Request(`https://corpuskit.org${path}?from=docs`, {
          method,
          headers: { 'accept-language': 'en-AU' },
        }),
        harness.env,
      )
      expect(response.status).toBe(200)
      expect(Object.fromEntries(response.headers)).toEqual(Object.fromEntries(home.headers))
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toBe(method === 'HEAD' ? '' : asset)
      expect(harness.portalRequests).toHaveLength(0)
      expect(harness.assetRequests).toHaveLength(1)
      expect(harness.assetRequests[0]!.url).toBe(`https://corpuskit.org${asset}?from=docs`)
      expect(harness.assetRequests[0]!.method).toBe(method)
      expect(harness.assetRequests[0]!.headers.get('accept-language')).toBe('en-AU')
    }
  }
})

Deno.test('public docs stay on the apex, preserve www canonicalisation and do not rewrite mutations', async () => {
  const paths = [
    '/docs',
    '/docs/',
    '/docs/index.html',
    ...DOC_PAGES.flatMap((page) =>
      ['', '/', '.html', '.html/'].map((suffix) => `/docs/${page.id}${suffix}`)
    ),
  ]
  for (const host of ['demo.corpuskit.org', 'research.example.org', 'corpuskit.noice.net.au']) {
    for (const path of paths) {
      const harness = workerHarness()
      expect((await worker.fetch(new Request(`https://${host}${path}`), harness.env)).status).toBe(
        404,
      )
      expect(harness.assetRequests).toHaveLength(0)
      expect(harness.portalRequests).toHaveLength(0)
    }
  }
  for (const path of paths) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const request = new Request(`https://corpuskit.org${path}`, { method })
      expect(workerModule.marketingHomeRequest(request, 'corpuskit.org')).toBe(request)
    }
  }
  const response = await worker.fetch(
    new Request('https://www.corpuskit.org/docs/search/?from=www'),
    workerHarness().env,
  )
  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('https://corpuskit.org/docs/search/?from=www')
})

Deno.test('Worker permanently redirects the Assistant route alias for GET and HEAD', async () => {
  for (const method of ['GET', 'HEAD']) {
    const harness = workerHarness()

    const response = await worker.fetch(
      new Request('https://corpuskit.test/t/marine/assistant?ask=x', { method }),
      harness.env,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine/ask?ask=x')
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker alias redirects preserve nested paths and query strings', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request(
      'https://corpuskit.test/t/grains/assistant/sessions/report-42?view=evidence&sort=recent',
    ),
    harness.env,
  )

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe(
    '/t/grains/ask/sessions/report-42?view=evidence&sort=recent',
  )
  expect(harness.assetRequests).toHaveLength(0)
  expect(harness.portalRequests).toHaveLength(0)
})

Deno.test('Worker keeps normal tenant routes on the static asset fast path', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request('https://corpuskit.test/t/marine/library'),
    harness.env,
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('asset')
  expect(harness.assetRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/t/marine/library',
  ])
  expect(harness.portalRequests).toHaveLength(0)
})

Deno.test('Worker refuses secret and script probes before any asset lookup', async () => {
  const probes = [
    '/.env',
    '/transactional/.env',
    '/.git/config',
    '/wp-admin/install.php',
    '/phpinfo.php',
    '/auth%20(1).zip',
    '/cgi-bin/test',
  ]
  for (const path of probes) {
    const harness = workerHarness()
    const response = await worker.fetch(new Request(`https://corpuskit.org${path}`), harness.env)
    expect([path, response.status]).toEqual([path, 404])
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker serves the app shell for an unknown path, but as a 404', async () => {
  for (const path of ['/sitemap.xml', '/nope', '/admin/users', '/t', '/firebase-adminsdk.json']) {
    const harness = workerHarness()
    const response = await worker.fetch(new Request(`https://corpuskit.org${path}`), harness.env)
    expect([path, response.status]).toEqual([path, 404])
    expect(await response.text()).toBe('asset')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(harness.assetRequests.map((request) => new URL(request.url).pathname)).toEqual([path])
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker keeps router paths and real assets at their own status', async () => {
  for (
    const path of ['/', '/admin', '/t/marine', '/t/marine/library/abc', '/t/marine/robots.txt']
  ) {
    const harness = workerHarness()
    const response = await worker.fetch(new Request(`https://corpuskit.org${path}`), harness.env)
    expect([path, response.status]).toEqual([path, 200])
  }

  const files: Record<string, [string, string]> = {
    '/app.js': ['text/javascript', 'js'],
    '/robots.txt': ['text/plain; charset=utf-8', 'User-agent: *'],
  }
  for (const [path, [type, body]] of Object.entries(files)) {
    const harness = workerHarness({
      assets: () => new Response(body, { headers: { 'content-type': type } }),
    })
    const response = await worker.fetch(new Request(`https://corpuskit.org${path}`), harness.env)
    expect([path, response.status]).toEqual([path, 200])
    expect(await response.text()).toBe(body)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
  }

  const missing = workerHarness({ assets: () => new Response('gone', { status: 404 }) })
  const response = await worker.fetch(new Request('https://corpuskit.org/og/old.png'), missing.env)
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('gone')
})

Deno.test('Worker answers writes to pages and assets with 405 and no asset lookup', async () => {
  for (const [path, method] of [['/', 'POST'], ['/t/marine', 'PUT'], ['/app.js', 'DELETE']]) {
    const harness = workerHarness()
    const response = await worker.fetch(
      new Request(`https://corpuskit.org${path}`, { method }),
      harness.env,
    )
    expect([path, response.status]).toEqual([path, 405])
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(harness.assetRequests).toHaveLength(0)
    expect(harness.portalRequests).toHaveLength(0)
  }
})

Deno.test('Worker sends HSTS and frame-ancestors on pages, refusals and its own JSON', async () => {
  const harness = workerHarness({
    assets: (request) =>
      new URL(request.url).pathname === '/app.js'
        ? new Response('js', { headers: { 'content-type': 'text/javascript' } })
        : new Response('asset', { headers: { 'content-type': 'text/html' } }),
  })
  const responses = await Promise.all([
    worker.fetch(new Request('https://corpuskit.org/'), harness.env),
    worker.fetch(new Request('https://corpuskit.org/t/marine'), harness.env),
    worker.fetch(new Request('https://corpuskit.org/.env'), harness.env),
    worker.fetch(new Request('https://corpuskit.org/app.js'), harness.env),
    worker.fetch(new Request('https://corpuskit.org/auth/login'), harness.env),
    worker.fetch(new Request('https://www.corpuskit.org/'), harness.env),
  ])
  expect(responses.map((response) => response.status)).toEqual([200, 200, 404, 200, 503, 308])
  for (const response of responses) {
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    )
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  }
  expect(responses[5].headers.get('location')).toBe('https://corpuskit.org/')
})

Deno.test('Worker keeps API requests routed through the Durable Object', async () => {
  const harness = workerHarness()

  const response = await worker.fetch(
    new Request('https://corpuskit.test/api/t/marine/config'),
    harness.env,
  )

  expect(response.status).toBe(202)
  expect(await response.text()).toBe('portal')
  expect(harness.assetRequests).toHaveLength(0)
  expect(harness.portalRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/api/t/marine/config',
  ])
})

Deno.test('Worker removes caller-supplied identity markers before forwarding API requests', async () => {
  const harness = workerHarness()

  await worker.fetch(
    new Request('https://corpuskit.test/api/t/marine/mcp/keys', {
      headers: {
        'x-corpuskit-sso-admin': '1',
        'x-corpuskit-sso-user-id': 'spoofed-user',
      },
    }),
    harness.env,
  )

  expect(harness.portalRequests[0]?.headers.get('x-corpuskit-sso-admin')).toBeNull()
  expect(harness.portalRequests[0]?.headers.get('x-corpuskit-sso-user-id')).toBeNull()
})

Deno.test('Worker forwards identity only from a validated session user', async () => {
  const forwarded = await workerModule.forwardPortalRequest(
    new Request('https://corpuskit.test/api/t/marine/mcp/keys', {
      headers: {
        'x-corpuskit-sso-admin': 'spoofed',
        'x-corpuskit-sso-user-id': 'spoofed-user',
      },
    }),
    {
      id: 'entra-object-id',
      tenantId: 'entra-tenant-id',
      name: 'Portal administrator',
      email: 'admin@example.test',
      roles: ['CorpusKit.Admin'],
      isAdmin: true,
      sessionFacts: facts(),
    },
    workerHarness().env,
  )

  expect(forwarded.headers.get('x-corpuskit-sso-user-id')).toBeNull()
  expect(forwarded.headers.get('x-corpuskit-sso-admin')).toBeNull()
  expect(
    (await verifyPrincipal(forwarded.headers.get('x-corpuskit-principal'), {
      sessionSecret: secret,
      audience: 'corpuskit',
      tenantId: 'entra-tenant-id',
    })).kind,
  ).toBe('verified')
})

function workerHarness(
  overrides: { assets?: (request: Request) => Response } = {},
): WorkerHarness {
  const assetRequests: Request[] = []
  const portalRequests: Request[] = []
  const env: Env = {
    CF_VERSION_METADATA: { id: 'test', tag: 'test' },
    ASSETS: {
      fetch(request) {
        assetRequests.push(request)
        return Promise.resolve(
          overrides.assets?.(request) ??
            new Response('asset', { headers: { 'content-type': 'text/html' } }),
        )
      },
    },
    ENVIRONMENT: 'production',
    ENTRA_CLIENT_ID: '147a13c9-2a9e-4e32-aa01-3f020d2a18cd',
    ENTRA_TENANT_ID: '15c1eb19-1f38-4a09-bb25-7ff9892387b8',
    ENTRA_REDIRECT_URI: 'https://corpuskit.org/auth/callback',
    PORTAL: {
      getByName() {
        return {
          fetch(request) {
            portalRequests.push(request)
            return Promise.resolve(new Response('portal', { status: 202 }))
          },
          handleTrustedRequest(request: Request) {
            portalRequests.push(request)
            return Promise.resolve(new Response('portal', { status: 202 }))
          },
          auditDenial() {
            return Promise.resolve()
          },
          auditOperatorFailure() {
            return Promise.resolve({ limited: false as const })
          },
          requestPrincipal() {
            return Promise.resolve({
              requestId: 'fixture',
              session: null,
              coarseAdminEligible: false,
            })
          },
          consumeExternalAssertion() {
            return Promise.resolve(false)
          },
          auditExternalFailure() {
            return Promise.resolve()
          },
          maintenance() {
            return Promise.resolve()
          },
        }
      },
    },
  }
  Object.assign(env, { WORKER_NAME: 'corpuskit', SESSION_SECRET: secret })
  return { env, assetRequests, portalRequests }
}

const secret = 'test-session-secret-at-least-thirty-two-bytes'
function facts(): TrustedSessionFacts {
  return {
    verified: true,
    tenantId: 'entra-tenant-id',
    oid: 'entra-object-id',
    email: 'admin@example.test',
    roles: ['CorpusKit.Admin'],
    groups: [],
    groupStatus: 'absent',
    claimIssuedAt: Date.now() - 120_000,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3600_000,
  }
}

async function sessionCookie(session: TrustedSessionFacts): Promise<string> {
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('__Secure-corpuskit_session') },
    key,
    new TextEncoder().encode(
      JSON.stringify({
        id: session.oid,
        tenantId: session.tenantId,
        name: 'Verified user',
        email: session.email,
        roles: session.roles,
        isAdmin: false,
        expiresAt: session.expiresAt,
        sessionFacts: session,
      }),
    ),
  )
  return `__Secure-corpuskit_session=v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}
async function principalRequest(
  path = '/auth/me',
  session = facts(),
  extra: Partial<SessionEnvelope> = {},
) {
  const header = await signPrincipal({
    v: 1,
    aud: 'corpuskit',
    tid: session.tenantId,
    oid: session.oid,
    email: session.email ?? '',
    name: 'Verified user',
    roles: session.roles,
    groups: session.groups,
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  }, secret)
  return new Request(`https://corpuskit.test${path}`, {
    headers: { 'x-corpuskit-principal': header, 'x-corpuskit-sso-admin': '1' },
  })
}
async function realHarness(
  extraEnv: Record<string, string> = {},
  legacyBindings?: unknown,
  databasePath = ':memory:',
) {
  const database = new DatabaseSync(databasePath)
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
        const rows = statement.columns().length
          ? statement.all(...bindings as SQLInputValue[]) as T[]
          : (statement.run(...bindings as SQLInputValue[]), [])
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
  const harness = workerHarness()
  Object.assign(harness.env, {
    ENTRA_TENANT_ID: 'entra-tenant-id',
    ENTRA_CLIENT_SECRET: 'fixture',
    ADMIN_PASSCODE: 'fixture',
    ...extraEnv,
  })
  if (legacyBindings) {
    const seed = new DurableState(storage.sql, storage)
    seed.migrate()
    seed.put('bindings', legacyBindings)
  }
  let initialization: Promise<unknown> = Promise.resolve()
  const object = new workerModule.PortalDurableObject({
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const pending = callback()
      initialization = pending
      return pending
    },
  }, harness.env)
  await initialization
  harness.env.PORTAL = { getByName: () => object }
  return { ...harness, object, database, state: new DurableState(storage.sql, storage) }
}

Deno.test('Worker startup seals stored binding credentials only when the deployment opts in', async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    // A release verification health probe is the first request a new version serves. Unless
    // the operator has opted in, it must leave stored plaintext readable by the version a failed
    // verification rolls back to.
    for (const mode of ['no-key', 'key', 'key-and-migrate'] as const) {
      const token = 'fixture-only-stored-credential'
      const h = await realHarness(
        mode === 'no-key' ? {} : {
          BINDING_KEY: btoa('x'.repeat(32)),
          ...(mode === 'key-and-migrate' ? { BINDING_KEY_MIGRATE: 'true' } : {}),
        },
        {
          marine: {
            baseUrl: 'https://example.test/kb/marine',
            token,
            connectedAt: '2026-01-01T00:00:00Z',
          },
        },
      )
      try {
        const health = await worker.fetch(new Request('https://corpuskit.test/api/health'), h.env)
        expect(health.status).toBe(200)
        const healthBody = await health.json()
        expect(healthBody.bindingsReady).toBe(mode !== 'no-key')
        expect(healthBody.bindingEncryption).toBeUndefined()
        const binding = await worker.fetch(
          new Request('https://corpuskit.test/api/t/marine/knowledge-box'),
          h.env,
        )
        expect(binding.status).toBe(200)
        const body = await binding.text()
        expect(JSON.parse(body).status).toBe('connected')
        expect(body).not.toContain(token)
        const stored = h.state.get<Record<string, { token: string }>>('bindings', {})
        if (mode === 'key-and-migrate') expect(stored.marine?.token).toMatch(/^enc:v1:/)
        else expect(stored.marine?.token).toBe(token)
      } finally {
        h.database.close()
      }
    }
  } finally {
    console.warn = warn
  }
})

Deno.test('Worker withholds a binding sealed under another key without failing other portals', async () => {
  const originalFetch = globalThis.fetch
  const warn = console.warn
  const upstream: string[] = []
  globalThis.fetch = (input) => {
    upstream.push(String(input instanceof Request ? input.url : input))
    return Promise.resolve(Response.json({ resources: [] }))
  }
  console.warn = () => {}
  const token = 'fixture-only-stored-credential'
  const sealed = await new BindingCipher(btoa('o'.repeat(32))).seal('marine', token)
  const h = await realHarness({
    BINDING_KEY: btoa('x'.repeat(32)),
    ARAG_KB_MARINE: 'https://example.test/api/v1/kb/environment',
    ARAG_KB_MARINE_TOKEN: 'fixture-only-environment-token',
  }, {
    marine: { baseUrl: 'https://example.test/kb/marine', token: sealed, connectedAt: 'then' },
  })
  try {
    const status = await worker.fetch(
      new Request('https://corpuskit.test/api/t/marine/knowledge-box'),
      h.env,
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ slug: 'marine', status: 'unavailable', kbId: 'marine' })
    const resources = await worker.fetch(
      new Request('https://corpuskit.test/api/t/marine/resources'),
      h.env,
    )
    expect(resources.status).toBe(503)
    expect(await resources.json()).toEqual({ error: 'binding_unavailable' })
    // Neither the environment box nor the stored text stands in for the withheld credential.
    expect(upstream).toEqual([])
    const health = await worker.fetch(new Request('https://corpuskit.test/api/health'), h.env)
    expect(health.status).toBe(200)
    expect((await health.json()).bindingsReady).toBe(false)
    const other = await worker.fetch(
      new Request('https://corpuskit.test/api/t/grains/knowledge-box'),
      h.env,
    )
    expect(other.status).toBe(200)
    expect(h.state.get<Record<string, { token: string }>>('bindings', {}).marine?.token)
      .toBe(sealed)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = warn
    h.database.close()
  }
})

Deno.test('Worker answers portal requests with binding_key_invalid for a malformed key', async () => {
  const warn = console.warn
  console.warn = () => {}
  const h = await realHarness({ BINDING_KEY: 'not-a-valid-key' }, {
    marine: { baseUrl: 'https://example.test/kb/marine', token: 'enc:v1:a:b', connectedAt: 'then' },
  })
  try {
    for (const path of ['/api/health', '/api/t/marine/knowledge-box', '/auth/me']) {
      const response = await worker.fetch(new Request(`https://corpuskit.test${path}`), h.env)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'binding_key_invalid' })
    }
    // Pages that never touch credentials keep working.
    const home = await worker.fetch(new Request('https://corpuskit.org/'), h.env)
    expect(home.status).toBe(200)
    // Paths that reach the object directly (scheduled maintenance) find it started and degraded.
    const direct = await h.object.handleTrustedRequest(
      new Request('https://corpuskit.test/api/t/marine/knowledge-box'),
      {},
    )
    expect(direct.status).toBe(200)
    expect((await direct.json()).status).toBe('unavailable')
  } finally {
    console.warn = warn
    h.database.close()
  }
})

Deno.test('Worker break-glass uses trusted peer lockout and production policy with session co-attribution', async () => {
  for (const enabled of [false, true]) {
    const h = await realHarness({ ENVIRONMENT: 'production', ADMIN_BREAK_GLASS: String(enabled) })
    try {
      const session = { ...facts(), roles: ['CorpusKit.Owner'] }
      const cookie = await sessionCookie(session)
      const invoke = (passcode?: string) =>
        worker.fetch(
          new Request('https://corpuskit.test/api/admin/overview', {
            headers: {
              cookie,
              'cf-connecting-ip': '192.0.2.1',
              'x-forwarded-for': crypto.randomUUID(),
              ...(passcode === undefined ? {} : { 'x-admin-passcode': passcode }),
            },
          }),
          h.env,
        )
      expect((await invoke()).status).toBe(200)
      const me = await worker.fetch(new Request('https://corpuskit.test/auth/me'), h.env)
      expect((await me.json()).breakGlassEnabled).toBe(enabled)
      expect((await invoke('fixture')).status).toBe(enabled ? 200 : 403)
      if (enabled) {
        for (let i = 0; i < 5; i++) expect((await invoke('wrong')).status).toBe(i === 4 ? 403 : 401)
        const locked = await invoke('fixture')
        expect(locked.status).toBe(403)
        expect(locked.headers.get('retry-after')).toBe('600')
        const used = h.state.rbac.audit.read({ scope: { kind: 'platform' } }).find((e) =>
          e.action === 'break_glass.used'
        )!
        expect(JSON.parse(used.detail_json)).toEqual({
          sessionOid: session.oid,
          sessionTenantId: session.tenantId,
        })
        expect(h.state.rbac.locks.lockedUntil('192.0.2.1')).toBeGreaterThan(Date.now())
      }
      expect((await invoke()).status).toBe(200)
    } finally {
      h.database.close()
    }
  }
})

Deno.test('scheduled RPC runs retention while every HTTP maintenance spelling stays non-system', async () => {
  const h = await realHarness()
  try {
    h.state.put('tenants', { disabled: ['marine', 'grains'] })
    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (
        const path of [
          '/__corpuskit/maintenance',
          '/__corpuskit/maintenance/',
          '/%5f%5fcorpuskit/maintenance',
        ]
      ) {
        const response = await h.object.fetch(
          new Request(`https://corpuskit.test${path}`, {
            method,
            headers: { 'x-corpuskit-actor': 'system', 'x-corpuskit-sso-admin': '1' },
          }),
        )
        expect([200, 201, 202, 204]).not.toContain(response.status)
      }
    }
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
        e.action === 'maintenance.run' || e.action === 'audit.retention'
      ),
    ).toHaveLength(0)
    const pending: Promise<unknown>[] = []
    await worker.scheduled({ cron: '0 0 * * *', scheduledTime: Date.now() }, h.env, {
      waitUntil: (promise) => {
        pending.push(promise)
      },
    })
    await Promise.all(pending)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).some((e) =>
        e.action === 'audit.retention' && e.actor_kind === 'system'
      ),
    ).toBe(true)
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    pending.length = 0
    await worker.scheduled({ cron: '0 0 * * *', scheduledTime: Date.now() }, h.env, {
      waitUntil: (promise) => {
        pending.push(promise)
      },
    })
    await expect(Promise.all(pending)).rejects.toThrow()
  } finally {
    h.database.close()
  }
})

Deno.test('Durable retention rolls back deleted history if its purge event cannot be written', async () => {
  const h = await realHarness()
  try {
    const before = h.state.rbac.audit.read({ scope: { kind: 'platform' } })
    h.database.exec("UPDATE audit_events SET at = '2020-01-01T00:00:00.000Z'")
    h.database.exec(
      "CREATE TRIGGER fail_purge BEFORE INSERT ON audit_events WHEN NEW.action = 'audit.retention' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(() => h.state.rbac.retainAudit(400)).toThrow()
    expect(h.state.rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(before.length)
    h.database.exec('DROP TRIGGER fail_purge')
    expect(h.state.rbac.retainAudit(400).deletedCount).toBe(before.length)
  } finally {
    h.database.close()
  }
})

Deno.test('real DO rejects invalid envelope or mismatched method facts without legacy rescue', async () => {
  const h = await realHarness()
  try {
    const session = facts()
    const requests = [
      await principalRequest('/api/health', session, { iat: Math.floor(Date.now() / 1000) - 61 }),
      await principalRequest('/api/health', session, { aud: 'corpuskit-demo' }),
      new Request('https://corpuskit.test/api/health', {
        headers: { 'x-corpuskit-principal': 'x'.repeat(8193), 'x-corpuskit-sso-admin': '1' },
      }),
      new Request('https://corpuskit.test/api/health', {
        headers: { 'x-corpuskit-principal': 'forged', 'x-corpuskit-sso-admin': '1' },
      }),
    ]
    for (const request of requests) {
      expect(
        (await h.object.handleTrustedRequest(request, { session, clientIp: '192.0.2.1' })).status,
      ).toBe(401)
    }
    expect(
      (await h.object.handleTrustedRequest(await principalRequest(), {
        session: { ...session, oid: 'other' },
      })).status,
    ).toBe(401)
    for (
      const changed of [{ ...session, roles: ['CorpusKit.Owner'] }, {
        ...session,
        groups: ['injected-group'],
        groupStatus: 'complete' as const,
      }, { ...session, expiresAt: Date.now() - 1 }]
    ) {
      expect(
        (await h.object.handleTrustedRequest(await principalRequest('/api/health', session), {
          session: changed,
        })).status,
      ).toBe(401)
    }
    expect(
      (await h.object.handleTrustedRequest(new Request('https://corpuskit.test/api/health'), {
        session,
      })).status,
    ).toBe(401)
    expect((await h.object.fetch(await principalRequest('/api/admin/overview'))).status).toBe(401)
    expect(
      (await h.object.fetch(new Request('https://corpuskit.test/__corpuskit/maintenance'))).status,
    ).toBe(404)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).filter((row) =>
        row.action === 'request.denied'
      ).length,
    ).toBeGreaterThanOrEqual(7)
  } finally {
    h.database.close()
  }
})

Deno.test('real DO principal failures perform zero protected provider calls and require denial audit', async () => {
  const h = await realHarness()
  const original = AragProvider.prototype.catalog
  let calls = 0
  AragProvider.prototype.catalog = (tenant) => {
    calls++
    return new DoubleProvider().catalog(tenant)
  }
  try {
    const session = facts()
    const path = '/api/t/marine/catalog'
    const allowed = await h.object.handleTrustedRequest(await principalRequest(path, session), {
      session,
    })
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).items.length).toBeGreaterThan(0)
    expect(calls).toBe(1)
    for (
      const extra of [{ iat: Math.floor(Date.now() / 1000) - 61 }, {
        iat: Math.floor(Date.now() / 1000) + 31,
      }, { aud: 'corpuskit-demo' as const }]
    ) {
      expect(
        (await h.object.handleTrustedRequest(await principalRequest(path, session, extra), {
          session,
        })).status,
      ).toBe(401)
      expect(calls).toBe(1)
    }
    for (const header of ['forged', 'x'.repeat(8193)]) {
      const request = new Request(`https://corpuskit.test${path}`, {
        headers: {
          'x-corpuskit-principal': header,
          'x-corpuskit-sso-admin': '1',
          'x-corpuskit-sso-user-id': session.oid,
        },
      })
      expect((await h.object.handleTrustedRequest(request, { session })).status).toBe(401)
      expect(calls).toBe(1)
    }
    const ordinary = { ...session, roles: [] }
    expect(
      (await h.object.handleTrustedRequest(
        await principalRequest('/api/admin/overview', ordinary),
        { session: ordinary },
      )).status,
    ).toBe(403)
    h.database.exec(
      "CREATE TRIGGER principal_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect(
      (await h.object.handleTrustedRequest(
        await principalRequest(path, session, { iat: Math.floor(Date.now() / 1000) - 61 }),
        { session },
      )).status,
    ).toBe(500)
    expect(calls).toBe(1)
  } finally {
    AragProvider.prototype.catalog = original
    h.database.close()
  }
})

Deno.test('real DO auth/me resolves current assignments and preserves original claim age', async () => {
  const h = await realHarness()
  try {
    const session = { ...facts(), roles: [] }
    const read = async () =>
      (await h.object.handleTrustedRequest(await principalRequest('/auth/me', session), {
        session,
      })).json()
    const first = await read()
    expect(first.coarseAdminEligible).toBe(false)
    expect(first.claimAgeSeconds).toBeGreaterThanOrEqual(120)
    const service = h.state.rbac.assignmentService(session.tenantId, 'corpuskit')
    expect(
      service.create({
        subjectKind: 'active-oid',
        subjectId: 'backup-owner',
        scope: { kind: 'platform' },
        role: 'owner',
      }, { requestId: 'seed-backup', actor: { kind: 'system' } }).ok,
    ).toBe(true)
    const platformAdmin = { ...session, oid: 'read-only-admin', roles: ['CorpusKit.PlatformAdmin'] }
    const adminMe = await h.object.handleTrustedRequest(
      await principalRequest('/auth/me', platformAdmin),
      {
        session: platformAdmin,
      },
    )
    expect((await adminMe.json()).effectiveRoles.platformRole).toBe('platform-admin')
    const created = service.create({
      subjectKind: 'active-oid',
      subjectId: session.oid,
      scope: { kind: 'platform' },
      role: 'owner',
    }, { requestId: 'test-create', actor: { kind: 'user', id: 'owner' } })
    expect(created.ok).toBe(true)
    const second = await read()
    expect(second.coarseAdminEligible).toBe(true)
    expect(second.effectiveRoles.platformRole).toBe('owner')
    expect(second.claimAgeSeconds).toBeGreaterThanOrEqual(first.claimAgeSeconds)
    expect(second.groupMappings).toBe('disabled')
    expect(
      (await h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', session), {
        session,
      })).status,
    ).toBe(200)
    if (created.ok) {
      expect(
        service.remove(created.value.id, {
          requestId: 'test-remove',
          actor: { kind: 'user', id: 'owner' },
        }).ok,
      ).toBe(true)
    }
    expect((await read()).coarseAdminEligible).toBe(false)
  } finally {
    h.database.close()
  }
})

Deno.test('Worker auth/me retains cookie lifetime and original age across fresh envelopes', async () => {
  const h = await realHarness()
  const originalNow = Date.now
  try {
    const now = originalNow()
    const session = { ...facts(), roles: [] }
    const cookie = await sessionCookie(session)
    const read = () =>
      worker.fetch(new Request('https://corpuskit.test/auth/me', { headers: { cookie } }), h.env)
    Date.now = () => now
    const first = await read()
    expect(first.headers.get('set-cookie')).toBeNull()
    const body = await first.json()
    Date.now = () => now + 90_000
    const later = await (await read()).json()
    expect(later.claimAgeSeconds).toBe(body.claimAgeSeconds + 90)
    Date.now = () => session.expiresAt
    expect(await (await read()).json()).toMatchObject({
      authenticated: false,
      coarseAdminEligible: false,
    })
  } finally {
    Date.now = originalNow
    h.database.close()
  }
})

Deno.test('Worker signing denials require audit before returning and concurrent DO contexts stay separate', async () => {
  const h = await realHarness()
  try {
    const session = { ...facts(), roles: ['CorpusKit.Owner'] }
    const cookie = await sessionCookie(session)
    Object.assign(h.env, { WORKER_NAME: 'invalid-deployment' })
    const request = () => new Request('https://corpuskit.test/auth/me', { headers: { cookie } })
    expect((await worker.fetch(request(), h.env)).status).toBe(401)
    expect(
      h.state.rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
        event.action === 'request.denied'
      ),
    ).toBe(true)
    const ordinary = { ...facts(), oid: 'ordinary', roles: [] }
    const responses = await Promise.all([
      h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', session), {
        session,
      }),
      h.object.handleTrustedRequest(await principalRequest('/api/admin/overview', ordinary), {
        session: ordinary,
      }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 403])
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    )
    expect((await worker.fetch(request(), h.env)).status).toBe(500)
  } finally {
    h.database.close()
  }
})

Deno.test('real Worker and DO fail closed on audit outages and keep anonymous public requests usable', async () => {
  const h = await realHarness()
  try {
    const response = await worker.fetch(
      new Request('https://corpuskit.test/api/t/marine/config', {
        headers: {
          'x-corpuskit-principal': 'forged',
          'x-corpuskit-sso-session': JSON.stringify(facts()),
          'x-corpuskit-sso-admin': '1',
        },
      }),
      h.env,
    )
    expect(response.status).toBe(200)
    Object.assign(h.env, { ENTRA_CLIENT_SECRET: undefined })
    const me = await worker.fetch(new Request('https://corpuskit.test/auth/me'), h.env)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      authenticated: false,
      coarseAdminEligible: false,
      breakGlassEnabled: false,
    })
    h.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    )
    expect(
      (await h.object.fetch(
        new Request('https://corpuskit.test/api/health', {
          headers: { 'x-corpuskit-principal': 'forged' },
        }),
      )).status,
    ).toBe(500)
    expect(
      (await worker.fetch(
        new Request('https://corpuskit.test/api/admin/tenants', {
          headers: { 'x-admin-passcode': 'wrong' },
        }),
        h.env,
      )).status,
    ).toBe(500)
  } finally {
    h.database.close()
  }
})

/**
 * Deno cannot resolve Cloudflare's runtime-only `cloudflare:workers` module.
 * Replace only that platform base class, then import the actual worker module
 * so these tests execute its exported default fetch handler.
 */
async function loadWorker(): Promise<WorkerModule> {
  const workerUrl = new URL('./worker.ts', import.meta.url)
  const durableObjectShim =
    'data:application/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'
  const source = (await Deno.readTextFile(workerUrl))
    .replace("from 'cloudflare:workers'", `from '${durableObjectShim}'`)
    .replaceAll(
      /from '(\.\.?\/[^']+)'/g,
      (_match, specifier: string) => `from '${new URL(specifier, workerUrl).href}'`,
    )
  const moduleUrl = `data:application/typescript,${encodeURIComponent(source)}`
  return await import(moduleUrl) as WorkerModule
}

Deno.test('external handoff reaches the real Worker and durable roles across object restarts', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const key = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const mint = async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${
      part({
        iss: 'https://issuer.example',
        aud: 'dedicated-portal',
        sub: 'person-1',
        email: 'Person@Example.test',
        email_verified: true,
        name: 'Person',
        iat: now - 20,
        exp: now + 60,
        jti: crypto.randomUUID(),
        roles: ['CorpusKit.Owner'],
      })
    }`
    return `${content}.${
      encode(
        new Uint8Array(
          await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(content)),
        ),
      )
    }`
  }
  const directory = Deno.makeTempDirSync()
  try {
    for (const entra of [true, false]) {
      const settings = {
        WORKER_NAME: 'dedicated-portal',
        EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
        EXTERNAL_LOGIN_JWK: key,
        EXTERNAL_LOGIN_START_URL: 'https://issuer.example/start',
        ...(entra ? {} : { ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '', ENTRA_CLIENT_SECRET: '' }),
      }
      const path = `${directory}/${entra}.sqlite`
      let h = await realHarness(settings, undefined, path)
      try {
        h.state.rbac.assignmentService(
          entra ? 'entra-tenant-id' : 'external',
          'dedicated-portal',
          true,
        ).create({
          subjectKind: 'pending-email',
          subjectId: 'person@example.test',
          source: 'external',
          scope: { kind: 'portal', slug: 'marine' },
          role: 'analyst',
        }, { requestId: 'external-grant', actor: { kind: 'system' } })
        const stores = (h.object as unknown as { stores: DurableStores }).stores
        stores.tenants.patch('marine', { accessMode: 'restricted' })
        const token = await mint()
        const externalRequest = (returnTo = '/t/marine') =>
          new Request(
            `https://corpuskit.test/auth/external?${new URLSearchParams({
              assertion: token,
              returnTo,
            })}`,
          )
        const response = await worker.fetch(externalRequest(), h.env)
        expect(response.status).toBe(303)
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        const cookie = response.headers.get('set-cookie')!.split(';')[0]!
        const authenticated = (path: string) =>
          new Request(`https://corpuskit.test${path}`, { headers: { cookie } })
        const me = await worker.fetch(authenticated('/auth/me?portal=marine'), h.env)
        const body = await me.json()
        expect(body.authenticated).toBe(true)
        expect(body.sessionProvenance).toBe('external')
        expect(body.user.roles).toEqual([])
        expect(body.effectiveRoles).toEqual({ portalRoles: [{ slug: 'marine', role: 'analyst' }] })
        expect(body.portalAccess.permissions).toContain('portal.investigate')
        expect(body.entraEnabled).toBe(entra)
        expect((await worker.fetch(authenticated('/api/t/marine/config'), h.env)).status).toBe(200)
        // Authorisation and owned-store paths use the same external identity, with no provider call.
        const trail = await worker.fetch(
          new Request('https://corpuskit.test/api/t/marine/sessions/external-trail', {
            method: 'PUT',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'external-trail',
              title: 'External research',
              updatedAt: new Date().toISOString(),
              messages: [],
            }),
          }),
          h.env,
        )
        expect(trail.status).toBe(200)
        h.database.close()
        h = await realHarness(settings, undefined, path)
        expect((await worker.fetch(externalRequest(), h.env)).status).toBe(401)
        const afterRestart = await worker.fetch(authenticated('/auth/me?portal=marine'), h.env)
        expect((await afterRestart.json()).portalAccess.available).toBe(true)
        const rows = h.state.rbac.assignments.list(entra ? 'entra-tenant-id' : 'external')
        expect(rows.find((row) => row.source === 'external')).toMatchObject({
          subjectKind: 'active-oid',
          subjectId: 'ext:person-1',
        })
        expect(
          h.state.rbac.audit.read({ scope: { kind: 'platform' }, action: 'auth.external.denied' })
            .map((event) => JSON.parse(event.detail_json)),
        ).toEqual([{ externalReason: 'replay' }])
      } finally {
        h.database.close()
      }
    }
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('external-only Worker sets up its first owner through break-glass and an external sign-in', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const now = Math.floor(Date.now() / 1000)
  const content = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${
    part({
      iss: 'https://issuer.example',
      aud: 'dedicated-portal',
      sub: 'first-owner',
      email: 'First-Owner@Example.test',
      email_verified: true,
      iat: now - 5,
      exp: now + 60,
      jti: crypto.randomUUID(),
    })
  }`
  const signature = await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(content))
  const h = await realHarness({
    WORKER_NAME: 'dedicated-portal',
    ENTRA_TENANT_ID: '',
    ENTRA_CLIENT_ID: '',
    ENTRA_CLIENT_SECRET: '',
    ADMIN_BREAK_GLASS: 'true',
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  })
  try {
    const grant = (body: Record<string, unknown>) =>
      worker.fetch(
        new Request('https://corpuskit.test/api/admin/people', {
          method: 'POST',
          headers: {
            'x-admin-passcode': 'fixture',
            'cf-connecting-ip': '192.0.2.1',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            subjectKind: 'pending-email',
            subjectId: 'first-owner@example.test',
            role: 'owner',
            ...body,
          }),
        }),
        h.env,
      )
    // Without an Entra tenant an Entra row could never be claimed, so it is refused.
    for (const body of [{}, { source: 'entra' }]) {
      const refused = await grant(body)
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({ error: 'invalid_input' })
    }
    const created = await grant({ source: 'external' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ source: 'external', role: 'owner' })
    const handoff = await worker.fetch(
      new Request(
        `https://corpuskit.test/auth/external?${new URLSearchParams({
          assertion: `${content}.${encode(new Uint8Array(signature))}`,
          returnTo: '/admin',
        })}`,
      ),
      h.env,
    )
    expect(handoff.status).toBe(303)
    expect(handoff.headers.get('location')).toBe('/admin')
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    const me = await (await worker.fetch(
      new Request('https://corpuskit.test/auth/me', { headers: { cookie } }),
      h.env,
    )).json()
    expect(me).toMatchObject({
      entraEnabled: false,
      sessionProvenance: 'external',
      effectiveRoles: { platformRole: 'owner' },
    })
    const overview = await worker.fetch(
      new Request('https://corpuskit.test/api/admin/overview', { headers: { cookie } }),
      h.env,
    )
    expect(overview.status).toBe(200)
  } finally {
    h.database.close()
  }
})

Deno.test('Worker refuses external handoffs, cookies and envelopes once the issuer is removed', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const mint = async () => {
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
    return `${content}.${encode(new Uint8Array(signature))}`
  }
  const handoff = async (env: Env) =>
    worker.fetch(
      new Request(
        `https://corpuskit.test/auth/external?${new URLSearchParams({
          assertion: await mint(),
          returnTo: '/t/marine',
        })}`,
      ),
      env,
    )
  const enabled = await realHarness({
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  })
  const disabled = await realHarness()
  try {
    const issued = await handoff(enabled.env)
    expect(issued.status).toBe(303)
    const cookie = issued.headers.get('set-cookie')!.split(';')[0]!
    const me = (env: Env) =>
      worker.fetch(new Request('https://corpuskit.test/auth/me', { headers: { cookie } }), env)
    expect((await (await me(enabled.env)).json()).authenticated).toBe(true)
    // Same session key, no external configuration: the cookie is anonymous, not an identity.
    const ignored = await (await me(disabled.env)).json()
    expect(ignored.authenticated).toBe(false)
    expect(ignored.externalLogin).toBeNull()
    const refused = await handoff(disabled.env)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'external_login_invalid' })
    expect(refused.headers.get('set-cookie')).toBeNull()
    expect(
      disabled.state.rbac.audit.read({
        scope: { kind: 'platform' },
        action: 'auth.external.denied',
      }).map((event) => JSON.parse(event.detail_json)),
    ).toEqual([{ externalReason: 'configuration' }])
    // A correctly signed envelope for an external identity is refused, not downgraded.
    const external: TrustedSessionFacts = {
      verified: true,
      provenance: 'external',
      tenantId: 'external',
      oid: 'ext:person-1',
      email: 'person@example.test',
      roles: [],
      groups: [],
      groupStatus: 'absent',
      claimIssuedAt: Date.now() - 5_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    }
    const forged = await disabled.object.handleTrustedRequest(
      await principalRequest('/auth/me', external),
      { session: external },
    )
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({ error: 'invalid_principal' })
    const accepted = await enabled.object.handleTrustedRequest(
      await principalRequest('/auth/me', external),
      { session: external },
    )
    expect((await accepted.json()).authenticated).toBe(true)
  } finally {
    enabled.database.close()
    disabled.database.close()
  }
})

Deno.test('Worker caps failed handoff audit records per client address in the Durable Object', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const h = await realHarness({
    EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
    EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  })
  const handoff = (address: string) =>
    worker.fetch(
      new Request('https://corpuskit.test/auth/external?assertion=not-a-signed-assertion', {
        headers: { 'cf-connecting-ip': address },
      }),
      h.env,
    )
  const records = () =>
    h.state.rbac.audit.read({ scope: { kind: 'platform' }, action: 'auth.external.denied' })
      .map((event) => JSON.parse(event.detail_json))
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const refused = await handoff('192.0.2.10')
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual({ error: 'external_login_invalid' })
    }
    expect(records()).toEqual([{ externalReason: 'encoding' }])
    expect((await handoff('198.51.100.20')).status).toBe(401)
    expect(records()).toHaveLength(2)
    expect(records()).toContainEqual({ externalReason: 'encoding', count: 5 })
  } finally {
    h.database.close()
  }
})

// Operator credential (hosting automation) combined with external sign-in and Entra sign-in.
const hostingOperatorKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

async function externalIssuer(audience = 'corpuskit') {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const encoder = new TextEncoder()
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const part = (value: unknown) => encode(encoder.encode(JSON.stringify(value)))
  const mint = async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${
      part({
        iss: 'https://issuer.example',
        aud: audience,
        sub: 'person-1',
        email: 'person@example.test',
        email_verified: true,
        iat: now - 5,
        exp: now + 60,
        jti: crypto.randomUUID(),
      })
    }`
    const signature = await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(content))
    return `${content}.${encode(new Uint8Array(signature))}`
  }
  return {
    env: {
      WORKER_NAME: audience,
      EXTERNAL_LOGIN_ISSUER: 'https://issuer.example',
      EXTERNAL_LOGIN_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    },
    mint,
    url: (assertion: string, origin = 'https://corpuskit.test', returnTo = '/t/marine') =>
      `${origin}/auth/external?${new URLSearchParams({ assertion, returnTo })}`,
  }
}

Deno.test('Worker operator credential beside an external session cookie never reads or upgrades the session', async () => {
  const issuer = await externalIssuer()
  const h = await realHarness({
    ...issuer.env,
    OPERATOR_API_KEY: hostingOperatorKey,
    OPERATOR_ID: 'hosting-test',
  })
  try {
    const assignments = h.state.rbac.assignmentService('entra-tenant-id', 'corpuskit', true)
    assignments.create({
      subjectKind: 'pending-email',
      subjectId: 'person@example.test',
      source: 'external',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'analyst',
    }, { requestId: 'external-grant', actor: { kind: 'system' } })
    const handoff = await worker.fetch(new Request(issuer.url(await issuer.mint())), h.env)
    expect(handoff.status).toBe(303)
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    const call = (path: string, init: RequestInit = {}, authorization?: string) => {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      headers.set('cf-connecting-ip', '192.0.2.10')
      if (authorization) headers.set('authorization', authorization)
      return worker.fetch(new Request(`https://corpuskit.test${path}`, { ...init, headers }), h.env)
    }
    const operator = `Operator ${hostingOperatorKey}`
    const earlier = new Set(
      h.state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }).map((event) =>
        event.id
      ),
    )

    // A flagged admin route: the operator acts, and the external session is never read.
    const created = await call('/api/admin/t/marine/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectKind: 'pending-email',
        subjectId: 'reader@example.test',
        source: 'external',
        role: 'viewer',
      }),
    }, operator)
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ source: 'external', role: 'viewer' })
    const pending = h.state.rbac.assignments.list('entra-tenant-id')
      .filter((row) => row.source === 'external')
    // The session's own pending assignment was not activated by the operator request.
    expect(pending.map((row) => [row.subjectKind, row.subjectId]).sort()).toEqual([
      ['pending-email', 'person@example.test'],
      ['pending-email', 'reader@example.test'],
    ])

    // Unflagged routes refuse the operator and never fall back to the session's own access.
    for (const path of ['/api/t/marine/config', '/auth/me', '/auth/external']) {
      const refused = await call(path, {}, operator)
      expect([path, refused.status]).toEqual([path, 403])
      expect(await refused.json()).toEqual({ error: 'operator_not_allowed' })
    }
    // A wrong operator key beside a valid session is refused rather than treated as the session.
    const wrong = await call('/api/t/marine/config', {}, `Operator ${'A'.repeat(43)}`)
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'invalid_operator' })

    const operatorEvents = h.state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
      .filter((event) => !earlier.has(event.id))
    expect(operatorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(operatorEvents)).not.toContain('ext:person-1')
    expect(JSON.stringify(operatorEvents)).not.toContain(hostingOperatorKey)
    expect(
      operatorEvents.filter((event) => event.actor_kind !== 'anonymous')
        .every((event) =>
          event.actor_kind === 'operator' && event.actor_id === 'operator:hosting-test'
        ),
    ).toBe(true)

    // The same cookie alone is still only the external person, with only its own assignment.
    const me = await (await call('/auth/me?portal=marine')).json()
    expect(me).toMatchObject({
      authenticated: true,
      sessionProvenance: 'external',
      effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'analyst' }] },
    })
    expect(me.effectiveRoles.platformRole).toBeUndefined()
    expect((await call('/api/t/marine/config')).status).toBe(200)
    const platformRoute = await call('/api/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Not Allowed' }),
    })
    expect(platformRoute.status).toBe(403)
  } finally {
    h.database.close()
  }
})

Deno.test('an external identity never becomes the operator principal', async () => {
  const issuer = await externalIssuer()
  const h = await realHarness({
    ...issuer.env,
    OPERATOR_API_KEY: hostingOperatorKey,
    OPERATOR_ID: 'hosting-test',
  })
  try {
    const external: TrustedSessionFacts = {
      verified: true,
      provenance: 'external',
      tenantId: 'external',
      oid: 'ext:person-1',
      email: 'person@example.test',
      roles: [],
      groups: [],
      groupStatus: 'absent',
      claimIssuedAt: Date.now() - 5_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    }
    // A verified external envelope is a session principal with no operator marker or platform role.
    const principal = await h.object.requestPrincipal(
      await principalRequest('/api/admin/tenants', external),
      { session: external },
    )
    expect(principal.operator).toBeUndefined()
    expect(principal.session?.provenance).toBe('external')
    expect(principal.effectiveRoles).toEqual({ portalRoles: [] })
    // A genuine operator envelope arriving with an external session is refused outright.
    const operatorEnvelope = await signPrincipal({
      v: 1,
      kind: 'operator',
      aud: 'corpuskit',
      id: 'hosting-test',
      iat: Math.floor(Date.now() / 1000),
    }, secret)
    const combined = await h.object.handleTrustedRequest(
      new Request('https://corpuskit.test/api/admin/tenants', {
        headers: { 'x-corpuskit-principal': operatorEnvelope },
      }),
      { session: external },
    )
    expect(combined.status).toBe(401)
    expect(await combined.json()).toEqual({ error: 'invalid_principal' })
    // An operator envelope naming the external identity is not the configured operator.
    const impersonation = await h.object.handleTrustedRequest(
      new Request('https://corpuskit.test/api/admin/tenants', {
        headers: {
          'x-corpuskit-principal': await signPrincipal({
            v: 1,
            kind: 'operator',
            aud: 'corpuskit',
            id: 'ext:person-1',
            iat: Math.floor(Date.now() / 1000),
          }, secret),
        },
      }),
      {},
    )
    expect(impersonation.status).toBe(401)
    // Through the Worker, the external session is refused on an operator-flagged platform route
    // and audited as itself.
    const handoff = await worker.fetch(new Request(issuer.url(await issuer.mint())), h.env)
    const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
    const refused = await worker.fetch(
      new Request('https://corpuskit.test/api/admin/tenants', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Hosted Lab' }),
      }),
      h.env,
    )
    expect(refused.status).toBe(403)
    const denial = h.state.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
      .find((event) => event.action === 'request.denied' && event.actor_id === 'ext:person-1')
    expect(denial?.actor_kind).toBe('user')
    const stores = (h.object as unknown as { stores: DurableStores }).stores
    expect(stores.tenants.get('hosted-lab')).toBeUndefined()
  } finally {
    h.database.close()
  }
})

Deno.test('Worker serves /auth/external without Entra after platform-domain and operator checks', async () => {
  const issuer = await externalIssuer()
  const h = await realHarness({
    ...issuer.env,
    ENTRA_TENANT_ID: '',
    ENTRA_CLIENT_ID: '',
    ENTRA_CLIENT_SECRET: '',
    OPERATOR_API_KEY: hostingOperatorKey,
    PLATFORM_DOMAIN: 'research.example.org',
  })
  try {
    const origin = 'https://research.example.org'
    const assertion = await issuer.mint()
    // Platform-domain validation comes first and leaves the assertion unused.
    const invalid = await worker.fetch(
      new Request(issuer.url(assertion, origin)),
      { ...h.env, PLATFORM_DOMAIN: 'research.example.org/"' } as Env,
    )
    expect(invalid.status).toBe(503)
    expect(await invalid.json()).toEqual({ error: 'platform_domain_invalid' })
    // An operator credential on the handoff is refused as a non-API route and consumes nothing.
    const operatorAttempt = await worker.fetch(
      new Request(issuer.url(assertion, origin), {
        headers: { authorization: `Operator ${hostingOperatorKey}` },
      }),
      h.env,
    )
    expect(operatorAttempt.status).toBe(403)
    expect(operatorAttempt.headers.get('set-cookie')).toBeNull()
    // The handoff itself works with Entra unconfigured, scoped to the configured platform domain.
    const handoff = await worker.fetch(new Request(issuer.url(assertion, origin)), h.env)
    expect(handoff.status).toBe(303)
    expect(handoff.headers.get('location')).toBe('/t/marine')
    const setCookie = handoff.headers.get('set-cookie')!
    expect(setCookie).toContain('Domain=research.example.org')
    const cookie = setCookie.split(';')[0]!
    const me = await (await worker.fetch(
      new Request(`${origin}/auth/me`, { headers: { cookie } }),
      h.env,
    )).json()
    expect(me).toMatchObject({
      authenticated: true,
      sessionProvenance: 'external',
      entraEnabled: false,
      externalLoginEnabled: true,
    })
    // Only the Microsoft routes report that Microsoft sign-in is not configured.
    for (const path of ['/auth/login', '/auth/callback']) {
      const response = await worker.fetch(new Request(`${origin}${path}`), h.env)
      expect([path, response.status]).toEqual([path, 503])
      expect(await response.json()).toEqual({ error: 'microsoft_sign_in_not_configured' })
    }
  } finally {
    h.database.close()
  }
})

Deno.test('Worker Entra sign-in is unchanged beside external sign-in and the operator credential', async () => {
  const issuer = await externalIssuer()
  const h = await realHarness({
    ...issuer.env,
    OPERATOR_API_KEY: hostingOperatorKey,
    OPERATOR_ID: 'hosting-test',
  })
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const encode = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const text = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)))
  const original = globalThis.fetch
  let nonce = ''
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('openid-configuration')) {
      return Response.json({
        issuer: 'https://issuer.test',
        jwks_uri: 'https://issuer.test/keys',
        token_endpoint: 'https://issuer.test/token',
        authorization_endpoint: 'https://issuer.test/authorize',
      })
    }
    if (url.endsWith('/keys')) return Response.json({ keys: [{ ...publicKey, kid: 'test' }] })
    if (url.endsWith('/token')) {
      const content = `${text({ alg: 'RS256', kid: 'test' })}.${
        text({
          aud: '147a13c9-2a9e-4e32-aa01-3f020d2a18cd',
          iss: 'https://issuer.test',
          tid: 'entra-tenant-id',
          oid: 'entra-person',
          email: 'entra.person@example.test',
          nonce,
          iat: Math.floor(Date.now() / 1000) - 60,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      }`
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(content),
      )
      return Response.json({ id_token: `${content}.${encode(new Uint8Array(signature))}` })
    }
    throw new Error('Unexpected fixture request')
  }
  try {
    h.state.rbac.assignmentService('entra-tenant-id', 'corpuskit', true).create({
      subjectKind: 'active-oid',
      subjectId: 'entra-person',
      scope: { kind: 'portal', slug: 'marine' },
      role: 'viewer',
    }, { requestId: 'entra-grant', actor: { kind: 'system' } })
    const login = await worker.fetch(new Request('https://corpuskit.org/auth/login'), h.env)
    expect(login.status).toBe(302)
    const location = new URL(login.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://issuer.test/authorize')
    nonce = location.searchParams.get('nonce')!
    const callback = await worker.fetch(
      new Request(
        `https://corpuskit.org/auth/callback?code=test&state=${location.searchParams.get('state')}`,
        { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } },
      ),
      h.env,
    )
    expect(callback.status).toBe(302)
    const cookie = callback.headers.getSetCookie().find((value) =>
      value.startsWith('__Secure-corpuskit_session=')
    )!.split(';')[0]!
    const me = await (await worker.fetch(
      new Request('https://corpuskit.org/auth/me?portal=marine', { headers: { cookie } }),
      h.env,
    )).json()
    expect(me).toMatchObject({
      authenticated: true,
      sessionProvenance: 'entra',
      user: { id: 'entra-person', provenance: 'entra' },
      entraEnabled: true,
      externalLoginEnabled: true,
      effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'viewer' }] },
    })
    // The Entra session is not upgraded by an operator credential either.
    const combined = await worker.fetch(
      new Request('https://corpuskit.org/api/t/marine/config', {
        headers: { cookie, authorization: `Operator ${hostingOperatorKey}` },
      }),
      h.env,
    )
    expect(combined.status).toBe(403)
    expect(await combined.json()).toEqual({ error: 'operator_not_allowed' })
  } finally {
    globalThis.fetch = original
    h.database.close()
  }
})
