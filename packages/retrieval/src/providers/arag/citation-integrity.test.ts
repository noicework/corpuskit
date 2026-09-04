import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * THE INVARIANT: every `[n]` marker in `done.text` resolves to a `citation`
 * event the same stream emitted. A marker with no event is a dead link - the
 * reader clicks a citation and gets nothing - which breaks the claim-level
 * grounding guarantee the whole portal rests on.
 *
 * It was broken in production. Measured over 33 live answers on a live
 * production corpus, 38 of 522 markers (7.3%) resolved to nothing, one answer carrying 51
 * markers for 3 cited resources. Root cause: `spliceCitationMarkers` numbered
 * and spliced from the UNFILTERED platform citations map while the emit loop
 * separately skipped any citation outside `validSourceIds` - two different
 * sets, so a suppressed event still left its marker in the prose.
 *
 * The gap was structurally untestable in citations.test.ts, which exercises
 * `spliceCitationMarkers` in isolation where no scope filter exists. It has to
 * be asserted end-to-end through `ask()`, which is what this file does.
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

function hit(id: string, title: string, score = 0.9, text = 'Retrieved passage text.') {
  return { [id]: { title, fields: { a: { paragraphs: { p1: { score, text } } } } } }
}

/** A catalogue resource. listResources drops documentation, so this is the research scope. */
function catalogued(id: string, title: string) {
  return { [id]: { title, metadata: { status: 'PROCESSED' } } }
}

function provider(opts: {
  askLines: unknown[]
  catalog?: Record<string, unknown>
}): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/ask')) return Promise.resolve(ndjsonResponse(opts.askLines))
      if (url.includes('/catalog')) {
        return Promise.resolve(jsonResponse({ resources: opts.catalog ?? {} }))
      }
      if (url.includes('/predict/remi')) return Promise.resolve(jsonResponse({}))
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
}

async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

interface Bound {
  text: string
  markers: number[]
  citedIndices: number[]
  citedResourceIds: string[]
}

