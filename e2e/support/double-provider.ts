// ---------------------------------------------------------------------------
// DoubleProvider - a deterministic, in-memory RetrievalProvider used ONLY by
// the browser E2E persona journeys (e2e/*.test.ts). Never imported outside
// the e2e/ directory and never shipped in product code - the real API server
// always gets `createProviderFromEnv` (see apps/api/src/server.ts). Modelled
// on the StubProvider in apps/api/src/app.test.ts, extended with the fields
// the persona journeys need to render: a matched passage (for the citation
// deep link) and a citation that binds a `[1]` marker in the answer text to
// a resource so the AI Answer panel's citation marker click-through works.
// ---------------------------------------------------------------------------
import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'

export const RESOURCE_ONE: ResourceSummary = {
  id: 'res-1',
  title: 'Abalone stock health in southern waters',
  summary: 'An overview of abalone population trends and stressors across southern fisheries.',
  type: 'pdf',
  topicIds: ['stock-assessment', 'marine-sustainability'],
  keyFacts: [
    'Populations have declined 12% since 2019.',
    'Marine heatwaves are the leading stressor identified.',
  ],
  published: '2023-06-01',
}

export const RESOURCE_TWO: ResourceSummary = {
  id: 'res-2',
  title: 'Marine heatwave impacts on rock lobster',
  summary: 'Field study of thermal stress on rock lobster fisheries in temperate waters.',
  type: 'web',
  topicIds: ['fisheries-policy'],
  keyFacts: ['Heatwave events correlate with reduced catch rates.'],
}

const MATCHED_PASSAGE =
  'Surveys across the southern region recorded a sustained 12% decline in abalone ' +
  'populations since 2019, with marine heatwaves identified as the leading stressor.'

export class DoubleProvider implements RetrievalProvider {
  private resources: ResourceSummary[] = [RESOURCE_ONE, RESOURCE_TWO]

  listResources(_tenant: TenantConfig): Promise<ResourceSummary[]> {
    return Promise.resolve(this.resources)
  }

  resource(_tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    return Promise.resolve(this.resources.find((resource) => resource.id === id) ?? null)
  }

  search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return Promise.resolve({
      query,
      resources: [
        {
          ...RESOURCE_ONE,
          relevance: 0.91,
          citedCount: 0,
          matchedPassage: MATCHED_PASSAGE,
          matchedPage: 3,
        },
        { ...RESOURCE_TWO, relevance: 0.58, citedCount: 0 },
      ],
      relatedQuestions: [{ id: 'rq-1', text: 'What else affects abalone stock health?' }],
    })
  }

  catalog(_tenant: TenantConfig): Promise<CatalogPage> {
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

  topicResources(
    _tenant: TenantConfig,
    topicId: string,
    limit = this.resources.length,
  ): Promise<ResourceSummary[]> {
    return Promise.resolve(
      this.resources.filter((resource) => resource.topicIds.includes(topicId)).slice(0, limit),
    )
  }

  facets(_tenant: TenantConfig, labelsets: string[]): Promise<FacetCounts> {
    const counts: FacetCounts = {}
    for (const ls of labelsets) {
      if (ls === 'topic') {
        counts.topic = { 'stock-assessment': 1, 'marine-sustainability': 1, 'post-harvest': 1 }
      } else if (ls === 'kind') {
        counts.kind = { pdf: 1, web: 1 }
      }
    }
    return Promise.resolve(counts)
  }

  labelsets(_tenant: TenantConfig): Promise<Labelset[]> {
    return Promise.resolve([
      { id: 'topic', title: 'Topic', multiple: true, labels: ['stock-assessment'] },
      { id: 'kind', title: 'Kind', multiple: false, labels: ['pdf', 'web'] },
    ])
  }

  suggest(_tenant: TenantConfig): Promise<Question[]> {
    return Promise.resolve([{ id: 'sq-1', text: 'What is known about abalone stock health?' }])
  }

  async *ask(_tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }
    const source = {
      ...RESOURCE_ONE,
      relevance: 0.91,
      citedCount: 1,
      matchedPassage: MATCHED_PASSAGE,
    }
    yield { type: 'sources', resources: [source] }
    yield { type: 'stage', stage: 'retrieval', status: 'completed' }
    yield { type: 'stage', stage: 'generating', status: 'started' }
    const text = `Abalone populations in southern waters have declined about 12% since 2019 [1]. ` +
      `Marine heatwaves are the leading identified stressor for ${query || 'this stock'}.`
    for (const chunk of text.split(/(?<=\s)/)) {
      yield { type: 'delta', text: chunk }
    }
    yield {
      type: 'citation',
      citation: {
        index: 1,
        resourceId: RESOURCE_ONE.id,
        title: RESOURCE_ONE.title,
        passage: MATCHED_PASSAGE,
      },
    }
    yield { type: 'stage', stage: 'generating', status: 'completed' }
    yield { type: 'quality', answerRelevance: 4.2, groundedness: 4.5, contextRelevance: 4.0 }
    yield { type: 'done', refused: false, text }
  }
}
