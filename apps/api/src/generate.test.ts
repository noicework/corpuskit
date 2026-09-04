import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  SearchResults,
} from '@research-portal/core'
import { DEFAULT_RESEARCH_ENRICHMENT, type Enrichment } from '@research-portal/core'
import { AragProvider, type RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'

/**
 * Route-level tests for the /generate endpoint's grounding gate - the fix
 * for the credibility defect a simulated grains scientist found: on a thin or
 * broken corpus, /generate produced fluent, plausible artefacts from the
 * model's background knowledge, with real-looking citations attached to
 * sources that were actually junk (e.g. ingested Cloudflare bot-check
 * pages). The provider-level grounding gate itself is covered in
 * packages/retrieval/src/providers/arag/ask-structured.test.ts; these tests
 * prove the route wires it up honestly end to end - the insufficient-
 * grounding shape the frontend renders, and that invented per-cell
 * citations never survive to the response.
 */

// Hermetic tenant store - tests must never read the repo's live data/tenants.json.
const freshTenants = () =>
  new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })

// buildApp requires a search/catalog RetrievalProvider even though /generate
// never calls it - a minimal double that would fail loudly if it ever were.
class UnusedProvider implements RetrievalProvider {
  listResources(): Promise<ResourceSummary[]> {
    throw new Error('not used by /generate tests')
  }
  resource(): Promise<ResourceSummary | null> {
    throw new Error('not used by /generate tests')
  }
  search(): Promise<SearchResults> {
    throw new Error('not used by /generate tests')
  }
  suggest(): Promise<Question[]> {
    throw new Error('not used by /generate tests')
  }
  ask(): AsyncIterable<AskEvent> {
    throw new Error('not used by /generate tests')
  }
  catalog(): Promise<CatalogPage> {
    throw new Error('not used by /generate tests')
  }
  topicResources(): Promise<ResourceSummary[]> {
    throw new Error('not used by /generate tests')
  }
  facets(): Promise<FacetCounts> {
    throw new Error('not used by /generate tests')
  }
  labelsets(): Promise<Labelset[]> {
    throw new Error('not used by /generate tests')
  }
}

const KB_BASE_URL = 'https://test.rag.progress.cloud/api/v1/kb/test-kb'

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

/** /catalog -> empty catalogue; /ask -> the supplied canned NDJSON stream,
 * for every call (the comparison cell-fill enrichment issues extra /ask
 * calls, which reuse the same fixture - none of these tests trigger it). */
