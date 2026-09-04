import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  AdminTenantOverviewSchema,
  type AskEvent,
  AskEventSchema,
  type CatalogPage,
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  type FacetCounts,
  type Labelset,
  type Question,
  type ResourceSummary,
  type SearchResults,
  SearchResultsSchema,
  type TenantConfig,
  TenantConfigSchema,
} from '@research-portal/core'
import { AragApiError, type AragProvider, type RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'
import type { PortalDomainProvisioner } from './cloudflare-domains.ts'

// Hermetic tenant store - tests must never read the repo's live data/tenants.json.
const freshTenants = () =>
  new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })
import { BindingStore } from './bindings.ts'

// ---------------------------------------------------------------------------
// StubProvider - a deterministic, in-memory RetrievalProvider double used only
// in tests. It never ships in product code; the API server always gets a real
// provider (currently `createProviderFromEnv`) injected via `buildApp`.
// ---------------------------------------------------------------------------

const resourceOne: ResourceSummary = {
  id: 'res-1',
  title: 'Abalone stock health in southern waters',
  summary: 'An overview of abalone population trends and stressors.',
  type: 'pdf',
  topicIds: ['stock-assessment'],
  keyFacts: ['Populations have declined 12% since 2019.'],
  published: '2023-06-01',
}

const resourceTwo: ResourceSummary = {
  id: 'res-2',
  title: 'Marine heatwave impacts on rock lobster',
  summary: 'Field study of thermal stress on rock lobster fisheries.',
  type: 'web',
  topicIds: ['marine-sustainability'],
  keyFacts: ['Heatwave events correlate with reduced catch rates.'],
}

class StubProvider implements RetrievalProvider {
  private resources: ResourceSummary[] = [resourceOne, resourceTwo]

  async listResources(_tenant: TenantConfig): Promise<ResourceSummary[]> {
    return this.resources
  }

  async resource(_tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    return this.resources.find((resource) => resource.id === id) ?? null
  }

  async search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return {
      query,
      resources: this.resources.map((resource, index) => ({
        ...resource,
        relevance: index === 0 ? 0.9 : 0.6,
        citedCount: 0,
      })),
      relatedQuestions: [{ id: 'rq-1', text: 'What else affects this species?' }],
    }
  }

  async catalog(_tenant: TenantConfig): Promise<CatalogPage> {
    return {
      items: this.resources.map((r) => ({
        id: r.id,
        title: r.title,
        status: 'processed' as const,
        topicIds: r.topicIds,
      })),
      total: this.resources.length,
    }
  }

  async facets(_tenant: TenantConfig, labelsets: string[]): Promise<FacetCounts> {
    const first = labelsets[0]
    return first ? { [first]: { 'stock-assessment': 1 } } : {}
  }

  async topicResources(_tenant: TenantConfig, topicId: string): Promise<ResourceSummary[]> {
    return this.resources.filter((resource) => resource.topicIds.includes(topicId))
  }

  async labelsets(_tenant: TenantConfig): Promise<Labelset[]> {
    return [{ id: 'topic', title: 'Topic', multiple: false, labels: ['stock-assessment'] }]
  }

  async suggest(_tenant: TenantConfig): Promise<Question[]> {
    return [{ id: 'sq-1', text: 'What is known about abalone stock health?' }]
  }

  async *ask(_tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield {
      type: 'sources',
      resources: [{ ...resourceOne, relevance: 0.9, citedCount: 1 }],
    }
    yield { type: 'delta', text: `Here is what we know about ${query}.` }
    yield {
      type: 'citation',
      citation: { index: 1, resourceId: resourceOne.id, title: resourceOne.title },
    }
    yield { type: 'done' }
  }
}

function makeApp(enrichments?: EnrichmentStore) {
  return buildApp({ provider: new StubProvider(), tenants: freshTenants(), enrichments })
}

describe('GET /api/tenants', () => {
  it('returns the seeded tenants', async () => {
    const app = makeApp()
    const response = await app.request('/api/tenants')

    expect(response.status).toBe(200)
    const body = await response.json() as Array<{ slug: string }>
    const slugs = body.map((tenant) => tenant.slug)
    expect(slugs).toContain('marine')
    expect(slugs).toContain('grains')
  })
})

describe('GET /api/t/:slug/config', () => {
  it('parses with TenantConfigSchema for a known tenant', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/marine/config')

    expect(response.status).toBe(200)
    TenantConfigSchema.parse(await response.json())
  })

  it('returns 404 for an unknown tenant', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/nope/config')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_tenant' })
  })
})

