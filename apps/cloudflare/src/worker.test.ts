/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { expect } from '@std/expect'
import { DOC_PAGES } from '../../../packages/core/src/docs.ts'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DurableState } from './state.ts'
import {
  type PrincipalEnvelope,
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
          requestPrincipal() {
            return Promise.resolve({
              requestId: 'fixture',
              session: null,
              coarseAdminEligible: false,
            })
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
  extra: Partial<PrincipalEnvelope> = {},
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
async function realHarness(extraEnv: Record<string, string> = {}, legacyBindings?: unknown) {
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

Deno.test('Worker startup migrates legacy binding credentials before serving requests', async () => {
  for (const configured of [false, true]) {
    const token = 'fixture-only-stored-credential'
    const h = await realHarness(configured ? { BINDING_KEY: btoa('x'.repeat(32)) } : {}, {
      marine: {
        baseUrl: 'https://example.test/kb/marine',
        token,
        connectedAt: '2026-01-01T00:00:00Z',
      },
    })
    try {
      const health = await worker.fetch(new Request('https://corpuskit.test/api/health'), h.env)
      expect(health.status).toBe(200)
      expect((await health.json()).bindingEncryption).toEqual({
        configured,
        required: true,
        writable: configured,
      })
      const binding = await worker.fetch(
        new Request('https://corpuskit.test/api/t/marine/knowledge-box'),
        h.env,
      )
      expect(binding.status).toBe(200)
      const body = await binding.text()
      expect(JSON.parse(body).status).toBe('connected')
      expect(body).not.toContain(token)
      const stored = h.state.get<Record<string, { token: string }>>('bindings', {})
      if (configured) expect(stored.marine?.token).toMatch(/^enc:v1:/)
      else expect(stored.marine?.token).toBe(token)
    } finally {
      h.database.close()
    }
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
