import process from 'node:process'
import { join } from 'node:path'
import {
  type CatalogItem,
  type CatalogPage,
  type Citation,
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  type EnrichmentAgent,
  enrichmentJsonSchema,
  type EnrichmentRunEvent,
  parseEnrichmentData,
  type ResourceContent,
  type ResourceSummary,
  type ScoredResource,
  type SearchResults,
  type TenantConfig,
} from '@research-portal/core'
import { AragApiError, type AragProvider, overlayEnrichment } from '@research-portal/retrieval'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

/**
 * The portal's own store of generated enrichments (the merchandising cache),
 * keyed by tenant + resource id. Generation is app-side and cached here rather
 * than written back to the knowledge box, because the platform's ingest-time
 * JSON DA generator is unavailable (the `generator` task type is not in the DA
 * task enum - verified live; see docs/ARAG-DEV.md). Enrichments are produced
 * with the query-time `/ask` `answer_json_schema` path scoped to one resource,
 * which is verified working. One JSON file per tenant, matching the other
 * volume-backed stores (insights, sessions, sources).
 */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

/** Persisted shape: schemaId -> resourceId -> Enrichment. */
type TenantEnrichments = Record<string, Record<string, Enrichment>>

export class EnrichmentStore {
  private cache = new Map<string, TenantEnrichments>()
  private readonly dataDir: string

  /** `dataDir` defaults to $DATA_DIR (or ./data); overridable for tests. */
  constructor(dataDir: string = process.env.DATA_DIR ?? './data') {
    this.dataDir = dataDir
  }

  private pathFor(slug: string): string {
    return join(this.dataDir, 'enrichments', `${safeSegment(slug)}.json`)
  }

  private load(slug: string): TenantEnrichments {
    const cached = this.cache.get(slug)
    if (cached) return cached
    const data = readJsonSafe<TenantEnrichments>(this.pathFor(slug), {})
    this.cache.set(slug, data)
    return data
  }

  /** The enrichment for one resource under one agent (default agent when omitted). */
  get(
    slug: string,
    resourceId: string,
    schemaId = DEFAULT_RESEARCH_ENRICHMENT.id,
  ): Enrichment | undefined {
    return this.load(slug)[schemaId]?.[resourceId]
  }

  /** A resource-id -> enrichment map for the default agent (used by overlays). */
  forAgent(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): Record<string, Enrichment> {
    return this.load(slug)[schemaId] ?? {}
  }

  put(slug: string, resourceId: string, enrichment: Enrichment): void {
    const data = this.load(slug)
    const bucket = data[enrichment.schemaId] ?? (data[enrichment.schemaId] = {})
    bucket[resourceId] = enrichment
    writeJsonAtomic(this.pathFor(slug), data)
  }

  /** How many resources carry an enrichment for this agent. */
  count(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): number {
    return Object.keys(this.load(slug)[schemaId] ?? {}).length
  }
}

/** Public enrichment-store contract for alternate durable runtimes. */
export type EnrichmentStoreApi = Pick<EnrichmentStore, keyof EnrichmentStore>

// ---------------------------------------------------------------------------
// Overlays: apply cached enrichments to provider results before they leave the
// API, so every user-facing surface merchandises from the same source. The
// provider already produced a baseline (cleaned fallback title + source name);
// here the generated title/summary/takeaways/quotes win when present.
// ---------------------------------------------------------------------------

function overlay(
  base: { title: string; summary?: string; sourceName?: string; enriched?: boolean },
  enrichment: Enrichment | undefined,
) {
  return overlayEnrichment({
    title: base.title,
    summary: base.summary ?? base.title,
    ...(base.sourceName ? { sourceName: base.sourceName } : {}),
    enriched: base.enriched ?? false,
  }, enrichment)
}

export function merchandiseSummary(
  store: EnrichmentStoreApi,
  slug: string,
  resource: ResourceSummary,
): ResourceSummary {
  const m = overlay(resource, store.get(slug, resource.id))
  return {
    ...resource,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    ...(m.keyTakeaways ? { keyTakeaways: m.keyTakeaways } : {}),
    ...(m.quotesOfInterest ? { quotesOfInterest: m.quotesOfInterest } : {}),
    enriched: m.enriched,
  }
}

export function merchandiseSummaries(
  store: EnrichmentStoreApi,
  slug: string,
  resources: ResourceSummary[],
): ResourceSummary[] {
  return resources.map((r) => merchandiseSummary(store, slug, r))
}

export function merchandiseScored(
  store: EnrichmentStoreApi,
  slug: string,
  resource: ScoredResource,
): ScoredResource {
  return { ...resource, ...merchandiseSummary(store, slug, resource) }
}