describe('portal domain lifecycle', () => {
  const passcode = 'test-passcode'
  const adminHeaders = {
    'x-admin-passcode': passcode,
    'content-type': 'application/json',
  }
  const add = (app: ReturnType<typeof buildApp>, name: string) =>
    app.request('/api/admin/tenants', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name }),
    })

  it('persists a hostname only after successful provisioning and removes it with the portal', async () => {
    const tenants = freshTenants()
    const attached: string[] = []
    const detached: string[] = []
    const domains: PortalDomainProvisioner = {
      attach(hostname) {
        attached.push(hostname)
        return Promise.resolve({ hostname, created: true })
      },
      detach(hostname) {
        detached.push(hostname)
        return Promise.resolve({ hostname, removed: true })
      },
    }
    const app = buildApp({
      provider: new StubProvider(),
      tenants,
      adminPasscode: passcode,
      domainProvisioner: domains,
    })

    const created = await add(app, 'New research portal')
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      ok: true,
      slug: 'new-research-portal',
      domain: {
        status: 'active',
        hostname: 'new-research-portal.corpuskit.org',
        created: true,
      },
    })
    expect(attached).toEqual(['new-research-portal.corpuskit.org'])
    expect(tenants.get('new-research-portal')?.hostname).toBe(
      'new-research-portal.corpuskit.org',
    )
    expect(tenants.list().find((tenant) => tenant.slug === 'new-research-portal')?.hostname).toBe(
      'new-research-portal.corpuskit.org',
    )

    const removed = await app.request('/api/admin/tenants/new-research-portal', {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    })
    expect(removed.status).toBe(200)
    expect(detached).toEqual(['new-research-portal.corpuskit.org'])
    expect(tenants.get('new-research-portal')).toBeUndefined()
  })

  it('creates a usable relative-route portal when credentials are absent or provisioning fails', async () => {
    const withoutCredentials = freshTenants()
    const unconfigured = buildApp({
      provider: new StubProvider(),
      tenants: withoutCredentials,
      adminPasscode: passcode,
      domainProvisioner: null,
    })
    const skipped = await add(unconfigured, 'Relative only')
    expect(await skipped.json()).toMatchObject({
      ok: true,
      slug: 'relative-only',
      domain: { status: 'skipped', reason: 'not_configured' },
    })
    expect(withoutCredentials.get('relative-only')?.hostname).toBeUndefined()

    const failedStore = freshTenants()
    const failed = buildApp({
      provider: new StubProvider(),
      tenants: failedStore,
      adminPasscode: passcode,
      domainProvisioner: {
        attach: () => Promise.reject(new Error('Cloudflare is unavailable')),
        detach: () => Promise.resolve({ hostname: '', removed: false }),
      },
    })
    const response = await add(failed, 'Still usable')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      slug: 'still-usable',
      domain: { status: 'failed', message: 'Cloudflare is unavailable' },
    })
    expect(failedStore.get('still-usable')).toBeDefined()
    expect(failedStore.get('still-usable')?.hostname).toBeUndefined()
  })

  it('skips unsafe hostnames without failing the portal', async () => {
    const tenants = freshTenants()
    let called = false
    const app = buildApp({
      provider: new StubProvider(),
      tenants,
      adminPasscode: passcode,
      domainProvisioner: {
        attach: () => {
          called = true
          return Promise.resolve({ hostname: '', created: false })
        },
        detach: () => Promise.resolve({ hostname: '', removed: false }),
      },
    })

    const response = await add(app, 'API')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      slug: 'api',
      domain: { status: 'skipped', reason: 'unsafe_slug' },
    })
    expect(called).toBe(false)
    expect(tenants.get('api')).toBeDefined()
  })

  it('keeps the tenant when its attached domain cannot be removed', async () => {
    const tenants = freshTenants()
    tenants.add({ name: 'Removal retry' })
    tenants.patch('removal-retry', { hostname: 'removal-retry.corpuskit.org' })
    const app = buildApp({
      provider: new StubProvider(),
      tenants,
      adminPasscode: passcode,
      domainProvisioner: {
        attach: (hostname) => Promise.resolve({ hostname, created: false }),
        detach: () => Promise.reject(new Error('Cloudflare is unavailable')),
      },
    })

    const response = await app.request('/api/admin/tenants/removal-retry', {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    })
    expect(response.status).toBe(502)
    expect(tenants.get('removal-retry')).toBeDefined()
  })

  it('upgrades the existing OPAX runtime config to its configured hostname', () => {
    const tenants = freshTenants()
    expect(tenants.add({ name: 'OPAX' }).hostname).toBe('opax.corpuskit.org')
    expect(tenants.list().find((tenant) => tenant.slug === 'opax')?.hostname).toBe(
      'opax.corpuskit.org',
    )
  })
})

