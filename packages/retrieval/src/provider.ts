import type {
  AgentAskErrorCode,
  AgentAskEvent,
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
  /** Cancel the source search, including its retries. */
  signal?: AbortSignal
  /** Retrieval for composition needs passages, without fetching display-only summaries. */
  passagesOnly?: boolean
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

/** Server-created original-source material, never accepted from an HTTP request.
 * The caller must load/verify the text from this resource in the current tenant.
 * Resource-level provenance deliberately makes no claim about PDF fields/pages.
 */
export interface SourceContext {
  resourceId: string
  text: string
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
  /** Legacy additional instructions. Never replaces the surface's built-in grounding prompt. */
  systemPrompt?: string
  /** Portal-authored additions. Built-in grounding instructions always remain. */
  answerInstructions?: string
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
   * Legacy anonymous extra context. It cannot produce a verified citation;
   * use sourceContext for original evidence and promptAddendum for instructions.
   */
  extraContext?: string[]
  /** Verified original-source passages with explicit resource-level provenance. */
  sourceContext?: SourceContext[]
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
   * already supplied as `sourceContext` and whose retrieval only has to
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

export interface AgentAskOptions {
  /** Prior turns, oldest first, for multi-turn conversations. */
  context?: { author: 'USER' | 'AGENT'; text: string }[]
  /** Aborted when the reader goes away: the provider ends its upstream session at once. */
  signal?: AbortSignal
}

/** A passage gathered for a composed answer, cited by its 1-based place in the list. */
export interface ComposePassage {
  /** The collection it came from, as the reader knows it. */
  source: string
  title: string
  text: string
}

/** An agent ask refused before it streamed: the route reports it as an `error` event. */
export class AgentAskError extends Error {
  constructor(readonly code: AgentAskErrorCode, message: string, readonly retryable = false) {
    super(message)
    this.name = 'AgentAskError'
  }
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
/** How a caller reads the catalogue listing. */
export interface ListResourcesOptions {
  /** Reports must refuse a truncated inventory, including one stopped at a reader cap. */
  requireComplete?: boolean
  /** Administrative enumeration only: include drafts and failed resources without caching them. */
  includeHidden?: boolean
  signal?: AbortSignal
  /**
   * A reader's request that must not wait on a slow box: answer within a bound with the cached
   * listing, or as much of it as has been read, possibly none, rather than the whole catalogue.
   * Without it the listing is complete or the call fails.
   */
  bounded?: boolean
}

/** Administrative inventory, including drafts and failed ingests, without credentialed URLs. */
export interface ExportResource {
  resource: ResourceSummary
  metadata: Record<string, unknown>
  labels: { labelset: string; label: string }[]
  created?: string
  modified?: string
  status?: string
  files: { fieldId: string; contentType?: string }[]
}

export interface RetrievalProvider {
  /** Complete paged inventory or failure. Optional providers must refuse export, never truncate. */
  exportResources?(tenant: TenantConfig, signal: AbortSignal): AsyncIterable<ExportResource>
  /** The configured answer model, when the provider can report it. No credentials. */
  generativeModel?(tenant: TenantConfig): Promise<string>
  /** Non-secret identifier of the store supplying this portal. */
  storeIdentifier?(tenant: TenantConfig): string | undefined

  listResources(tenant: TenantConfig, options?: ListResourcesOptions): Promise<ResourceSummary[]>
  /**
   * One resource by id. A hidden resource (a draft) is null unless `hidden` is set, which only a
   * caller managing content may ask for.
   */
  resource(
    tenant: TenantConfig,
    id: string,
    options?: { hidden?: boolean },
  ): Promise<ResourceSummary | null>
  search(tenant: TenantConfig, query: string, opts?: SearchOptions): Promise<SearchResults>
  /**
   * Suggested questions for the ask box. With a query, the ones that share a
   * term with it come first; without one, the tenant's configured list.
   */
  suggest(tenant: TenantConfig, query?: string): Promise<Question[]>
  ask(tenant: TenantConfig, query: string, opts?: AskOptions): AsyncIterable<AskEvent>
  /**
   * A retrieval agent's answer, streamed step by step (docs/AGENT-ASK.md). Optional: a provider
   * with no agent support leaves it out. It may throw `AgentAskError` before streaming, and it
   * ends its upstream session when `opts.signal` aborts or the caller stops iterating.
   */
  agentAsk?(
    tenant: TenantConfig,
    question: string,
    opts?: AgentAskOptions,
  ): AsyncIterable<AgentAskEvent>
  /**
   * One answer composed from passages the caller gathered across collections (agent ask without
   * an agent, docs/AGENT-ASK.md), on this portal's own generation path and model. It cites the
   * passages inline as `[n]`, n each one's 1-based place in `passages`, and nothing else; the
   * caller checks every citation against its passage. Optional: without it, no composing.
   */
  compose?(
    tenant: TenantConfig,
    question: string,
    passages: readonly ComposePassage[],
    opts?: Pick<AgentAskOptions, 'context' | 'signal'> & { answerInstructions?: string },
  ): Promise<string>
  /** Generation deltas as received, before the caller checks the final text and citations. */
  composeStream?(
    tenant: TenantConfig,
    question: string,
    passages: readonly ComposePassage[],
    opts?: Pick<AgentAskOptions, 'context' | 'signal'> & { answerInstructions?: string },
  ): AsyncIterable<string>
  catalog(tenant: TenantConfig, opts?: CatalogOptions): Promise<CatalogPage>
  /** Top resources filed under one topic (Explore's topic rows) - via the classification index, not per-resource topicIds. */
  topicResources(tenant: TenantConfig, topicId: string, limit?: number): Promise<ResourceSummary[]>
  facets(tenant: TenantConfig, labelsets: string[], filters?: string[]): Promise<FacetCounts>
  /** Resources carrying no label at all from a labelset (the "Untagged" count). Optional. */
  untaggedCount?(tenant: TenantConfig, labelset: string): Promise<number>
  labelsets(tenant: TenantConfig): Promise<Labelset[]>
}