export function merchandiseSearchResults(
  store: EnrichmentStoreApi,
  slug: string,
  results: SearchResults,
): SearchResults {
  return { ...results, resources: results.resources.map((r) => merchandiseScored(store, slug, r)) }
}

export function merchandiseCatalogItem(
  store: EnrichmentStoreApi,
  slug: string,
  item: CatalogItem,
): CatalogItem {
  const m = overlay({
    title: item.title,
    summary: item.summary,
    sourceName: item.sourceName,
    enriched: item.enriched,
  }, store.get(slug, item.id))
  return {
    ...item,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    enriched: m.enriched,
  }
}

export function merchandiseCatalogPage(
  store: EnrichmentStoreApi,
  slug: string,
  page: CatalogPage,
): CatalogPage {
  return { ...page, items: page.items.map((i) => merchandiseCatalogItem(store, slug, i)) }
}

/**
 * The `/ask` and `/generate` answer surface's own sources list - the same
 * overlay `merchandiseSearchResults`/`merchandiseCatalogPage` apply to
 * /search, /catalog and /resources, so a source card on the answer surface
 * never shows a raw filename or project code when a real enrichment exists.
 */
export function merchandiseSources(
  store: EnrichmentStoreApi,
  slug: string,
  resources: ScoredResource[],
): ScoredResource[] {
  return resources.map((r) => merchandiseScored(store, slug, r))
}

/**
 * A resolved citation's display title, merchandised the same way its
 * resource's card is everywhere else - a citation must never show a bare
 * filename/project code when a real enrichment exists for that resource.
 * Only the title changes; the citation's passage/index/resourceId are the
 * platform's own evidence and are left untouched.
 */
export function merchandiseCitation(
  store: EnrichmentStoreApi,
  slug: string,
  citation: Citation,
): Citation {
  const m = overlay({ title: citation.title }, store.get(slug, citation.resourceId))
  return { ...citation, title: m.title }
}

export function merchandiseContent(
  store: EnrichmentStoreApi,
  slug: string,
  content: ResourceContent,
): ResourceContent {
  const m = overlay({
    title: content.title,
    summary: content.summary,
    sourceName: content.sourceName,
    enriched: content.enriched,
  }, store.get(slug, content.id))
  return {
    ...content,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    ...(m.keyTakeaways ? { keyTakeaways: m.keyTakeaways } : {}),
    ...(m.quotesOfInterest ? { quotesOfInterest: m.quotesOfInterest } : {}),
    enriched: m.enriched,
  }
}

// ---------------------------------------------------------------------------
// Generation: app-side, one resource at a time. Earlier this scoped the
// query-time answer_json_schema call to the resource with `resource_filters`,
// which depends on that resource being fully settled server-side (status
// PROCESSED) and turned out to be unreliable in combination with
// answer_json_schema - verified live on a production box: every resource
// returned "no structured answer" while a corpus reprocess left resources
// "pending", and a plain per-document /ask (no schema) worked the whole time.
// So generation now embeds the resource's OWN already-fetched text directly
// in the query and calls askStructured with NO resourceId/resource_filters -
// the embedded text is the grounding, not a second scoped retrieval, so it
// has no dependency on ingest status. The platform DA page-summary is reused
// as the summary source when present (work already paid for at ingest), and
// also preferred as the embedded grounding text when present (short, clean,
// already paid for) - the fuller extracted body text is the fallback.
// ---------------------------------------------------------------------------

/** Cap on embedded document text - a sane generation budget, not a full-document dump. */
const DOCUMENT_TEXT_BUDGET = 8000

/**
 * The resource's own text to embed as grounding: the platform DA page
 * summary when present (short, clean, already paid for at ingest), otherwise
 * the extracted body text joined and truncated to a sane budget. Empty when
 * neither is available (e.g. a scanned document with no OCR and no DA
 * summary) - callers should skip structured generation in that case rather
 * than asking the model to answer with nothing to ground on.
 */
export function documentTextFor(
  content: ResourceContent | null,
  pageSummary: string | undefined,
): string {
  if (pageSummary) return pageSummary
  if (!content) return ''
  const joined = content.texts.map((t) => t.text).join('\n\n').trim()
  return joined.slice(0, DOCUMENT_TEXT_BUDGET)
}

