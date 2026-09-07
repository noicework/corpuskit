import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  type AskEvent,
  AskEventSchema,
  type CatalogPage,
  type FacetCounts,
  type Labelset,
  type Question,
  type ResourceSummary,
  type SearchResults,
  type TenantConfig,
} from '@research-portal/core'
import type { AragProvider, RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { tenantsWithNeuro } from './fixtures/neuro-tenant.ts'
import { markersPerSentence } from './clause-pin.ts'

/**
 * Clause pinning end to end (review loop 8 section 6).
 *
 * The defect this closes, in one test: "compare the 12-month retention rates
 * of brivaracetam and perampanel" printed the perampanel extension's 74.6%
 * under a heading that said Brivaracetam (D8-14), and a figure the audit had
 * listed as removed was still in the body because both papers' passages sat
 * in one pool (D8-02). Here each drug is asked its own paper, and every
 * composed sentence carries exactly one marker.
 */

const BRV: ResourceSummary = {
  id: 'brv',
  title: 'Effectiveness and tolerability of 12-month brivaracetam in the real world',
  summary: 'A pooled real-world analysis of brivaracetam retention.',
  type: 'pdf',
  topicIds: ['epilepsy-research'],
  keyFacts: [],
}

const PER: ResourceSummary = {
  id: 'per',
  title: 'PERMIT study: a pooled analysis of perampanel effectiveness',
  summary: 'A pooled real-world analysis of perampanel retention.',
  type: 'pdf',
  topicIds: ['epilepsy-research'],
  keyFacts: [],
}

const TEXTS: Record<string, string> = {
  brv: 'Brivaracetam retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months, ' +
    'respectively (FAS; n = 1644).',
  per: 'Perampanel retention at 12 months was 64.2% (2698/4201) in the PERMIT pooled analysis.',
}

const ANSWERS: Record<string, string> = {
  brv: 'The 12-month retention rate was 71.1% (n = 1644).',
  per: 'The 12-month retention rate was 64.2% (2698/4201).',
}

class TwoPaperProvider implements RetrievalProvider {
  asked: { resourceId?: string; query: string }[] = []
  private resources = [BRV, PER]

  listResources(): Promise<ResourceSummary[]> {
    return Promise.resolve(this.resources)
  }
  resource(_t: TenantConfig, id: string): Promise<ResourceSummary | null> {
    return Promise.resolve(this.resources.find((r) => r.id === id) ?? null)
  }
  search(
    _t: TenantConfig,
    query: string,
    opts: { resourceIds?: string[] } = {},
  ): Promise<SearchResults> {
    const scope = opts.resourceIds
    const wants = (id: string) => (!scope || scope.includes(id))
    const resources = this.resources
      .filter((r) => wants(r.id))
      .map((r) => ({
        ...r,
        // The clause's own drug scores highest inside its own scope.
        relevance: new RegExp(r.id === 'brv' ? 'brivaracetam' : 'perampanel', 'i').test(query)
          ? 0.9
          : 0.5,
        citedCount: 0,
      }))
    return Promise.resolve({ query, resources, relatedQuestions: [] })
  }
  catalog(): Promise<CatalogPage> {
    return Promise.resolve({
      items: this.resources.map((r) => ({
        id: r.id,
        title: r.title,
        status: 'processed' as const,
        topicIds: r.topicIds,
      })),
      total: this.resources.length,
    })
  }
  facets(): Promise<FacetCounts> {
    return Promise.resolve({})
  }
  topicResources(): Promise<ResourceSummary[]> {
    return Promise.resolve(this.resources)
  }
  labelsets(): Promise<Labelset[]> {
    return Promise.resolve([])
  }
  suggest(): Promise<Question[]> {
    return Promise.resolve([])
  }
  async *ask(
    _t: TenantConfig,
    query: string,
    opts: { resourceId?: string } = {},
  ): AsyncIterable<AskEvent> {
    this.asked.push({ ...(opts.resourceId ? { resourceId: opts.resourceId } : {}), query })
    const id = opts.resourceId ?? 'brv'
    const resource = this.resources.find((r) => r.id === id)!
    yield { type: 'sources', resources: [{ ...resource, relevance: 0.9, citedCount: 1 }] }
    // The generator writes its own marker numbering, which means nothing in
    // a single-source context and is replaced by the composition.
    yield { type: 'delta', text: `${ANSWERS[id]}[3]` }
    yield { type: 'citation', citation: { index: 3, resourceId: id, title: resource.title } }
    yield { type: 'done', text: `${ANSWERS[id]}[3]` }
  }
}

const management = () =>
  ({
    resourceExtraction: (_t: TenantConfig, id: string) =>
      Promise.resolve({
        status: 'PROCESSED',
        text: TEXTS[id] ?? '',
        chars: 0,
        paragraphs: 0,
        tableRows: 0,
      }),
    rephrase: () => Promise.resolve(null),
    askStructured: () => Promise.reject(new Error('not in this test')),
  }) as unknown as AragProvider

const freshTenants = () => tenantsWithNeuro()

const sseEvents = async (response: Response): Promise<AskEvent[]> =>
  (await response.text())
    .split('\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => AskEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))

async function ask(provider: TwoPaperProvider, query: string) {
  const app = buildApp({ provider, tenants: freshTenants(), management: management() })
  const response = await app.request('/api/t/neuro/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const events = await sseEvents(response)
  const done = events.find((e) => e.type === 'done')
  return {
    events,
    text: done && done.type === 'done' ? done.text ?? '' : '',
    citations: events.flatMap((e) => e.type === 'citation' ? [e.citation] : []),
  }
}

describe('clause pinning: a comparison is answered one paper at a time (D8-13, D8-14)', () => {
  it('asks each drug its own paper and cites each figure to that paper', async () => {
    const provider = new TwoPaperProvider()
    const { text, citations } = await ask(
      provider,
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
    )
    // Two one-paper asks, each constrained by resource_filters, not one ask
    // over a pool of both papers.
    expect(provider.asked.filter((a) => a.resourceId).map((a) => a.resourceId).sort())
      .toEqual(['brv', 'per'])
    expect(text).toContain('**brivaracetam**')
    expect(text).toContain('**perampanel**')
    const brv = citations.find((c) => c.resourceId === 'brv')!
    const per = citations.find((c) => c.resourceId === 'per')!
    expect(text).toContain(`71.1% (n = 1644).[${brv.index}]`)
    expect(text).toContain(`64.2% (2698/4201).[${per.index}]`)
    // The D8-14 defect: one drug's figure under the other drug's heading.
    const headingBrv = text.indexOf('**brivaracetam**')
    const headingPer = text.indexOf('**perampanel**')
    const figureBrv = text.indexOf('71.1%')
    const figurePer = text.indexOf('64.2%')
    expect(figureBrv > headingBrv && (headingPer < headingBrv || figureBrv < headingPer))
      .toBe(true)
    expect(figurePer > headingPer && (headingBrv < headingPer || figurePer < headingBrv))
      .toBe(true)
  })

  it('gives every sentence exactly one citation marker', async () => {
    const { text } = await ask(
      new TwoPaperProvider(),
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
    )
    expect(markersPerSentence(text).every((n) => n <= 1)).toBe(true)
    expect(/\[\d+\]\s*\[\d+\]/.test(text)).toBe(false)
  })

  it('declines the clause whose paper answered nothing and keeps the other', async () => {
    class SilentPerampanel extends TwoPaperProvider {
      override async *ask(
        t: TenantConfig,
        query: string,
        opts: { resourceId?: string } = {},
      ): AsyncIterable<AskEvent> {
        if (opts.resourceId === 'per') {
          yield { type: 'done', refused: true, text: '' }
          return
        }
        yield* super.ask(t, query, opts)
      }
    }
    const { text } = await ask(
      new SilentPerampanel(),
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
    )
    expect(text).toContain('71.1% (n = 1644).')
    expect(text).toContain(
      '*This collection holds no paper answering this question for perampanel.*',
    )
  })

  it('leaves a multi-paper synthesis question on the ordinary path', async () => {
    const provider = new TwoPaperProvider()
    await ask(provider, 'What is the evidence that sleep deprivation increases seizure risk?')
    expect(provider.asked.some((a) => a.resourceId)).toBe(false)
  })
})
