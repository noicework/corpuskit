import { expect } from '@std/expect'
import { Hono } from 'hono'
import type { AuditEvent } from './audit.ts'
import { TenantStore } from './tenants.ts'
import { buildApp } from './app.ts'
import { AragApiError, type AragProvider, type RetrievalProvider } from '@research-portal/retrieval'
import { createMcpServer, type McpRoutesOptions } from './mcp.ts'
import {
  assertRouteInventory,
  assertToolInventory,
  declarationFor,
  DECLARATIONS,
  declaredRoute,
  declaredSubAction,
  declaredTool,
  isPrivileged,
} from './permissions.ts'

Deno.test('real privileged responses retain errors and never escape failed completion audit', async () => {
  for (const mode of ['success', 'throw', 'denied', 'audit'] as const) {
    const events: AuditEvent[] = []
    const app = buildApp({
      provider: {} as RetrievalProvider,
      management: {
        counters: () => {
          if (mode === 'throw') throw new Error('provider-failure')
          return { resources: 4 }
        },
        createText: () => {
          throw new AragApiError(403, 'private-provider', 'private-body')
        },
      } as unknown as AragProvider,
      audit: {
        append: (event) => {
          if (mode === 'audit' && events.length === 1) throw new Error('private')
          events.push(event)
        },
        read: () => events,
      },
      requestContext: () => ({
        requestId: 'real-request',
        session: null,
        coarseAdminEligible: true,
        effectiveRoles: { platformRole: 'owner', portalRoles: [] },
        actor: { kind: 'user', id: 'real-user' },
      }),
    })
    const response = await app.request(
      mode === 'denied' ? '/api/admin/t/marine/resources/text' : '/api/admin/t/marine/counters',
      mode === 'denied'
        ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Title', body: 'Content' }),
        }
        : {},
    )
    expect(response.status).toBe(mode === 'success' ? 200 : mode === 'denied' ? 403 : 500)
    if (mode !== 'audit') {
      expect(events[1]?.outcome).toBe(
        mode === 'success' ? 'success' : mode === 'denied' ? 'denied' : 'failure',
      )
    }
    expect(events.every((e) => e.request_id === 'real-request' && e.actor_id === 'real-user')).toBe(
      true,
    )
    expect(JSON.stringify(events)).not.toContain('private')
    await response.text()
  }
})