/** Build the generator instruction from the agent's field descriptors (programmatic). */
export function buildEnrichmentQuery(agent: EnrichmentAgent, documentText?: string): string {
  const fields = agent.fields.map((f) => `${f.label}: ${f.description}`).join(' ')
  const instruction = 'You are writing a catalogue entry for a SINGLE research document. ' +
    `Produce these fields. ${fields} ` +
    'Base everything strictly on the document text provided below; do not invent, and do not ' +
    'draw on any outside or background knowledge. Australian English.'
  if (!documentText) return instruction
  return `${instruction}\n\n--- DOCUMENT TEXT (use only this) ---\n${documentText}\n--- END DOCUMENT TEXT ---`
}

/**
 * A short, sentence-based title from a longer passage of prose: the first
 * sentence, capped to a sane title length. Falls back to the whole passage
 * (also capped) when no sentence break is found, and to '' when the passage
 * is too thin to yield anything useful.
 */
function deriveTitleFromText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0]?.trim() ?? ''
  const candidate = firstSentence.length >= 8 ? firstSentence : trimmed
  const capped = candidate.length > 120 ? `${candidate.slice(0, 117).trim()}...` : candidate
  return capped.replace(/[.]+$/, '').trim()
}

/**
 * Graceful degradation when structured generation returns nothing (a
 * platform hiccup, a resource mid-reprocess, or text too thin/garbled to
 * generate from - see the scanned-document/OCR note below). Rather than
 * failing the resource outright, build a partial enrichment from what the
 * platform already gave us: the DA page summary (or the baseline
 * merchandised summary) as the summary field, and a title derived from it
 * (or the baseline cleaned name). List/quotes fields are left empty - there
 * is no verbatim source to draw them from without a real generation pass.
 *
 * Returns null only when there is genuinely nothing to work with (the
 * resource fetch itself failed, or it resolved with no usable summary text
 * at all) - that is the one case generateEnrichment still treats as an
 * error.
 *
 * KNOWN LIMITATION: a scanned PDF with no OCR layer has no extracted body
 * text and, if the DA page-summary agent also could not read it, no
 * pageSummary either - this path then has nothing better than the raw
 * filename to title from. OCR ingestion is the real fix; out of scope here.
 */
function degradedEnrichment(
  agent: EnrichmentAgent,
  content: ResourceContent | null,
  pageSummary: string | undefined,
): Enrichment | null {
  if (!content) return null
  const summaryText = pageSummary || content.summary
  if (!summaryText) return null
  const derivedTitle = pageSummary ? deriveTitleFromText(pageSummary) : ''
  const data: Record<string, unknown> = {}
  for (const field of agent.fields) {
    if (field.kind === 'title') data[field.key] = derivedTitle || content.title
    else if (field.kind === 'summary') data[field.key] = summaryText
    else data[field.key] = []
  }
  return {
    schemaId: agent.id,
    generatedAt: new Date().toISOString(),
    data,
    ...(pageSummary ? { usedPageSummary: true } : {}),
    degraded: true,
  }
}

export async function generateEnrichment(
  management: AragProvider,
  config: TenantConfig,
  resourceId: string,
  agent: EnrichmentAgent = DEFAULT_RESEARCH_ENRICHMENT,
): Promise<Enrichment> {
  // Read the resource first: this is both the grounding text for generation
  // and the fallback source for graceful degradation.
  const content = await management.resourceContent(config, resourceId).catch((err) => {
    // Do not turn a busy platform into a degraded enrichment. A 429/timeout
    // means "try this resource later", not "this resource has no content".
    // The corpus runner recognises the typed error and applies bounded
    // back-off; swallowing it here was what made a strained run look empty.
    if (isEnrichmentStrain(err)) throw err
    return null
  })
  const pageSummary = content?.pageSummary?.trim()
  const documentText = documentTextFor(content, pageSummary)

  const schema = enrichmentJsonSchema(agent)
  let data: Record<string, unknown> | null = null
  if (documentText) {
    try {
      const result = await management.askStructured(
        config,
        schema,
        buildEnrichmentQuery(agent, documentText),
      )
      data = result.object != null ? parseEnrichmentData(agent, result.object) : null
    } catch (err) {
      if (isEnrichmentStrain(err)) throw err
      // A platform hiccup (a transient 5xx, "no structured answer") is not a
      // hard failure while we have the resource's own content to fall back
      // on - see degradedEnrichment below.
      data = null
    }
  }

  if (data) {
    // Prefer the platform's already-generated page summary for the summary
    // field when it exists and is substantial - cheaper, and a real
    // per-resource summary paid for at ingest.
    let usedPageSummary = false
    const summaryField = agent.fields.find((f) => f.kind === 'summary')
    if (summaryField && pageSummary && pageSummary.length >= 40) {
      data[summaryField.key] = pageSummary
      usedPageSummary = true
    }
    return {
      schemaId: agent.id,
      generatedAt: new Date().toISOString(),
      data,
      ...(usedPageSummary ? { usedPageSummary: true } : {}),
    }
  }

  const partial = degradedEnrichment(agent, content, pageSummary)
  if (partial) return partial

  throw new Error('No content available to generate an enrichment for this resource')
}

