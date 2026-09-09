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
  /** Intent id from the tenant's `intents` (search-capable intents only). */
  intent?: string
  pageSize?: number
  /** Restrict the search to these resources (a targeted find on a named paper). */
  resourceIds?: string[]
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
  /**
   * Scope retrieval to these resources (a question about a named author's
   * papers). Ignored when `resourceId` is set.
   */
  resourceIds?: string[]
  topicIds?: string[]
  /** Override the surface's system prompt (portal management setting). */
  systemPrompt?: string
  /** 'deep' grounds on the full text of matching resources. */
  depth?: 'default' | 'deep'
  /** Sub-questions to research before the main query (deep-research mode). */
  prequeries?: string[]
  /**
   * Skip the provider's own firmer-prompt retry on a guardrail refusal: the
   * caller manages retries itself and wants one extra ask at most (D3-05).
   */
  noRefusalRetry?: boolean
  /** Also ground on page/table images (needs visual content in the box). */
  images?: boolean
  /** Intent id from the tenant's `intents`: selects the stored configuration and the portal half. */
  intent?: string
  /**
   * Resources the question names (the study-name guard): each joins the
   * grounding set through its own retrieval pass, whatever the main
   * retrieval ranks, so a question about a named trial reads that trial.
   */
  pinnedResourceIds?: string[]
  /**
   * The clauses of a multi-part question, each run against the pinned
   * resources as its own retrieval pass, so a two-part question about one
   * named paper reads the paragraphs that answer each part.
   */
  pinnedQueries?: string[]
  /**
   * Extra retrieval passes restricted to a set of resources (an author's
   * articles searched for the topic alone, without the author's name, which
   * otherwise matches their other papers' reference lists).
   */
  scopedQueries?: { query: string; resourceIds: string[] }[]
  /**
   * Paragraph budget for retrieval, overriding the stored configuration's
   * (an author-scoped review over forty papers needs more than twenty
   * paragraphs). With a budget set, whole-resource grounding gives way to
   * neighbouring paragraphs: the two do not fit in one context.
   */
  topK?: number
  /**
   * Scope the answer to the in-app documentation ONLY (the Help assistant).
   * Selects the documentation-scoped stored search config and applies the
   * citation-vs-filter cross-check that withholds any answer grounded outside
   * the documentation. Default (false) answers from the research corpus, which
   * excludes documentation. See packages/retrieval/CLAUDE.md.
   */
  docScope?: boolean
  /**
   * The tenant is a scratch sandbox box (the Extraction Lab): it carries none
   * of the portal's stored search configurations and holds one freshly
   * uploaded document at a time, so no named configuration is sent and no
   * retrieval score floor applies - the resource filter is the whole scope.
   */
  sandbox?: boolean
  /**
   * Passages the application adds to the grounding context beside what
   * retrieval finds (a document's tables and key-resources block for
   * document chat, the publication years of the matching resources for a
   * recency question). Plain text, already trimmed to size by the caller.
   */
  extraContext?: string[]
  /** Instructions appended to the system prompt for this ask only. */
  promptAddendum?: string
  /**
   * Resources the session's earlier turns cited (a follow-up): each gets
   * a lighter retrieval pass of its own than a pinned paper, so "that
   * cohort" resolves to the earlier turn's paper without its paragraphs
   * crowding out a paper the follow-up newly asks about (D4-07).
   */
  priorResourceIds?: string[]
  /**
   * The generation budget in tokens for this ask, when the answer's shape
   * needs more than the platform's default (a table over three studies).
   */
  maxTokens?: number
  /**
   * Lean retrieval: no context expansion (neighbouring paragraphs, graph
   * walks) and no cross-encoder reranking, for a turn whose material is
   * already supplied as `extraContext` and whose retrieval only has to
   * produce citations to bind (a reformatting turn, D5-05).
   */
  lean?: boolean
  /**
   * Light retrieval for a terse question (D5-08, D3-05): one neighbouring
   * paragraph each side instead of two, no graph walk, the reranker kept.
   * A five-word clinic question was reading thirty-five thousand tokens of
   * context before its first word; the pinned paper's own passes still
   * carry their full budget.
   */
  light?: boolean
}

export interface CatalogOptions {
  page?: number
  pageSize?: number
  query?: string
  topicIds?: string[]
  /** Labels in the 'kind' labelset to filter by. */
  kindIds?: string[]
  /** Labels in the 'format' labelset (article / supplement / media) to filter by. */
  formatIds?: string[]
  /** `published` orders by the source's publication date (newest first by default). */
  sortField?: 'created' | 'modified' | 'title' | 'published'
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
  /**
   * Suggested questions for the ask box. With a query, the ones that share a
   * term with it come first; without one, the tenant's configured list.
   */
  suggest(tenant: TenantConfig, query?: string): Promise<Question[]>
  ask(tenant: TenantConfig, query: string, opts?: AskOptions): AsyncIterable<AskEvent>
  catalog(tenant: TenantConfig, opts?: CatalogOptions): Promise<CatalogPage>
  /** Top resources filed under one topic (Explore's topic rows) - via the classification index, not per-resource topicIds. */
  topicResources(tenant: TenantConfig, topicId: string, limit?: number): Promise<ResourceSummary[]>
  facets(tenant: TenantConfig, labelsets: string[], filters?: string[]): Promise<FacetCounts>
  /** Resources carrying no label at all from a labelset (the "Untagged" count). Optional. */
  untaggedCount?(tenant: TenantConfig, labelset: string): Promise<number>
  labelsets(tenant: TenantConfig): Promise<Labelset[]>
}