describe('GET /api/t/:slug/resources/:id/thumbnail', () => {
  it('keeps stable thumbnails warm and forwards validators from the platform', async () => {
    const management = {
      thumbnailResponse: () =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              'content-type': 'image/webp',
              'content-length': '3',
              etag: '"thumb-v1"',
              'last-modified': 'Mon, 31 Aug 2026 00:00:00 GMT',
            },
          }),
        ),
    } as unknown as AragProvider
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
    })

    const response = await app.request('/api/t/marine/resources/res-1/thumbnail')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.headers.get('etag')).toBe('"thumb-v1"')
    expect(response.headers.get('last-modified')).toBe('Mon, 31 Aug 2026 00:00:00 GMT')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('tenant route aliases', () => {
  it('permanently redirects Assistant bookmarks to Ask and preserves the query string', async () => {
    const app = makeApp()
    const response = await app.request('/t/marine/assistant?ask=abalone%20recovery')

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine/ask?ask=abalone%20recovery')
  })

  it('preserves sub-paths when redirecting renamed routes', async () => {
    const app = makeApp()
    const response = await app.request('/t/marine/assistant/sessions/report-42?view=evidence')

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(
      '/t/marine/ask/sessions/report-42?view=evidence',
    )
  })
})

describe('GET /api/t/:slug/search', () => {
  it('returns a SearchResultsSchema-valid payload', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/marine/search?q=abalone')

    expect(response.status).toBe(200)
    SearchResultsSchema.parse(await response.json())
  })

  it('returns 400 when q is missing', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/marine/search')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'missing_query' })
  })
})

describe('POST /api/t/:slug/ask', () => {
  it('streams SSE data lines that parse with AskEventSchema, including a done event', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/marine/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const payload = await response.text()
    const dataLines = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => chunk.slice('data: '.length))

    expect(dataLines.length).toBeGreaterThan(0)

    const events = dataLines.map((line) => AskEventSchema.parse(JSON.parse(line)))
    expect(events.some((event) => event.type === 'done')).toBe(true)
  })

  it('BUG 1: merchandises sources and citations with the real generated title, never the raw filename/project-code title', async () => {
    // resourceOne's raw title stands in for a raw filename/project code
    // (e.g. "Project 1996-107") the way /search, /catalog and /resources
    // never show one when a real enrichment exists - /ask and /generate must
    // not diverge from that surface-wide rule.
    const enrichment: Enrichment = {
      schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
      generatedAt: '2026-08-28T00:00:00.000Z',
      data: {
        title: 'Distribution and Ecology of Southern Rock Lobster Larvae',
        summary: 'A study of larval distribution and ecology in southern rock lobster stocks.',
      },
    }
    const store = new EnrichmentStore(Deno.makeTempDirSync())
    store.put('marine', resourceOne.id, enrichment)
    const app = makeApp(store)

    const response = await app.request('/api/t/marine/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    expect(response.status).toBe(200)

    const payload = await response.text()
    const events = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => AskEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))

    const sourcesEvent = events.find((e) => e.type === 'sources') as
      | { type: 'sources'; resources: { id: string; title: string }[] }
      | undefined
    const citationEvent = events.find((e) => e.type === 'citation') as
      | { type: 'citation'; citation: { resourceId: string; title: string } }
      | undefined

    expect(sourcesEvent?.resources[0]?.title).toBe(
      'Distribution and Ecology of Southern Rock Lobster Larvae',
    )
    expect(sourcesEvent?.resources[0]?.title).not.toBe(resourceOne.title)
    expect(citationEvent?.citation.title).toBe(
      'Distribution and Ecology of Southern Rock Lobster Larvae',
    )
    expect(citationEvent?.citation.title).not.toBe(resourceOne.title)
  })

  it('falls back to the baseline title when no enrichment exists for the cited resource', async () => {
    const app = makeApp(new EnrichmentStore(Deno.makeTempDirSync()))
    const response = await app.request('/api/t/marine/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    const payload = await response.text()
    const events = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => AskEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))
    const sourcesEvent = events.find((e) => e.type === 'sources') as
      | { type: 'sources'; resources: { title: string }[] }
      | undefined
    expect(sourcesEvent?.resources[0]?.title).toBe(resourceOne.title)
  })
})

