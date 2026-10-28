import { expect } from '@std/expect'
import { KbClient, regionalBase } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { BindingStore, SealedBindingStore } from './bindings.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { operatorRequestContext } from './operator.ts'
import { AcceptanceCollection, ORIGINAL_TEXT } from '../../../e2e/support/acceptance-collection.ts'

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`AT16: ${adapter} portal model change is isolated, persists and requests no re-indexing`, async () => {
    const collection = new AcceptanceCollection()
    collection.plant('a', 'nursery-marker', 'Nursery survey', ORIGINAL_TEXT)
    collection.plant('b', 'soil-marker', 'Soil survey', ORIGINAL_TEXT)
    const f = createEnforcementFixture({ provider: collection }, adapter)
    const env = {
      BINDINGS_PATH: `${f.directory}/acceptance-bindings.json`,
      BINDING_KEY: btoa('x'.repeat(32)),
    }
    const bindings = adapter === 'local' ? new BindingStore(env) : f.stores.bindings
    const fetchBefore = globalThis.fetch
    const requests: { path: string; method: string }[] = []
    // The binding route verifies counters. Every outbound request is intercepted, and anything
    // that could ingest, process or change content is an assertion failure.
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      requests.push({ path: url.pathname, method })
      expect(url.pathname).toBe('/api/v1/kb/portal-a/counters')
      expect(method).toBe('GET')
      return Promise.resolve(Response.json({ resources: 1 }))
    }
    try {
      await bindings.initialize()
      for (const slug of ['a', 'b']) {
        await bindings.set(slug, {
          baseUrl: `${regionalBase('fixture')}/kb/portal-${slug}`,
          kbId: `portal-${slug}`,
          token: `fixture-only-service-account-${slug}`,
          inferenceModel: `generation-${slug}`,
        })
      }
      const other = structuredClone(bindings.get('b'))
      const aConfig = f.stores.tenants.get('a')!
      const bConfig = f.stores.tenants.get('b')!
      const contentBefore = await collection.listResources(aConfig)
      const otherContent = await collection.listResources(bConfig)
      const lifecycleBefore = f.stores.lifecycle.get('a')
      const app = buildApp({
        ...f.stores,
        bindings,
        provider: collection,
        management: collection.management(),
        configuredTenantId: f.tenantId,
        audience: f.audience,
        rbac: f.rbac,
        breakGlass: f.rbac.breakGlassService({}),
        audit: f.rbac.audit,
        now: f.now,
        requestContext: () => operatorRequestContext('fixture-host', 'at16-model-change'),
      })
      const response = await app.request('/api/admin/t/a/knowledge-box', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `${regionalBase('fixture')}/kb/portal-a`,
          token: 'fixture-only-service-account-a',
          inferenceModel: 'generation-revised',
        }),
      })
      const reply = await response.text()
      expect(response.status, reply + JSON.stringify(requests)).toBe(200)
      expect(JSON.parse(reply).ok).toBe(true)
      expect(reply).not.toContain('fixture-only-service-account-a')
      expect(bindings.inferenceModel('a')).toBe('generation-revised')
      expect(bindings.get('b')).toEqual(other)
      expect(await collection.listResources(aConfig)).toEqual(contentBefore)
      expect(await collection.listResources(bConfig)).toEqual(otherContent)
      expect(collection.writes).toEqual([])
      expect(requests).toEqual([{ path: '/api/v1/kb/portal-a/counters', method: 'GET' }])
      expect(f.stores.lifecycle.get('a')).toEqual(lifecycleBefore)

      // Reload the real binding persistence and inspect the policy the next generated ask uses.
      // KbClient's transport is a local function; no model is called.
      const restored = adapter === 'local' ? new BindingStore(env) : new SealedBindingStore(
        {
          read: () => f.state.get('bindings', {}),
          write: () => {
            throw new Error('AT16 read must not write bindings')
          },
        },
        { BINDING_KEY: env.BINDING_KEY },
        true,
      )
      await restored.initialize()
      const models: unknown[] = []
      for (const slug of ['a', 'b']) {
        const transport: typeof fetch = (_input, init) => {
          models.push(JSON.parse(String(init?.body)).generative_model)
          return Promise.resolve(Response.json({}))
        }
        const client = new KbClient(restored.get(slug)!, transport)
        const stream = await client.postStream('/ask', {
          query: 'Local acceptance question',
          generative_model: 'caller-default',
        })
        await stream.body?.cancel()
      }
      expect(models).toEqual(['generation-revised', 'generation-b'])
      expect(restored.get('b')).toEqual(other)
      const events = f.rbac.audit.read({ scope: { kind: 'platform' } })
      expect(
        events.some((event) =>
          event.action === 'request.privileged' && event.outcome === 'success' &&
          event.request_id === 'at16-model-change'
        ),
      ).toBe(true)
      expect(JSON.stringify(events)).not.toContain('fixture-only-service-account-a')
    } finally {
      globalThis.fetch = fetchBefore
      f.close()
    }
  })
}
