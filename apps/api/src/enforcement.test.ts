import { expect } from '@std/expect'
import { Hono } from 'hono'
import { buildApp } from './app.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import {
  assertDeclarationInventory,
  assertRouteInventory,
  assertToolInventory,
  declarationFor,
  DECLARATIONS,
  matchedDeclaration,
  registerInfrastructure,
} from './permissions.ts'
import { assertExpectedPermission, createEnforcementFixture } from './enforcement-fixture.ts'
import {
  ADMIN_MATRIX_ROWS,
  assertCompleteHttpInventory,
  PORTAL_MATRIX_ROWS,
  runAdminMatrixRow,
  runPortalMatrixRow,
} from './enforcement-fixture.ts'
import { runAccessMatrix, runAuditMatrix } from './enforcement-fixture.ts'
import './cold-read-enforcement.test.ts'

Deno.test('complete HTTP matrix: members and groups', runAccessMatrix)
Deno.test('complete HTTP matrix: audit and exports', runAuditMatrix)

Deno.test('independent expected role mutation is rejected by the behavioural runner', async () => {
  const row = PORTAL_MATRIX_ROWS.find((r) => r[1] === '/api/t/:slug/summarize')!
  await expect(runPortalMatrixRow([row[0], row[1], row[2], 'viewer', row[4]])).rejects.toThrow()
})

Deno.test('real MCP list and every call equal independent inventory and reject unknown tools', async () => {
  const cases = [
    ['search_corpus', { query: 'Abalone' }, 'portal.read', 'search'],
    ['get_document', { id: 'res-1' }, 'portal.read', 'resource'],
    ['browse_catalogue', {}, 'portal.read', 'catalog'],
    ['answer_question', { question: 'Abalone evidence?' }, 'portal.ask', 'ask'],
  ] as const
  const f = createEnforcementFixture()
  const rpc = (method: string, params?: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  try {
    const list = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/mcp', rpc('tools/list'))
    expect(list.status).toBe(200)
    const names = (await list.json()).result.tools.map((tool: { name: string }) => tool.name)
    expect(names.sort()).toEqual(cases.map(([name]) => name).sort())
    assertToolInventory(names)
    for (const invalid of [names.slice(1), [...names, 'undeclared_tool'], [...names, names[0]]]) {
      expect(() => assertToolInventory(invalid)).toThrow()
    }
    for (const [name, args, permission, dispatch] of cases) {
      expect(DECLARATIONS.find((d) => d.kind === 'mcp' && d.path === name)?.permission).toBe(
        permission,
      )
      for (const denied of [null, f.unassigned, f.sessionFor('viewer', 'b')]) {
        const before = f.providerCalls.length
        expect(
          (await f.requestAs(denied, '/api/t/a/mcp', rpc('tools/call', { name, arguments: args })))
            .status,
        ).toBe(denied ? 403 : 401)
        f.assertNoProtectedDispatch(before)
      }
      const before = f.providerCalls.length
      const response = await f.requestAs(
        f.sessionFor('viewer'),
        '/api/t/a/mcp',
        rpc('tools/call', { name, arguments: args }),
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.result.isError).not.toBe(true)
      expect(JSON.stringify(body.result)).toContain('res-1')
      expect(f.providerCalls.slice(before).map((c) => c.method)).toContain(dispatch)
    }
    const before = f.providerCalls.length
    const unknown = await f.requestAs(
      f.sessionFor('viewer'),
      '/api/t/a/mcp',
      rpc('tools/call', { name: 'undeclared_tool', arguments: {} }),
    )
    const result = await unknown.json()
    expect(Boolean(result.error || result.result?.isError)).toBe(true)
    f.assertNoProtectedDispatch(before)
  } finally {
    f.close()
  }
})

Deno.test('complete inventory detects removed, added, duplicate and changed independent policy', () => {
  const app = buildApp({ provider: new DoubleProvider() })
  const target = declarationFor('GET', '/api/t/:slug/catalog')
  for (
    const declarations of [
      DECLARATIONS.filter((d) => d !== target),
      [...DECLARATIONS, { ...target, path: '/api/future' }],
      [...DECLARATIONS, target],
      DECLARATIONS.map((d) => d === target ? { ...d, permission: 'portal.generate' as const } : d),
    ]
  ) expect(() => assertCompleteHttpInventory(app, declarations)).toThrow()
  app.get('/api/future', (c) => c.text('undeclared'))
  expect(() => assertCompleteHttpInventory(app)).toThrow()
})

for (const row of ADMIN_MATRIX_ROWS) {
  Deno.test(`complete HTTP matrix: ${row[0]} ${row[1]}`, () => runAdminMatrixRow(row))
}

for (const row of PORTAL_MATRIX_ROWS) {
  Deno.test(`complete HTTP matrix: ${row[0]} ${row[1]}`, () => runPortalMatrixRow(row))
}
Deno.test('independent fixture registry equals actual registrations and declarations', () => {
  assertCompleteHttpInventory(buildApp({ provider: new DoubleProvider() }))
})

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
