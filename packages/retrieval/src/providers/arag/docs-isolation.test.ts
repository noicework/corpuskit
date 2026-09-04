import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import {
  DOC_PAGES,
  docResourceOrigin,
  DOCUMENTATION_LABEL,
  DOCUMENTATION_LABELSET,
} from '@research-portal/core'
import {
  AragProvider,
  docOnlyFilterExpression,
  isDocumentationResource,
  researchExcludeFilterExpression,
  SEARCH_CONFIG_DOC_ASK,
  SEARCH_CONFIG_DOC_FIND,
  SEARCH_CONFIG_RESEARCH_ASK,
  SEARCH_CONFIG_RESEARCH_FIND,
} from './index.ts'

/**
 * The CENTRAL search-config isolation contract (packages/retrieval/CLAUDE.md):
 *  - the research configs (portal-search / portal-ask) EXCLUDE the
 *    `documentation` label,
 *  - the doc-scoped configs (portal-doc-search / portal-doc-ask) include ONLY
 *    it,
 *  - `search`/`ask` select the config by `docScope`, and a server-side
 *    cross-check filters results so isolation holds even if the stored filter
 *    misbehaves (the platform's known weak `/ask` filtering).
 */

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** An NDJSON `/ask` stream from a list of item objects. */
function ndjsonResponse(items: unknown[], headers: Record<string, string> = {}): Response {
  const body = items.map((item) => JSON.stringify({ item })).join('\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson', ...headers },
  })
}

function providerWithFetch(fetchImpl: typeof fetch): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl,
  })
}

const RESEARCH_RAW = {
  title: 'Carp control final report',
  metadata: { status: 'PROCESSED' },
  origin: { url: 'https://example.org/report.pdf' },
}
const DOC_RAW = {
  title: 'Search: Find versus Ask',
  metadata: { status: 'PROCESSED' },
  slug: 'doc-search',
  origin: { url: docResourceOrigin('search') },
  usermetadata: {
    classifications: [{ labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL }],
  },
}

// ---------------------------------------------------------------------------
// Pure filter-shape and identity helpers
// ---------------------------------------------------------------------------

describe('filter expressions', () => {
  it('research-exclude NOTs the documentation label field predicate', () => {
    expect(researchExcludeFilterExpression()).toEqual({
      field: {
        not: { prop: 'label', labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL },
      },
    })
  })

  it('doc-only is the plain documentation label field predicate', () => {
    expect(docOnlyFilterExpression()).toEqual({
      field: { prop: 'label', labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL },
    })
  })
})

