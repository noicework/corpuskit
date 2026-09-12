import { expect } from '@std/expect'
import { Hono } from 'hono'
import { buildApp } from './app.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import {
  assertDeclarationInventory,
  assertRouteInventory,
  declarationFor,
  DECLARATIONS,
  matchedDeclaration,
  registerInfrastructure,
} from './permissions.ts'
import { assertExpectedPermission, createEnforcementFixture } from './enforcement-fixture.ts'

Deno.test('global gate blocks injected routes without a startup inventory and audits refusal', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
    const f = createEnforcementFixture()
    try {
      let calls = 0
      f.app.all('/api/future', (c) => {
        calls++
        return c.json({ secret: true })
      })
      const response = await f.requestAs(f.sessionFor('owner'), '/api/future', { method })
      expect(response.status).toBe(403)
      expect(calls).toBe(0)
      expect(
        f.rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
          event.request_id === response.headers.get('x-request-id') && event.outcome === 'denied'
        ),
      ).toBe(true)
      f.failAudit()
      expect((await f.requestAs(null, '/api/future', { method })).status).toBe(500)
      expect(calls).toBe(0)
    } finally {
      f.close()
    }
  }
})

Deno.test('global gate has no legacy, coarse context, missing state or OPTIONS authority', async () => {
  const f = createEnforcementFixture()
  try {
    const forged = {
      'x-corpuskit-sso-admin': '1',
      'x-corpuskit-sso-user-id': 'owner',
      'x-corpuskit-sso-extra': 'owner',
      'x-sso-admin': '1',
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (
        const path of [
          '/api/admin/overview',
          '/api/admin/unknown',
          '/api/t/a/catalog',
          '/api/t/a/mcp',
          '/api/t/a/unknown',
        ]
      ) {
        const response = await f.requestAs(null, path, { method, headers: forged })
        expect(response.status).toBe(401)
        f.assertNoProtectedDispatch()
      }
    }
    const preflight = await f.requestAs(null, '/api/admin/t/a/reingest', {
      method: 'OPTIONS',
      headers: { origin: 'https://source.test', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    f.assertNoProtectedDispatch()
    const allowed = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/catalog', {
      headers: forged,
    })
    expect(allowed.status).toBe(200)
    expect(f.providerCalls.some((call) => call.method === 'catalog')).toBe(true)
    expect((await allowed.json()).items.length).toBeGreaterThan(0)
    const before = f.providerCalls.length
    expect(
      (await f.requestAs(f.sessionFor('viewer'), '/api/admin/overview', { headers: forged }))
        .status,
    ).toBe(403)
    f.assertNoProtectedDispatch(before)
    const missing = buildApp({
      provider: f.provider,
      tenants: f.stores.tenants,
      audit: f.rbac.audit,
      requestContext: () => ({
        requestId: crypto.randomUUID(),
        session: null,
        coarseAdminEligible: true,
      }),
    })
    for (const path of ['/api/t/public-a/catalog', '/api/tenants', '/api/admin/overview']) {
      expect((await missing.request(path, { headers: forged })).status).toBe(401)
      f.assertNoProtectedDispatch(before)
    }
    expect((await missing.request('/api/health')).status).toBe(200)
    f.failAudit()
    expect((await missing.request('/api/t/public-a/catalog')).status).toBe(500)
    f.assertNoProtectedDispatch(before)
  } finally {
    f.close()
  }
})

Deno.test('declarations explicitly distinguish aggregate, safe metadata and research ownership', () => {
  for (
    const [method, path, permission] of [
      ['GET', '/api/tenants', 'portal.read'],
      ['POST', '/api/ask-estate', 'portal.ask'],
    ] as const
  ) {
    expect(declarationFor(method, path)).toMatchObject({
      scope: 'portal',
      permission,
      aggregate: 'authorised-portals',
    })
  }
  expect(declarationFor('GET', '/api/t/:slug/config')).toMatchObject({
    scope: 'portal',
    portalTarget: 'url-slug',
    safeMetadata: true,
  })
  expect(declarationFor('GET', '/api/t/:slug/config').reason).toContain('D9')
  for (
    const path of ['/api/t/:slug/sessions', '/api/t/:slug/investigations', '/api/t/:slug/watches']
  ) {
    expect(declarationFor('GET', path).owned).toBe('research')
  }
  assertExpectedPermission('GET', '/api/t/:slug/catalog', 'portal.read', 'portal')
  expect(() => assertExpectedPermission('GET', '/api/t/:slug/catalog', 'portal.ask', 'portal'))
    .toThrow()
})

Deno.test('inventory rejects undeclared, stale and duplicate concrete operations', () => {
  const app = buildApp({ provider: new DoubleProvider() })
  assertRouteInventory(app)
  expect(() => assertDeclarationInventory([...DECLARATIONS, DECLARATIONS[0]!])).toThrow()
  expect(() =>
    assertRouteInventory(app, [...DECLARATIONS, {
      ...declarationFor('GET', '/api/health'),
      path: '/stale',
    }])
  ).toThrow()
  app.get('/api/health', (c) => c.json({ duplicate: true }))
  expect(() => assertRouteInventory(app)).toThrow()
  const missing = buildApp({ provider: new DoubleProvider() })
  missing.get('/api/admin/undeclared', (c) => c.text('unprotected'))
  expect(() => assertRouteInventory(missing)).toThrow()
})

Deno.test('matched registration resolves exact operations through infrastructure, HEAD and ALL', async () => {
  const app = new Hono()
  let protectedCalls = 0
  registerInfrastructure(app, '*', async (c, next) => {
    const declaration = matchedDeclaration(c)
    c.header('x-operation', `${declaration.method} ${declaration.path}`)
    await next()
  })
  app.get('/api/t/:slug/catalog', (c) => {
    protectedCalls++
    return c.json({ items: ['seeded-document'] })
  })
  app.all('/api/t/:slug/mcp', (c) => c.json({ transport: true }))
  app.get('/api/t/:slug/undeclared', (c) => {
    protectedCalls++
    return c.text('must not dispatch')
  })
  app.onError((_error, c) => c.json({ error: 'undeclared' }, 500))
  const response = await app.request('/api/t/a/catalog')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: ['seeded-document'] })
  expect(response.headers.get('x-operation')).toBe('GET /api/t/:slug/catalog')
  expect((await app.request('/api/t/a/catalog', { method: 'HEAD' })).status).toBe(200)
  expect((await app.request('/api/t/a/mcp', { method: 'OPTIONS' })).headers.get('x-operation'))
    .toBe('ALL /api/t/:slug/mcp')
  const before = protectedCalls
  expect((await app.request('/api/t/a/undeclared')).status).toBe(500)
  expect(protectedCalls).toBe(before)
})