describe('admin', () => {
  const passcode = 'test-passcode'

  it('disables the admin surface entirely when no passcode is configured', async () => {
    const app = buildApp({ provider: new StubProvider(), tenants: freshTenants() })
    const response = await app.request('/api/admin/overview')
    expect(response.status).toBe(503)
  })

  it('rejects admin calls without the passcode', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/overview')

    expect(response.status).toBe(401)
  })

  it('returns a schema-valid overview with the passcode', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/overview', {
      headers: { 'x-admin-passcode': passcode },
    })

    expect(response.status).toBe(200)
    const rows = (await response.json()) as unknown[]
    expect(rows.length).toBe(2)
    for (const row of rows) AdminTenantOverviewSchema.parse(row)
  })

  it('accepts a platform-authenticated administrator without a fallback passcode', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      trustedAdmin: (request) => request.headers.get('x-corpuskit-sso-admin') === '1',
    })
    const response = await app.request('/api/admin/overview', {
      headers: { 'x-corpuskit-sso-admin': '1' },
    })

    expect(response.status).toBe(200)
  })

  it('reverting a connected binding falls back to the demo box', async () => {
    const dir = Deno.makeTempDirSync()
    const bindings = new BindingStore({
      BINDINGS_PATH: `${dir}/bindings.json`,
      ARAG_ZONE: 'aws-ap-southeast-2-1',
      ARAG_KB_MARINE: 'demo-kb-id-000000',
      ARAG_KB_MARINE_TOKEN: 'demo-token-00000000000000',
    })
    bindings.set('marine', {
      baseUrl: 'https://zone.rag.progress.cloud/api/v1/kb/connected-kb-111111',
      token: 'connected-token-1111111111',
      kbId: 'connected-kb-111111',
    })
    expect(bindings.status('marine').status).toBe('connected')

    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      bindings,
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/t/marine/knowledge-box', {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    })

    expect(response.status).toBe(200)
    expect(bindings.status('marine').status).toBe('demo')
  })
})

describe('admin enrichment import and export', () => {
  const passcode = 'test-passcode'
  const adminHeaders = {
    'x-admin-passcode': passcode,
    'content-type': 'application/json',
  }
  const enrichment = (title: string): Enrichment => ({
    schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
    generatedAt: '2026-08-28T00:00:00.000Z',
    data: { title, summary: `${title} summary` },
  })
  const appWithStore = () => {
    const store = new EnrichmentStore(Deno.makeTempDirSync())
    return {
      store,
      app: buildApp({
        provider: new StubProvider(),
        tenants: freshTenants(),
        enrichments: store,
        adminPasscode: passcode,
      }),
    }
  }

  it('keeps both bulk routes behind the admin guard', async () => {
    const { app } = appWithStore()
    const exported = await app.request('/api/admin/t/marine/enrichments/export')
    const imported = await app.request('/api/admin/t/marine/enrichments/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(exported.status).toBe(401)
    expect(imported.status).toBe(401)
  })

  it('rejects an unknown target tenant before reading an import', async () => {
    const { app } = appWithStore()
    const response = await app.request('/api/admin/t/unknown/enrichments/import', {
      method: 'POST',
      headers: adminHeaders,
      body: '{}',
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_tenant' })
  })

  it('rejects a malformed archive without writing its valid records', async () => {
    const { app, store } = appWithStore()
    const existing = enrichment('Existing title')
    store.put('marine', 'existing', existing)
    const response = await app.request('/api/admin/t/marine/enrichments/import', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        [DEFAULT_RESEARCH_ENRICHMENT.id]: {
          valid: enrichment('Would otherwise be valid'),
          malformed: { generatedAt: '2026-08-28T00:00:00.000Z', data: {} },
        },
      }),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('invalid_enrichment_import')
    expect(body.issues[0].path).toContain('malformed')
    expect(store.get('marine', 'valid')).toBeUndefined()
    expect(store.get('marine', 'existing')).toEqual(existing)
  })

  it('imports a legacy-slug archive into the URL tenant and exports the store shape', async () => {
    const { app } = appWithStore()
    const archive = {
      [DEFAULT_RESEARCH_ENRICHMENT.id]: {
        'stable-resource-id': enrichment('Restored title'),
      },
    }
    const imported = await app.request('/api/admin/t/grains/enrichments/import?collision=skip', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(archive),
    })

    expect(imported.status).toBe(200)
    expect(await imported.json()).toEqual({
      ok: true,
      targetSlug: 'grains',
      collisionPolicy: 'skip',
      imported: 1,
      skipped: 0,
      overwritten: 0,
      reasons: { existing: 0 },
    })

    const exported = await app.request('/api/admin/t/grains/enrichments/export', {
      headers: { 'x-admin-passcode': passcode },
    })
    expect(exported.status).toBe(200)
    expect(exported.headers.get('cache-control')).toBe('no-store')
    expect(await exported.json()).toEqual(archive)
  })

  it('defaults to skip-existing and overwrites only when explicitly requested', async () => {
    const { app, store } = appWithStore()
    store.put('marine', 'same-id', enrichment('Original title'))
    const archive = {
      [DEFAULT_RESEARCH_ENRICHMENT.id]: {
        'same-id': enrichment('Replacement title'),
      },
    }
    const skipped = await app.request('/api/admin/t/marine/enrichments/import', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(archive),
    })
    expect(skipped.status).toBe(200)
    expect(await skipped.json()).toMatchObject({
      collisionPolicy: 'skip',
      imported: 0,
      skipped: 1,
      overwritten: 0,
      reasons: { existing: 1 },
    })
    expect(store.get('marine', 'same-id')?.data.title).toBe('Original title')

    const overwritten = await app.request(
      '/api/admin/t/marine/enrichments/import?collision=overwrite',
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify(archive),
      },
    )
    expect(overwritten.status).toBe(200)
    expect(await overwritten.json()).toMatchObject({
      collisionPolicy: 'overwrite',
      imported: 1,
      skipped: 0,
      overwritten: 1,
    })
    expect(store.get('marine', 'same-id')?.data.title).toBe('Replacement title')
  })

  it('rejects a body above the 8 MB import limit', async () => {
    const { app } = appWithStore()
    const response = await app.request('/api/admin/t/marine/enrichments/import', {
      method: 'POST',
      headers: adminHeaders,
      body: 'x'.repeat(8 * 1024 * 1024 + 1),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'payload_too_large',
      message: 'The enrichment import exceeds the 8 MB limit.',
    })
  })

  it('accepts a 3.8 MB archive in one request', async () => {
    const { app } = appWithStore()
    const bucket: Record<string, Enrichment> = {}
    for (let index = 0; index < 3163; index++) {
      bucket[`resource-${index}`] = {
        schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
        generatedAt: '2026-08-28T00:00:00.000Z',
        data: {
          title: `Restored resource ${index}`,
          summary: 'x'.repeat(1120),
        },
      }
    }
    const body = JSON.stringify({ [DEFAULT_RESEARCH_ENRICHMENT.id]: bucket })
    const bytes = new TextEncoder().encode(body).byteLength
    expect(bytes).toBeGreaterThan(3_800_000)
    expect(bytes).toBeLessThan(8 * 1024 * 1024)

    const response = await app.request('/api/admin/t/marine/enrichments/import?collision=skip', {
      method: 'POST',
      headers: adminHeaders,
      body,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ imported: 3163, skipped: 0 })
  })
})

