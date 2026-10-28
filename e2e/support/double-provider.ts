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
import type { ExportResource, RetrievalProvider } from '@research-portal/retrieval'

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

/** The passage search matches and the answer cites in `RESOURCE_ONE`. */
export const MATCHED_PASSAGE =
  'Surveys across the southern region recorded a sustained 12% decline in abalone ' +
  'populations since 2019, with marine heatwaves identified as the leading stressor.'

/** The page (counted from one) a journey's PDF of `RESOURCE_ONE` carries the passage on. */
export const CITED_PAGE = 3

export class DoubleProvider implements RetrievalProvider {
  /** Protected so a journey that deletes a document can take it out of the collection. */
  protected resources: ResourceSummary[] = [RESOURCE_ONE, RESOURCE_TWO]

  /**
   * A provider for portals whose collection is still empty. A factory, not a constructor
   * argument: Worker fixtures subclass this class and construct it as the Worker constructs its
   * real provider.
   */
  static empty(): DoubleProvider {
    const provider = new DoubleProvider()
    provider.resources = []
    return provider
  }

  /** Planted duplicates and a dated version, only for duplicate review journeys. */
  static withDuplicates(): DoubleProvider {
    const provider = new DoubleProvider()
    provider.resources = [
      {
        ...RESOURCE_ONE,
        originUrl: 'https://research.example.test/stock',
        sourceName: 'stock-report.pdf',
        published: '2023-06-01',
      },
      {
        ...RESOURCE_ONE,
        id: 'res-copy',
        originUrl: 'https://research.example.test/stock?utm_source=catalogue',
        sourceName: 'stock-report.pdf',
      },
      { ...RESOURCE_TWO, published: '2023-01-01' },
      {
        ...RESOURCE_TWO,
        id: 'res-version',
        title: RESOURCE_TWO.title + ' version 2',
        published: '2024-01-01',
      },
    ]
    return provider
  }

  listResources(_tenant: TenantConfig): Promise<ResourceSummary[]> {
    return Promise.resolve(this.resources)
  }

  async *exportResources(
    _tenant: TenantConfig,
    signal: AbortSignal,
  ): AsyncIterable<ExportResource> {
    for (const resource of this.resources) {
      signal.throwIfAborted()
      yield {
        resource: { ...resource, originUrl: `https://research.example.test/${resource.id}` },
        metadata: { collection: 'Fisheries research' },
        labels: resource.topicIds.map((label) => ({ labelset: 'topic', label })),
        status: 'PROCESSED',
        files: resource.type === 'pdf' ? [{ fieldId: 'file', contentType: 'application/pdf' }] : [],
      }
    }
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
          matchedPage: CITED_PAGE,
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
    if (this.resources.length === 0) return Promise.resolve(counts)
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
      matchedPage: CITED_PAGE,
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
        page: CITED_PAGE,
      },
    }
    yield { type: 'stage', stage: 'generating', status: 'completed' }
    yield { type: 'quality', answerRelevance: 4.2, groundedness: 4.5, contextRelevance: 4.0 }
    yield { type: 'done', refused: false, text }
  }
}