describe('isDocumentationResource()', () => {
  it('is true by classification label', () => {
    expect(isDocumentationResource({
      usermetadata: {
        classifications: [{ labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL }],
      },
    })).toBe(true)
  })

  it('is true by origin url even when labels are absent from the payload', () => {
    expect(isDocumentationResource({ origin: { url: docResourceOrigin('assistant') } })).toBe(true)
  })

  it('is true by doc- slug fallback', () => {
    expect(isDocumentationResource({ slug: 'doc-library' })).toBe(true)
  })

  it('is false for ordinary research content', () => {
    expect(isDocumentationResource(RESEARCH_RAW)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ensureSearchConfigs - the stored configs carry the isolation filters
// ---------------------------------------------------------------------------

describe('ensureSearchConfigs()', () => {
  it('stores the exclusion filter on research configs and the doc-only filter on doc configs', async () => {
    const bodies = new Map<string, Record<string, unknown>>()
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const name = url.split('/search_configurations/')[1] ?? ''
      bodies.set(name, JSON.parse(String(init?.body ?? '{}')))
      return Promise.resolve(jsonResponse({ ok: true }, 201))
    })

    const created = await provider.ensureSearchConfigs(TENANT)

    // All four scoped configs plus typeahead are written.
    expect(created).toContain(SEARCH_CONFIG_RESEARCH_FIND)
    expect(created).toContain(SEARCH_CONFIG_RESEARCH_ASK)
    expect(created).toContain(SEARCH_CONFIG_DOC_FIND)
    expect(created).toContain(SEARCH_CONFIG_DOC_ASK)

    const exclude = researchExcludeFilterExpression()
    const only = docOnlyFilterExpression()
    for (const name of [SEARCH_CONFIG_RESEARCH_FIND, SEARCH_CONFIG_RESEARCH_ASK]) {
      const config = (bodies.get(name)?.config ?? {}) as Record<string, unknown>
      expect(config.filter_expression).toEqual(exclude)
    }
    for (const name of [SEARCH_CONFIG_DOC_FIND, SEARCH_CONFIG_DOC_ASK]) {
      const config = (bodies.get(name)?.config ?? {}) as Record<string, unknown>
      expect(config.filter_expression).toEqual(only)
    }
  })

  it('back-fills an existing config in place via PATCH when POST conflicts', async () => {
    const methods: string[] = []
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/search_configurations/')) {
        methods.push(method)
        // POST 409s (already exists); PATCH converges it.
        if (method === 'POST') return Promise.resolve(jsonResponse({ error: 'exists' }, 409))
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    const created = await provider.ensureSearchConfigs(TENANT)
    expect(created).toContain(SEARCH_CONFIG_RESEARCH_FIND)
    // Every config was attempted as POST then PATCHed on the conflict.
    expect(methods.filter((m) => m === 'PATCH').length).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// search() doc-scope selection + cross-check
// ---------------------------------------------------------------------------

describe('search() documentation scoping', () => {
  it('research search selects portal-search and drops any documentation that leaks in', async () => {
    let findBody: Record<string, unknown> = {}
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/find')) {
        findBody = JSON.parse(String(init?.body ?? '{}'))
        return Promise.resolve(jsonResponse({
          resources: {
            'res-research': {
              ...RESEARCH_RAW,
              fields: { a: { paragraphs: { p: { score: 0.8, text: 'carp' } } } },
            },
            'res-doc': {
              ...DOC_RAW,
              fields: { a: { paragraphs: { p: { score: 0.9, text: 'find vs ask' } } } },
            },
          },
        }))
      }
      // listResources catalogue call
      return Promise.resolve(jsonResponse({ resources: {} }))
    })

    const results = await provider.search(TENANT, 'carp', {})
    expect(findBody.search_configuration).toBe(SEARCH_CONFIG_RESEARCH_FIND)
    // The documentation resource is excluded from research results.
    expect(results.resources.map((r) => r.id)).toEqual(['res-research'])
  })

  it('doc search selects portal-doc-search and keeps ONLY documentation', async () => {
    let findBody: Record<string, unknown> = {}
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/find')) {
        findBody = JSON.parse(String(init?.body ?? '{}'))
        return Promise.resolve(jsonResponse({
          resources: {
            'res-research': {
              ...RESEARCH_RAW,
              fields: { a: { paragraphs: { p: { score: 0.8, text: 'carp' } } } },
            },
            'res-doc': {
              ...DOC_RAW,
              fields: { a: { paragraphs: { p: { score: 0.9, text: 'find vs ask' } } } },
            },
          },
        }))
      }
      return Promise.resolve(jsonResponse({ resources: {} }))
    })

    const results = await provider.search(TENANT, 'how do I search', { docScope: true })
    expect(findBody.search_configuration).toBe(SEARCH_CONFIG_DOC_FIND)
    // Only the documentation resource survives the cross-check.
    expect(results.resources.map((r) => r.id)).toEqual(['res-doc'])
  })
})

// ---------------------------------------------------------------------------
// ask() doc-scope selection + citation cross-check
// ---------------------------------------------------------------------------

async function collect(events: AsyncIterable<{ type: string } & Record<string, unknown>>) {
  const out: ({ type: string } & Record<string, unknown>)[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('ask() documentation scoping', () => {
  it('doc ask selects portal-doc-ask and cites only documentation sources', async () => {
    let askBody: Record<string, unknown> = {}
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/ask')) {
        askBody = JSON.parse(String(init?.body ?? '{}'))
        return Promise.resolve(ndjsonResponse([
          {
            type: 'retrieval',
            results: {
              resources: {
                'res-doc': {
                  ...DOC_RAW,
                  fields: {
                    a: { paragraphs: { p: { score: 0.9, text: 'Use Find to locate documents.' } } },
                  },
                },
              },
            },
          },
          { type: 'answer', text: 'Use **Find** to locate documents [1].' },
          { type: 'citations', citations: { 'Use Find to locate documents.': ['res-doc'] } },
          { type: 'done' },
        ]))
      }
      // listResources / remi etc
      return Promise.resolve(jsonResponse({ resources: {} }))
    })

    const events = await collect(
      provider.ask(TENANT, 'how do I find documents', { docScope: true }),
    )
    expect(askBody.search_configuration).toBe(SEARCH_CONFIG_DOC_ASK)
    const sources = events.find((e) => e.type === 'sources')
    expect((sources?.resources as { id: string }[]).map((r) => r.id)).toEqual(['res-doc'])
    const done = events.find((e) => e.type === 'done')
    expect(done?.refused).toBeFalsy()
  })

  it('research ask withholds an answer grounded ONLY in leaked documentation', async () => {
    const provider = providerWithFetch((input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/ask')) {
        return Promise.resolve(ndjsonResponse([
          {
            type: 'retrieval',
            results: {
              // The stored filter failed (weak /ask filtering) and only a
              // documentation resource grounded the answer.
              resources: {
                'res-doc': {
                  ...DOC_RAW,
                  fields: {
                    a: { paragraphs: { p: { score: 0.9, text: 'How to search the portal.' } } },
                  },
                },
              },
            },
          },
          { type: 'answer', text: 'To search, use the box [1].' },
          { type: 'done' },
        ]))
      }
      return Promise.resolve(jsonResponse({ resources: {} }))
    })

    const events = await collect(provider.ask(TENANT, 'what does the corpus say', {}))
    const done = events.find((e) => e.type === 'done')
    expect(done?.refused).toBe(true)
    // No documentation source is surfaced on a research answer.
    const sourceEvents = events.filter((e) => e.type === 'sources')
    const last = sourceEvents[sourceEvents.length - 1]
    expect((last?.resources as unknown[]) ?? []).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ingestDocumentation - creates labelled resources, idempotent by page id
// ---------------------------------------------------------------------------

describe('ingestDocumentation()', () => {
  it('creates each page as a documentation-labelled resource with the right slug and origin', async () => {
    const posted: Record<string, unknown>[] = []
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/resources') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return Promise.resolve(jsonResponse({ uuid: 'new' }, 201))
      }
      return Promise.resolve(jsonResponse({}))
    })

    const result = await provider.ingestDocumentation(TENANT, DOC_PAGES.slice(0, 2))
    expect(result.created.length).toBe(2)
    expect(result.updated.length).toBe(0)
    for (const body of posted) {
      const classifications =
        (body.usermetadata as { classifications: { labelset: string; label: string }[] })
          .classifications
      expect(classifications).toContainEqual({
        labelset: DOCUMENTATION_LABELSET,
        label: DOCUMENTATION_LABEL,
      })
      expect(String(body.slug)).toMatch(/^doc-/)
      expect(String((body.origin as { url: string }).url)).toMatch(/^portal-doc:/)
    }
  })

  it('updates in place (PATCH) when the slug already exists - idempotent by page id', async () => {
    let patched = 0
    const provider = providerWithFetch((input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/resources') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'slug exists' }, 409))
      }
      if (url.includes('/slug/')) {
        return Promise.resolve(jsonResponse({ id: 'existing-id' }))
      }
      if (url.includes('/resource/existing-id') && init?.method === 'PATCH') {
        patched += 1
        return Promise.resolve(jsonResponse({}))
      }
      return Promise.resolve(jsonResponse({}))
    })

    const result = await provider.ingestDocumentation(TENANT, DOC_PAGES.slice(0, 1))
    expect(result.updated).toEqual([DOC_PAGES[0]!.id])
    expect(result.created.length).toBe(0)
    expect(patched).toBe(1)
  })
})