describe('GET /api/health', () => {
  it('returns 200 with ok:true and web:true when the SPA bundle exists', async () => {
    const dir = Deno.makeTempDirSync()
    Deno.writeTextFileSync(`${dir}/index.html`, '<!doctype html>')
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.web).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  it('returns 503 when the SPA bundle is missing - a bundle-less image fails its health check', async () => {
    const dir = Deno.makeTempDirSync()
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.web).toBe(false)
  })

  it('requires no authentication', async () => {
    const dir = Deno.makeTempDirSync()
    Deno.writeTextFileSync(`${dir}/index.html`, '<!doctype html>')
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: 'test-passcode',
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
  })
})

describe('appearance (typography, shape, branding fonts)', () => {
  const passcode = 'test-passcode'
  const appearanceApp = () =>
    buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
      brandingPath: `${Deno.makeTempDirSync()}/branding`,
    })
  const patch = (app: ReturnType<typeof buildApp>, body: unknown) =>
    app.request('/api/admin/tenants/marine', {
      method: 'PATCH',
      headers: { 'x-admin-passcode': passcode, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('saves a typography pairing, shape and text scale, and serves them in the tenant config', async () => {
    const app = appearanceApp()
    const response = await patch(app, {
      typography: 'fraunces-poppins',
      shape: 'soft',
      textScale: 'larger',
      density: 'compact',
      paletteId: 'fathom',
    })
    expect(response.status).toBe(200)

    const config = TenantConfigSchema.parse(
      await (await app.request('/api/t/marine/config')).json(),
    )
    expect(config.branding.typography).toBe('fraunces-poppins')
    expect(config.branding.shape).toBe('soft')
    expect(config.branding.textScale).toBe('larger')
    expect(config.branding.density).toBe('compact')
    expect(config.branding.paletteId).toBe('fathom')
  })

  it('accepts the custom and default typography choices', async () => {
    const app = appearanceApp()
    expect((await patch(app, { typography: 'custom' })).status).toBe(200)
    expect((await patch(app, { typography: 'default', shape: 'square' })).status).toBe(200)
    const config = TenantConfigSchema.parse(
      await (await app.request('/api/t/marine/config')).json(),
    )
    expect(config.branding.typography).toBe('default')
    expect(config.branding.shape).toBe('square')
  })

  it('persists the choice across a store reload', () => {
    const path = `${Deno.makeTempDirSync()}/tenants.json`
    const store = new TenantStore({ TENANTS_PATH: path })
    store.patchBranding('marine', { typography: 'lexend-zilla', shape: 'rounded' })
    const reloaded = new TenantStore({ TENANTS_PATH: path })
    expect(reloaded.get('marine')?.branding.typography).toBe('lexend-zilla')
    expect(reloaded.get('marine')?.branding.shape).toBe('rounded')
  })

  it('rejects an unknown pairing, shape, text scale or density', async () => {
    const app = appearanceApp()
    expect((await patch(app, { typography: 'comic-sans' })).status).toBe(400)
    expect((await patch(app, { shape: 'blobby' })).status).toBe(400)
    expect((await patch(app, { textScale: 'enormous' })).status).toBe(400)
    expect((await patch(app, { density: 'cramped' })).status).toBe(400)
    expect((await patch(app, { paletteId: 'neon' })).status).toBe(400)
  })

  it('stores an uploaded heading font, exposes its URL and serves it back', async () => {
    const app = appearanceApp()
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32])
    const upload = await app.request('/api/admin/t/marine/branding/font-heading', {
      method: 'POST',
      headers: { 'x-admin-passcode': passcode, 'content-type': 'font/woff2' },
      body: bytes,
    })
    expect(upload.status).toBe(200)
    const { url } = (await upload.json()) as { url: string }
    expect(url).toBe('/api/t/marine/branding/font-heading')

    const config = TenantConfigSchema.parse(
      await (await app.request('/api/t/marine/config')).json(),
    )
    expect(config.branding.headingFontUrl).toContain('/api/t/marine/branding/font-heading?v=')
    expect(config.branding.bodyFontUrl).toBeUndefined()

    const served = await app.request('/api/t/marine/branding/font-heading')
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('font/woff2')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)
  })

  it('rejects a font upload with a non-font content type', async () => {
    const app = appearanceApp()
    const response = await app.request('/api/admin/t/marine/branding/font-body', {
      method: 'POST',
      headers: { 'x-admin-passcode': passcode, 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(response.status).toBe(415)
  })

  it('rejects an unknown branding kind', async () => {
    const app = appearanceApp()
    const response = await app.request('/api/admin/t/marine/branding/favicon', {
      method: 'POST',
      headers: { 'x-admin-passcode': passcode, 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(response.status).toBe(400)
  })
})

describe('GET /api/admin-prefill', () => {
  it('no longer exists - the passcode-prefill endpoint has been removed', async () => {
    const app = makeApp()
    const response = await app.request('/api/admin-prefill')
    expect(response.status).toBe(404)
  })
})

describe('security headers', () => {
  it('sets baseline security headers on every response', async () => {
    const app = makeApp()
    const response = await app.request('/api/tenants')

    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  })
})

describe('POST /api/ask-estate', () => {
  it('scrubs upstream error detail (URL, knowledge-box id, response body) from anonymous callers', async () => {
    class FailingProvider extends StubProvider {
      override ask(): AsyncIterable<AskEvent> {
        throw new AragApiError(
          500,
          'https://zone.rag.progress.cloud/api/v1/kb/secret-kb-id-111111',
          'super secret upstream response body',
        )
      }
    }

    const app = buildApp({ provider: new FailingProvider(), tenants: freshTenants() })
    const response = await app.request('/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })

    expect(response.status).toBe(200)
    const payload = await response.text()

    expect(payload).not.toContain('secret-kb-id')
    expect(payload).not.toContain('super secret upstream response body')
    expect(payload).not.toContain('zone.rag.progress.cloud')
    expect(payload).toContain('had a problem (HTTP 500)')
  })
})

describe('rate limiting on anonymous LLM-spend routes', () => {
  it('429s an EXPENSIVE route (ask) after the configured per-IP limit, with Retry-After', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 2,
    })
    const ask = () =>
      app.request('/api/t/marine/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.5' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    const third = await ask()

    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ error: 'rate_limited' })
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('isolates the limit per client IP - a different caller is unaffected', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 1,
    })
    const askAs = (ip: string) =>
      app.request('/api/t/marine/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': ip },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await askAs('203.0.113.1')).status).toBe(200)
    expect((await askAs('203.0.113.1')).status).toBe(429)
    expect((await askAs('203.0.113.2')).status).toBe(200)
  })

  it('applies the ESTATE tier (not the EXPENSIVE tier) to POST /api/ask-estate', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 20,
      rateLimitEstatePerMin: 1,
    })
    const askEstate = () =>
      app.request('/api/ask-estate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.9' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await askEstate()).status).toBe(200)
    const second = await askEstate()
    expect(second.status).toBe(429)
  })

  it('0 disables the EXPENSIVE tier entirely', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 0,
    })
    const ask = () =>
      app.request('/api/t/marine/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.5' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    for (let i = 0; i < 25; i++) {
      expect((await ask()).status).toBe(200)
    }
  })

  it('never rate-limits admin routes, even past the EXPENSIVE per-IP limit', async () => {
    const passcode = 'test-passcode'
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
      rateLimitAskPerMin: 1,
    })
    const headers = { 'x-admin-passcode': passcode, 'fly-client-ip': '203.0.113.5' }

    for (let i = 0; i < 5; i++) {
      const response = await app.request('/api/admin/overview', { headers })
      expect(response.status).toBe(200)
    }
  })
})

