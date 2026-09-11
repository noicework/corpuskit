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
import { assertExpectedPermission } from './enforcement-fixture.ts'

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