Deno.test('Hono privileged SSE completes audit before response release and records logical failure', async () => {
  for (const failAt of [0, 2]) {
    const events: AuditEvent[] = []
    const app = buildApp({
      provider: {} as RetrievalProvider,
      management: {} as AragProvider,
      audit: {
        append: (event) => {
          if (events.length + 1 === failAt) throw new Error('private')
          events.push(event)
        },
        read: () => events,
      },
      requestContext: () => ({
        requestId: 'stream-request',
        session: null,
        coarseAdminEligible: true,
        effectiveRoles: { platformRole: 'owner', portalRoles: [] },
      }),
    })
    // The real enrichment stream catches its missing provider method and emits an error event.
    const response = await app.request('/api/admin/t/marine/enrichments/run', {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(failAt ? 500 : 200)
    if (!failAt) {
      expect(events.map((e) => e.outcome)).toEqual(['intent', 'failure'])
      expect(await response.text()).toContain('"type":"error"')
    } else expect(await response.json()).toEqual({ error: 'audit_write_failed' })
  }
})

Deno.test('every privileged HTTP declaration enters mandatory audit before its handler', async (t) => {
  for (const declaration of DECLARATIONS.filter((d) => d.kind === 'http' && isPrivileged(d))) {
    await t.step(`${declaration.method} ${declaration.path}`, async () => {
      const events: AuditEvent[] = []
      const app = buildApp({
        provider: {} as RetrievalProvider,
        tenants: new TenantStore({}),
        audit: {
          append: (event) => {
            events.push(event)
          },
          read: () => events,
        },
        requestContext: () => ({
          requestId: 'inventory-request',
          session: null,
          coarseAdminEligible: true,
          effectiveRoles: { platformRole: 'owner', portalRoles: [] },
          actor: { kind: 'user', id: 'inventory-user' },
        }),
      })
      const path = declaration.path.replace(/:[^/]+/g, 'fixture')
      const response = await app.request(path, {
        method: declaration.method,
        ...(declaration.method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      })
      await response.text()
      expect(events[0]?.outcome).toBe('intent')
      expect(events[0]?.actor_id).toBe('inventory-user')
      expect(events[0]?.request_id).toBe('inventory-request')
      expect(events[0]?.scope_kind).toBe(declaration.scope)
      expect(events[0]?.target_id).toBe(declaration.target.param ? 'fixture' : null)
      expect(JSON.parse(events[0]!.detail_json).permission).toBe(declaration.permission)
      expect(events.at(-1)?.outcome).not.toBe('intent')
      let dispatches = 0
      const failing = buildApp({
        provider: new Proxy({}, {
          get: () => {
            dispatches++
            throw new Error('dispatch')
          },
        }) as RetrievalProvider,
        audit: {
          append: () => {
            throw new Error('private-audit')
          },
          read: () => [],
        },
        requestContext: () => ({
          requestId: 'inventory-request',
          session: null,
          coarseAdminEligible: true,
          effectiveRoles: { platformRole: 'owner', portalRoles: [] },
        }),
      })
      expect((await failing.request(path, { method: declaration.method })).status).toBe(500)
      expect(dispatches).toBe(0)
    })
  }
})

Deno.test('denials have one request correlation and failed required appends return 500', async () => {
  for (const fail of [false, true]) {
    const events: AuditEvent[] = []
    const app = buildApp({
      provider: {} as RetrievalProvider,
      audit: {
        append: (event) => {
          if (fail) throw new Error('private')
          events.push(event)
        },
        read: () => events,
      },
      requestContext: () => ({
        requestId: 'denied-request',
        session: null,
        coarseAdminEligible: false,
      }),
    })
    const response = await app.request('/api/admin/t/marine/counters')
    expect(response.status).toBe(fail ? 500 : 401)
    if (!fail) {
      expect(events).toHaveLength(1)
      expect(events[0]!.request_id).toBe('denied-request')
      expect(events[0]!.scope_slug).toBe('marine')
    }
  }
})

Deno.test('actual routes equal the sole declaration inventory in both directions', () => {
  const app = buildApp({ provider: {} as RetrievalProvider })
  assertRouteInventory(app)
  app.get('/api/admin/future', (c) => c.json({ ok: true }))
  expect(() => assertRouteInventory(app)).toThrow()
  expect(() => assertRouteInventory(new Hono())).toThrow()
  expect(() => declaredRoute('POST', '/api/future')).toThrow()
  expect(() => declaredTool('future_tool')).toThrow()
})

Deno.test('actual MCP tools/list equals declarations in both directions', async () => {
  const server = createMcpServer({
    provider: {} as RetrievalProvider,
    tenant: () => undefined,
    keys: {} as McpRoutesOptions['keys'],
  })
  await server.connected
  try {
    const response = await server.transport.handleRequest(
      new Request('https://local.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    const names = (await response.json()).result.tools.map((tool: { name: string }) => tool.name)
    assertToolInventory(names)
    expect(() => assertToolInventory([...names, 'future_tool'])).toThrow()
    expect(() => assertToolInventory(names.slice(1))).toThrow()
    expect(DECLARATIONS.filter((item) => item.kind === 'mcp').every((item) => !isPrivileged(item)))
      .toBe(true)
  } finally {
    await server.transport.close()
  }
})

Deno.test('Worker authentication and static boundaries stay separate from Hono handlers', async () => {
  const worker = await Deno.readTextFile(new URL('../../cloudflare/src/worker.ts', import.meta.url))
  expect(worker).toContain("url.pathname.startsWith('/auth/')")
  expect(worker).toContain('env.ASSETS.fetch(marketingHomeRequest(request))')
  const boundaries = DECLARATIONS.filter((item) => item.kind === 'boundary')
  expect(boundaries.map((item) => item.path)).toEqual(['/auth/*', 'static-assets'])
  expect(boundaries.every((item) => item.scope === 'public' && !!item.reason)).toBe(true)
})

Deno.test('privileged and mixed route declarations are explicit without enforcement', () => {
  for (const declaration of DECLARATIONS) {
    if (declaration.scope === 'public') expect(declaration.reason!.length).toBeGreaterThan(10)
    if (declaration.kind === 'http' && declaration.path.startsWith('/api/admin/')) {
      expect(isPrivileged(declaration)).toBe(true)
    }
  }
  const questions = declarationFor('GET', '/api/t/:slug/resources/:id/questions')
  expect(isPrivileged(questions)).toBe(false)
  expect(questions.subActions?.map((action) => action.action)).toEqual([
    'resource.questions.generate',
    'resource.questions.cache',
  ])
  expect(
    declaredSubAction('GET', questions.path, 'resource.questions.generate', (d) => d.permission),
  )
    .toBe('portal.generate')
  expect(() => declaredSubAction('GET', questions.path, 'unknown', () => null)).toThrow()
  expect(isPrivileged(questions, { kind: 'break-glass' })).toBe(true)
  expect(declarationFor('HEAD', '/api/t/:slug/search')).toBe(
    declarationFor('GET', '/api/t/:slug/search'),
  )
  const patch = declarationFor('PATCH', '/api/admin/tenants/:slug')
  expect(patch.subActions?.map((action) => action.permission)).toEqual([
    'appearance.write',
    'behaviour.write',
  ])
})
