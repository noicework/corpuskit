import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'

// ---------------------------------------------------------------------------
// Ingestion back-pressure hardening, sync side. The platform's processing
// queue can fill up mid-sync (HTTP 429 with a back_pressure_type/try_after
// body - see AragApiError.backpressure). A daily/manual sync must not abort
// or crash when that happens: it should stop cleanly, leave the un-ingested
// pages out of `synced` so the next run picks them up, and report how many
// were added vs deferred - never throw.
//
// DATA_DIR is read once at stores.ts module load, so it must be pointed at a
// temp dir before that module (or anything importing it) is first imported -
// same pattern as scheduler.test.ts.
// ---------------------------------------------------------------------------

const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)

const { syncSource, runAutoSyncs } = await import('./scheduler.ts')
const { SourceStore } = await import('./stores.ts')

const TENANT: TenantConfig = {
  slug: 'marine',
  branding: {
    productName: 'Southern Waters Research Portal',
    organisation: 'Southern Waters Research Institute',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const SOURCE_URL = 'https://example.org/reports'
const PAGE_URLS = [
  'https://example.org/reports/a',
  'https://example.org/reports/b',
  'https://example.org/reports/c',
]

function discoveryHtml(): string {
  return `<html><body>${PAGE_URLS.map((u) => `<a href="${u}">link</a>`).join('\n')}</body></html>`
}

/** Enough distinct words (>= 80) to clear extractMainContent's real-content threshold. */
function pageHtml(id: string): string {
  const words = Array.from({ length: 90 }, (_, i) => `${id}-word-${i}`).join(' ')
  return `<html><head><title>Report ${id}</title></head><body><main><h1>Report ${id}</h1><p>${words}</p></main></body></html>`
}

/** Stubs global fetch for discoverLinks + syncSource's own page fetches; restores after. */
function withFetchDouble<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === SOURCE_URL) {
      return Promise.resolve(
        new Response(discoveryHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      )
    }
    const match = PAGE_URLS.find((u) => u === url)
    if (match) {
      const id = match.split('/').pop() ?? 'x'
      return Promise.resolve(
        new Response(pageHtml(id), { status: 200, headers: { 'content-type': 'text/html' } }),
      )
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as typeof fetch
  return run().finally(() => {
    globalThis.fetch = original
  })
}

function backpressureError(): AragApiError {
  return new AragApiError(
    429,
    'https://test.rag.progress.cloud/api/v1/kb/test-kb/resources',
    JSON.stringify({
      detail: {
        message: 'Too many messages pending to ingest. Retry after 1700000000',
        try_after: Math.floor(Date.now() / 1000),
        back_pressure_type: 'processing',
      },
    }),
  )
}

/** A management double whose createText throws back-pressure for one chosen origin URL. */
function fakeManagement(failOnOriginUrl: string): { attempts: string[]; management: AragProvider } {
  const attempts: string[] = []
  const management = {
    createText: (_tenant: TenantConfig, input: { title: string; originUrl?: string }) => {
      const key = input.originUrl ?? input.title
      attempts.push(key)
      if (key === failOnOriginUrl) return Promise.reject(backpressureError())
      return Promise.resolve({ id: `id-${attempts.length}` })
    },
    createLink: (_tenant: TenantConfig, input: { url: string }) => {
      attempts.push(`link:${input.url}`)
      return Promise.resolve({ id: `id-${attempts.length}` })
    },
  }
  return { attempts, management: management as unknown as AragProvider }
}

Deno.test(
  'syncSource stops cleanly on a per-page 429 back-pressure - it does not throw, and defers the rest',
  async () => {
    await withFetchDouble(async () => {
      const sources = new SourceStore()
      const source = sources.add(TENANT.slug, SOURCE_URL, true)
      // Fail on the second page (b) - a should already be ingested, c should
      // never even be attempted once the queue is known to be full.
      const { attempts, management } = fakeManagement(PAGE_URLS[1]!)
      const emitted: string[] = []

      const result = await syncSource(
        management,
        sources,
        TENANT,
        source,
        (label) => {
          emitted.push(label)
        },
      )

      expect(result.added).toBe(1)
      expect(result.deferred).toBe(2)
      expect(attempts).toEqual([PAGE_URLS[0], PAGE_URLS[1]]) // c never attempted
      expect(emitted.some((m) => /busy/i.test(m) && /stopping this run early/i.test(m))).toBe(true)
      expect(emitted.some((m) => /2 pages left for the next sync/i.test(m))).toBe(true)

      // The deferred pages must not be marked as synced, so the next run retries them.
      const [persisted] = sources.list(TENANT.slug)
      expect(persisted?.synced).toContain(PAGE_URLS[0])
      expect(persisted?.synced).not.toContain(PAGE_URLS[1])
      expect(persisted?.synced).not.toContain(PAGE_URLS[2])
      expect(persisted?.lastAdded).toBe(1)
    })
  },
)

Deno.test(
  'runAutoSyncs never throws when a source hits back-pressure mid-sync',
  async () => {
    await withFetchDouble(async () => {
      const sources = new SourceStore()
      sources.add(TENANT.slug, SOURCE_URL, true)
      const { management } = fakeManagement(PAGE_URLS[0]!) // fail on the very first page

      const tenants = {
        list: () => [{ slug: TENANT.slug, name: TENANT.branding.productName }],
        get: (slug: string) => (slug === TENANT.slug ? TENANT : undefined),
        // deno-lint-ignore no-explicit-any
      } as any

      // The assertion is simply that this resolves - a pre-fix build would
      // have let the back-pressure AragApiError propagate out of syncSource
      // and (depending on call site) crash the daily job.
      await runAutoSyncs(management, tenants, sources)
    })
  },
)