describe('PUT /api/admin/t/:slug/labelsets/:id', () => {
  const FILTER = { field_types: ['FILE', 'LINK'], apply_to_agent_generated_fields: false }
  const topicLabeller = {
    id: 'task-topic',
    task: 'labeler',
    title: 'topic-labeller',
    model: 'chatgpt-azure-4o-mini',
    on: 1,
    filter: FILTER,
    operations: [
      { label: { ident: 'topic', labels: [{ label: 'stock-assessment' }], multiple: false } },
    ],
    enabled: true,
  }
  const summariser = {
    id: 'task-ask',
    task: 'ask',
    title: 'summariser',
    model: 'chatgpt-azure-4o-mini',
    filter: FILTER,
    operations: [{ ask: { question: 'Summarise', destination: 'summary' } }],
    enabled: true,
  }
  const body = {
    title: ' Topic ',
    multiple: true,
    labels: [
      { title: 'stock-assessment', text: ' Surveys and models of a fished population. ' },
      { title: 'marine-sustainability', text: '' },
    ],
  }

  function fakeManagement(opts: { agents?: unknown[]; startFails?: boolean } = {}) {
    const calls: { name: string; args: unknown[] }[] = []
    const management = {
      updateLabelset: (_t: unknown, input: unknown) => {
        calls.push({ name: 'updateLabelset', args: [input] })
        return Promise.resolve()
      },
      agentConfigs: () => {
        calls.push({ name: 'agentConfigs', args: [] })
        return Promise.resolve(opts.agents ?? [])
      },
      deleteAgent: (_t: unknown, id: string) => {
        calls.push({ name: 'deleteAgent', args: [id] })
        return Promise.resolve()
      },
      startAgent: (_t: unknown, input: unknown) => {
        calls.push({ name: 'startAgent', args: [input] })
        return opts.startFails
          ? Promise.reject(new Error('422 a labeler task is already running'))
          : Promise.resolve()
      },
    } as unknown as AragProvider
    return { management, calls }
  }

  const passcode = 'test-passcode'
  const put = (
    app: ReturnType<typeof buildApp>,
    id: string,
    payload: unknown,
    headers: Record<string, string> = { 'x-admin-passcode': passcode },
  ) =>
    app.request(`/api/admin/t/marine/labelsets/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })

  it('is gated by the admin passcode like the create route', async () => {
    const { management, calls } = fakeManagement()
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const response = await put(app, 'topic', body, {})
    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('is unavailable without the management surface', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
    })
    expect((await put(app, 'topic', body)).status).toBe(503)
  })

  it('rejects an invalid body and duplicate label titles before touching the box', async () => {
    const { management, calls } = fakeManagement()
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    expect((await put(app, 'topic', { ...body, labels: [] })).status).toBe(400)
    expect((await put(app, 'topic', { ...body, title: '' })).status).toBe(400)
    expect(
      (await put(app, 'topic', { ...body, labels: [{ title: 'a', text: 'x'.repeat(601) }] }))
        .status,
    ).toBe(400)
    const duplicate = await put(app, 'topic', {
      ...body,
      labels: [{ title: 'Region', text: '' }, { title: 'region', text: '' }],
    })
    expect(duplicate.status).toBe(400)
    expect(((await duplicate.json()) as { message: string }).message).toContain('more than once')
    expect(calls).toEqual([])
  })

  it('refuses an id that is not an existing labelset', async () => {
    const { management, calls } = fakeManagement()
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const response = await put(app, 'region', body)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_labelset' })
    expect(calls).toEqual([])
  })

  it('writes the labelset and reports no agents when none carries it', async () => {
    const { management, calls } = fakeManagement({ agents: [summariser] })
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const response = await put(app, 'topic', body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, id: 'topic', agents: [] })
    expect(calls.map((c) => c.name)).toEqual(['updateLabelset', 'agentConfigs'])
    expect(calls[0]?.args[0]).toEqual({
      id: 'topic',
      title: 'Topic',
      multiple: true,
      labels: [
        { title: 'stock-assessment', text: 'Surveys and models of a fished population.' },
        { title: 'marine-sustainability', text: '' },
      ],
    })
  })

  it('writes the labelset first, then deletes and restarts only the carrying labeller', async () => {
    const { management, calls } = fakeManagement({ agents: [summariser, topicLabeller] })
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const response = await put(app, 'topic', body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      id: 'topic',
      agents: [{ previousId: 'task-topic', newTitle: 'topic-labeller' }],
    })
    expect(calls.map((c) => c.name)).toEqual([
      'updateLabelset',
      'agentConfigs',
      'deleteAgent',
      'startAgent',
    ])
    expect(calls[2]?.args[0]).toBe('task-topic')
    expect(calls[3]?.args[0]).toEqual({
      task: 'labeler',
      title: 'topic-labeller',
      model: 'chatgpt-azure-4o-mini',
      on: 1,
      filter: FILTER,
      applyExisting: false,
      operations: [
        {
          label: {
            ident: 'topic',
            labels: [
              {
                label: 'stock-assessment',
                description: 'Surveys and models of a fished population.',
              },
              { label: 'marine-sustainability', description: '' },
            ],
            multiple: true,
          },
        },
      ],
    })
  })

  it("returns the removed agent's previous configuration when the replacement fails", async () => {
    const { management, calls } = fakeManagement({ agents: [topicLabeller], startFails: true })
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const response = await put(app, 'topic', body)
    expect(response.status).toBe(502)
    const payload = await response.json() as {
      error: string
      message: string
      previous: typeof topicLabeller
    }
    expect(payload.error).toBe('agent_restart_failed')
    expect(payload.message).toContain('topic-labeller')
    expect(payload.message).toContain('already running')
    expect(payload.previous).toEqual(topicLabeller)
    expect(calls.map((c) => c.name)).toEqual([
      'updateLabelset',
      'agentConfigs',
      'deleteAgent',
      'startAgent',
    ])
  })
})

describe('GET /api/t/:slug/labelsets - definitions', () => {
  it('passes label definitions through to the public taxonomy', async () => {
    class DefinedProvider extends StubProvider {
      override labelsets(): Promise<Labelset[]> {
        return Promise.resolve([{
          id: 'topic',
          title: 'Topic',
          multiple: false,
          labels: ['stock-assessment'],
          definitions: { 'stock-assessment': 'Surveys and models of a fished population.' },
        }])
      }
    }
    const app = buildApp({ provider: new DefinedProvider(), tenants: freshTenants() })
    const response = await app.request('/api/t/marine/labelsets')
    expect(response.status).toBe(200)
    const [topic] = await response.json() as Labelset[]
    expect(topic?.definitions).toEqual({
      'stock-assessment': 'Surveys and models of a fished population.',
    })
  })
})

describe('POST /api/admin/t/:slug/labelsets - label shapes', () => {
  const passcode = 'test-passcode'
  function fakeCreate() {
    const calls: unknown[] = []
    const management = {
      createLabelset: (_t: unknown, input: unknown) => {
        calls.push(input)
        return Promise.resolve()
      },
    } as unknown as AragProvider
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      management,
      adminPasscode: passcode,
    })
    const post = (payload: unknown) =>
      app.request('/api/admin/t/marine/labelsets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-passcode': passcode },
        body: JSON.stringify(payload),
      })
    return { calls, post }
  }

  it('still accepts plain label titles (the original shape)', async () => {
    const { calls, post } = fakeCreate()
    const response = await post({ title: 'Region', multiple: false, labels: ['North', 'South'] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, id: 'region' })
    expect(calls).toEqual([{
      id: 'region',
      title: 'Region',
      multiple: false,
      labels: [{ title: 'North' }, { title: 'South' }],
    }])
  })

  it('accepts title + definition pairs and writes the definitions on create', async () => {
    const { calls, post } = fakeCreate()
    const response = await post({
      title: 'Marine Region',
      multiple: true,
      labels: [
        { title: 'North', text: ' Northern waters. ' },
        { title: 'South' },
      ],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, id: 'marine-region' })
    expect(calls).toEqual([{
      id: 'marine-region',
      title: 'Marine Region',
      multiple: true,
      labels: [{ title: 'North', text: 'Northern waters.' }, { title: 'South' }],
    }])
  })

  it('rejects duplicate titles and over-long definitions before touching the box', async () => {
    const { calls, post } = fakeCreate()
    const duplicate = await post({
      title: 'Region',
      multiple: false,
      labels: [{ title: 'North', text: '' }, { title: 'north' }],
    })
    expect(duplicate.status).toBe(400)
    expect(((await duplicate.json()) as { message: string }).message).toContain('more than once')
    const tooLong = await post({
      title: 'Region',
      multiple: false,
      labels: [{ title: 'North', text: 'x'.repeat(601) }],
    })
    expect(tooLong.status).toBe(400)
    const mixed = await post({
      title: 'Region',
      multiple: false,
      labels: ['North', { title: 'S' }],
    })
    expect(mixed.status).toBe(400)
    expect(calls).toEqual([])
  })
})
