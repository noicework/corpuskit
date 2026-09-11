import { expect } from '@std/expect'
import { Hono } from 'hono'
import { buildApp } from './app.ts'
import type { RetrievalProvider } from '@research-portal/retrieval'
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
