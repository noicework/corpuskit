import { expect } from '@std/expect'
import type { ResourceSummary, SearchResults, TenantConfig } from '@research-portal/core'
import { AragProvider, type ListResourcesOptions } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

// Search, Ask, typeahead and the Library read the catalogue on a reader's request. With a
// knowledge box whose catalogue never answers, each of them still answers within the bound, and
// the requests share one walk of it.

const TIMING = { pageTimeoutMs: 300, readerWaitMs: 150 }
/** Scheduling slack on top of a bound, generous enough for a loaded test machine. */
const SLACK = 400
/** A route that has not answered in this long is taken to be hanging. */
const HANG = 3_000

/** A box whose `/catalog` never answers, while retrieval (`/find`) answers at once. */
function stalledBox() {
  const catalogueReads: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname.replace(/^.*\/kb\/stalled-kb/, '')
    if (path === '/catalog') {
      catalogueReads.push(url.searchParams.get('page_number') ?? '')
      return new Promise<Response>(() => {})
    }
    if (path === '/find') {
      return Promise.resolve(Response.json({
        resources: {
          r1: {
            title: 'Housing affordability in regional towns',
            metadata: { status: 'PROCESSED' },
            fields: {
              'f/body': {
                paragraphs: {
                  p1: { score: 0.8, text: 'Housing affordability fell across regional towns.' },
                },
              },
            },
          },
        },
      }))
    }
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/stalled-kb',
      token: 'fixture',
    }),
    fetchImpl,
    catalogueTiming: TIMING,
  })
  return { provider, catalogueReads }
}

function portalApp(provider: AragProvider | DoubleProvider) {
  const directory = Deno.makeTempDirSync({ prefix: 'catalogue-hot-path-' })
  const db = new LocalRbacDatabase(':memory:')
  const rbac = new RbacState(db)
  rbac.migrate()
  const app = buildApp({
    provider,
    ...(provider instanceof AragProvider ? { management: provider } : {}),
    tenants: new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` }),
    enrichments: new EnrichmentStore(directory),
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    audit: rbac.audit,
    breakGlass: rbac.breakGlassService({}),
    requestContext: () => ({
      requestId: crypto.randomUUID(),
      session: null,
      clientIp: '192.0.2.1',
      coarseAdminEligible: false,
    }),
    rateLimitAskPerMin: 0,
    rateLimitAnonPortalAskPerMin: 0,
  })
  return {
    app,
    close: () => {
      db.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

/** A route's response and how long it took, failing the test if it has not answered. */
async function timed(response: Promise<Response>): Promise<{ status: number; ms: number }> {
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const answered = await Promise.race([
    response,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${HANG} ms`)), HANG)
    }),
  ]).finally(() => clearTimeout(timer))
  await answered.body?.cancel()
  return { status: answered.status, ms: performance.now() - started }
}

Deno.test('search, typeahead and the Library answer within the bound when the catalogue stalls', async () => {
  const { provider, catalogueReads } = stalledBox()
  const portal = portalApp(provider)
  try {
    const get = (path: string) => timed(Promise.resolve(portal.app.request(path)))
    // A plain search never waits on the catalogue.
    const plain = await get('/api/t/marine/search?q=housing%20affordability%20trends')
    expect(plain.status).toBe(200)
    expect(plain.ms).toBeLessThan(TIMING.readerWaitMs)
    expect(catalogueReads).toEqual([])
    // Name-shaped and identifier searches, typeahead and the Library wait at most the bound, and
    // share the one walk that is under way.
    const bounded = await Promise.all([
      get('/api/t/marine/search?q=Wilma%20O%27Neill'),
      get('/api/t/marine/search?q=Oneill'),
      get('/api/t/marine/search?q=10.1234%2Fabc.def'),
      get('/api/t/marine/typeahead?q=hou'),
      get('/api/t/marine/catalog?sort=published'),
    ])
    for (const read of bounded) {
      expect(read.status).toBe(200)
      expect(read.ms).toBeLessThan(TIMING.readerWaitMs + SLACK)
    }
    expect(catalogueReads).toEqual(['0'])
  } finally {
    portal.close()
  }
})

/**
 * A provider whose catalogue answers a bounded read with nothing after 50 ms, as the real one does
 * when its box stalls, and never answers a read that asks for all of it.
 */
class StalledCatalogue extends DoubleProvider {
  listed = false
  probedBeforeListing = false

  override listResources(
    _tenant: TenantConfig,
    options?: ListResourcesOptions,
  ): Promise<ResourceSummary[]> {
    if (!options?.bounded) return new Promise(() => {})
    return new Promise((resolve) =>
      setTimeout(() => {
        this.listed = true
        resolve([])
      }, 50)
    )
  }

  override search(tenant: TenantConfig, query: string): Promise<SearchResults> {
    if (!this.listed) this.probedBeforeListing = true
    return super.search(tenant, query)
  }
}

Deno.test('Ask starts its grounding probe before the catalogue and never waits on it past the bound', async () => {
  const provider = new StalledCatalogue()
  const portal = portalApp(provider)
  try {
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = await Promise.race([
      portal.app.request('/api/t/marine/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer after ${HANG} ms`)), HANG)
      }),
    ]).finally(() => clearTimeout(timer))
    expect(response.status).toBe(200)
    let text = ''
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    const deadline = setTimeout(() => void reader.cancel(), HANG)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += value
      }
    } finally {
      clearTimeout(deadline)
    }
    expect(text).toContain('"type":"done"')
    expect(performance.now() - started).toBeLessThan(HANG)
    expect(provider.probedBeforeListing).toBe(true)
  } finally {
    portal.close()
  }
})
