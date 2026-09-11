import { expect } from '@std/expect'
import { Hono } from 'hono'
import type { AuditEvent } from './audit.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'
import { buildApp as buildRawApp, type BuildAppOptions } from './app.ts'
import { afterEach } from '@std/testing/bdd'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { sessionFor } from './enforcement-fixture.ts'
import { AragApiError, type AragProvider, type RetrievalProvider } from '@research-portal/retrieval'
import { createMcpServer, type McpRoutesOptions } from './mcp.ts'
import { AUDIT_MAX_RESPONSE_BYTES } from './audit-execution.ts'
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

const fixtureDatabases: LocalRbacDatabase[] = []
afterEach(() => {
  for (const db of fixtureDatabases.splice(0)) db.close()
})
function buildApp(options: BuildAppOptions) {
  const db = new LocalRbacDatabase(':memory:')
  fixtureDatabases.push(db)
  const rbac = new RbacState(db)
  rbac.migrate()
  return buildRawApp({
    ...options,
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    breakGlass: rbac.breakGlassService({ environment: 'production' }),
  })
}

Deno.test('cold question jobs deduplicate attribution and require every completion append for all waiters', async () => {
  for (const failAt of [0, 1, 2, 3, 4]) {
    const directory = Deno.makeTempDirSync()
    try {
      const events: AuditEvent[] = []
      const enrichments = new EnrichmentStore(directory)
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      let calls = 0
      let appends = 0
      const app = buildApp({
        provider: {
          resource: () =>
            Promise.resolve({
              id: 'doc',
              title: 'Document',
              summary: 'Summary',
              type: 'pdf',
              topicIds: [],
              keyFacts: [],
            }),
        } as unknown as RetrievalProvider,
        management: {
          resourceContent: async () => {
            calls++
            started()
            await held
            return null
          },
        } as unknown as AragProvider,
        enrichments,
        audit: {
          append: (event) => {
            if (++appends === failAt) throw new Error('private')
            events.push(event)
          },
          read: () => events,
        },
        requestContext: (request) => ({
          requestId: request.headers.get('x-test-request')!,
          session: null,
          coarseAdminEligible: false,
          actor: { kind: 'user', id: request.headers.get('x-test-request')! },
        }),
      })
      const first = app.request('/api/t/marine/resources/doc/questions', {
        headers: { 'x-test-request': 'first' },
      })
      if (failAt === 1) {
        expect((await first).status).toBe(500)
        expect(calls).toBe(0)
        continue
      }
      await ready
      let returned = false
      const second = Promise.resolve(app.request('/api/t/marine/resources/doc/questions?wait=1', {
        headers: { 'x-test-request': 'second' },
      })).then((response) => {
        returned = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(returned).toBe(false)
      release()
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(failAt ? 500 : 200)
        expect(await response.json()).toEqual(
          failAt ? { error: 'audit_write_failed' } : { questions: [] },
        )
      }
      expect(calls).toBe(1)
      expect(events.every((event) => event.request_id === 'first' && event.actor_id === 'first'))
        .toBe(true)
      if (!failAt) {
        expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual([
          'resource.questions.generate:intent',
          'resource.questions.cache:intent',
          'resource.questions.cache:success',
          'resource.questions.generate:success',
        ])
        const count = events.length
        expect(
          (await app.request('/api/t/marine/resources/doc/questions', {
            headers: { 'x-test-request': 'cached' },
          })).status,
        ).toBe(200)
        expect(events.length).toBe(count)
        expect(calls).toBe(1)
      }
    } finally {
      Deno.removeSync(directory, { recursive: true })
    }
  }
})

Deno.test('question waiter arriving during cache write joins mandatory completion instead of reading cache', async () => {
  const dir = Deno.makeTempDirSync()
  try {
    let late!: Response | Promise<Response>
    class JoiningStore extends EnrichmentStore {
      override put(...args: Parameters<EnrichmentStore['put']>) {
        super.put(...args)
        late = app.request('/api/t/marine/resources/doc/questions?wait=1')
      }
    }
    const app = buildApp({
      provider: {
        resource: () =>
          Promise.resolve({
            id: 'doc',
            title: 'Title',
            type: 'pdf',
            summary: '',
            topicIds: [],
            keyFacts: [],
          }),
      } as unknown as RetrievalProvider,
      management: { resourceContent: () => Promise.resolve(null) } as unknown as AragProvider,
      enrichments: new JoiningStore(dir),
      audit: {
        append: (event) => {
          if (
            event.action === 'resource.questions.generate' && event.outcome === 'success'
          ) throw new Error('fixture')
        },
        read: () => [],
      },
    })
    expect((await app.request('/api/t/marine/resources/doc/questions')).status).toBe(500)
    expect((await late).status).toBe(500)
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('question cancellation detaches one waiter and last-waiter abort prevents late cache writes', async () => {
  for (const join of [false, true]) {
    const dir = Deno.makeTempDirSync()
    try {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const events: AuditEvent[] = []
      const enrichments = new EnrichmentStore(dir)
      const app = buildApp({
        provider: {
          resource: () =>
            Promise.resolve({
              id: 'doc',
              title: 'Title',
              type: 'pdf',
              summary: '',
              topicIds: [],
              keyFacts: [],
            }),
        } as unknown as RetrievalProvider,
        management: {
          resourceContent: async () => {
            started()
            await held
            return null
          },
        } as unknown as AragProvider,
        enrichments,
        audit: {
          append: (event) => {
            events.push(event)
          },
          read: () => events,
        },
      })
      const abort = new AbortController()
      const first = app.request('/api/t/marine/resources/doc/questions', { signal: abort.signal })
      await ready
      const second = join ? app.request('/api/t/marine/resources/doc/questions?wait=1') : undefined
      await new Promise((resolve) => setTimeout(resolve, 0))
      abort.abort()
      expect((await first).status).toBe(500)
      release()
      if (second) expect((await second).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(!!enrichments.get('marine', 'doc', 'suggested-questions')).toBe(join)
      expect(events.filter((e) => e.action === 'resource.questions.generate').map((e) => e.outcome))
        .toEqual(['intent', join ? 'success' : 'uncertain'])
    } finally {
      Deno.removeSync(dir, { recursive: true })
    }
  }
})

Deno.test('materialised enrichment exports above 1 MiB require successful completion audit', async () => {
  const directory = Deno.makeTempDirSync()
  try {
    const enrichments = new EnrichmentStore(directory)
    enrichments.put('marine', 'large-record', {
      schemaId: 'research',
      generatedAt: '2026-09-12T00:00:00Z',
      data: { summary: 'é'.repeat(AUDIT_MAX_RESPONSE_BYTES) },
    })
    const expected = enrichments.exportRecords('marine')
    for (const failCompletion of [false, true]) {
      const events: AuditEvent[] = []
      const app = buildApp({
        provider: {} as RetrievalProvider,
        enrichments,
        audit: {
          append: (event) => {
            if (failCompletion && event.outcome === 'success') throw new Error('private')
            events.push(event)
          },
          read: () => events,
        },
        requestContext: () => ({
          requestId: 'export-request',
          session: sessionFor('owner', 'a', Date.now()),
          coarseAdminEligible: true,
          effectiveRoles: { platformRole: 'owner', portalRoles: [] },
          actor: { kind: 'user', id: 'owner-a' },
        }),
      })
      const response = await app.request('/api/admin/t/marine/enrichments/export')
      expect(response.status).toBe(failCompletion ? 500 : 200)
      expect(events.map((event) => event.outcome)).toEqual(
        failCompletion ? ['intent'] : ['intent', 'success'],
      )
      const body = await response.text()
      if (failCompletion) expect(JSON.parse(body)).toEqual({ error: 'audit_write_failed' })
      else {
        expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(AUDIT_MAX_RESPONSE_BYTES)
        expect(JSON.parse(body)).toEqual(expected)
      }
    }
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

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
        session: sessionFor('owner', 'a', Date.now()),
        coarseAdminEligible: true,
        effectiveRoles: { platformRole: 'owner', portalRoles: [] },
        actor: { kind: 'user', id: 'owner-a' },
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
    expect(events.every((e) => e.request_id === 'real-request' && e.actor_id === 'owner-a')).toBe(
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
        session: sessionFor('owner', 'a', Date.now()),
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
          session: sessionFor('owner', 'a', Date.now()),
          coarseAdminEligible: true,
          effectiveRoles: { platformRole: 'owner', portalRoles: [] },
          actor: { kind: 'user', id: 'owner-a' },
        }),
      })
      const path = declaration.path.replace(':slug', 'marine').replace(/:[^/]+/g, 'fixture')
      const response = await app.request(path, {
        method: declaration.method,
        ...(declaration.method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      })
      await response.text()
      expect(events[0]?.outcome).toBe('intent')
      expect(events[0]?.actor_id).toBe('owner-a')
      expect(events[0]?.request_id).toBe('inventory-request')
      expect(events[0]?.scope_kind).toBe(declaration.scope)
      expect(events[0]?.target_id).toBe(
        declaration.target.param === 'slug'
          ? 'marine'
          : declaration.target.param
          ? 'fixture'
          : null,
      )
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
          session: sessionFor('owner', 'a', Date.now()),
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
