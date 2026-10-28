import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider, platformTime } from './index.ts'

// When documents were added, for the monthly usage report: the catalogue read newest first,
// stopping once it passes the start of the period, with the library's own exclusions.

const TENANT = { slug: 'added', suggestedQuestions: [], topics: [] } as unknown as TenantConfig
const PAGE = 200
const HOUR = 3_600_000

/**
 * A knowledge box holding `total` documents, one added each hour back from `newest`, listed newest
 * first. The platform writes times without a zone. Page `failAt` answers 500.
 */
function box(options: { total: number; newest: number; failAt?: number; extra?: object }) {
  const pages: number[] = []
  const searches: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.pathname.endsWith('/catalog')) return Promise.resolve(Response.json({}))
    searches.push(url.search)
    const page = Number(url.searchParams.get('page_number'))
    pages.push(page)
    if (page === options.failAt) {
      return Promise.resolve(Response.json({ detail: 'upstream failure' }, { status: 500 }))
    }
    const resources: Record<string, unknown> = {}
    for (let index = page * PAGE; index < Math.min(options.total, (page + 1) * PAGE); index++) {
      resources[`r${index}`] = {
        title: `Report ${index}`,
        metadata: { status: 'PROCESSED' },
        created: new Date(options.newest - index * HOUR).toISOString().slice(0, -1),
      }
    }
    if (page === 0) Object.assign(resources, options.extra ?? {})
    return Promise.resolve(Response.json({ resources }))
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/added-kb',
      token: 'fixture',
    }),
    fetchImpl,
  })
  return { provider, pages, searches }
}

Deno.test('platform times without a zone are UTC', () => {
  expect(platformTime('2026-10-01T00:30:00.123456')).toBe(Date.parse('2026-10-01T00:30:00.123Z'))
  expect(platformTime('2026-10-01T00:30:00Z')).toBe(Date.parse('2026-10-01T00:30:00Z'))
  expect(platformTime('2026-10-01T10:30:00+10:00')).toBe(Date.parse('2026-10-01T00:30:00Z'))
  expect(platformTime('2026-10-01')).toBe(Date.parse('2026-10-01T00:00:00Z'))
  expect(platformTime(undefined)).toBeNaN()
})

Deno.test('documents added are read newest first until the read passes the period', async () => {
  const newest = Date.parse('2026-10-20T12:00:00Z')
  // Inside the period, but not library documents.
  const created = new Date(newest - 6 * HOUR).toISOString().slice(0, -1)
  const { provider, pages, searches } = box({
    total: 1000,
    newest,
    extra: {
      draft: { title: 'Draft report', metadata: { status: 'PROCESSED' }, created, hidden: true },
      failed: { title: 'Failed import', metadata: { status: 'ERROR' }, created },
      help: { title: 'Using the portal', slug: 'doc-using', created },
    },
  })
  // The 24 hours from 08:00 UTC on 19 October hold documents r5 to r28.
  const from = '2026-10-19T08:00:00.000Z'
  const to = '2026-10-20T08:00:00.000Z'
  const result = await provider.addedBetween(TENANT, from, to)
  expect(result.readBackTo).toBeNull()
  expect(result.created).toHaveLength(24)
  expect(result.created[0]).toBe('2026-10-20T07:00:00.000Z')
  expect(result.created.at(-1)).toBe(from)
  // The first page already reaches past `from`, so no later page is read.
  expect(pages).toEqual([0])
  expect(searches[0]).toContain('sort_field=created')
  expect(searches[0]).toContain('sort_order=desc')
  expect(searches[0]).toContain('hidden=false')
})

Deno.test('a read that stops short says how far back it reached; a failed first page throws', async () => {
  const newest = Date.parse('2026-10-20T12:00:00Z')
  const from = '2026-09-01T00:00:00.000Z'
  const to = '2026-10-21T00:00:00.000Z'
  const stopped = box({ total: 2000, newest, failAt: 2 })
  const result = await stopped.provider.addedBetween(TENANT, from, to)
  expect(stopped.pages).toEqual([0, 1, 2])
  expect(result.created).toHaveLength(400)
  // The oldest document read was r399, added 399 hours before the newest.
  expect(result.readBackTo).toBe(new Date(newest - 399 * HOUR).toISOString())

  const capped = box({ total: 60 * PAGE, newest: Date.parse('2026-10-20T12:00:00Z') })
  const all = await capped.provider.addedBetween(TENANT, '2020-01-01T00:00:00.000Z', to)
  expect(capped.pages).toHaveLength(50)
  expect(all.created).toHaveLength(50 * PAGE)
  expect(all.readBackTo).toBe(new Date(newest - (50 * PAGE - 1) * HOUR).toISOString())

  const failing = box({ total: 10, newest, failAt: 0 })
  await expect(failing.provider.addedBetween(TENANT, from, to)).rejects.toThrow()
})
