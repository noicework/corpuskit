import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

// The catalogue walk reads a portal's whole listing page by page. Search, Ask, typeahead and the
// Library read it on a person's request, so a slow or stalled knowledge box must never hold that
// request past a bound, and requests arriving together must share one walk.

const TENANT = {
  slug: 'walk',
  suggestedQuestions: [],
  topics: [],
  entityTerms: [],
} as unknown as TenantConfig
const PAGE = 200
/** Timing for these tests: pages given up after 300 ms, readers waiting at most 150 ms. */
const TIMING = { pageTimeoutMs: 300, readerWaitMs: 150 }
/** Scheduling slack on top of a bound, generous enough for a loaded test machine. */
const SLACK = 250

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Report ${id}`,
    metadata: { status: 'PROCESSED' },
    created: '2026-09-01T00:00:00Z',
    extra: { metadata: { published: '2025-01-01', authors: ["O'Neill WJ"] } },
    ...extra,
  }
}

/**
 * A knowledge box whose catalogue has `total` resources. Each catalogue page answers after
 * `delayMs`; from page `hangFrom` on, a page never answers and ignores its abort signal.
 */
function box(options: { total: number; delayMs?: number; hangFrom?: number; failFrom?: number }) {
  const pages: number[] = []
  const urls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname.replace(/^.*\/kb\/walk-kb/, '')
    if (path === '/catalog') {
      urls.push(url.search)
      const page = Number(url.searchParams.get('page_number'))
      pages.push(page)
      if (options.hangFrom !== undefined && page >= options.hangFrom) {
        return new Promise<Response>(() => {})
      }
      if (options.failFrom !== undefined && page >= options.failFrom) {
        return Promise.resolve(Response.json({ detail: 'upstream failure' }, { status: 500 }))
      }
      const start = page * PAGE
      const ids = Array.from(
        { length: Math.max(0, Math.min(PAGE, options.total - start)) },
        (_, i) => `r${start + i}`,
      )
      const resources = Object.fromEntries(ids.map((id) => [id, row(id)]))
      // A draft the platform lists regardless is still left out.
      if (page === 0) resources['draft'] = row('draft', { hidden: true })
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json({ resources })), options.delayMs ?? 0)
      )
    }
    if (path === '/find') {
      return Promise.resolve(Response.json({
        resources: {
          r1: {
            ...row('r1'),
            summary: 'A report on stock health and housing affordability.',
            fields: {
              'f/body': {
                paragraphs: {
                  p1: { score: 0.8, text: 'Housing affordability findings for the region.' },
                },
              },
            },
          },
        },
      }))
    }
    if (path === '/suggest') return Promise.resolve(Response.json({}))
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/walk-kb',
      token: 'fixture',
    }),
    fetchImpl,
    catalogueTiming: TIMING,
  })
  return { provider, pages, urls }
}

/** How long a call took, failing the test outright when it has not settled within `limit`. */
async function timed<T>(call: Promise<T>, limit: number): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const value = await Promise.race([
    call,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still waiting after ${limit} ms`)), limit)
    }),
  ]).finally(() => clearTimeout(timer))
  return { value, ms: performance.now() - started }
}

Deno.test('requests arriving together share one catalogue walk', async () => {
  const { provider, pages, urls } = box({ total: 450, delayMs: 20 })
  const results = await Promise.all([
    provider.listResources(TENANT, { bounded: true }),
    provider.listResources(TENANT, { bounded: true }),
    provider.listResources(TENANT),
    provider.catalog(TENANT, { sortField: 'published', pageSize: 5 }),
    provider.typeahead(TENANT, 'report'),
    provider.search(TENANT, '10.1234/abc.def'),
  ])
  // One walk: three pages, each read once.
  expect(pages).toEqual([0, 1, 2])
  expect((results[2] as unknown[]).length).toBe(450)
  // Drafts stay out, and the platform is asked to leave them out.
  expect(urls.every((search) => search.includes('hidden=false'))).toBe(true)
  expect((results[2] as { id: string }[]).some((r) => r.id === 'draft')).toBe(false)
  // Later reads come from the listing the walk left.
  await provider.listResources(TENANT, { bounded: true })
  expect(pages).toEqual([0, 1, 2])
})

Deno.test('a hanging catalogue never holds a reader past the bound', async () => {
  const { provider, pages } = box({ total: 450, hangFrom: 0 })
  const bound = TIMING.readerWaitMs + SLACK
  const reads = await Promise.all([
    timed(provider.listResources(TENANT, { bounded: true }), bound),
    timed(provider.listResources(TENANT, { bounded: true }), bound),
    timed(provider.catalog(TENANT, { sortField: 'published' }), bound),
    timed(provider.facets(TENANT, ['kind']), bound),
    timed(provider.typeahead(TENANT, 'report'), bound),
    timed(provider.search(TENANT, '10.1234/abc.def'), bound),
  ])
  expect(reads[0]!.value).toEqual([])
  expect((reads[2]!.value as { items: unknown[] }).items).toEqual([])
  // They all waited on the same walk.
  expect(pages).toEqual([0])
  // A plain search does not wait on the catalogue at all.
  const plain = await timed(provider.search(TENANT, 'housing affordability'), bound)
  expect(plain.ms).toBeLessThan(TIMING.readerWaitMs)
  expect(plain.value.resources.map((r) => r.id)).toEqual(['r1'])
  // A caller that needs the whole catalogue is told it could not be read, and is not left hanging.
  await expect(timed(provider.listResources(TENANT), TIMING.pageTimeoutMs + SLACK)).rejects
    .toThrow('too long')
})

Deno.test('a slow catalogue gives a waiting reader what has been read, and finishes for the next', async () => {
  // Three pages of 110 ms each: the walk takes about 330 ms, past the reader bound of 150 ms.
  const { provider, pages } = box({ total: 450, delayMs: 110 })
  const first = await timed(
    provider.listResources(TENANT, { bounded: true }),
    TIMING.readerWaitMs + SLACK,
  )
  expect(first.value.length).toBeGreaterThan(0)
  expect(first.value.length).toBeLessThan(450)
  // The walk went on; a caller that needs it all gets it all, from the same walk.
  expect((await provider.listResources(TENANT)).length).toBe(450)
  expect(pages).toEqual([0, 1, 2])
  const next = await timed(provider.listResources(TENANT, { bounded: true }), SLACK)
  expect(next.value.length).toBe(450)
  expect(pages).toEqual([0, 1, 2])
})

Deno.test('a catalogue that fails is not walked again by every reader', async () => {
  const { provider, pages } = box({ total: 450, failFrom: 1 })
  // The first page arrives, the second fails: readers get the partial listing.
  expect((await provider.listResources(TENANT, { bounded: true })).length).toBe(200)
  expect(pages).toEqual([0, 1])
  // Within the cache lifetime, readers use it rather than walking again.
  expect((await provider.listResources(TENANT, { bounded: true })).length).toBe(200)
  expect(pages).toEqual([0, 1])
  // A caller that needs it all walks again, and is told it failed.
  await expect(provider.listResources(TENANT)).rejects.toThrow('500')
  expect(pages).toEqual([0, 1, 0, 1])
  // A rebinding starts afresh.
  provider.invalidate(TENANT.slug)
  await provider.listResources(TENANT, { bounded: true })
  expect(pages).toEqual([0, 1, 0, 1, 0, 1])
})
