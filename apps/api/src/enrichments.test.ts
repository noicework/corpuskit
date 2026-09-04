import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type {
  Citation,
  Enrichment,
  EnrichmentRunEvent,
  ResourceSummary,
  ScoredResource,
  TenantConfig,
} from '@research-portal/core'
import { DEFAULT_RESEARCH_ENRICHMENT } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import {
  buildEnrichmentQuery,
  EnrichmentStore,
  generateEnrichment,
  merchandiseCitation,
  merchandiseScored,
  merchandiseSources,
  merchandiseSummary,
  runEnrichmentOverCorpus,
} from './enrichments.ts'

/**
 * The enrichment store, the merchandising overlays, and app-side generation
 * (the query-time answer_json_schema path that sidesteps the unavailable
 * ingest-time JSON DA generator), driven by fetch doubles.
 */

const tmp = () => Deno.makeTempDirSync()

const baseSummary = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: 'r1',
  title: 'Project 1981-071',
  summary: 'Project 1981-071',
  type: 'document',
  topicIds: [],
  keyFacts: [],
  sourceName: '1981-071-DLD.pdf',
  enriched: false,
  ...over,
})

const enrichment = (): Enrichment => ({
  schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
  generatedAt: '2026-08-28T00:00:00.000Z',
  data: {
    title: 'Echo-sounder and radar training for professional fishers',
    summary: 'A 1985 NSW Department of Agriculture course program.',
    keyTakeaways: ['Covers echosounders, sonar, radar and radio'],
    quotesOfInterest: ['"Participants receive financial assistance"'],
  },
})

describe('EnrichmentStore', () => {
  it('persists and reads back an enrichment keyed by tenant + resource', () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    expect(store.get('marine', 'r1')?.data.title).toContain('Echo-sounder')
    expect(store.count('marine')).toBe(1)
    expect(store.get('marine', 'missing')).toBeUndefined()
  })

  it('survives a fresh instance over the same directory (durable)', () => {
    const dir = tmp()
    new EnrichmentStore(dir).put('marine', 'r1', enrichment())
    expect(new EnrichmentStore(dir).get('marine', 'r1')?.data.title).toContain('Echo-sounder')
  })
})

describe('merchandising overlays', () => {
  it('leaves the baseline title (fallback) when no enrichment is stored', () => {
    const store = new EnrichmentStore(tmp())
    const out = merchandiseSummary(store, 'marine', baseSummary())
    expect(out.title).toBe('Project 1981-071')
    expect(out.enriched).toBe(false)
    expect(out.sourceName).toBe('1981-071-DLD.pdf')
  })

  it('overlays the generated title/summary/takeaways/quotes when present', () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const out = merchandiseSummary(store, 'marine', baseSummary())
    expect(out.title).toBe('Echo-sounder and radar training for professional fishers')
    expect(out.summary).toContain('1985 NSW Department of Agriculture')
    expect(out.keyTakeaways?.length).toBe(1)
    expect(out.quotesOfInterest?.length).toBe(1)
    expect(out.enriched).toBe(true)
    // Raw filename is retained as muted secondary, never the headline.
    expect(out.sourceName).toBe('1981-071-DLD.pdf')
  })

  it('overlays a scored search result the same way', () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const scored: ScoredResource = { ...baseSummary(), relevance: 0.8, citedCount: 0 }
    const out = merchandiseScored(store, 'marine', scored)
    expect(out.title).toBe('Echo-sounder and radar training for professional fishers')
    expect(out.relevance).toBe(0.8)
  })

  it('merchandiseSources overlays every source in an /ask or /generate sources list', () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const scored: ScoredResource = { ...baseSummary(), relevance: 0.8, citedCount: 0 }
    const [out] = merchandiseSources(store, 'marine', [scored])
    expect(out?.title).toBe('Echo-sounder and radar training for professional fishers')
  })

  it('merchandiseCitation - BUG 1 - overlays a resolved /ask citation title, never the raw filename', () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const citation: Citation = { index: 1, resourceId: 'r1', title: 'Project 1981-071' }
    const out = merchandiseCitation(store, 'marine', citation)
    expect(out.title).toBe('Echo-sounder and radar training for professional fishers')
    // Everything else about the citation (the platform's own evidence) is untouched.
    expect(out.index).toBe(1)
    expect(out.resourceId).toBe('r1')
  })

  it('merchandiseCitation falls back to the baseline title when no enrichment is stored', () => {
    const store = new EnrichmentStore(tmp())
    const citation: Citation = { index: 1, resourceId: 'unknown-resource', title: 'A Real Title' }
    const out = merchandiseCitation(store, 'marine', citation)
    expect(out.title).toBe('A Real Title')
  })
})

