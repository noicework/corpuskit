import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { findPageSummaryFieldId } from '../../merchandise.ts'
import { AragProvider } from './index.ts'

/**
 * Cards must never be bare (#46): when a resource has no summary of its own
 * and no generated enrichment yet, list surfaces (search, library, topic
 * rows) show the platform's DA page summary. List endpoints only return the
 * field's id, so the provider fetches that one small field per bare card,
 * bounded and memoised, and leaves the card untouched when the read fails.
 */

const TENANT: TenantConfig = {
  slug: 'demo',
  branding: {
    productName: 'Demo Portal',
    organisation: 'Demo',
    tagline: 'Research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

const PAGE_SUMMARY = 'This project investigates how wheat traits affect frost susceptibility.'
const FIELD_ID = 'da-pagesummary-f-65dc5dc96c28479db9d08fcd14c20a85'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A processed resource whose title is a project code and which has no summary. */
function bareRaw() {
  return {
    title: 'CSP2307-003RTX.txt',
    metadata: { status: 'PROCESSED' },
    data: { texts: { [FIELD_ID]: {} } },
  }
}

interface Calls {
  find: number
  catalog: number
  field: number
}

/** A stub platform: one bare resource, its page summary behind the field read. */
function stubProvider(
  opts: { fieldStatus?: number; ownSummary?: string } = {},
): { provider: AragProvider; calls: Calls } {
  const calls: Calls = { find: 0, catalog: 0, field: 0 }
  const raw = {
    ...bareRaw(),
    ...(opts.ownSummary ? { summary: opts.ownSummary } : {}),
  }
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/find')) {
        calls.find++
        return Promise.resolve(jsonResponse({
          resources: {
            'res-1': {
              ...raw,
              fields: { a: { paragraphs: { p: { score: 0.8, text: 'wheat' } } } },
            },
          },
        }))
      }
      if (url.includes('/catalog')) {
        calls.catalog++
        return Promise.resolve(
          jsonResponse({ resources: { 'res-1': raw }, fulltext: { total: 1 } }),
        )
      }
      if (url.includes(`/resource/res-1/text/${FIELD_ID}`)) {
        calls.field++
        if (opts.fieldStatus && opts.fieldStatus !== 200) {
          return Promise.resolve(jsonResponse({ detail: 'boom' }, opts.fieldStatus))
        }
        return Promise.resolve(jsonResponse({ extracted: { text: { text: PAGE_SUMMARY } } }))
      }
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
  return { provider, calls }
}

describe('findPageSummaryFieldId()', () => {
  it('picks the DA page-summary field among a resource text field ids', () => {
    expect(findPageSummaryFieldId(['body', FIELD_ID, 'da-labels-f-x'])).toBe(FIELD_ID)
    expect(findPageSummaryFieldId(['body', 'da-labels-f-x'])).toBeUndefined()
  })
})

describe('platform page-summary fallback on list surfaces', () => {
  it('search: a bare card takes the platform summary; the title stays the cleaned code', async () => {
    const { provider, calls } = stubProvider()
    const results = await provider.search(TENANT, 'wheat', {})
    expect(results.resources).toHaveLength(1)
    const card = results.resources[0]!
    expect(card.title).toBe('CSP2307-003RTX')
    expect(card.summary).toBe(PAGE_SUMMARY)
    expect(card.enriched ?? false).toBe(false)
    expect(calls.field).toBe(1)
  })

  it('search: the summary is memoised, so a second query reads no field again', async () => {
    const { provider, calls } = stubProvider()
    await provider.search(TENANT, 'wheat', {})
    await provider.search(TENANT, 'wheat again', {})
    expect(calls.find).toBe(2)
    expect(calls.field).toBe(1)
  })

  it('search: a resource with its own summary triggers no field read', async () => {
    const { provider, calls } = stubProvider({ ownSummary: 'A real abstract.' })
    const results = await provider.search(TENANT, 'wheat', {})
    expect(results.resources[0]!.summary).toBe('A real abstract.')
    expect(calls.field).toBe(0)
  })

  it('search: a failed field read leaves the card on its fallback and is retried next time', async () => {
    const { provider, calls } = stubProvider({ fieldStatus: 500 })
    const first = await provider.search(TENANT, 'wheat', {})
    expect(first.resources[0]!.summary).toBe('CSP2307-003RTX')
    await provider.search(TENANT, 'wheat', {})
    expect(calls.field).toBe(2)
  })

  it('library browse and topic rows take the platform summary too', async () => {
    const { provider, calls } = stubProvider()
    const page = await provider.catalog(TENANT, {})
    expect(page.items[0]!.summary).toBe(PAGE_SUMMARY)
    const row = await provider.topicResources(TENANT, 'any-topic', 12)
    expect(row[0]!.summary).toBe(PAGE_SUMMARY)
    // One resource, one read: the cache serves the second surface.
    expect(calls.field).toBe(1)
  })
})