/** Concurrency for corpus runs - bounded so a run never hammers the ARAG account. */
const RUN_CONCURRENCY = 4

/** Calls slower than this are a useful early warning that the shared box is strained. */
const STRAIN_LATENCY_MS = 5_000
/** Extra attempts for a call which explicitly reports transient strain. */
const STRAIN_MAX_RETRIES = 2
/** Exponential back-off floor and hard ceiling. */
const STRAIN_BACKOFF_BASE_MS = 1_000
const STRAIN_BACKOFF_MAX_MS = 10_000

interface EnrichmentBackoffOptions {
  /** Extra attempts after the first call. */
  maxRetries: number
  latencyThresholdMs: number
  baseDelayMs: number
  maxDelayMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type EnrichmentRunOptions = {
  scope: 'all' | 'missing'
  limit?: number
  agent?: EnrichmentAgent
  /** Test/operations seam; HTTP callers cannot set these values. */
  backoff?: Partial<EnrichmentBackoffOptions>
}

function resolvedBackoff(
  override: Partial<EnrichmentBackoffOptions> | undefined,
): EnrichmentBackoffOptions {
  return {
    maxRetries: override?.maxRetries ?? STRAIN_MAX_RETRIES,
    latencyThresholdMs: override?.latencyThresholdMs ?? STRAIN_LATENCY_MS,
    baseDelayMs: override?.baseDelayMs ?? STRAIN_BACKOFF_BASE_MS,
    maxDelayMs: override?.maxDelayMs ?? STRAIN_BACKOFF_MAX_MS,
    now: override?.now ?? Date.now,
    sleep: override?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
}

/**
 * Strain has more than one platform shape. Ingestion back-pressure has a
 * structured body, while generation may return a plain 429, a gateway
 * timeout, or an aborted fetch. All are retryable here, but only inside the
 * small bounded budget above.
 */
function isEnrichmentStrain(err: unknown): boolean {
  if (err instanceof AragApiError) {
    return err.status === 408 || err.status === 429 || err.status === 503 || err.status === 504
  }
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError' ||
    /timed?\s*out|too many requests|rate.?limit/i.test(err.message)
}

function retryDelayMs(
  err: unknown,
  retry: number,
  options: EnrichmentBackoffOptions,
): number {
  const exponential = options.baseDelayMs * 2 ** retry
  const hinted = err instanceof AragApiError && err.backpressure
    ? Math.max(0, err.backpressure.tryAfter * 1_000 - options.now())
    : 0
  return Math.min(options.maxDelayMs, Math.max(exponential, hinted))
}

/** One shared gate prevents concurrent workers from each starting a retry immediately. */
class EnrichmentBackoffGate {
  private notBefore = 0

  constructor(private readonly options: EnrichmentBackoffOptions) {}

  defer(ms: number): void {
    this.notBefore = Math.max(this.notBefore, this.options.now() + ms)
  }

  async wait(): Promise<void> {
    const remaining = this.notBefore - this.options.now()
    if (remaining > 0) await this.options.sleep(remaining)
  }
}

async function withEnrichmentBackoff<T>(
  operation: () => Promise<T>,
  gate: EnrichmentBackoffGate,
  options: EnrichmentBackoffOptions,
): Promise<T> {
  for (let attempt = 0;; attempt++) {
    await gate.wait()
    const started = options.now()
    try {
      const value = await operation()
      const elapsed = options.now() - started
      if (elapsed >= options.latencyThresholdMs) {
        // A slow success still signals contention. Keep the useful result,
        // but pause every worker before another platform call begins.
        gate.defer(retryDelayMs(null, attempt, options))
        await gate.wait()
      }
      return value
    } catch (err) {
      if (!isEnrichmentStrain(err) || attempt >= options.maxRetries) throw err
      gate.defer(retryDelayMs(err, attempt, options))
    }
  }
}

/**
 * Run an enrichment agent over the corpus, streaming progress as each resource
 * completes. `scope: 'missing'` only enriches resources without an enrichment
 * yet; `'all'` regenerates everything. Bounded concurrency keeps the account
 * safe. Never blocks a hot path - this is an admin operation. Items complete
 * out of order (concurrent), so progress is by count, not sequence.
 */
export async function* runEnrichmentOverCorpus(
  management: AragProvider,
  store: EnrichmentStoreApi,
  config: TenantConfig,
  opts: EnrichmentRunOptions,
): AsyncGenerator<EnrichmentRunEvent> {
  const agent = opts.agent ?? DEFAULT_RESEARCH_ENRICHMENT
  const titleKey = agent.fields.find((f) => f.kind === 'title')?.key
  const backoff = resolvedBackoff(opts.backoff)
  const gate = new EnrichmentBackoffGate(backoff)
  let catalogue: ResourceSummary[]
  try {
    catalogue = await withEnrichmentBackoff(
      () => management.listResources(config),
      gate,
      backoff,
    )
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Could not list resources',
    }
    return
  }
  let targets = opts.scope === 'all'
    ? catalogue
    : catalogue.filter((r) => !store.get(config.slug, r.id, agent.id))

  if (opts.scope === 'missing' && targets.length === 0) {
    // A zero from a cached or strained catalogue is not authoritative. Drop
    // the provider cache and make the issue's cheap `scope:missing limit:1`
    // probe: finding even one outstanding resource proves this run is not
    // caught up. Only a fresh, non-empty catalogue whose every resource is in
    // the store is allowed to report `done: 0`.
    management.invalidate(config.slug)
    if (catalogue.length === 0) {
      gate.defer(retryDelayMs(null, 0, backoff))
    }
    try {
      const fresh = await withEnrichmentBackoff(
        () => management.listResources(config),
        gate,
        backoff,
      )
      targets = fresh.filter((r) => !store.get(config.slug, r.id, agent.id)).slice(0, 1)
      if (fresh.length === 0) {
        yield {
          type: 'error',
          message:
            'The knowledge box returned an empty catalogue, so enrichment could not confirm that the corpus is caught up.',
        }
        return
      }
    } catch (err) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not confirm outstanding enrichments',
      }
      return
    }
  }

  const limited = typeof opts.limit === 'number' ? targets.slice(0, opts.limit) : targets

  yield { type: 'start', total: limited.length }
  if (limited.length === 0) {
    yield { type: 'done', enriched: 0, errors: 0 }
    return
  }

  // Producer/consumer channel: a bounded pool of workers pushes an event per
  // completed resource; this generator drains the channel and yields.
  const channel: EnrichmentRunEvent[] = []
  let notify: (() => void) | null = null
  const wake = () => {
    notify?.()
    notify = null
  }
  const push = (event: EnrichmentRunEvent) => {
    channel.push(event)
    wake()
  }

  let index = 0
  let enriched = 0
  let errors = 0
  let strained = false
  const worker = async () => {
    for (;;) {
      const i = index++
      if (i >= limited.length) return
      const resource = limited[i]!
      try {
        const enrichment = await withEnrichmentBackoff(
          () => generateEnrichment(management, config, resource.id, agent),
          gate,
          backoff,
        )
        store.put(config.slug, resource.id, enrichment)
        enriched++
        const generatedTitle = titleKey && typeof enrichment.data[titleKey] === 'string'
          ? String(enrichment.data[titleKey])
          : ''
        push({
          type: 'item',
          id: resource.id,
          title: generatedTitle || resource.title,
          outcome: 'enriched',
        })
      } catch (err) {
        errors++
        strained ||= isEnrichmentStrain(err)
        push({
          type: 'item',
          id: resource.id,
          title: resource.title,
          outcome: 'error',
          detail: err instanceof Error ? err.message.slice(0, 140) : 'generation failed',
        })
      }
    }
  }

  const pool = Promise.all(
    Array.from({ length: Math.min(RUN_CONCURRENCY, limited.length) }, worker),
  )
  let finished = false
  pool.then(() => {
    finished = true
    wake()
  })

  let emitted = 0
  while (emitted < limited.length) {
    if (channel.length > emitted) {
      yield channel[emitted]!
      emitted++
      continue
    }
    if (finished) break
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
  await pool
  if (strained || (limited.length > 0 && enriched === 0)) {
    // A zero-yield run had outstanding work at `start`, so it is never
    // "caught up". Pause once before returning a distinct error event; the
    // caller or next scheduler cycle can safely retry the still-missing set.
    gate.defer(retryDelayMs(null, 0, backoff))
    await gate.wait()
    yield {
      type: 'error',
      message: strained
        ? 'The knowledge box remained busy after bounded retries. Outstanding enrichments were left for a later run.'
        : 'The run yielded no enrichments despite outstanding work. It stopped without marking the corpus caught up.',
    }
    return
  }
  yield { type: 'done', enriched, errors }
}