describe('buildEnrichmentQuery', () => {
  it('names every field of the agent (programmatic, not hardcoded)', () => {
    const q = buildEnrichmentQuery(DEFAULT_RESEARCH_ENRICHMENT)
    for (const field of DEFAULT_RESEARCH_ENRICHMENT.fields) {
      expect(q).toContain(field.label)
    }
    expect(q).toContain('SINGLE research document')
  })
})

// --- Generation via fetch doubles -----------------------------------------

const KB = 'https://test.rag.progress.cloud/api/v1/kb/test-kb'

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A management double: /catalog lists two resources, each /resource carries a
 * DA page-summary field, /ask returns a structured answer_json object. `answer`
 * overrides the generated object; `pageSummary` seeds the DA field.
 *
 * `askBodies`, when passed, collects the parsed JSON body of every /ask call -
 * so a test can assert what generation actually sent (no resource_filters,
 * the document text embedded in the query).
 */
function management(
  opts: {
    answer?: Record<string, unknown>
    pageSummary?: string
    bodyText?: string
    askShouldFail?: boolean
    askFailures?: number
    catalogues?: Record<string, unknown>[]
    noAnswer?: boolean
    resourceShouldFail?: boolean
  } = {},
  askBodies?: Record<string, unknown>[],
): AragProvider {
  let askFailures = opts.askFailures ?? 0
  let catalogueCall = 0
  const pageSummary = opts.pageSummary ??
    'This document outlines a series of courses for professional fishers in 1985.'
  const answer = opts.answer ?? {
    title: 'Echo-sounder and radar training for professional fishers',
    summary: '', // force the page-summary reuse path
    keyTakeaways: ['Covers echosounders, sonar, radar and radio'],
    quotesOfInterest: [],
  }
  return new AragProvider({
    resolveBinding: (slug) => slug === 'marine' ? { baseUrl: KB, token: 't' } : undefined,
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) {
        const configured = opts.catalogues?.[
          Math.min(catalogueCall++, Math.max(0, opts.catalogues.length - 1))
        ]
        return Promise.resolve(json({
          resources: configured ?? {
            r1: { title: '1981-071-DLD.pdf', metadata: { status: 'PROCESSED' } },
            r2: { title: '1984-065-DLD.pdf', metadata: { status: 'PROCESSED' } },
          },
        }))
      }
      if (url.includes('/resource/')) {
        if (opts.resourceShouldFail) return Promise.resolve(new Response('boom', { status: 500 }))
        return Promise.resolve(json({
          title: '1981-071-DLD.pdf',
          data: {
            texts: {
              ...(pageSummary
                ? { 'da-pagesummary-f-file': { extracted: { text: { text: pageSummary } } } }
                : {}),
              ...(opts.bodyText ? { body: { extracted: { text: { text: opts.bodyText } } } } : {}),
            },
          },
        }))
      }
      if (url.endsWith('/ask')) {
        if (askBodies && init?.body) askBodies.push(JSON.parse(init.body as string))
        if (askFailures > 0) {
          askFailures--
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        if (opts.askShouldFail) return Promise.resolve(new Response('boom', { status: 500 }))
        return Promise.resolve(ndjson([
          { item: { type: 'retrieval', results: { resources: {} } } },
          ...(opts.noAnswer ? [] : [{ item: { type: 'answer_json', object: answer } }]),
        ]))
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  })
}

const config = {
  slug: 'marine',
  branding: {
    productName: 'P',
    organisation: 'O',
    tagline: 't',
    colours: { primary: '#000', accent: '#000', heroFrom: '#000', heroTo: '#000' },
  },
  searchPlaceholder: '',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
} satisfies TenantConfig

describe('generateEnrichment', () => {
  it('produces schema-conformant data and reuses the DA page summary for the summary field', async () => {
    const e = await generateEnrichment(management(), config, 'r1')
    expect(e.schemaId).toBe(DEFAULT_RESEARCH_ENRICHMENT.id)
    expect(e.data.title).toContain('Echo-sounder')
    // The generator returned an empty summary; the DA page summary filled it.
    expect(e.data.summary).toContain('courses for professional fishers')
    expect(e.usedPageSummary).toBe(true)
  })

  it('prefers the platform DA page summary even over a generated summary (cheaper, already paid for)', async () => {
    const e = await generateEnrichment(
      management({
        answer: {
          title: 'A real title',
          summary: 'A full generated summary of at least forty characters in length here.',
          keyTakeaways: [],
          quotesOfInterest: [],
        },
      }),
      config,
      'r1',
    )
    expect(e.data.summary).toContain('courses for professional fishers')
    expect(e.usedPageSummary).toBe(true)
  })

  it('falls back to the generated summary when no DA page summary exists', async () => {
    const e = await generateEnrichment(
      management({
        pageSummary: '', // no DA page summary on this resource
        bodyText: 'The extracted body text of the document, used as grounding when there is no ' +
          'page summary to embed instead.',
        answer: {
          title: 'A real title',
          summary: 'A full generated summary of at least forty characters in length here.',
          keyTakeaways: [],
          quotesOfInterest: [],
        },
      }),
      config,
      'r1',
    )
    expect(e.data.summary).toContain('full generated summary')
    expect(e.usedPageSummary).toBeUndefined()
  })

  it("embeds the resource's own text in the query and generates WITHOUT resource_filters", async () => {
    const askBodies: Record<string, unknown>[] = []
    const e = await generateEnrichment(management({}, askBodies), config, 'r1')
    expect(askBodies.length).toBe(1)
    const body = askBodies[0]!
    // The document's own text is embedded in the query - no dependency on
    // scoped retrieval, so no resource_filters and no reliance on ingest status.
    expect(body.resource_filters).toBeUndefined()
    expect(String(body.query)).toContain('courses for professional fishers')
    expect(e.data.title).toContain('Echo-sounder')
  })

  it('prefers the platform page summary as the embedded grounding text when present', async () => {
    const askBodies: Record<string, unknown>[] = []
    await generateEnrichment(
      management({ bodyText: 'Some other extracted body text, not the page summary.' }, askBodies),
      config,
      'r1',
    )
    const body = askBodies[0]!
    expect(String(body.query)).toContain('courses for professional fishers')
    expect(String(body.query)).not.toContain('Some other extracted body text')
  })

  it('falls back to the extracted body text as grounding when there is no page summary', async () => {
    const askBodies: Record<string, unknown>[] = []
    await generateEnrichment(
      management({
        pageSummary: '',
        bodyText: 'This is the full extracted body text used as grounding instead.',
      }, askBodies),
      config,
      'r1',
    )
    const body = askBodies[0]!
    expect(String(body.query)).toContain('full extracted body text used as grounding')
  })

  it(
    'returns a partial (degraded) enrichment from the page summary when structured ' +
      'generation returns nothing, rather than erroring',
    async () => {
      const e = await generateEnrichment(management({ noAnswer: true }), config, 'r1')
      expect(e.degraded).toBe(true)
      expect(e.data.summary).toBe(
        'This document outlines a series of courses for professional fishers in 1985.',
      )
      // Title derived from the page summary's first sentence, not empty/an error.
      expect(typeof e.data.title).toBe('string')
      expect((e.data.title as string).length).toBeGreaterThan(0)
      expect(e.usedPageSummary).toBe(true)
    },
  )

  it(
    'also degrades gracefully on a hard platform error (5xx) when a page summary is available',
    async () => {
      const e = await generateEnrichment(management({ askShouldFail: true }), config, 'r1')
      expect(e.degraded).toBe(true)
      expect(e.data.summary).toContain('courses for professional fishers')
    },
  )

  it(
    'throws only when there is genuinely nothing to work with (no content, no page summary)',
    async () => {
      let threw = false
      try {
        await generateEnrichment(management({ resourceShouldFail: true }), config, 'r1')
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    },
  )
})

describe('runEnrichmentOverCorpus', () => {
  async function collect(gen: AsyncGenerator<EnrichmentRunEvent>): Promise<EnrichmentRunEvent[]> {
    const out: EnrichmentRunEvent[] = []
    for await (const e of gen) out.push(e)
    return out
  }

  it('streams start -> item(s) -> done and stores each enrichment', async () => {
    const store = new EnrichmentStore(tmp())
    const events = await collect(
      runEnrichmentOverCorpus(management(), store, config, { scope: 'missing' }),
    )
    expect(events[0]).toEqual({ type: 'start', total: 2 })
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type === 'done') {
      expect(done.enriched).toBe(2)
      expect(done.errors).toBe(0)
    }
    expect(store.count('marine')).toBe(2)
    // Item events carry the generated title, not the filename.
    const items = events.filter((e) => e.type === 'item')
    expect(items.every((i) => i.type === 'item' && i.outcome === 'enriched')).toBe(true)
  })

  it('scope "missing" skips resources already enriched', async () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const events = await collect(
      runEnrichmentOverCorpus(management(), store, config, { scope: 'missing' }),
    )
    expect(events[0]).toEqual({ type: 'start', total: 1 })
  })

  it('reports done with zero only after a fresh one-item missing probe confirms caught up', async () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    store.put('marine', 'r2', enrichment())
    const events = await collect(
      runEnrichmentOverCorpus(management(), store, config, { scope: 'missing' }),
    )
    expect(events).toEqual([
      { type: 'start', total: 0 },
      { type: 'done', enriched: 0, errors: 0 },
    ])
  })

  it('a fresh limit-one probe finds work hidden by an optimistic cached zero', async () => {
    const store = new EnrichmentStore(tmp())
    store.put('marine', 'r1', enrichment())
    const events = await collect(
      runEnrichmentOverCorpus(
        management({
          catalogues: [
            { r1: { title: 'Already enriched', metadata: { status: 'PROCESSED' } } },
            {
              r1: { title: 'Already enriched', metadata: { status: 'PROCESSED' } },
              r2: { title: 'Still outstanding', metadata: { status: 'PROCESSED' } },
            },
          ],
        }),
        store,
        config,
        { scope: 'missing' },
      ),
    )
    expect(events[0]).toEqual({ type: 'start', total: 1 })
    expect(events.at(-1)).toEqual({ type: 'done', enriched: 1, errors: 0 })
    expect(store.get('marine', 'r2')).toBeDefined()
  })

  it('an empty catalogue response remains distinct from caught up', async () => {
    const events = await collect(
      runEnrichmentOverCorpus(
        management({ catalogues: [{}, {}] }),
        new EnrichmentStore(tmp()),
        config,
        {
          scope: 'missing',
          backoff: {
            baseDelayMs: 0,
            maxDelayMs: 0,
            sleep: () => Promise.resolve(),
          },
        },
      ),
    )
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('retries a 429 with bounded back-off and enriches instead of reporting caught up', async () => {
    const store = new EnrichmentStore(tmp())
    const waits: number[] = []
    const events = await collect(
      runEnrichmentOverCorpus(management({ askFailures: 1 }), store, config, {
        scope: 'all',
        limit: 1,
        backoff: {
          maxRetries: 1,
          baseDelayMs: 10,
          maxDelayMs: 10,
          sleep: (ms) => {
            waits.push(ms)
            return Promise.resolve()
          },
        },
      }),
    )
    expect(waits).toEqual([10])
    expect(events.at(-1)).toEqual({ type: 'done', enriched: 1, errors: 0 })
    expect(store.get('marine', 'r1')).toBeDefined()
  })

  it('stops with an error, never done zero, when 429 strain outlasts the retry budget', async () => {
    const store = new EnrichmentStore(tmp())
    const events = await collect(
      runEnrichmentOverCorpus(management({ askFailures: 3 }), store, config, {
        scope: 'all',
        limit: 1,
        backoff: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          sleep: () => Promise.resolve(),
        },
      }),
    )
    expect(events.some((event) => event.type === 'done')).toBe(false)
    const final = events.at(-1)
    expect(final?.type).toBe('error')
    if (final?.type === 'error') {
      expect(final.message).toContain('bounded retries')
    }
  })

  it('backs off after elevated catalogue latency before generating', async () => {
    let clock = 0
    const waits: number[] = []
    const slow = {
      listResources: () => {
        clock += 6_000
        return Promise.resolve([baseSummary()])
      },
      resourceContent: () =>
        Promise.resolve({
          id: 'r1',
          title: 'A report',
          summary: 'A useful source summary with enough detail to merchandise the report.',
          slug: 'a-report',
          kind: 'text',
          texts: [{ fieldId: 'body', text: 'Grounding text for the report.' }],
          topicIds: [],
        }),
      askStructured: () =>
        Promise.resolve({
          object: {
            title: 'A real report title',
            summary: 'A useful source summary with enough detail to merchandise the report.',
            keyTakeaways: [],
            quotesOfInterest: [],
          },
        }),
    } as unknown as AragProvider
    const events = await collect(
      runEnrichmentOverCorpus(slow, new EnrichmentStore(tmp()), config, {
        scope: 'all',
        backoff: {
          now: () => clock,
          baseDelayMs: 25,
          maxDelayMs: 25,
          sleep: (ms) => {
            waits.push(ms)
            clock += ms
            return Promise.resolve()
          },
        },
      }),
    )
    expect(waits).toContain(25)
    expect(events.at(-1)).toEqual({ type: 'done', enriched: 1, errors: 0 })
  })

  it(
    'a structured-generation failure degrades gracefully rather than erroring the run ' +
      '(the page summary is still available)',
    async () => {
      const store = new EnrichmentStore(tmp())
      const events = await collect(
        runEnrichmentOverCorpus(management({ askShouldFail: true }), store, config, {
          scope: 'all',
        }),
      )
      const done = events.at(-1)
      if (done?.type === 'done') {
        expect(done.errors).toBe(0)
        expect(done.enriched).toBe(2)
      }
      expect(store.get('marine', 'r1')?.degraded).toBe(true)
    },
  )

  it(
    'does not report done zero when every outstanding resource yields an error',
    async () => {
      const store = new EnrichmentStore(tmp())
      const events = await collect(
        runEnrichmentOverCorpus(management({ resourceShouldFail: true }), store, config, {
          scope: 'all',
          backoff: {
            baseDelayMs: 0,
            maxDelayMs: 0,
            sleep: () => Promise.resolve(),
          },
        }),
      )
      expect(events.some((event) => event.type === 'done')).toBe(false)
      expect(events.at(-1)?.type).toBe('error')
    },
  )
})
