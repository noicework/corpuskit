import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

// A resource hidden (made a draft) or deleted while a catalogue walk is under way must not reach
// any request made after the change: not a reader joining the walk, not the Library, not a caller
// that needs the whole listing, and not the listing the walk would otherwise leave in the cache.

const TENANT = {
  slug: 'walk',
  suggestedQuestions: [],
  topics: [],
  entityTerms: [],
} as unknown as TenantConfig
const PAGE = 200
/** Pages are given up after 5 s (longer than this test holds one); readers wait 100 ms. */
const TIMING = { pageTimeoutMs: 5_000, readerWaitMs: 100 }

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
 * A box of 201 resources over two catalogue pages. `secret` is on page 0 until it is hidden or
 * deleted; page 1 does not answer until `release()` (a slow box).
 */
function box() {
  const gone = new Set<string>()
  const pages: number[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^.*\/kb\/walk-kb/, '')
    if (path === '/catalog') {
      const page = Number(url.searchParams.get('page_number'))
      pages.push(page)
      if (page === 0) {
        const resources: Record<string, unknown> = Object.fromEntries(
          Array.from({ length: PAGE }, (_, i) => [`r${i}`, row(`r${i}`)]),
        )
        if (!gone.has('secret')) {
          resources.secret = row('secret', { title: 'Unpublished board minutes' })
        }
        return Response.json({ resources })
      }
      await held
      return Response.json({ resources: { tail: row('tail') } })
    }
    const match = /^\/resource\/([^/]+)$/.exec(path)
    if (match && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { hidden?: boolean }
      if (body.hidden) gone.add(match[1]!)
      return Response.json({})
    }
    if (match && method === 'DELETE') {
      gone.add(match[1]!)
      return new Response(null, { status: 204 })
    }
    return Response.json({})
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/walk-kb',
      token: 'fixture',
    }),
    fetchImpl,
    catalogueTiming: TIMING,
  })
  return { provider, pages, release }
}

const ids = (list: { id: string }[]) => list.map((r) => r.id)
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5))
}

for (const change of ['hidden', 'deleted'] as const) {
  Deno.test(`a resource ${change} during a catalogue walk reaches no request after the change`, async () => {
    const { provider, pages, release } = box()
    // A reader starts the walk; it reads page 0 (with `secret`) and waits on page 1.
    const before = await provider.listResources(TENANT, { bounded: true })
    expect(ids(before)).toContain('secret')
    await until(() => pages.includes(1))

    if (change === 'hidden') await provider.setResourceHidden(TENANT, 'secret', true)
    else await provider.deleteResource(TENANT, 'secret')

    // A reader after the change starts afresh rather than joining the walk that read `secret`.
    const afterReader = await provider.listResources(TENANT, { bounded: true })
    const library = await provider.catalog(TENANT, { sortField: 'published', pageSize: 500 })
    // The full listing enrichment and counts use, once the slow page answers.
    release()
    const full = await provider.listResources(TENANT)
    // And the cached listing every reader gets for the next minute.
    const cached = await provider.listResources(TENANT, { bounded: true })

    const leaks = {
      reader: ids(afterReader).includes('secret'),
      library: library.items.some((item) => item.id === 'secret'),
      full: ids(full).includes('secret'),
      cached: ids(cached).includes('secret'),
    }
    expect(leaks).toEqual({ reader: false, library: false, full: false, cached: false })
  })
}