function buildManagement(askLines: unknown[]): AragProvider {
  return new AragProvider({
    resolveBinding: (slug) =>
      slug === 'marine' ? { baseUrl: KB_BASE_URL, token: 'test-token' } : undefined,
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) {
        return Promise.resolve(
          new Response(JSON.stringify({ resources: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      if (url.endsWith('/ask')) return Promise.resolve(ndjsonResponse(askLines))
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
}

function hit(id: string, title: string, score: number, text = 'A retrieved passage.') {
  return { [id]: { title, fields: { a: { paragraphs: { p1: { score, text } } } } } }
}

function makeApp(askLines: unknown[], enrichments?: EnrichmentStore) {
  return buildApp({
    provider: new UnusedProvider(),
    tenants: freshTenants(),
    management: buildManagement(askLines),
    enrichments,
  })
}

describe('POST /api/t/:slug/generate', () => {
  it('sufficient grounding: returns the artefact, no insufficientGrounding flag', async () => {
    const app = makeApp([
      {
        item: {
          type: 'retrieval',
          results: { resources: hit('res-1', 'Soil Carbon Measurement Handbook', 0.75) },
        },
      },
      {
        item: {
          type: 'answer_json',
          object: {
            title: 'Soil carbon measurement',
            executive_summary: 'A grounded overview.',
            sections: [{ heading: 'Methods', content: 'Direct and indirect measurement.' }],
            key_takeaways: ['Direct methods are more accurate but costlier.'],
          },
        },
      },
    ])
    const response = await app.request('/api/t/marine/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'briefing', query: 'soil carbon measurement' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      kind: string
      insufficientGrounding?: boolean
      object?: { title?: string }
      sources: { id: string }[]
    }
    expect(body.kind).toBe('briefing')
    expect(body.insufficientGrounding).toBe(false)
    expect(body.object?.title).toBe('Soil carbon measurement')
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]?.id).toBe('res-1')
  })

  it('BUG 1: merchandises /generate sources with the real generated title, never the raw filename/project-code title', async () => {
    const store = new EnrichmentStore(Deno.makeTempDirSync())
    const enrichment: Enrichment = {
      schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
      generatedAt: '2026-08-28T00:00:00.000Z',
      data: {
        title: 'Soil Carbon Measurement: A Practical Handbook',
        summary: 'A practical guide to direct and indirect soil-carbon measurement.',
      },
    }
    store.put('marine', 'res-1', enrichment)
    const app = makeApp([
      {
        item: {
          type: 'retrieval',
          results: { resources: hit('res-1', 'Soil Carbon Measurement Handbook', 0.75) },
        },
      },
      {
        item: {
          type: 'answer_json',
          object: {
            title: 'Soil carbon measurement',
            executive_summary: 'A grounded overview.',
            sections: [{ heading: 'Methods', content: 'Direct and indirect measurement.' }],
            key_takeaways: ['Direct methods are more accurate but costlier.'],
          },
        },
      },
    ], store)
    const response = await app.request('/api/t/marine/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'briefing', query: 'soil carbon measurement' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { sources: { id: string; title: string }[] }
    expect(body.sources[0]?.title).toBe('Soil Carbon Measurement: A Practical Handbook')
  })

  it('zero grounding: returns an honest insufficient-grounding result, not a fabricated artefact', async () => {
    const app = makeApp([
      { item: { type: 'retrieval', results: { resources: {} } } },
      // The model still answers fluently from background knowledge - this
      // must never reach the caller.
      {
        item: {
          type: 'answer_json',
          object: {
            title: 'A fabricated briefing',
            executive_summary: 'Plausible-sounding but not grounded in this corpus.',
            sections: [],
            key_takeaways: [],
          },
        },
      },
    ])
    const response = await app.request('/api/t/marine/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'briefing', query: 'a topic with no corpus coverage' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      kind: string
      insufficientGrounding?: boolean
      object?: unknown
      message?: string
      sources: unknown[]
    }
    expect(body.kind).toBe('briefing')
    expect(body.insufficientGrounding).toBe(true)
    expect(body.object).toBeUndefined()
    expect(body.sources).toEqual([])
    expect(body.message).toContain('not enough source material')
    expect(body.message).toContain('briefing')
    // Australian English, no em dashes, in user-facing copy.
    expect(body.message).not.toContain('—')
  })

  it('weak grounding (Cloudflare-bot-check case): junk retrieved but below the floor still refuses', async () => {
    const app = makeApp([
      {
        item: {
          type: 'retrieval',
          results: {
            resources: hit('res-junk', 'Untitled', 0.02, 'Checking your browser before access...'),
          },
        },
      },
      {
        item: {
          type: 'answer_json',
          object: {
            title: 'A fabricated briefing',
            executive_summary: 'Drawn from the model, not the corpus.',
            sections: [],
            key_takeaways: [],
          },
        },
      },
    ])
    const response = await app.request('/api/t/marine/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'briefing', query: 'a topic the junk page happens to mention' }),
    })
    const body = await response.json() as { insufficientGrounding?: boolean; object?: unknown }
    expect(body.insufficientGrounding).toBe(true)
    expect(body.object).toBeUndefined()
  })

  it('comparison: drops an invented per-cell citation (never an empty-string source) but keeps one that names a real retrieved source', async () => {
    const app = makeApp([
      {
        item: {
          type: 'retrieval',
          results: { resources: hit('res-1', 'Controlled Traffic Farming Field Trial', 0.7) },
        },
      },
      {
        item: {
          type: 'answer_json',
          object: {
            dimensions: ['Cost', 'Soil compaction'],
            items: [
              {
                name: 'Controlled traffic farming',
                ratings: [
                  {
                    dimension: 'Cost',
                    assessment: 'Higher upfront cost, offset over several seasons.',
                    // Not a real retrieved source - must be stripped.
                    source: 'A Report Nobody Retrieved',
                  },
                  {
                    dimension: 'Soil compaction',
                    assessment: 'Substantially reduced compaction in the trial.',
                    // Names the real retrieved source - must survive.
                    source: 'Controlled Traffic Farming Field Trial',
                  },
                ],
              },
            ],
          },
        },
      },
    ])
    const response = await app.request('/api/t/marine/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'comparison',
        query: 'controlled traffic farming versus conventional tillage',
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      insufficientGrounding?: boolean
      object: {
        items: { ratings: { dimension: string; source?: string }[] }[]
      }
      sources: { id: string; title: string }[]
    }
    expect(body.insufficientGrounding).toBe(false)
    const ratings = body.object.items[0]?.ratings ?? []
    const costRating = ratings.find((r) => r.dimension === 'Cost')
    const compactionRating = ratings.find((r) => r.dimension === 'Soil compaction')
    // An unattributable cell has its `source` field DROPPED entirely, never
    // shown as an empty-string attribution (BUG 4: prefer honest omission).
    expect(costRating?.source).toBeUndefined()
    expect('source' in (costRating ?? {})).toBe(false)
    expect(compactionRating?.source).toBe('Controlled Traffic Farming Field Trial')
    // Every present citation resolves to a source actually in the response.
    const knownTitles = new Set(body.sources.map((s) => s.title))
    for (const rating of ratings) {
      if (rating.source) expect(knownTitles.has(rating.source)).toBe(true)
    }
  })
})
