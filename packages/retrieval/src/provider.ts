import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  RetrievalMode,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'

export interface SearchOptions {
  mode?: RetrievalMode
  /** Topic ids (labels in the 'topic' labelset) to filter by. */
  topicIds?: string[]
  /** Labels in the 'kind' labelset to filter by. */
  kindIds?: string[]
  pageSize?: number
  /**
   * Scope the search to the in-app documentation ONLY (the Help section).
   * Selects the documentation-scoped stored search config and cross-checks
   * results to documentation resources. Default (false) is the research corpus,
   * which excludes documentation. See packages/retrieval/CLAUDE.md.
   */
  docScope?: boolean
}

export interface AskOptions {
  /** Prior turns, oldest first, for multi-turn conversations. */
  context?: { author: 'USER' | 'AGENT'; text: string }[]
  /** Scope the answer to a single resource (per-document chat). */
  resourceId?: string
  topicIds?: string[]
  /** Override the surface's system prompt (portal management setting). */
  systemPrompt?: string
  /** 'deep' grounds on the full text of matching resources. */
  depth?: 'default' | 'deep'
  /** Sub-questions to research before the main query (deep-research mode). */
  prequeries?: string[]
  /** Also ground on page/table images (needs visual content in the box). */
  images?: boolean
  /**
   * Scope the answer to the in-app documentation ONLY (the Help assistant).
   * Selects the documentation-scoped stored search config and applies the
   * citation-vs-filter cross-check that withholds any answer grounded outside
   * the documentation. Default (false) answers from the research corpus, which
   * excludes documentation. See packages/retrieval/CLAUDE.md.
   */
  docScope?: boolean
}

export interface CatalogOptions {
  page?: number
  pageSize?: number
  query?: string
  topicIds?: string[]
  /** Labels in the 'kind' labelset to filter by. */
  kindIds?: string[]
  sortField?: 'created' | 'modified' | 'title'
  sortOrder?: 'asc' | 'desc'
}

/**
 * The only doorway between the portal and any AI/retrieval backend.
 *
 * Implementations map a vendor API (Progress Agentic RAG) into portal domain
 * types. Nothing vendor-shaped crosses this boundary, so swapping backends is
 * configuration, not a rewrite. Server-side only - credentials never reach
 * the client.
 */
export interface RetrievalProvider {
  listResources(tenant: TenantConfig): Promise<ResourceSummary[]>
  resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null>
  search(tenant: TenantConfig, query: string, opts?: SearchOptions): Promise<SearchResults>
  suggest(tenant: TenantConfig): Promise<Question[]>
  ask(tenant: TenantConfig, query: string, opts?: AskOptions): AsyncIterable<AskEvent>
  catalog(tenant: TenantConfig, opts?: CatalogOptions): Promise<CatalogPage>
  /** Top resources filed under one topic (Explore's topic rows) - via the classification index, not per-resource topicIds. */
  topicResources(tenant: TenantConfig, topicId: string, limit?: number): Promise<ResourceSummary[]>
  facets(tenant: TenantConfig, labelsets: string[], filters?: string[]): Promise<FacetCounts>
  labelsets(tenant: TenantConfig): Promise<Labelset[]>
}