function bind(events: AskEvent[]): Bound {
  const done = events.find((e) => e.type === 'done') as { text?: string } | undefined
  const text = done?.text ?? ''
  const citations = events.filter((e) => e.type === 'citation').map((e) =>
    (e as { citation: { index: number; resourceId: string } }).citation
  )
  return {
    text,
    markers: [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    citedIndices: citations.map((c) => c.index),
    citedResourceIds: citations.map((c) => c.resourceId),
  }
}

/** The invariant itself, as an assertion any of these cases can apply. */
function expectEveryMarkerResolves(bound: Bound) {
  const resolvable = new Set(bound.citedIndices)
  const unresolved = bound.markers.filter((m) => !resolvable.has(m))
  expect(unresolved, `markers with no citation event in: ${bound.text}`).toEqual([])
}

describe('citation integrity - every marker in done.text has a citation event', () => {
  it('cites a graph-expanded resource that never appeared in a retrieval item', async () => {
    // graph_beta and full_resource ground answers in resources outside
    // `results.resources`. These are legitimate and in scope; the old code
    // spliced their markers but suppressed their events, which was the main
    // source of the 7.3% dead-marker rate.
    const events = await collect(
      provider({
        catalog: {
          ...catalogued('res-retrieved', 'Retrieved Report'),
          ...catalogued('res-graph', 'Graph Expanded Report'),
        },
        askLines: [
          {
            item: {
              type: 'retrieval',
              results: { resources: hit('res-retrieved', 'Retrieved Report') },
            },
          },
          { item: { type: 'answer', text: 'Stocks recovered strongly after the closure.' } },
          {
            item: {
              type: 'citations',
              citations: {
                'res-retrieved/t/text/0-20': [[0, 20]],
                'res-graph/t/text/21-43': [[21, 43]],
              },
            },
          },
        ],
      }).ask(TENANT, 'What happened after the closure?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.citedResourceIds.sort()).toEqual(['res-graph', 'res-retrieved'])
    expect(bound.markers.length).toBe(2)
  })

  it('drops both the event and the marker for a resource that failed the scope check', async () => {
    // A documentation resource leaking into a research answer is a real
    // isolation breach: it must not be cited, and must not leave a marker
    // behind either.
    const events = await collect(
      provider({
        catalog: catalogued('res-research', 'Research Report'),
        askLines: [
          {
            item: {
              type: 'retrieval',
              results: {
                resources: {
                  ...hit('res-research', 'Research Report'),
                  'res-doc': {
                    title: 'How to use the portal',
                    slug: 'doc-getting-started',
                    fields: { a: { paragraphs: { p1: { score: 0.9, text: 'Help text.' } } } },
                  },
                },
              },
            },
          },
          { item: { type: 'answer', text: 'Abalone stocks are assessed by dive survey.' } },
          {
            item: {
              type: 'citations',
              citations: {
                'res-research/t/text/0-20': [[0, 20]],
                'res-doc/t/text/21-42': [[21, 42]],
              },
            },
          },
        ],
      }).ask(TENANT, 'How are abalone assessed?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.citedResourceIds).toEqual(['res-research'])
    expect(bound.text).not.toContain('[2]')
  })

  it('numbers the surviving citations contiguously from 1', async () => {
    // Numbering used to be assigned over the unfiltered map, so filtered
    // citations left gaps ([1], [4], [7]) and the evidence table looked broken.
    const events = await collect(
      provider({
        catalog: {
          ...catalogued('res-a', 'Report A'),
          ...catalogued('res-c', 'Report C'),
        },
        askLines: [
          { item: { type: 'retrieval', results: { resources: hit('res-a', 'Report A') } } },
          { item: { type: 'answer', text: 'One finding. Two finding. Three finding.' } },
          {
            item: {
              type: 'citations',
              citations: {
                'res-a/t/text/0-12': [[0, 12]],
                // Out of scope: retrieved nowhere and absent from the catalogue.
                'res-unknown/t/text/13-26': [[13, 26]],
                'res-c/t/text/27-40': [[27, 40]],
              },
            },
          },
        ],
      }).ask(TENANT, 'What were the findings?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.citedIndices).toEqual([1, 2])
    expect(bound.citedResourceIds).toEqual(['res-a', 'res-c'])
  })

  it('holds when the platform piles several citations onto one offset', async () => {
    // Out-of-range offsets all clamp to the end of the text, producing the
    // `[3][2][1]` runs seen in production. Noisy, but every marker must still
    // resolve.
    const events = await collect(
      provider({
        catalog: {
          ...catalogued('res-a', 'Report A'),
          ...catalogued('res-b', 'Report B'),
          ...catalogued('res-c', 'Report C'),
        },
        askLines: [
          { item: { type: 'retrieval', results: { resources: hit('res-a', 'Report A') } } },
          { item: { type: 'answer', text: 'Short answer.' } },
          {
            item: {
              type: 'citations',
              citations: {
                'res-a/t/text/900-999': [[900, 999]],
                'res-b/t/text/900-999': [[900, 999]],
                'res-c/t/text/900-999': [[900, 999]],
              },
            },
          },
        ],
      }).ask(TENANT, 'Summarise.'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.citedIndices).toEqual([1, 2, 3])
  })

  it('emits no citations and no markers when every cited resource is out of scope', async () => {
    const events = await collect(
      provider({
        catalog: {},
        askLines: [
          { item: { type: 'retrieval', results: { resources: hit('res-a', 'Report A') } } },
          { item: { type: 'answer', text: 'An answer with no admissible sources.' } },
          {
            item: {
              type: 'citations',
              citations: { 'res-ghost/t/text/0-10': [[0, 10]] },
            },
          },
        ],
      }).ask(TENANT, 'Anything?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.citedIndices).toEqual([])
    expect(bound.markers).toEqual([])
  })

  it("strips the model's own markers rather than leaving them unresolved", async () => {
    // The model writes its own [n]; those are untrusted prose noise and must
    // never survive into done.text, where they would read as dead markers.
    const events = await collect(
      provider({
        catalog: catalogued('res-a', 'Report A'),
        askLines: [
          { item: { type: 'retrieval', results: { resources: hit('res-a', 'Report A') } } },
          { item: { type: 'answer', text: 'The stock recovered [4] after closure [9].' } },
          {
            item: {
              type: 'citations',
              citations: { 'res-a/t/text/0-20': [[0, 20]] },
            },
          },
        ],
      }).ask(TENANT, 'Did it recover?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.markers).toEqual([1])
  })
})

describe('marker reading order', () => {
  it('renders a multi-source claim in ascending order', async () => {
    // The platform commonly attributes one claim to several sources, all at the
    // same char offset. Splicing used to emit them backwards - `[3][2][1]` -
    // which reads as noise; ascending reads as a list.
    const events = await collect(
      provider({
        catalog: {
          ...catalogued('res-a', 'Report A'),
          ...catalogued('res-b', 'Report B'),
          ...catalogued('res-c', 'Report C'),
        },
        askLines: [
          { item: { type: 'retrieval', results: { resources: hit('res-a', 'Report A') } } },
          { item: { type: 'answer', text: 'Stocks recovered.' } },
          {
            item: {
              type: 'citations',
              citations: {
                'res-a/t/text/0-17': [[0, 17]],
                'res-b/t/text/0-17': [[0, 17]],
                'res-c/t/text/0-17': [[0, 17]],
              },
            },
          },
        ],
      }).ask(TENANT, 'Did stocks recover?'),
    )

    const bound = bind(events)
    expectEveryMarkerResolves(bound)
    expect(bound.text).toBe('Stocks recovered.[1][2][3]')
  })
})
