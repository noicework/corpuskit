import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * Roadmap R4, the search half: reference-list, front-matter and DOI-fragment
 * paragraphs never become the snippet or the rank when the body matched; a
 * DOI query names one document; an exact lookup returns only documents that
 * contain every term. Exercises `search()` against a mocked `/find` and
 * `/catalog` the way catalog-filter.test.ts does.
 */

const LOOKUP_INTENT = {
  id: 'lookup',
  label: 'Exact lookup',
  description: 'An identifier or a bare term.',
  examples: ['SCN8A'],
  retrieval: { features: ['keyword' as const], topK: 30, reranker: 'noop' as const },
  answer: { surfaces: ['search' as const], strategy: 'none' as const },
}

const TENANT: TenantConfig = {
  slug: 'neuro',
  branding: {
    productName: 'Neurology Research Collective',
    organisation: 'Neurology Research Collective',
    tagline: 'Epilepsy research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
  defaultIntent: 'general',
  intents: [
    LOOKUP_INTENT,
    {
      id: 'general',
      label: 'General',
      description: 'Everything else.',
      examples: [],
      retrieval: { features: ['keyword', 'semantic'], topK: 20, reranker: 'predict' },
      answer: { surfaces: ['ask', 'search'], strategy: 'neighbours' },
    },
  ],
} as unknown as TenantConfig

const REF_LINE =
  '33. Steinhoff BJ, Christensen J, Doherty CP, Majoie M, Schulz A-L, Brock F, et al. Cognitive performance of brivaracetam patients. Epilepsia. 2018;59:186-94.'
const BODY_LINE =
  'Upon admission, the patient was started on brivaracetam (50 mg/day); complete seizure control was achieved and retention at twelve months was 78%.'

function resource(
  title: string,
  paragraphs: Record<string, { score: number; text: string; page?: number }>,
  extra: Record<string, unknown> = {},
) {
  return {
    title,
    metadata: { status: 'PROCESSED' },
    extra: { metadata: extra },
    fields: {
      'f/body': {
        paragraphs: Object.fromEntries(
          Object.entries(paragraphs).map(([k, p]) => [k, {
            score: p.score,
            text: p.text,
            ...(p.page ? { position: { page_number: p.page } } : {}),
          }]),
        ),
      },
    },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function providerWith(findResources: Record<string, unknown>): {
  provider: AragProvider
  bodies: Record<string, unknown>[]
} {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/find')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Promise.resolve(jsonResponse({ resources: findResources }))
    }
    if (url.includes('/catalog')) {
      return Promise.resolve(jsonResponse({ resources: findResources, total: 1 }))
    }
    throw new Error(`unexpected fetch to ${url}`)
  }
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl,
  })
  return { provider, bodies }
}

describe('search() snippet selection', () => {
  it('quotes the body paragraph even when a reference line scored higher', async () => {
    const { provider } = providerWith({
      paper: resource('Brivaracetam retention study', {
        ref: { score: 0.97, text: REF_LINE, page: 16 },
        body: { score: 0.62, text: BODY_LINE, page: 3 },
      }),
    })
    const result = await provider.search(TENANT, 'brivaracetam retention')
    const hit = result.resources[0]!
    expect(hit.matchedPassage).toBe(BODY_LINE)
    // The platform's page index is zero-based; the reader counts from one
    // (displayPage, roadmap R15), so index 3 is shown as page 4.
    expect(hit.matchedPage).toBe(4)
    expect(hit.referenceChunk).toBeUndefined()
    expect(hit.relevance).toBe(0.62)
  })

  it('ranks a reference-only match below a body match and flags it', async () => {
    const { provider } = providerWith({
      refOnly: resource('Review citing brivaracetam', {
        ref: { score: 0.97, text: REF_LINE },
      }),
      body: resource('Brivaracetam case', {
        body: { score: 0.45, text: BODY_LINE },
      }),
    })
    const result = await provider.search(TENANT, 'brivaracetam retention')
    expect(result.resources.map((r) => r.id)).toEqual(['body', 'refOnly'])
    expect(result.resources[1]!.referenceChunk).toBe(true)
  })

  it('never picks a first-page title block or a DOI fragment over body text', async () => {
    const { provider } = providerWith({
      paper: resource('Rituximab for relapse prevention', {
        front: {
          score: 0.9,
          text:
            'RESEARCH ARTICLE OPEN ACCESS Rituximab Use for Relapse Prevention Nabil Seery,1,2 Robb Wesselingh,1,2 Paul Beech,3,4',
        },
        doi: { score: 0.8, text: 'https://doi.org/10.1111/epi.17440' },
        body: { score: 0.5, text: BODY_LINE },
      }),
    })
    const result = await provider.search(TENANT, 'rituximab')
    expect(result.resources[0]!.matchedPassage).toBe(BODY_LINE)
  })
})

describe('search() identifier queries', () => {
  it('a DOI returns only the document that carries it', async () => {
    const { provider } = providerWith({
      wanted: resource('The wanted paper', {
        body: { score: 0.37, text: 'Findings of the wanted paper.' },
      }, { doi: '10.1111/epi.17440' }),
      neighbour: resource('A neighbour citing other DOIs', {
        refs: {
          score: 0.35,
          text: 'https://doi.org/10.1111/epi.17588 https://doi.org/10.1111/epi.17217',
        },
      }, { doi: '10.1111/epi.17588' }),
    })
    const result = await provider.search(TENANT, '10.1111/epi.17440')
    expect(result.resources.map((r) => r.id)).toEqual(['wanted'])
    expect(result.resources[0]!.relevance).toBe(1)
  })

  it('a DOI nobody has returns nothing rather than fuzzy reference-list hits', async () => {
    const { provider } = providerWith({
      neighbour: resource('A neighbour citing other DOIs', {
        refs: { score: 0.35, text: 'https://doi.org/10.1111/epi.17588' },
      }, { doi: '10.1111/epi.17588' }),
    })
    const result = await provider.search(TENANT, '10.1111/epi.17708')
    expect(result.resources).toEqual([])
  })
})

describe('search() exact lookups', () => {
  it('returns only documents containing every term, so a stray name yields nothing', async () => {
    const { provider, bodies } = providerWith({
      febrile: resource('Febrile seizure recurrence reduced by levetiracetam', {
        body: { score: 0.83, text: 'Recurrence rates fell in the treated group.' },
      }),
    })
    const result = await provider.search(TENANT, 'Okafor recurrence', { intent: 'lookup' })
    expect(result.resources).toEqual([])
    // The lookup's own keyword-only features ride the request, so the
    // configuration-shedding retry stays keyword-only instead of going fuzzy.
    expect(bodies[0]?.features).toEqual(['keyword'])
  })

  it('keeps a genuine term match under the lookup intent', async () => {
    const { provider } = providerWith({
      febrile: resource('Febrile seizure recurrence reduced by levetiracetam', {
        body: { score: 0.83, text: 'Recurrence rates fell in the treated group.' },
      }),
    })
    const result = await provider.search(TENANT, 'recurrence', { intent: 'lookup' })
    expect(result.resources.map((r) => r.id)).toEqual(['febrile'])
  })
})
