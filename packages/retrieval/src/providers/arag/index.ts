import type {
  AskEvent,
  CatalogItem,
  CatalogPage,
  FacetCounts,
  GraphData,
  KbAgent,
  KbCounters,
  Labelset,
  Question,
  RecentResource,
  ResourceContent,
  ResourceSummary,
  ResourceType,
  ScoredResource,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import {
  classifyStudyDesign,
  DOC_PAGES,
  docPageToMarkdown,
  docResourceOrigin,
  docResourceSlug,
  DOCUMENTATION_LABEL,
  DOCUMENTATION_LABELSET,
  type ExtractionMethod,
  type Intent,
  isDocOrigin,
  type LabelRef,
  ResourceSummarySchema,
} from '@research-portal/core'
import type { DocPage } from '@research-portal/core'
import type {
  AskOptions,
  CatalogOptions,
  RetrievalProvider,
  SearchOptions,
} from '../../provider.ts'
import {
  baselineMerchandising,
  extractPageSummary,
  findPageSummaryFieldId,
} from '../../merchandise.ts'
import { variantPreamble } from '../../prompts.ts'
import { AragApiError, type KbBinding, KbClient, ndjson } from './client.ts'
import { spliceCitationMarkers, stripInlineMarkers } from './citations.ts'
import { dedupeResourceFamilies } from './resource-groups.ts'
import { dedupeEntityCase } from './graph-relations.ts'
import { dedupeNames, isNoiseEntity, keepEntity, preferredSpelling } from './entity-filter.ts'
import { rankSuggestedQuestions } from './suggest-ranking.ts'
import {
  catalogFilterExpression,
  matchesCatalogFilters,
  paginateCatalogItems,
  sortCatalogItems,
  untaggedFilterExpression,
} from './catalog-browse.ts'
import {
  chooseSnippet,
  extractDoi,
  isCitationNoise,
  isExactTermMatch,
  matchesDoi,
  type ScoredParagraph,
} from './snippet.ts'

const CATALOG_TTL_MS = 60_000
/** Parallel page-summary field reads per list response - one small GET per bare card. */
const PAGE_SUMMARY_FETCH_CONCURRENCY = 8
/** Identical search queries return the identical list for this long. */
const SEARCH_CACHE_TTL_MS = 3 * 60_000
/** Paragraphs a search listing retrieves before resources are ranked (see searchUncached). */
const SEARCH_PARAGRAPH_BUDGET = 60
const SEARCH_CACHE_MAX = 200
/** The relations slice and the entity groups are re-read from the box this often. */
const GRAPH_CACHE_TTL_MS = 5 * 60_000
/** The platform caps /graph at 500 paths per call (422 above it, verified live). */
const GRAPH_PAGE = 500
/** Nodes on the whole-corpus map; the entity view is not capped this way. */
const GRAPH_SLICE = 120
/**
 * Every group keeps at least this many of its strongest nodes in the slice,
 * so a genetics corpus whose conditions outweigh its genes still shows the
 * genes rather than six of them.
 */
const GRAPH_GROUP_FLOOR = 12

/**
 * The top `size` nodes by the caller's order, except that each group is
 * guaranteed its first `floor` nodes when it has them. Deterministic for a
 * deterministic input order.
 */
export function sliceWithGroupFloor<T extends { id: string; group: string }>(
  ranked: readonly T[],
  size: number,
  floor: number,
): T[] {
  const perGroup = new Map<string, number>()
  const reserved = new Set<string>()
  for (const node of ranked) {
    const n = perGroup.get(node.group) ?? 0
    if (n < floor) {
      perGroup.set(node.group, n + 1)
      reserved.add(node.id)
    }
    if (reserved.size >= size) break
  }
  const out: T[] = []
  for (const node of ranked) {
    if (out.length >= size) break
    if (reserved.has(node.id)) out.push(node)
  }
  for (const node of ranked) {
    if (out.length >= size) break
    if (!reserved.has(node.id)) out.push(node)
  }
  // Back to rank order - the reservation only decides membership.
  const rank = new Map(ranked.map((n, i) => [n.id, i]))
  return out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
}

type RelationsGraphResult = {
  nodes: { id: string; group: string; weight: number }[]
  edges: { source: string; target: string; label: string }[]
}
/** Catalogue paging: 200 per call, up to 40 calls - 8,000 resources. */
const CATALOG_PAGE_SIZE = 200
const CATALOG_MAX_PAGES = 40
/** Health scan reads full text per resource - sample the newest slice. */
const HEALTH_SCAN_LIMIT = 400
const HEALTH_SCAN_CONCURRENCY = 12
/** Bounded delete concurrency for `purgeFailedResources` - never hammer the box. */
const PURGE_DELETE_CONCURRENCY = 5
/** Dry-run/confirmation sample size for `purgeFailedResources`. */
const PURGE_SAMPLE_SIZE = 20
/** Extra attempts (beyond the first) for an ingestion call that hits back-pressure. */
const BACKPRESSURE_MAX_RETRIES = 2
/** Never let one request wait longer than this for the platform's queue to clear. */
const BACKPRESSURE_MAX_WAIT_MS = 20_000
/** Floor for the wait even when try_after is already in the past. */
const BACKPRESSURE_MIN_WAIT_MS = 1_000
/** Cheap extraction-tier model for high-volume data-augmentation work. */
export const DEFAULT_DA_AGENT_MODEL = 'gemini-2.5-flash-lite'

function envValue(name: string): string | undefined {
  try {
    return Deno.env.get(name)
  } catch {
    // Library consumers without environment permission still get the safe default.
    return undefined
  }
}

/**
 * Retry a single ingestion write (createText/createLink) across the
 * platform's ingestion back-pressure (HTTP 429, `back_pressure_type`
 * present). Honours the server's `try_after` hint, capped so one request
 * never hangs indefinitely. Any other error - or back-pressure that is still
 * present after the retry budget - is rethrown as-is (a typed AragApiError
 * with `.backpressure` set, for the caller to distinguish from a hard
 * failure).
 */
async function withBackpressureRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const backpressure = err instanceof AragApiError ? err.backpressure : null
      if (!backpressure || attempt >= BACKPRESSURE_MAX_RETRIES) throw err
      const waitMs = Math.min(
        Math.max(backpressure.tryAfter * 1000 - Date.now(), BACKPRESSURE_MIN_WAIT_MS),
        BACKPRESSURE_MAX_WAIT_MS,
      )
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

/**
 * Reference-list / front-matter heuristic: bibliography chunks match query
 * strings through citation TITLES and masquerade as high-scoring evidence.
 * Dense author-year patterns, DOIs and "References" headers give them away.
 */
export function looksLikeReferenceChunk(text: string): boolean {
  const sample = text.slice(0, 1200)
  const authorYear = (sample.match(/\(\s*(19|20)\d{2}[a-z]?\s*\)|,\s*(19|20)\d{2}[.,)]/g) ?? [])
    .length
  const dois = (sample.match(/doi\.org|10\.\d{4,}\//gi) ?? []).length
  const etAl = (sample.match(/et al\.?/gi) ?? []).length
  const headerHit = /^(#+\s*)?(references|bibliography|works cited|further reading)\b/im.test(
    sample,
  )
  const frontMatter =
    /ISBN|ISSN|all rights reserved|copyright ©|creative commons|this publication (may|should) be cited/i
      .test(sample)
  const words = sample.split(/\s+/).length || 1
  const density = (authorYear + dois + etAl) / (words / 100)
  return headerHit || frontMatter || density > 2.5 || (authorYear >= 4 && etAl >= 2)
}

/**
 * A declarations block - conflicts of interest, funding, ethics approval,
 * author contributions, data availability - is not evidence: it is never
 * the passage quoted under a result nor the paragraph an evidence card
 * offers, and a hit made of nothing else is treated like a reference-list
 * hit (D3-04). Heading words are counted with the disclosure phrases that
 * follow them, so a Methods paragraph that mentions its funding once is
 * still a Methods paragraph.
 */
export function looksLikeDeclarationsChunk(text: string): boolean {
  const sample = text.slice(0, 800)
  const headings = (sample.match(
    /\b(?:declarations?|conflicts? of interest|competing interests?|disclosures?|funding|acknowledge?ments?|author(?:s'|s’)? contributions?|ethics approval|ethical approval|data availability|code availability|consent (?:to|for) (?:publication|participate)|informed consent|supplementary information)\b/gi,
  ) ?? []).length
  const disclosures = (sample.match(
    /\b(?:honoraria|honorarium|speaker(?:'s|’s)? fees?|consultancy|consulting fees?|advisory boards?|research (?:grants?|funds?|funding|support) from|(?:has|have) received|equity interest|no (?:competing|conflicts?)|nothing to disclose|declares? no|declared no|not applicable|study concept or design|analysis or interpretation of data|acquisition of data|drafting(?:\/revision)? of the manuscript|critical revision|medical writing for content|major role in|we (?:acknowledge|thank)|the authors (?:acknowledge|thank))\b/gi,
  ) ?? []).length
  // "We thank" and "we acknowledge" open an acknowledgements block on their own.
  const acknowledgement = /\b(?:we|the authors) (?:acknowledge|thank|are grateful to)\b/i.test(
    sample,
  )
  // A CRediT author-contribution block is a list of roles; a conflicts
  // statement is a list of companies.
  const credit = (sample.match(
    /\b(?:conceptuali[sz]ation|methodology|formal analysis|funding acquisition|writing (?:-|–|—) (?:review|original)|supervision|data curation|project administration|visuali[sz]ation|resources|validation)\b/gi,
  ) ?? []).length
  const companies = new Set(
    (sample.match(
      /\b(?:UCB|Eisai|Novartis|Roche|Janssen|Genzyme|Pfizer|GSK|GlaxoSmithKline|Sanofi|Biogen|Bial|Angelini|Arvelle|Esteve|GW Pharma|LivaNova|Medtronic|Zogenix|Jazz|SK Life|Lundbeck|Merck|Takeda|AbbVie|Sunovion|Xenon|Marinus|Neurelis|Ovid|Stoke|Praxis|Epiminder|Seer Medical|Supernus|Cerebral Therapeutics|Longboard|Bayer|Boehringer)\b/g,
    ) ?? []).map((c) => c.toLowerCase()),
  ).size
  return acknowledgement || credit >= 3 || companies >= 3 || headings >= 2 ||
    (headings >= 1 && disclosures >= 1) || disclosures >= 3
}

/** A paragraph that is not evidence: a bibliography or a declarations block. */
function isNonEvidenceChunk(text: string): boolean {
  return looksLikeReferenceChunk(text) || looksLikeDeclarationsChunk(text)
}

/**
 * Raw platform id/hash rather than a human title - the shape a resource's
 * internal identifier takes when title extraction failed and the id leaked
 * through as the display title (e.g. a bare 32-char hex uuid). Requires both
 * a letter and a digit so ordinary short codes and numeric strings never
 * false-positive.
 */
export function looksLikeRawHashTitle(value: string): boolean {
  const v = value.trim()
  if (!v || v.includes(' ')) return false
  return /^[a-f0-9-]{20,64}$/i.test(v) && /[a-f]/i.test(v) && /\d/.test(v)
}

/** Known bot-challenge page titles that must never surface as a resource label. */
export function looksLikeBotChallengeTitle(value: string): boolean {
  return /(just a moment\s*\.{0,3}$|attention required|please verify you are human|enable javascript and cookies to continue)/i
    .test(value.trim())
}

/**
 * System/housekeeping file names that are never a real document - a dotfile
 * (`.uploaded.log`, `.DS_Store`) or a log/temp/backup artefact that slipped
 * into the box during ingestion. These must never surface in a user-facing
 * list or as a "related" recommendation.
 */
export function looksLikeSystemFileTitle(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (v.startsWith('.')) return true
  return /\.(log|tmp|temp|bak|swp|ds_store)$/i.test(v)
}

/** Office/OpenDocument mime types the browser cannot render natively. */
export function isOfficeMime(mime: string | undefined): boolean {
  if (!mime) return false
  const m = mime.toLowerCase()
  return m.includes('officedocument') || // .docx/.pptx/.xlsx (OpenXML)
    m.includes('msword') || m.includes('ms-powerpoint') || m.includes('ms-excel') ||
    m.includes('vnd.oasis.opendocument') // .odt/.odp/.ods
}

/**
 * The viewer kind for a resource, derived from every mime hint the platform
 * gives (its `icon` plus the content-type of any attached file field), not
 * `icon` alone - a scanned/older PDF whose `icon` never populated still
 * renders as a PDF when its file field reports `application/pdf`. Pure and
 * order-sensitive (PDF/media/image win over the generic `file`/`office`
 * fallbacks); shared by `resourceContent` and its tests.
 */
export function detectContentKind(
  input: { icon: string; isLink: boolean; fileMimes: string[] },
): 'web' | 'pdf' | 'video' | 'audio' | 'image' | 'office' | 'text' | 'file' {
  if (input.isLink) return 'web'
  const mimes = [input.icon, ...input.fileMimes]
    .map((m) => (m ?? '').toLowerCase())
    .filter((m) => m.length > 0)
  const has = (pred: (m: string) => boolean) => mimes.some(pred)
  if (has((m) => m === 'application/pdf' || m.endsWith('/pdf'))) return 'pdf'
  if (has((m) => m.startsWith('video/'))) return 'video'
  if (has((m) => m.startsWith('audio/'))) return 'audio'
  if (has((m) => m.startsWith('image/'))) return 'image'
  if (has((m) => isOfficeMime(m))) return 'office'
  return input.fileMimes.length > 0 ? 'file' : 'text'
}

/**
 * A renderable stand-in for an original the browser can't display (an Office
 * document), when the platform generated one: a PDF or image rendition among
 * the resource's file fields, distinct from the primary Office file itself.
 * Returns nothing when no such rendition exists - the caller then falls back
 * to the honest thumbnail + download panel rather than pretending.
 */
export function selectPreviewFile(
  files: { fieldId: string; contentType?: string }[],
  primaryFieldId: string | undefined,
): { fieldId: string; contentType?: string } | undefined {
  return files.find((f) =>
    f.fieldId !== primaryFieldId &&
    (f.contentType === 'application/pdf' || (f.contentType ?? '').startsWith('image/'))
  )
}

/**
 * A resource's best available human title, never a raw platform id/hash and
 * never a bot-challenge string. Falls back to a clean, generic label rather
 * than the id itself - a bare funder-style project code is fine to show as-is,
 * it just isn't a hash.
 */
export function displayTitle(rawTitle: string | undefined, _id: string): string {
  const trimmed = (rawTitle ?? '').trim()
  if (trimmed && !looksLikeRawHashTitle(trimmed) && !looksLikeBotChallengeTitle(trimmed)) {
    return trimmed
  }
  return 'Untitled resource'
}

/** The shape `isDisplayableResource` needs from a raw platform resource. */
export interface DisplayabilityInput {
  title?: string
  metadata?: { status?: string }
}

/**
 * Whether a resource belongs in a user-facing list (catalog, library,
 * search, typeahead). Failed ingests (status ERROR) and junk titles - a raw
 * platform hash where title extraction failed, or a bot-challenge page that
 * slipped through ingestion - are hidden from every user-facing surface.
 * Admin/corpus-health surfaces read the platform's raw catalogue directly
 * and never call this, so curators still see everything that needs fixing.
 */
export function isDisplayableResource(raw: DisplayabilityInput): boolean {
  if ((raw.metadata?.status ?? '').toUpperCase() === 'ERROR') return false
  const title = (raw.title ?? '').trim()
  if (looksLikeRawHashTitle(title)) return false
  if (looksLikeBotChallengeTitle(title)) return false
  if (looksLikeSystemFileTitle(title)) return false
  return true
}

/**
 * Eligibility for `purgeFailedResources`'s PERMANENT delete - deliberately
 * much narrower than `isDisplayableResource` (which merely hides a resource
 * from user-facing lists; nothing there is destructive). A resource is
 * eligible only if:
 *  - its title is a known bot-challenge string (a crawl that "succeeded" but
 *    only captured a Cloudflare/bot-wall page as its content), OR
 *  - its ingest failed outright (status ERROR) AND it never got any title at
 *    all.
 * A raw hash title (title extraction failed but the underlying document may
 * be real) is NEVER eligible on its own, even under an ERROR status, and
 * NEITHER is any other genuine human title, even under an ERROR status - an
 * error with a real title may be a real document that just needs
 * re-ingesting, not deleting. If in doubt, this returns false; deletion is
 * irreversible.
 */
export function isPurgeEligible(raw: DisplayabilityInput): boolean {
  const title = (raw.title ?? '').trim()
  if (looksLikeBotChallengeTitle(title)) return true
  const isError = (raw.metadata?.status ?? '').toUpperCase() === 'ERROR'
  return isError && title === ''
}

/**
 * Relevance floor for structured generation's grounding gate: a calibrated
 * retrieval score below this is noise, not evidence - the same floor
 * `search`'s MIN_SCORE already applies to /find results. Kept as its own
 * constant because generate's grounding decision is a policy choice
 * independent of search's, even though today the two agree.
 */
export const MIN_GENERATE_GROUNDING = 0.1

/**
 * Refusal-override floor for `ask`: a known platform quirk (see
 * docs/ARAG-DEV.md) has Nuclia's default guardrail sentence ("Not enough
 * data to answer this.") fire even when the system prompt explicitly forbids
 * it and genuinely relevant material was retrieved - this is the inconsistent
 * refusal a rephrased question sails past. When a retrieved source clears
 * this bar, one retry with a firmer directive runs before an honest refusal
 * is accepted (see `ask`). Set well above the search/grounding noise floor
 * (`MIN_GENERATE_GROUNDING`, 0.1) so a genuinely out-of-corpus question -
 * which retrieves nothing this relevant - is never talked out of refusing.
 */
export const MIN_REFUSAL_OVERRIDE_RELEVANCE = 0.3

/** Nuclia's default guardrail sentence - see MIN_REFUSAL_OVERRIDE_RELEVANCE above. */
export const REFUSAL_TEXT = 'not enough data to answer this.'

/**
 * Whether `text` IS (or reduces to) the platform's bare guardrail refusal
 * sentence, tolerant of the incidental noise a real streamed response can
 * carry around it - surrounding whitespace/newlines (including non-breaking
 * space, which the platform has been seen to emit), wrapping quote marks, or
 * a missing trailing period. This is the single source of truth for "was
 * this call refused" - `ask`'s retry gates and its final refused/done.text
 * decision all read through it, so they can never disagree with each other
 * (see BUG 2: a prior ad hoc, streaming-only prefix check could diverge from
 * what the client was ultimately shown, letting a bare guardrail sentence
 * through as if it were a real, cited answer).
 */
export function isGuardrailRefusal(text: string): boolean {
  const normalised = text
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim()
  if (!normalised) return false
  return normalised === REFUSAL_TEXT || normalised === REFUSAL_TEXT.replace(/\.$/, '')
}

/**
 * Calibrates a raw retrieval score to [0, 1], comparable across queries:
 * semantic scores are already 0-1; BM25 scores (>1) are squashed
 * logistically. Never normalised to the top hit - a weak match must LOOK
 * weak. `search` and `ask` each apply an equivalent formula inline; factored
 * out here so structured generation's grounding gate agrees with them by
 * construction rather than by three implementations happening to match.
 */
export function calibrateRelevance(score: number): number {
  return score <= 1 ? Math.max(0, Math.min(1, score)) : score / (score + 2)
}

/**
 * Best-scoring paragraph match for one retrieval hit, and whether it looks
 * like reference-list/front-matter noise (downweighted, same heuristic
 * `search` and `ask` use via `looksLikeReferenceChunk`). Shared scoring pass
 * so structured generation's grounding gate judges a source's relevance the
 * same way `ask` scores its grounding sources.
 */
/**
 * The platform reports a paragraph's page as a zero-based index
 * (`position.page_number`); readers, "Open PDF at page N" and the PDF
 * viewer count from one. Converting here, at the one boundary the index
 * crosses, keeps every consumer one-based. A first-page match (index 0)
 * used to be dropped as falsy and now surfaces as page 1.
 */
export function displayPage(page: number | undefined): number | undefined {
  return typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page + 1 : undefined
}

function bestParagraphMatch(raw: {
  fields?: Record<
    string,
    {
      paragraphs?: Record<
        string,
        { score?: number; text?: string; position?: { page_number?: number } }
      >
    }
  >
}): { best: number; passage?: string; page?: number; reference: boolean } {
  let best = 0
  let passage: string | undefined
  let page: number | undefined
  // The best paragraph that is evidence: a bibliography or a declarations
  // block never becomes the quote under a result while a body paragraph
  // matched too (D3-04).
  let bodyBest = -1
  let bodyPassage: string | undefined
  let bodyPage: number | undefined
  for (const field of Object.values(raw.fields ?? {})) {
    for (const paragraph of Object.values(field.paragraphs ?? {})) {
      const score = paragraph.score ?? 0
      if (score >= best) {
        best = score
        passage = paragraph.text ?? passage
        page = paragraph.position?.page_number
      }
      if (paragraph.text && score >= bodyBest && !isNonEvidenceChunk(paragraph.text)) {
        bodyBest = score
        bodyPassage = paragraph.text
        bodyPage = paragraph.position?.page_number
      }
    }
  }
  if (passage !== undefined && bodyPassage !== undefined && isNonEvidenceChunk(passage)) {
    return { best: bodyBest, passage: bodyPassage, page: bodyPage, reference: false }
  }
  const reference = passage ? isNonEvidenceChunk(passage) : false
  return { best: reference ? best * 0.4 : best, passage, page, reference }
}

/** The extra.metadata payload the provisioning script stores on every resource. */
interface PortalMetadata {
  summary?: string
  keyFacts?: string[]
  topic?: string
  type?: string
  published?: string
  authors?: unknown
  journal?: unknown
  year?: unknown
  doi?: unknown
  pmid?: unknown
  pmcid?: unknown
  keywords?: unknown
  titleCurated?: unknown
}

interface RawResource {
  id?: string
  title?: string
  summary?: string
  created?: string
  usermetadata?: { classifications?: { labelset?: string; label?: string }[] }
  /**
   * Platform-computed metadata (DA classifier output etc). NucliaDB's own
   * shape carries computed labels per-field here rather than in
   * `usermetadata` (which is reserved for user-applied ones), and/or a
   * top-level `classifications` fallback on some deployments - see
   * `classificationLabels` below and the final report's probe notes for what
   * was and wasn't confirmed live on this box.
   */
  computedmetadata?: {
    field_classifications?: {
      classifications?: { labelset?: string; label?: string; cancelled_by_user?: boolean }[]
    }[]
    classifications?: { labelset?: string; label?: string; cancelled_by_user?: boolean }[]
  }
  extra?: { metadata?: PortalMetadata }
  metadata?: { status?: string }
  /** Resource slug and origin - the documentation cross-check reads both. */
  slug?: string
  origin?: { url?: string }
}

/**
 * A raw resource's labels for one labelset - user-applied
 * (`usermetadata.classifications`) union platform-computed
 * (`computedmetadata`), deduplicated. Shared by `catalogItemFromRaw` and
 * `toSummary` so every user-facing surface picks up computed (DA classifier)
 * labels the moment the platform includes them in a payload, with no further
 * code change. A computed label the user has since removed
 * (`cancelled_by_user: true`) is excluded.
 */
function classificationLabels(raw: RawResource, labelset: string): string[] {
  const labels = new Set<string>()
  for (const c of raw.usermetadata?.classifications ?? []) {
    if (c.labelset === labelset && c.label) labels.add(c.label)
  }
  for (const field of raw.computedmetadata?.field_classifications ?? []) {
    for (const c of field.classifications ?? []) {
      if (c.labelset === labelset && c.label && !c.cancelled_by_user) labels.add(c.label)
    }
  }
  for (const c of raw.computedmetadata?.classifications ?? []) {
    if (c.labelset === labelset && c.label && !c.cancelled_by_user) labels.add(c.label)
  }
  return [...labels]
}

// ---------------------------------------------------------------------------
// Documentation isolation - the CENTRAL search-config isolation contract (see
// packages/retrieval/CLAUDE.md). The named stored configs carry the label
// filter; these pure helpers build the exact filter shapes and identify a
// documentation resource for the server-side cross-check that guarantees
// isolation even if the platform's stored `filter_expression` misbehaves.
// ---------------------------------------------------------------------------

/** Stored search-configuration names, one per surface. */
export const SEARCH_CONFIG_RESEARCH_FIND = 'portal-search'
export const SEARCH_CONFIG_RESEARCH_ASK = 'portal-ask'
export const SEARCH_CONFIG_DOC_FIND = 'portal-doc-search'
export const SEARCH_CONFIG_DOC_ASK = 'portal-doc-ask'

/**
 * A single-label field filter in the platform's `filter_expression` grammar.
 * On `/find` and `/ask` the expression is keyed under `field` (it is `resource`
 * on `/catalog` - see docs/ARAG-DEV.md). A label field predicate is
 * `{ prop: 'label', labelset, label }`, combinable with `and`/`or`/`not`.
 *
 * NOTE FOR DEPLOY: this exact `filter_expression` shape could not be verified
 * against the live platform from this worktree. The stored config is the
 * primary isolation mechanism, but the server-side cross-check below
 * (`isDocumentationResource` + the filtering in `search`/`ask`) is authoritative
 * and holds even if this shape is wrong - so isolation does not depend on it.
 */
export function labelFieldExpression(): {
  prop: 'label'
  labelset: string
  label: string
} {
  return { prop: 'label', labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL }
}

/**
 * filter_expression EXCLUDING documentation - for portal-search / portal-ask -
 * plus any labels the tenant keeps out of research retrieval (supplements,
 * media). With no extra exclusions the shape is unchanged.
 */
export function researchExcludeFilterExpression(
  exclude: { labelset: string; label: string }[] = [],
): Record<string, unknown> {
  if (exclude.length === 0) return { field: { not: labelFieldExpression() } }
  return {
    field: {
      and: [
        { not: labelFieldExpression() },
        ...exclude.map((e) => ({ not: { prop: 'label', labelset: e.labelset, label: e.label } })),
      ],
    },
  }
}

/** filter_expression including ONLY documentation - for portal-doc-search / portal-doc-ask. */
export function docOnlyFilterExpression(): Record<string, unknown> {
  return { field: labelFieldExpression() }
}

/**
 * The stored filter for one intent: documentation is always excluded; then
 * either the intent's own exclusions, or, when `only` is set, grounding is
 * restricted to those labels instead.
 */
export function intentFilterExpression(
  retrieval: { exclude?: LabelRef[]; only?: LabelRef[] },
): Record<string, unknown> {
  const only = retrieval.only ?? []
  if (only.length > 0) {
    const include = only.length === 1
      ? { prop: 'label', labelset: only[0]!.labelset, label: only[0]!.label }
      : { or: only.map((e) => ({ prop: 'label', labelset: e.labelset, label: e.label })) }
    return { field: { and: [{ not: labelFieldExpression() }, include] } }
  }
  return researchExcludeFilterExpression(retrieval.exclude ?? [])
}

/** The platform caps a prequeries strategy at ten queries. */
export const MAX_PREQUERIES = 10

/** Paragraph budget of a pinned resource's own retrieval pass. */
export const PINNED_TOP_K = 20
/** Paragraph budget of a clause pass against a pinned resource. */
export const PINNED_CLAUSE_TOP_K = 10
/** Paragraph budget of a scoped topic pass (an author's articles). */
export const SCOPED_TOP_K = 30
/** Paragraph budget of an earlier turn's cited paper on a follow-up. */
export const PRIOR_TOP_K = 10

/**
 * The extra retrieval passes that join an ask's grounding set, in priority
 * order: a pass per pinned resource (a paper the question names, or the
 * top paper per named entity) with a wider paragraph budget and a heavier
 * weight than the main query, a pass per question clause against the
 * first pinned resources (so a two-part question reads the paragraphs that
 * answer each part), one pass restricted to the labels the intent prefers
 * (a data question's supplements beside its papers), then the caller's
 * sub-questions. Verified live: a prequery request is a full find request,
 * so `resource_filters`, `top_k` and label `filters` scope it.
 */
export function groundingPrequeries(
  query: string,
  opts: {
    pinnedResourceIds?: readonly string[]
    pinnedQueries?: readonly string[]
    scopedQueries?: readonly { query: string; resourceIds: readonly string[] }[]
    prefer?: readonly LabelRef[]
    prequeries?: readonly string[]
    /** Earlier turns' cited papers: a lighter pass each, after the pinned papers. */
    priorResourceIds?: readonly string[]
    /** A filter every caller prequery carries (the documentation-only filter under docScope). */
    filterExpression?: Record<string, unknown>
  },
): Record<string, unknown>[] {
  const features = ['keyword', 'semantic']
  const out: Record<string, unknown>[] = []
  for (const scoped of (opts.scopedQueries ?? []).slice(0, 2)) {
    if (!scoped.query.trim() || scoped.resourceIds.length === 0) continue
    out.push({
      request: {
        query: scoped.query,
        features,
        resource_filters: scoped.resourceIds.slice(0, 80),
        top_k: SCOPED_TOP_K,
      },
      weight: 2,
    })
  }
  const pinned = (opts.pinnedResourceIds ?? []).slice(0, 4)
  for (const id of pinned) {
    out.push({
      request: { query, features, resource_filters: [id], top_k: PINNED_TOP_K },
      weight: 2,
    })
  }
  for (const id of pinned.slice(0, 2)) {
    for (const clause of (opts.pinnedQueries ?? []).slice(0, 2)) {
      if (out.length >= MAX_PREQUERIES - 1) break
      out.push({
        request: { query: clause, features, resource_filters: [id], top_k: PINNED_CLAUSE_TOP_K },
        weight: 1,
      })
    }
  }
  for (const id of (opts.priorResourceIds ?? []).filter((id) => !pinned.includes(id)).slice(0, 4)) {
    if (out.length >= MAX_PREQUERIES - 1) break
    out.push({
      request: { query, features, resource_filters: [id], top_k: PRIOR_TOP_K },
      weight: 1,
    })
  }
  const prefer = opts.prefer ?? []
  if (prefer.length > 0) {
    out.push({
      request: {
        query,
        features,
        filters: prefer.map((l) => `/classification.labels/${l.labelset}/${l.label}`),
      },
      weight: 1,
    })
  }
  for (const q of opts.prequeries ?? []) {
    if (out.length >= MAX_PREQUERIES) break
    out.push({
      request: {
        query: q,
        features,
        ...(opts.filterExpression ? { filter_expression: opts.filterExpression } : {}),
      },
      weight: 1,
    })
  }
  return out.slice(0, MAX_PREQUERIES)
}

/**
 * The tail of a streamed chunk that may be the start of a `[n]` marker the
 * next chunk completes ("[", "[1", "[1, 2"). Held back so a marker split
 * across chunks is never shown half-stripped; the held text is prepended
 * to the next chunk.
 */
export function splitPartialMarker(text: string): { emit: string; hold: string } {
  const m = /\s*\[\d{0,3}(?:\s*,\s*\d{0,3})*$/.exec(text)
  if (!m) return { emit: text, hold: '' }
  return { emit: text.slice(0, m.index), hold: text.slice(m.index) }
}

/** The portal half of an intent's retrieval: grounding strategies. */
export function intentStrategies(intent: Intent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (intent.answer.strategy === 'full') out.push({ name: 'full_resource' })
  else if (intent.answer.strategy === 'neighbours') {
    const n = intent.answer.neighbours ?? 2
    out.push({ name: 'neighbouring_paragraphs', before: n, after: n })
  }
  if (intent.answer.graph) out.push({ name: 'graph_beta', hops: 2, agentic_graph_only: true })
  return out
}

/** Apply an intent's citation floor and recency ordering to retrieved sources. */
export function shapeSourcesForIntent(
  sources: ScoredResource[],
  intent: Intent | undefined,
): ScoredResource[] {
  if (!intent) return sources
  // Every source the platform grounded on stays visible: a citation the
  // reader cannot open is worse than a weak source they can judge. The
  // intent's minScore is a display hint (the evidence card marks weak
  // matches), never a filter after grounding.
  if (intent.answer.sortByPublished) {
    return [...sources].sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
  }
  return sources
}

/** A field written by a data-augmentation agent (a generated summary), not the document itself. */
export function isGeneratedField(fieldKey: string): boolean {
  return /da-|summary|\/a\/|^a\//i.test(fieldKey)
}

/** The platform's stored extraction strategy shape (as read back from /extract_strategies). */
interface RawStrategy {
  name?: string
  vllm_config?: { rules?: string[]; llm?: { generative_model?: string } } | null
  ai_tables?: { llm?: { generative_model?: string } } | null
}

/** Platform body for an extraction method; the vendor shape stays here. */
export function strategyBody(spec: Omit<ExtractionMethod, 'id'>): Record<string, unknown> {
  const llm = spec.model ? { generative_model: spec.model } : {}
  if (spec.kind === 'tables') return { name: spec.name, ai_tables: { llm } }
  if (spec.kind === 'visual') {
    return {
      name: spec.name,
      vllm_config: {
        rules: spec.rules && spec.rules.length > 0 ? spec.rules : [DEFAULT_VISUAL_RULE],
        llm,
      },
    }
  }
  return { name: spec.name }
}

export const DEFAULT_VISUAL_RULE =
  'Transcribe every element on the page faithfully: headings, paragraphs, tables as markdown ' +
  'tables, figure captions, axis labels and footnotes. Keep reading order. Do not summarise or omit.'

export function methodFromStrategy(id: string, s: RawStrategy): ExtractionMethod {
  if (s.ai_tables) {
    return {
      id,
      name: s.name ?? id,
      kind: 'tables',
      ...(s.ai_tables.llm?.generative_model ? { model: s.ai_tables.llm.generative_model } : {}),
    }
  }
  if (s.vllm_config) {
    return {
      id,
      name: s.name ?? id,
      kind: 'visual',
      ...(s.vllm_config.llm?.generative_model ? { model: s.vllm_config.llm.generative_model } : {}),
      ...(s.vllm_config.rules?.length ? { rules: s.vllm_config.rules } : {}),
    }
  }
  return { id, name: s.name ?? id, kind: 'default' }
}

/** Stored configuration name for an intent; the default intent keeps the default pair. */
export function intentConfigurationName(
  tenant: TenantConfig,
  intentId: string,
  kind: 'find' | 'ask',
): string {
  const isDefault = intentId === (tenant.defaultIntent ?? '')
  if (isDefault) return kind === 'ask' ? SEARCH_CONFIG_RESEARCH_ASK : SEARCH_CONFIG_RESEARCH_FIND
  const intent = tenant.intents?.find((i) => i.id === intentId)
  const askCapable = intent?.answer.surfaces.includes('ask') ?? true
  // An intent that answers gets the plain name for its ask config and a
  // `-find` twin for search; a search-only intent's plain name IS a find config.
  if (kind === 'ask' || !askCapable) return `portal-intent-${intentId}`
  return `portal-intent-${intentId}-find`
}

/** The stored configuration objects an intent needs on the box. */
export function intentSearchConfigs(tenant: TenantConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const intent of tenant.intents ?? []) {
    if (intent.id === tenant.defaultIntent) continue
    const filter = intentFilterExpression(intent.retrieval)
    const base = {
      features: intent.retrieval.features,
      reranker: intent.retrieval.reranker,
      filter_expression: filter,
    }
    if (intent.answer.surfaces.includes('ask')) {
      out[intentConfigurationName(tenant, intent.id, 'ask')] = {
        kind: 'ask',
        config: { ...base, top_k: intent.retrieval.topK, citations: true },
      }
    }
    if (intent.answer.surfaces.includes('search')) {
      out[intentConfigurationName(tenant, intent.id, 'find')] = {
        kind: 'find',
        config: { ...base, top_k: intent.retrieval.topK },
      }
    }
  }
  return out
}

/**
 * Whether a retrieved raw resource is a portal documentation page. Checks the
 * reserved classification label first (the primary signal), then the
 * app-stamped origin URL and slug (deterministic fallbacks set by
 * `ingestDocumentation`, present on a retrieval payload's `origin`/`slug` even
 * when classification labels are not returned). Used by both the doc-scoped
 * paths (keep only docs) and the research paths (drop any doc that leaked
 * through the platform's weak `/ask` filtering - see docs/ARAG-DEV.md).
 */
export function isDocumentationResource(
  raw: { slug?: string; origin?: { url?: string } } & RawResource,
): boolean {
  if (classificationLabels(raw, DOCUMENTATION_LABELSET).includes(DOCUMENTATION_LABEL)) return true
  if (isDocOrigin(raw.origin?.url)) return true
  return typeof raw.slug === 'string' && raw.slug.startsWith('doc-')
}

/** Shape of a /find response's resources map - shared by `search` and `catalogByQuery`. */
type FindResponse = {
  resources?: Record<
    string,
    RawResource & {
      fields?: Record<string, { paragraphs?: Record<string, { score?: number; text?: string }> }>
    }
  >
}

/**
 * The study design a research article shows as its `kind`: the rule-first
 * classifier over the stored record (title, abstract, keywords and MeSH
 * headings), with the box's own `kind` label admitted only where the text
 * corroborates it. Every surface - cards, the resource header, the facet and
 * its filter - derives the kind here, so they cannot disagree.
 */
function studyDesignOf(
  raw: RawResource,
  record: { title: string; keywords?: string[]; format?: string; type?: string },
): string | undefined {
  const meta = raw.extra?.metadata ?? {}
  // Only a bibliographic record (a journal article filed by format, or one
  // carrying a DOI, PubMed id or journal) states a study design. A corpus of
  // reports and submissions keeps the kind its labelset gives it.
  const bibliographic = Boolean(record.format) ||
    Boolean(meta.doi || meta.pmcid || meta.pmid || meta.journal)
  if (!bibliographic) return classificationLabels(raw, 'kind')[0]
  return classifyStudyDesign({
    title: record.title,
    abstract: meta.summary || raw.summary,
    keywords: record.keywords,
    format: record.format,
    type: record.type,
    label: classificationLabels(raw, 'kind')[0],
  })?.id
}

/** Builds a CatalogItem from a raw platform resource - shared by catalogue's paged browse and its filtered-query path, so both render the same shape. */
/**
 * The bibliographic record an ingest may store on `extra.metadata` (journal
 * articles carry authors, journal, year, DOI, keywords and a curated title).
 * Absent fields are simply omitted so older resources are unchanged.
 */
function bibliographic(meta: PortalMetadata): {
  authors?: string[]
  journal?: string
  year?: string
  doi?: string
  pmid?: string
  pmcid?: string
  keywords?: string[]
  titleCurated?: boolean
} {
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : undefined
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const authors = strings(meta.authors)
  const keywords = strings(meta.keywords)
  const journal = str(meta.journal)
  const year = str(meta.year)
  const doi = str(meta.doi)
  const pmid = str(meta.pmid)
  const pmcid = str(meta.pmcid)?.toUpperCase()
  return {
    ...(authors?.length ? { authors } : {}),
    ...(journal ? { journal } : {}),
    ...(year ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    ...(keywords?.length ? { keywords } : {}),
    ...(meta.titleCurated === true ? { titleCurated: true } : {}),
  }
}

/**
 * The names worth showing from one entity group: noise dropped (numbers,
 * people, journals, vignettes; non-genes in the Gene group), case variants
 * merged onto the spelling that reads best, and the result sorted so the
 * list is the same on every read.
 */
function cleanEntityNames(names: readonly string[], group: string): string[] {
  const variants = new Map<string, string[]>()
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim()
    if (!keepEntity(name, group)) continue
    const key = name.toLowerCase()
    const list = variants.get(key)
    if (list) list.push(name)
    else variants.set(key, [name])
  }
  return [...variants.values()]
    .map((list) => preferredSpelling(list))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** The portal's content type for a resource, from the metadata the ingest stored. */
function resourceTypeFromMeta(meta: PortalMetadata): ResourceType {
  const t = meta.type
  return t === 'video' || t === 'web' || t === 'pdf' ? t : 'document'
}

function catalogItemFromRaw(id: string, r: RawResource): CatalogItem {
  const status = r.metadata?.status
  const safe = displayTitle(r.title, id)
  const rawTitle = safe === 'Untitled resource' ? '' : (r.title ?? '')
  const merch = baselineMerchandising(rawTitle, r.summary ?? r.extra?.metadata?.summary)
  const { keywords, ...bib } = bibliographic(r.extra?.metadata ?? {})
  const format = classificationLabels(r, 'format')[0]
  const type = resourceTypeFromMeta(r.extra?.metadata ?? {})
  const kind = studyDesignOf(r, { title: rawTitle, keywords, format, type })
  return {
    id,
    title: merch.title,
    status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
    created: r.created,
    topicIds: classificationLabels(r, 'topic'),
    ...(kind ? { kind } : {}),
    ...(format ? { format } : {}),
    type,
    published: r.extra?.metadata?.published,
    ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
    ...bib,
    enriched: false,
  }
}

/**
 * Words too generic to signal a real topic match between a query and a
 * suggested question - question scaffolding ("what", "does", "about"), not
 * subject matter.
 */
const RELATED_QUESTION_STOPWORDS = new Set([
  'what',
  'does',
  'about',
  'which',
  'that',
  'this',
  'from',
  'with',
  'into',
  'than',
  'then',
  'over',
  'under',
  'more',
  'some',
  'will',
  'have',
  'been',
  'were',
  'being',
  'says',
  'say',
  'covers',
  'cover',
  'how',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'also',
])

/**
 * Query-aware "people also ask": `tenant.suggestedQuestions` filtered to the
 * ones that actually share meaningful words with the current query, so the
 * widget reflects what was searched instead of showing the same static
 * chips for every query. Returns `[]` when nothing genuinely overlaps - the
 * caller hides the widget rather than showing irrelevant suggestions. (The
 * platform's per-resource synthetic-questions DA output isn't read back
 * anywhere yet - see the final report; this is a lightweight heuristic over
 * the tenant's own curated question list, not a rewrite of that task.)
 */
export function deriveRelatedQuestions(query: string, suggested: Question[]): Question[] {
  const lowered = query.trim().toLowerCase()
  const queryWords = new Set(
    lowered.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !RELATED_QUESTION_STOPWORDS.has(w)),
  )
  if (queryWords.size === 0) return []
  return suggested
    .filter((q) => q.text.toLowerCase() !== lowered)
    .map((q) => {
      const words = q.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
        w.length >= 4 && !RELATED_QUESTION_STOPWORDS.has(w)
      )
      const overlap = words.filter((w) => queryWords.has(w)).length
      return { q, overlap }
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 4)
    .map((s) => s.q)
}

export class KnowledgeBoxNotConnectedError extends Error {
  constructor(readonly slug: string) {
    super(`No knowledge box connected for tenant '${slug}'`)
    this.name = 'KnowledgeBoxNotConnectedError'
  }
}

/** A labelset as the platform stores it (`GET /labelsets`). */
interface RawLabelset {
  title?: string
  color?: string
  multiple?: boolean
  kind?: string[]
  labels?: { title?: string; text?: string; uri?: string; related?: string }[]
}

/**
 * A configured data-augmentation agent with everything needed to reproduce it
 * on the platform. `operations` and `filter` are the platform's own shapes,
 * carried verbatim so a rebuild changes only what it means to change.
 */
export interface AgentConfig {
  id: string
  /** Task type: `labeler`, `ask`, `llm-graph`, ... */
  task: string
  /** The agent's display name (`parameters.name`). */
  title: string
  /** `parameters.llm.model`; empty when the agent has no pinned model. */
  model: string
  /** `parameters.on` - the platform's trigger; undefined when unset. */
  on?: number
  /** `parameters.filter` - field types, agent-generated eligibility, ... */
  filter?: unknown
  operations: unknown[]
  enabled: boolean
}

export interface AragProviderOptions {
  /** Resolve the current binding for a tenant slug - called per request so bindings can change at runtime. */
  resolveBinding: (slug: string) => KbBinding | undefined
  fetchImpl?: typeof fetch
  /**
   * Model for bulk DA agents. Defaults to ARAG_DA_AGENT_MODEL, then the cheap
   * extraction tier - never to the knowledge box's user-facing answer model.
   */
  augmentationModel?: string
}

/**
 * RetrievalProvider backed by Progress Agentic RAG knowledge boxes - one KB
 * per tenant, bound by slug. Every answer, search result and resource comes
 * from the live regional API; nothing is fabricated here.
 */
/** How long the REMi answer-quality request may run before the answer's stream closes without it. */
const REMI_CAP_MS = 8000

export class AragProvider implements RetrievalProvider {
  private readonly clients = new Map<string, KbClient>()
  /**
   * Search listings before their platform page summaries are filled: the
   * fill runs on every read (cheap: summaries are memoised per resource), so
   * a card whose summary read failed is retried on the next identical query.
   */
  private readonly searchCache = new Map<
    string,
    { at: number; results: SearchResults; rawById: Map<string, RawResource> }
  >()
  private readonly graphCache = new Map<string, { at: number; graph: RelationsGraphResult }>()
  /** Cleaned entity names per group, uncapped - the display list is a slice of it. */
  private readonly entityGroupsCache = new Map<
    string,
    { at: number; groups: { group: string; entities: string[] }[] }
  >()
  private readonly catalogCache = new Map<
    string,
    { at: number; resources: ResourceSummary[]; items: CatalogItem[] }
  >()
  /**
   * Platform page summaries by `<slug>/<resourceId>`, `null` when a resource
   * has none. Summaries are written once at ingest, so there is no TTL;
   * bounded by corpus size.
   */
  private readonly pageSummaryCache = new Map<string, string | null>()
  private readonly augmentationModelId: string

  constructor(private readonly opts: AragProviderOptions) {
    const configured = opts.augmentationModel === undefined
      ? envValue('ARAG_DA_AGENT_MODEL')
      : opts.augmentationModel
    this.augmentationModelId = configured?.trim() || DEFAULT_DA_AGENT_MODEL
  }

  private client(tenant: TenantConfig): KbClient {
    const binding = this.opts.resolveBinding(tenant.slug)
    if (!binding) {
      this.invalidate(tenant.slug)
      throw new KnowledgeBoxNotConnectedError(tenant.slug)
    }
    const key = `${tenant.slug}:${binding.baseUrl}`
    const existing = this.clients.get(key)
    if (existing) return existing
    // A new binding for this slug invalidates anything cached for the old one.
    this.invalidate(tenant.slug)
    const client = new KbClient(binding, this.opts.fetchImpl ?? fetch)
    this.clients.set(key, client)
    return client
  }

  /** Drop cached clients and catalogue entries for a tenant (call after rebinding). */
  invalidate(slug: string): void {
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${slug}:`)) this.clients.delete(key)
    }
    this.catalogCache.delete(slug)
    this.entityGroupsCache.delete(slug)
    for (const cache of [this.searchCache, this.graphCache]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${slug}|`)) cache.delete(key)
      }
    }
    this.forgetPageSummaries(slug)
  }

  /** Drop the memoised platform page summaries for a tenant (keys are `<slug>/<id>`). */
  private forgetPageSummaries(slug: string): void {
    for (const key of this.pageSummaryCache.keys()) {
      if (key.startsWith(`${slug}/`)) this.pageSummaryCache.delete(key)
    }
  }

  private toSummary(id: string, raw: RawResource): ResourceSummary {
    const meta = raw.extra?.metadata ?? {}
    const topicFromLabels = classificationLabels(raw, 'topic')
    const type = resourceTypeFromMeta(meta)
    // Merchandise the raw title/summary so a filename ("1981-071-DLD.pdf") is
    // never the headline. Junk titles (hash/bot/system) collapse to "Untitled
    // resource" with no source name shown. The API overlays a generated
    // enrichment (real title/summary/takeaways/quotes) from its own store.
    const safe = displayTitle(raw.title, id)
    const rawTitle = safe === 'Untitled resource' ? '' : (raw.title ?? '')
    // Either summary may be a structured value on a box whose agents wrote
    // one; only text is a summary (baselineMerchandising drops the rest).
    const merch = baselineMerchandising(
      rawTitle,
      typeof meta.summary === 'string' && meta.summary.trim() ? meta.summary : raw.summary,
    )
    const bib = bibliographic(meta)
    const kindLabel = studyDesignOf(raw, {
      title: rawTitle,
      keywords: bib.keywords,
      format: classificationLabels(raw, 'format')[0],
      type,
    })
    return ResourceSummarySchema.parse({
      id,
      title: merch.title,
      summary: merch.summary,
      type,
      topicIds: topicFromLabels.length > 0 ? topicFromLabels : meta.topic ? [meta.topic] : [],
      keyFacts: meta.keyFacts ?? [],
      published: meta.published,
      ...(kindLabel ? { kind: kindLabel } : {}),
      ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
      ...bib,
      // Where it came from (a PMC article URL, a crawled page): the search
      // route resolves PMC identifiers against it when the ingest stored no
      // pmcid field of its own.
      ...(raw.origin?.url ? { originUrl: raw.origin.url } : {}),
      enriched: false,
    })
  }

  /**
   * Cards must never be bare (#46). Our own enrichment (title/summary/
   * takeaways) is overlaid later by the API from its store; until it exists
   * for a resource, the platform's DA page-summary agent has usually already
   * written a real summary at ingest. List endpoints return its field id
   * (`show=values`) but never its text, so for each item whose summary is
   * still just its title, fetch that one small field - bounded parallelism,
   * memoised - and use it. Anything that fails leaves the item as it was.
   */
  private async fillPlatformSummaries<T extends { id: string; title: string; summary?: string }>(
    tenant: TenantConfig,
    items: T[],
    rawById: Map<string, RawResource>,
  ): Promise<T[]> {
    const bare = items.filter((item) => !item.summary || item.summary === item.title)
    if (bare.length === 0) return items
    const client = this.client(tenant)
    const summaries = new Map<string, string>()
    const queue = [...bare]
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const text = await this.platformPageSummary(
          client,
          tenant.slug,
          item.id,
          rawById.get(item.id),
        )
        if (text) summaries.set(item.id, text)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PAGE_SUMMARY_FETCH_CONCURRENCY, bare.length) }, worker),
    )
    if (summaries.size === 0) return items
    return items.map((item) => {
      const text = summaries.get(item.id)
      if (!text) return item
      // Same rule as the baseline: a summary that merely repeats the name
      // carries nothing, so it does not replace the fallback.
      const merch = baselineMerchandising(rawById.get(item.id)?.title ?? item.title, text)
      return merch.summary === merch.title ? item : { ...item, summary: merch.summary }
    })
  }

  /** The DA page summary for one resource, via cache, else one small field read. */
  private async platformPageSummary(
    client: KbClient,
    slug: string,
    id: string,
    raw: RawResource | undefined,
  ): Promise<string | null> {
    const key = `${slug}/${id}`
    const cached = this.pageSummaryCache.get(key)
    if (cached !== undefined) return cached
    let result: string | null = null
    try {
      // Every list request asks for `show=values`, so the field pointers are
      // on the raw resource; a resource without them has no text fields.
      // Read them structurally so the shared RawResource type need not
      // carry the per-method `data` shapes used elsewhere.
      const pointers = (raw as { data?: { texts?: Record<string, unknown> } } | undefined)?.data
      const fieldId = findPageSummaryFieldId(Object.keys(pointers?.texts ?? {}))
      if (fieldId) {
        const field = await client.getJson<{ extracted?: { text?: { text?: string } } }>(
          `/resource/${id}/text/${fieldId}?show=extracted&extracted=text`,
        )
        const text = field.extracted?.text?.text?.trim()
        result = text && text.length > 0 ? text : null
      }
    } catch {
      // A failed read must never break a list; the card keeps its fallback
      // and the next request retries (nothing is cached on error).
      return null
    }
    this.pageSummaryCache.set(key, result)
    return result
  }

  async listResources(tenant: TenantConfig): Promise<ResourceSummary[]> {
    return (await this.loadCatalogue(tenant)).resources
  }

  /**
   * Every displayable resource as a library item, from the same paged read
   * `listResources` makes and under the same TTL - the publication-date sort
   * the platform cannot do runs over this.
   */
  private async catalogItems(tenant: TenantConfig): Promise<CatalogItem[]> {
    return (await this.loadCatalogue(tenant)).items
  }

  private async loadCatalogue(
    tenant: TenantConfig,
  ): Promise<{ resources: ResourceSummary[]; items: CatalogItem[] }> {
    const cached = this.catalogCache.get(tenant.slug)
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached
    const client = this.client(tenant)
    // Read the catalogue in pages and build summaries from the page payload
    // itself. A per-resource fetch here would mean one request per document -
    // thousands of parallel calls on a real corpus, on the hot search path.
    const resources: ResourceSummary[] = []
    const items: CatalogItem[] = []
    for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
      const catalog = await client.getJson<{ resources?: Record<string, RawResource> }>(
        `/catalog?page_number=${page}&page_size=${CATALOG_PAGE_SIZE}&show=basic&show=extra&show=origin`,
      )
      const batch = Object.entries(catalog.resources ?? {})
      for (const [id, raw] of batch) {
        // Failed ingests and junk (hash/bot-challenge) titles never reach a
        // user-facing list - see isDisplayableResource. In-app documentation
        // is research-invisible: it never appears in the research catalogue.
        if (!isDisplayableResource(raw) || isDocumentationResource(raw)) continue
        resources.push(this.toSummary(id, raw))
        items.push(catalogItemFromRaw(id, raw))
      }
      if (batch.length < CATALOG_PAGE_SIZE) break
    }
    resources.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    const entry = { at: Date.now(), resources, items }
    this.catalogCache.set(tenant.slug, entry)
    return entry
  }

  async resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    try {
      const raw = await this.client(tenant).getJson<RawResource>(
        `/resource/${id}?show=basic&show=extra&show=origin`,
      )
      return this.toSummary(id, raw)
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
        return null
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Management operations (admin surfaces) - all live platform calls.
  // -------------------------------------------------------------------------

  async counters(tenant: TenantConfig): Promise<KbCounters> {
    const raw = await this.client(tenant).getJson<{
      resources?: number
      paragraphs?: number
      sentences?: number
      index_size?: number
    }>('/counters')
    return {
      resources: raw.resources ?? 0,
      paragraphs: raw.paragraphs ?? 0,
      sentences: raw.sentences ?? 0,
      indexMb: Math.round((raw.index_size ?? 0) / 1e6),
    }
  }

  async recentResources(tenant: TenantConfig, limit = 12): Promise<RecentResource[]> {
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
    }>(`/catalog?page_number=0&page_size=${limit}&show=basic&sort_field=created&sort_order=desc`)
    return Object.entries(raw.resources ?? {}).map(([id, r]) => {
      const status = r.metadata?.status
      return {
        id,
        title: r.title ?? id,
        status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
        created: r.created,
        hidden: (r as { hidden?: boolean }).hidden ?? false,
      }
    })
  }

  async uploadFile(
    tenant: TenantConfig,
    input: {
      filename: string
      contentType: string
      bytes: Uint8Array
      /** Extraction method (strategy id) to apply; omitted or 'default' = the platform default. */
      method?: string
    },
  ): Promise<{ id: string }> {
    const client = this.client(tenant)
    const headers: Record<string, string> = input.method && input.method !== 'default'
      ? { 'x-extract-strategy': input.method }
      : {}
    const res =
      (await withBackpressureRetry(() =>
        client.postRaw('/upload', input.bytes, input.contentType, input.filename, headers)
      )) as { uuid?: string; resource?: string }
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? res.resource ?? '' }
  }

  async createLink(
    tenant: TenantConfig,
    input: { url: string; title?: string; hidden?: boolean },
  ): Promise<{ id: string }> {
    const client = this.client(tenant)
    const res = await withBackpressureRetry(() =>
      client.postJson<{ uuid?: string }>('/resources', {
        title: input.title ?? input.url,
        icon: 'application/stf-link',
        origin: { url: input.url },
        links: { link: { uri: input.url } },
        ...(input.hidden ? { hidden: true } : {}),
      })
    )
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  async createText(
    tenant: TenantConfig,
    input: {
      title: string
      body: string
      format?: 'PLAIN' | 'MARKDOWN'
      slug?: string
      topicId?: string
      extraMetadata?: Record<string, unknown>
      originUrl?: string
    },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      title: input.title,
      icon: 'text/plain',
      texts: { body: { body: input.body, format: input.format ?? 'MARKDOWN' } },
    }
    if (input.originUrl) body.origin = { url: input.originUrl }
    if (input.slug) body.slug = input.slug
    if (input.topicId) {
      body.usermetadata = { classifications: [{ labelset: 'topic', label: input.topicId }] }
    }
    if (input.extraMetadata) body.extra = { metadata: input.extraMetadata }
    const client = this.client(tenant)
    const res = await withBackpressureRetry(() =>
      client.postJson<{ uuid?: string }>('/resources', body)
    )
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  /** Full resource read for migration - extracted text per field, labels, origin. */
  async resourceFull(tenant: TenantConfig, id: string): Promise<{
    title: string
    slug?: string
    kind: 'text' | 'link' | 'file'
    originUrl?: string
    texts: { fieldId: string; body: string }[]
    topicIds: string[]
    extraMetadata?: Record<string, unknown>
  }> {
    const raw = await this.client(tenant).getJson<
      RawResource & {
        slug?: string
        origin?: { url?: string }
        data?: {
          texts?: Record<
            string,
            { value?: { body?: string }; extracted?: { text?: { text?: string } } }
          >
          links?: Record<string, { extracted?: { text?: { text?: string } } }>
          files?: Record<string, unknown>
        }
      }
    >(
      `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
    )
    const texts: { fieldId: string; body: string }[] = []
    for (const [fieldId, field] of Object.entries(raw.data?.texts ?? {})) {
      const body = field.value?.body ?? field.extracted?.text?.text
      if (body) texts.push({ fieldId, body })
    }
    for (const [fieldId, field] of Object.entries(raw.data?.links ?? {})) {
      const body = field.extracted?.text?.text
      if (body) texts.push({ fieldId: `link:${fieldId}`, body })
    }
    const hasFiles = Object.keys(raw.data?.files ?? {}).length > 0
    const kind = raw.origin?.url && Object.keys(raw.data?.links ?? {}).length > 0
      ? 'link'
      : hasFiles
      ? 'file'
      : 'text'
    const summary = this.toSummary(id, raw)
    return {
      title: summary.title,
      slug: raw.slug,
      kind,
      originUrl: raw.origin?.url,
      texts,
      topicIds: summary.topicIds,
      extraMetadata: raw.extra?.metadata as Record<string, unknown> | undefined,
    }
  }

  /** Whether a resource slug already exists in the tenant's knowledge box. */
  async hasSlug(tenant: TenantConfig, slug: string): Promise<boolean> {
    try {
      await this.client(tenant).getJson(`/slug/${slug}`)
      return true
    } catch {
      return false
    }
  }

  private invalidateCatalogue(slug: string): void {
    this.catalogCache.delete(slug)
    for (const key of this.searchCache.keys()) {
      if (key.startsWith(`${slug}|`)) this.searchCache.delete(key)
    }
    // A write to the box can change what the platform summarised: the next
    // listing re-reads the summaries of the cards it shows.
    this.forgetPageSummaries(slug)
  }

  async suggest(tenant: TenantConfig, query?: string): Promise<Question[]> {
    return rankSuggestedQuestions(tenant.suggestedQuestions, query)
  }

  async search(
    tenant: TenantConfig,
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResults> {
    const trimmed = query.trim()
    if (!trimmed) return { query, resources: [], relatedQuestions: [] }
    // The platform's hybrid merge is not stable call to call: the same query
    // returned 14, 18, 18 and 17 results with a different top hit across four
    // loads in three minutes. A short per-query cache makes an identical
    // query return the identical list for a few minutes, which is what a
    // reader comparing two tabs expects.
    const cacheKey = `${tenant.slug}|${trimmed.toLowerCase()}|${JSON.stringify(opts)}`
    const cached = this.searchCache.get(cacheKey)
    let listing: { results: SearchResults; rawById: Map<string, RawResource> }
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      listing = cached
    } else {
      listing = await this.searchUncached(tenant, trimmed, opts)
      if (this.searchCache.size >= SEARCH_CACHE_MAX) {
        const oldest = this.searchCache.keys().next().value
        if (oldest !== undefined) this.searchCache.delete(oldest)
      }
      this.searchCache.set(cacheKey, { at: Date.now(), ...listing })
    }
    return {
      ...listing.results,
      resources: await this.fillPlatformSummaries(
        tenant,
        listing.results.resources,
        listing.rawById,
      ),
    }
  }

  private async searchUncached(
    tenant: TenantConfig,
    trimmed: string,
    opts: SearchOptions,
  ): Promise<{ results: SearchResults; rawById: Map<string, RawResource> }> {
    const client = this.client(tenant)
    const mode = opts.mode ?? 'hybrid'
    const features = mode === 'hybrid' ? ['keyword', 'semantic'] : [mode]
    const body: Record<string, unknown> = {
      query: trimmed,
      features,
      page_size: opts.pageSize ?? 20,
      // The paragraph budget, and what actually bounds the resource list:
      // a sentence that one paper answers in twenty paragraphs otherwise
      // fills the whole page with that paper and returns it alone
      // (verified live: "risk of SUDEP with lamotrigine" gave one resource
      // at the default and eighteen at sixty). A request-level top_k wins
      // over the stored configuration's.
      top_k: SEARCH_PARAGRAPH_BUDGET,
      show: ['basic', 'origin', 'values'],
      // Cross-encoder reranking pass over the retrieved candidates - verified
      // live (docs/ARAG-DEV.md has no prior record of this; see the reranker
      // note added there). This is in fact the platform's own default when
      // `reranker` is omitted (confirmed via `score_type: RERANKER` on an
      // unconfigured /find call), so pinning it here is defensive - it keeps
      // the box's next default change from silently un-reranking this path -
      // rather than a genuinely new capability. `findWithFallback` sheds it
      // on a 4xx same as `search_configuration`, so a deployment that
      // rejects the field still works.
      reranker: 'predict',
    }
    // The named search configuration's own features override the request's,
    // which would make the mode switch inert - only attach it for the
    // default hybrid mode. The documentation surface always uses its own
    // doc-scoped config (which carries the documentation-only stored filter);
    // isolation lives in that stored config, not a per-request filter.
    if (opts.docScope) body.search_configuration = SEARCH_CONFIG_DOC_FIND
    else if (mode === 'hybrid') body.search_configuration = SEARCH_CONFIG_RESEARCH_FIND
    const searchIntent = opts.intent ? tenant.intents?.find((i) => i.id === opts.intent) : undefined
    if (searchIntent && !opts.docScope && searchIntent.answer.surfaces.includes('search')) {
      // The stored configuration carries the intent's features and filter and
      // overrides request features - but `findWithFallback` sheds the
      // configuration on a zero result, and a retry with no features at all
      // is the platform's fuzzy default. Sending the intent's own features
      // keeps a keyword-only lookup keyword-only on that retry.
      body.search_configuration = intentConfigurationName(tenant, searchIntent.id, 'find')
      body.features = searchIntent.retrieval.features
      body.reranker = searchIntent.retrieval.reranker
      body.page_size = opts.pageSize ?? searchIntent.retrieval.topK
      body.top_k = Math.max(searchIntent.retrieval.topK, SEARCH_PARAGRAPH_BUDGET)
    }
    if (opts.resourceIds && opts.resourceIds.length > 0) body.resource_filters = opts.resourceIds
    // An exact lookup (a bare identifier or term on the keyword
    // configuration) promises the documents that contain it, never near
    // misses; a DOI names one document. Both are enforced below.
    const exactLookup = searchIntent !== undefined && !opts.docScope &&
      !searchIntent.answer.surfaces.includes('ask')
    const wantedDoi = opts.docScope ? undefined : extractDoi(trimmed)
    // Topics live in the index; the kind is derived from the record (see
    // studyDesignOf), so it is applied to the results below, not sent.
    const filters = (opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`)
    if (filters.length > 0) body.filters = filters
    const [found, all] = await Promise.all([
      this.findWithFallback(client, body),
      this.listResources(tenant),
    ])
    const byId = new Map(all.map((r) => [r.id, r]))
    // Failed ingests and junk (hash/bot-challenge) titles never surface as a
    // search result - see isDisplayableResource. Then the documentation
    // cross-check (authoritative safety net, independent of the stored filter):
    // a doc-scoped search keeps ONLY documentation; a research search DROPS any
    // documentation that leaked through (the config could have been shed on a
    // fallback retry - see findWithFallback).
    const entries = Object.entries(found.resources ?? {})
      .filter(([, raw]) => isDisplayableResource(raw))
      .filter(([, raw]) => isDocumentationResource(raw) === Boolean(opts.docScope))
    const rawById = new Map(entries)
    // Relevance floor: below this a match is noise, and an off-corpus query
    // should say "no results" honestly rather than surface weak hits.
    const MIN_SCORE = 0.1
    const scored = entries
      .map(([id, raw]) => {
        const paragraphs: ScoredParagraph[] = []
        for (const [fieldKey, field] of Object.entries(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            paragraphs.push({
              score: paragraph.score ?? 0,
              text: paragraph.text ?? '',
              page: (paragraph as { position?: { page_number?: number } }).position?.page_number,
              fieldKey,
            })
          }
        }
        // The snippet is the best BODY paragraph whenever one matched: a
        // reference-list line, a first-page title/author block or a DOI
        // fragment never outranks or stands in for body text. A resource
        // whose only matches are such noise stays findable, flagged, at a
        // fraction of its score.
        const choice = chooseSnippet(
          paragraphs,
          MIN_SCORE,
          (text) =>
            looksLikeReferenceChunk(text) || isCitationNoise(text) ||
            looksLikeDeclarationsChunk(text),
        )
        const passage = choice.passage?.text || undefined
        const summaryDoi = byId.get(id)?.doi
        const texts = paragraphs.map((p) => p.text)
        // A DOI query matches one document; the resource that records it is
        // a certain match whatever its paragraph scores say.
        const doiHit = wantedDoi !== undefined && matchesDoi(wantedDoi, { doi: summaryDoi, texts })
        return {
          id,
          title: raw.title,
          raw,
          best: doiHit && summaryDoi ? Math.max(choice.score, 1) : choice.score,
          passage,
          page: choice.passage?.page,
          reference: choice.reference,
          matchedField: choice.passage?.fieldKey && isGeneratedField(choice.passage.fieldKey)
            ? 'summary' as const
            : 'body' as const,
          texts,
          doiHit,
        }
      })
      .filter((s) => s.best >= MIN_SCORE)
      // A DOI names one document: nothing else - least of all a reference
      // list citing a neighbouring DOI - is a result for it.
      .filter((s) => wantedDoi === undefined || s.doiHit)
      // An exact lookup returns only documents that contain every term.
      .filter((s) =>
        !exactLookup || wantedDoi !== undefined ||
        isExactTermMatch(trimmed, { title: s.title, texts: s.texts })
      )
    // Near-duplicate suppression: crawled pages repeat nav/footer chrome, so
    // two results opening with the same 120 characters are the same content.
    const seenSignatures = new Set<string>()
    const contentDeduped = scored.sort((a, b) => b.best - a.best).filter((s) => {
      const signature = (s.passage ?? s.raw.title ?? s.id).slice(0, 120).toLowerCase()
      if (seenSignatures.has(signature)) return false
      seenSignatures.add(signature)
      return true
    })
    // Multi-part scans and project-code variants are one logical report in a
    // card list. Search keeps the highest-scoring member, rather than always
    // the primary, so a query specific to Part B can still reach Part B.
    const deduped = opts.docScope
      ? contentDeduped
      : dedupeResourceFamilies(contentDeduped.map((resource) => ({
        ...resource,
        priority: resource.best,
      })))
    // Calibrated relevance, comparable across queries: semantic scores are
    // already 0-1; BM25 scores (>1) are squashed logistically. Never
    // normalised to the top hit - a weak best match must LOOK weak.
    const calibrate = (s: number): number => s <= 1 ? Math.max(0, Math.min(1, s)) : s / (s + 2)
    const kinds = opts.kindIds ?? []
    const resources: ScoredResource[] = deduped.map(
      ({ id, raw, best, passage, page, reference, matchedField }) => ({
        ...(byId.get(id) ?? this.toSummary(id, raw)),
        relevance: Math.round(calibrate(best) * 100) / 100,
        citedCount: 0,
        matchedPassage: passage,
        ...(displayPage(page) ? { matchedPage: displayPage(page) } : {}),
        ...(reference ? { referenceChunk: true } : {}),
        ...(passage ? { matchedField } : {}),
      }),
    ).filter((r) => kinds.length === 0 || (r.kind !== undefined && kinds.includes(r.kind)))
    const relatedQuestions = deriveRelatedQuestions(trimmed, tenant.suggestedQuestions)
    return { results: { query: trimmed, resources, relatedQuestions }, rawById }
  }

  /**
   * POST /find with the fallback the platform's search configuration bug
   * needs: a stored config can exist but return zero for every query on an
   * admin-connected box while a config-free find works - shed it and retry
   * once, on a zero-result response or a 4xx before the fallback would ever
   * see output. Also sheds `reranker` on that same 4xx retry - verified
   * accepted on this deployment (see the reranker note in docs/ARAG-DEV.md),
   * but a box on an older platform build could still reject it, and this is
   * the same shed-and-retry-once pattern `ask` already uses for its own
   * optional strategies. Shared by `search` and the catalogue's
   * filtered-query path (`catalog`/`catalogByQuery`) so both use the exact
   * same retrieval call.
   */
  private async findWithFallback(
    client: KbClient,
    body: Record<string, unknown>,
  ): Promise<FindResponse> {
    try {
      const first = await client.postJson<FindResponse>('/find', body)
      if (body.search_configuration && Object.keys(first.resources ?? {}).length === 0) {
        delete body.search_configuration
        return await client.postJson<FindResponse>('/find', body)
      }
      return first
    } catch (err) {
      if (err instanceof AragApiError && err.status >= 400 && err.status < 500) {
        delete body.search_configuration
        delete body.reranker
        return await client.postJson<FindResponse>('/find', body)
      }
      throw err
    }
  }

  async catalog(tenant: TenantConfig, opts: CatalogOptions = {}): Promise<CatalogPage> {
    const query = opts.query?.trim()
    // A query filters the library, so it needs real retrieval, not the bare
    // `/catalog?query=` title-substring match (weak - it misses documents
    // `/find` finds for the same string). Route it through the same
    // retrieval path `search` uses; unfiltered browse/paging below is
    // untouched.
    if (query) return await this.catalogByQuery(tenant, query, opts)
    // The platform's `sort_field` is created/modified/title only, so a
    // publication-date sort runs over the cached listing (same paged read,
    // same TTL) with the same OR-within / AND-across facet semantics. A kind
    // filter takes the same path: the kind is derived from the record (see
    // studyDesignOf), not read from the index.
    if (opts.sortField === 'published' || (opts.kindIds?.length ?? 0) > 0) {
      return await this.catalogFromListing(tenant, opts)
    }
    const params = new URLSearchParams()
    params.set('page_number', String(opts.page ?? 0))
    params.set('page_size', String(opts.pageSize ?? 24))
    params.append('show', 'basic')
    params.append('show', 'extra')
    params.append('show', 'origin')
    params.append('show', 'values')
    params.set('sort_field', opts.sortField ?? 'created')
    params.set('sort_order', opts.sortOrder ?? 'desc')
    params.set('hidden', 'false')
    // One expression, not the legacy `filters` params: those AND every label,
    // so Articles + Video returned nothing. Labels within a facet OR, facets
    // AND (docs/ARAG-DEV.md: `/catalog` keys the expression under `resource`).
    const expression = catalogFilterExpression(opts)
    if (expression) params.set('filter_expression', JSON.stringify(expression))
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
      fulltext?: { total?: number }
      total?: number
    }>(`/catalog?${params.toString()}`)
    // Failed ingests and junk (hash/bot-challenge) titles never surface in
    // the library - see isDisplayableResource. In-app documentation is
    // research-invisible: it never surfaces in the research library.
    const entries = Object.entries(raw.resources ?? {})
      .filter(([, r]) => isDisplayableResource(r) && !isDocumentationResource(r))
      .map(([id, raw]) => ({ id, title: raw.title, raw }))
    // Plain browse keeps the canonical report (or Part A/Part 1 when no
    // primary exists). Resource detail routes still resolve every member.
    const kept = dedupeResourceFamilies(entries)
    const items: CatalogItem[] = await this.fillPlatformSummaries(
      tenant,
      kept.map(({ id, raw }) => catalogItemFromRaw(id, raw)),
      new Map(kept.map(({ id, raw }) => [id, raw])),
    )
    return { items, total: raw.fulltext?.total ?? raw.total ?? items.length }
  }

  /** Browse over the cached listing: the publication-date sort and any kind filter. */
  private async catalogFromListing(
    tenant: TenantConfig,
    opts: CatalogOptions,
  ): Promise<CatalogPage> {
    const all = await this.catalogItems(tenant)
    const matching = dedupeResourceFamilies(
      all.filter((item) => matchesCatalogFilters(item, opts)),
    )
    const sorted = sortCatalogItems(matching, opts.sortField ?? 'created', opts.sortOrder ?? 'desc')
    return {
      items: paginateCatalogItems(sorted, opts.page ?? 0, opts.pageSize ?? 24),
      total: sorted.length,
    }
  }

  /**
   * How many resources carry no label at all from a labelset - a real count
   * from the index, because topics are multi-valued and "resources minus the
   * sum of topic counts" goes negative.
   */
  async untaggedCount(tenant: TenantConfig, labelset: string): Promise<number> {
    const params = new URLSearchParams({ page_size: '0', hidden: 'false' })
    params.set('filter_expression', JSON.stringify(untaggedFilterExpression(labelset)))
    const raw = await this.client(tenant).getJson<{
      fulltext?: { total?: number }
      total?: number
    }>(`/catalog?${params.toString()}`)
    return raw.fulltext?.total ?? raw.total ?? 0
  }

  /**
   * Top resources filed under one topic - drives Explore's topic rows. Reads
   * the box's classification INDEX via `/catalog`'s param-based `filters=`
   * (the same call `catalog()`'s unfiltered/topic-filtered browse above
   * makes), not `/find`'s JSON-body `filters` array - docs/ARAG-DEV.md
   * records that legacy array silently returning zero for label paths, and
   * this `/catalog` param form is verified live to return real, non-empty
   * results filtered by `/classification.labels/topic/{id}` even though a
   * resource's own `usermetadata.classifications` can be empty for the same
   * resource (the classifier's labels live in the index, not necessarily in
   * that field - see the final report). Deliberately independent of
   * `listResources`'s per-resource `topicIds`, which the DA classifier's
   * labels don't reliably populate.
   */
  async topicResources(
    tenant: TenantConfig,
    topicId: string,
    limit = 12,
  ): Promise<ResourceSummary[]> {
    const params = new URLSearchParams()
    params.set('page_number', '0')
    // Over-fetch: documentation, junk and unprocessed resources are filtered
    // out BELOW, so asking for exactly `limit` can return nothing at all when
    // the first page happens to be all documentation - which is what a box
    // whose help articles sort newest-first does.
    const fetchSize = Math.min(200, Math.max(limit * 6, 30))
    params.set('page_size', String(fetchSize))
    params.append('show', 'basic')
    params.append('show', 'extra')
    params.append('show', 'origin')
    params.append('show', 'values')
    params.set('sort_field', 'created')
    params.set('sort_order', 'desc')
    params.set('hidden', 'false')
    params.append('filters', `/classification.labels/topic/${topicId}`)
    const raw = await this.client(tenant).getJson<{ resources?: Record<string, RawResource> }>(
      `/catalog?${params.toString()}`,
    )
    // Failed ingests and junk (hash/bot-challenge) titles never surface in a
    // topic row - see isDisplayableResource. Documentation is research-invisible.
    // A resource the platform has not finished processing has no extracted text
    // behind it yet, so its card would be an empty placeholder - browse rows
    // wait for it. The library still lists them, badged, so a curator can watch
    // the load progress.
    const entries = Object.entries(raw.resources ?? {})
      .filter(([, r]) =>
        isDisplayableResource(r) && !isDocumentationResource(r) &&
        (r.metadata?.status ?? '').toUpperCase() === 'PROCESSED'
      )
      .map(([id, raw]) => ({ id, title: raw.title, raw }))
    const picked = dedupeResourceFamilies(entries).slice(0, limit)
    return await this.fillPlatformSummaries(
      tenant,
      picked.map(({ id, raw }) => this.toSummary(id, raw)),
      new Map(picked.map(({ id, raw }) => [id, raw])),
    )
  }

  /**
   * Filtered catalogue browse: real retrieval via `/find` (the same path
   * `search` uses), reshaped into the catalogue's own item shape and paged
   * in-memory over the candidate pool. `total` reflects the candidate pool
   * actually scored (capped below), not the platform's full-corpus count.
   */
  private async catalogByQuery(
    tenant: TenantConfig,
    query: string,
    opts: CatalogOptions,
  ): Promise<CatalogPage> {
    const client = this.client(tenant)
    const body: Record<string, unknown> = {
      query,
      features: ['keyword', 'semantic'],
      page_size: 200,
      show: ['basic', 'extra', 'origin', 'values'],
      search_configuration: SEARCH_CONFIG_RESEARCH_FIND,
    }
    // Topics live in the index; the kind is derived from the record, so it
    // is applied to the results below rather than sent as a filter.
    const filters = (opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`)
    if (filters.length > 0) body.filters = filters
    const found = await this.findWithFallback(client, body)
    const MIN_SCORE = 0.1
    const scored = Object.entries(found.resources ?? {})
      .filter(([, raw]) => isDisplayableResource(raw) && !isDocumentationResource(raw))
      .map(([id, raw]) => {
        let best = 0
        for (const field of Object.values(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            best = Math.max(best, paragraph.score ?? 0)
          }
        }
        return { id, title: raw.title, raw, best, priority: best }
      })
      .filter((s) => s.best >= MIN_SCORE)
      .sort((a, b) => b.best - a.best)
    const kept = dedupeResourceFamilies(scored)
      .filter(({ id, raw }) =>
        matchesCatalogFilters(catalogItemFromRaw(id, raw), {
          kindIds: opts.kindIds,
          formatIds: opts.formatIds,
        })
      )
    const page = opts.page ?? 0
    const pageSize = opts.pageSize ?? 24
    const start = page * pageSize
    const slice = kept.slice(start, start + pageSize)
    const items = await this.fillPlatformSummaries(
      tenant,
      slice.map(({ id, raw }) => catalogItemFromRaw(id, raw)),
      new Map(slice.map(({ id, raw }) => [id, raw])),
    )
    return { items, total: kept.length }
  }

  async facets(
    tenant: TenantConfig,
    labelsets: string[],
    filters?: string[],
  ): Promise<FacetCounts> {
    if (labelsets.length === 0) return {}
    // The kind is derived here from the stored record (see studyDesignOf),
    // not read from the index, so its counts come from the cached listing.
    // A filter ON a kind is one the platform cannot apply, so every labelset
    // requested under it is counted from the listing as well.
    const kindFilter = (filters ?? []).some((f) => f.startsWith('/classification.labels/kind/'))
    if (kindFilter) return this.facetsFromListing(tenant, labelsets, filters ?? [])
    const out: FacetCounts = {}
    let remaining = labelsets
    if (labelsets.includes('kind')) {
      out.kind = (await this.facetsFromListing(tenant, ['kind'], filters ?? [])).kind ?? {}
      remaining = labelsets.filter((id) => id !== 'kind')
      if (remaining.length === 0) return out
    }
    const params = new URLSearchParams({ page_size: '0' })
    for (const id of remaining) params.append('faceted', `/classification.labels/${id}`)
    for (const f of filters ?? []) params.append('filters', f)
    const raw = await this.client(tenant).getJson<{
      fulltext?: { facets?: Record<string, Record<string, number>> }
      facets?: Record<string, Record<string, number>>
    }>(`/catalog?${params.toString()}`)
    const source = raw.fulltext?.facets ?? raw.facets ?? {}
    // The index can surface platform-computed classifications under the same
    // paths - keep only labels the labelset actually defines.
    const defined = new Map(
      (await this.labelsets(tenant)).map((ls) => [ls.id, new Set(ls.labels)]),
    )
    for (const [facetKey, counts] of Object.entries(source)) {
      const labelsetId = facetKey.split('/').pop() ?? facetKey
      const allowed = defined.get(labelsetId)
      const byLabel: Record<string, number> = {}
      for (const [labelPath, count] of Object.entries(counts)) {
        const label = labelPath.split('/').pop() ?? labelPath
        if (allowed && !allowed.has(label)) continue
        byLabel[label] = count
      }
      out[labelsetId] = byLabel
    }
    return out
  }

  private async rawLabelsets(tenant: TenantConfig): Promise<Record<string, RawLabelset>> {
    const raw = await this.client(tenant).getJson<{ labelsets?: Record<string, RawLabelset> }>(
      '/labelsets',
    )
    return raw.labelsets ?? {}
  }

  /**
   * Facet counts over the cached listing (the same paged read `listResources`
   * makes), with the same AND-across-facets filter semantics as the index:
   * the only way to count a labelset the portal derives itself.
   */
  private async facetsFromListing(
    tenant: TenantConfig,
    labelsets: string[],
    filters: string[],
  ): Promise<FacetCounts> {
    const wanted = filters
      .map((f) => /^\/classification\.labels\/([^/]+)\/(.+)$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ labelset: m[1]!, label: m[2]! }))
    const labelsOf = (item: CatalogItem, labelset: string): string[] =>
      labelset === 'kind'
        ? item.kind ? [item.kind] : []
        : labelset === 'format'
        ? item.format ? [item.format] : []
        : labelset === 'topic'
        ? item.topicIds
        : []
    const items = (await this.catalogItems(tenant)).filter((item) =>
      wanted.every((w) => labelsOf(item, w.labelset).includes(w.label))
    )
    const out: FacetCounts = {}
    for (const labelset of labelsets) {
      const counts: Record<string, number> = {}
      for (const item of items) {
        for (const label of labelsOf(item, labelset)) counts[label] = (counts[label] ?? 0) + 1
      }
      out[labelset] = counts
    }
    return out
  }

  /** The extraction methods registered on the box, plus the platform default. */
  async listExtractionMethods(tenant: TenantConfig): Promise<ExtractionMethod[]> {
    const raw = await this.client(tenant).getJson<Record<string, RawStrategy>>(
      '/extract_strategies',
    )
    const methods: ExtractionMethod[] = [
      { id: 'default', name: 'Default', kind: 'default' },
    ]
    for (const [id, s] of Object.entries(raw ?? {})) methods.push(methodFromStrategy(id, s))
    return methods
  }

  /** Register an extraction method; returns it with the platform's id. */
  async registerExtractionMethod(
    tenant: TenantConfig,
    spec: Omit<ExtractionMethod, 'id'>,
  ): Promise<ExtractionMethod> {
    const id = await this.client(tenant).postJson<string>('/extract_strategies', strategyBody(spec))
    return { ...spec, id: typeof id === 'string' ? id : String(id) }
  }

  /**
   * What the platform extracted from a resource: text, paragraph count and
   * the number of markdown-table rows in it (the table-aware method writes
   * tables into the text as rows of `|` cells).
   */
  async resourceExtraction(
    tenant: TenantConfig,
    id: string,
  ): Promise<
    { status: string; text: string; chars: number; paragraphs: number; tableRows: number }
  > {
    const full = await this.client(tenant).getJson<{
      metadata?: { status?: string }
      data?: Record<
        string,
        Record<
          string,
          {
            extracted?: {
              text?: { text?: string }
              metadata?: { metadata?: { paragraphs?: unknown[] } }
            }
          }
        >
      >
    }>(`/resource/${id}?show=basic&show=extracted&extracted=text&extracted=metadata`)
    const texts: string[] = []
    let paragraphs = 0
    for (const [group, fields] of Object.entries(full.data ?? {})) {
      if (group === 'generics') continue
      for (const [fieldKey, field] of Object.entries(fields ?? {})) {
        // A generated summary field is not the document: the audit and the
        // evidence cards read the extraction to check claims against what
        // the paper says, and a DA summary would vouch for itself.
        if (isGeneratedField(fieldKey)) continue
        const t = field.extracted?.text?.text
        if (t) texts.push(t)
        paragraphs += field.extracted?.metadata?.metadata?.paragraphs?.length ?? 0
      }
    }
    const text = texts.join('\n\n')
    const tableRows =
      text.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
        .length
    return {
      status: full.metadata?.status ?? 'PENDING',
      text,
      chars: text.length,
      paragraphs,
      tableRows,
    }
  }

  async labelsets(tenant: TenantConfig): Promise<Labelset[]> {
    return Object.entries(await this.rawLabelsets(tenant)).map(([id, ls]) => {
      const labels = (ls.labels ?? []).filter((l) => Boolean(l.title))
      // The platform keeps each label's definition in its `text` field; only
      // labels that actually carry one contribute to the vocabulary reference.
      const definitions: Record<string, string> = {}
      for (const l of labels) {
        const text = l.text?.trim()
        if (l.title && text) definitions[l.title] = text
      }
      return {
        id,
        title: ls.title ?? id,
        multiple: ls.multiple ?? true,
        kind: (ls.kind ?? []).includes('PARAGRAPHS') ? 'PARAGRAPHS' as const : 'RESOURCES' as const,
        labels: labels.map((l) => l.title!),
        ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
      }
    })
  }

  /**
   * Label co-occurrence graph, the reference portal's model: primary labels
   * become weighted nodes; for each, the secondary facet counts WITHIN that
   * primary filter become edges. N+1 catalog calls, so primaries are capped.
   */
  async graphData(tenant: TenantConfig, primary: string, secondary: string): Promise<GraphData> {
    const [primaryCountsAll, labelsets] = await Promise.all([
      this.facets(tenant, [primary]),
      this.labelsets(tenant).catch(() => []),
    ])
    // Facet keys are label slugs. Some labelsets store real display titles
    // ("Investment Strategy"), others store the slug itself - only a mapping
    // that genuinely differs is a display title.
    const displayTitle = new Map<string, string>()
    for (const ls of labelsets) {
      for (const label of ls.labels) {
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (label !== slug) displayTitle.set(slug, label)
      }
    }
    // The organisation's acronym ("SWRI" from "Southern Waters Research
    // Institute") should stay uppercase in fallback titles.
    const acronym = tenant.branding.organisation
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      .map((w) => w[0])
      .join('')
      .toLowerCase()
    const pretty = (slug: string) =>
      displayTitle.get(slug) ??
        slug.split('-').map((w) =>
          w === acronym ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
        ).join(' ')
    const primaryCounts = primaryCountsAll[primary] ?? {}
    const primaries = Object.entries(primaryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
    const nodes: GraphData['nodes'] = primaries.map(([label, weight]) => ({
      id: `${primary}:${label}`,
      label: pretty(label),
      group: 'primary',
      weight,
    }))
    const edges: GraphData['edges'] = []
    const secondaryTotals = new Map<string, number>()
    for (const [label] of primaries) {
      const within = await this.facets(
        tenant,
        [secondary],
        [`/classification.labels/${primary}/${label}`],
      )
      for (const [secLabel, count] of Object.entries(within[secondary] ?? {})) {
        if (count <= 0) continue
        edges.push({
          source: `${primary}:${label}`,
          target: `${secondary}:${secLabel}`,
          weight: count,
        })
        secondaryTotals.set(secLabel, (secondaryTotals.get(secLabel) ?? 0) + count)
      }
    }
    for (const [label, weight] of secondaryTotals) {
      nodes.push({ id: `${secondary}:${label}`, label: pretty(label), group: 'secondary', weight })
    }
    return { primary, secondary, nodes, edges }
  }

  /**
   * Query-time structured generation. Citations must stay OFF here - the
   * platform 500s when citations and answer_json_schema are combined; sources
   * come from the retrieval event instead.
   *
   * `requireGrounding` gates fabrication on a thin or broken corpus.
   * Structured generation has no textual guardrail to detect the way `ask`
   * detects the platform's "not enough data to answer this." sentence - the
   * model only ever returns valid JSON, whether fabricated from background
   * knowledge or not. When set, retrieval hits are scored and calibrated the
   * same way `ask` scores its grounding sources (`bestParagraphMatch` +
   * `calibrateRelevance`, floored at `MIN_GENERATE_GROUNDING` - the same
   * floor `search` applies), and if nothing survives, the model's JSON is
   * discarded and `insufficientGrounding: true` is returned instead - the
   * structured-artefact equivalent of `ask`'s honest refusal. When grounding
   * is weak but present, `sources` is filtered to the surviving (real,
   * relevant) sources only, so a caller emitting per-item citations never
   * has anything below the floor to cite.
   *
   * Off by default: callers that don't produce user-facing factual
   * artefacts (sub-question decomposition, source verdicts, investigation
   * synthesis - which already grounds strictly on the researcher's own kept
   * evidence, corpus analysis) keep their existing behaviour unchanged.
   */
  /**
   * Stage 2 of intent routing: one short structured generation that names the
   * intent, a confidence and a rationale. One keyword hit is retrieved (the
   * platform will not generate on an empty context) so it costs one short
   * generation.
   * `citations` is never sent with `answer_json_schema` (docs/ARAG-DEV.md).
   */
  async classifyIntent(
    tenant: TenantConfig,
    query: string,
    opts: { model?: string; allowed?: string[] } = {},
  ): Promise<{ intent?: unknown; confidence?: unknown; rationale?: unknown }> {
    const intents = (tenant.intents ?? []).filter((i) =>
      !opts.allowed || opts.allowed.includes(i.id)
    )
    if (intents.length === 0) return {}
    const schema = {
      name: 'route_intent',
      description: 'Choose which retrieval intent a research question belongs to',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intent: { type: 'string', enum: intents.map((i) => i.id) },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['intent', 'confidence', 'rationale'],
      },
    }
    const menu = intents
      .map((i) => `- ${i.id}: ${i.description} Examples: ${i.examples.join('; ')}`)
      .join('\n')
    const prompt = `Classify this question into exactly one intent. Intents:\n${menu}\n\n` +
      `Question: ${query}\n\nReturn the intent id, a confidence between 0 and 1, and a one-sentence rationale.`
    const client = this.client(tenant)
    const res = await client.postStream('/ask', {
      query: prompt,
      features: ['keyword'],
      answer_json_schema: schema,
      show: ['basic'],
      // The platform refuses to generate with no retrieved context, so the
      // classifier keeps one cheap keyword hit rather than grounding on
      // nothing; the schema answer ignores it.
      top_k: 1,
      reranker: 'noop',
      ...(opts.model ? { generative_model: opts.model } : {}),
      max_tokens: 400,
    })
    let object: unknown = null
    for await (const line of ndjson(res)) {
      const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
      if (item?.type === 'answer_json') object = item.object ?? null
    }
    return (object && typeof object === 'object') ? object as Record<string, unknown> : {}
  }

  async askStructured(
    tenant: TenantConfig,
    schema: { name: string; description: string; parameters: unknown },
    query: string,
    opts: {
      requireGrounding?: boolean
      resourceId?: string
      model?: string
      /** System-prompt instructions for the generation (how to write, what to include). */
      instructions?: string
      /** Restrict retrieval to resources filed under any of these topics. */
      topicIds?: string[]
      /** Restrict retrieval to these resources (a briefing's chosen papers). */
      resourceIds?: string[]
      /**
       * Passages the application adds to the grounding context (a briefing's
       * section-filtered paragraphs and data-augmentation fields), beside
       * what retrieval finds. Plain text, trimmed to size by the caller.
       */
      extraContext?: string[]
      /** Paragraph budget for the platform's own retrieval, when the caller supplies the context. */
      topK?: number
    } = {},
  ): Promise<{
    object: unknown
    sources: ScoredResource[]
    insufficientGrounding: boolean
    /** Every retrieved passage per resource id - the grounding context the model wrote from. */
    passagesByResource: Record<string, string[]>
  }> {
    const client = this.client(tenant)
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    const res = await client.postStream('/ask', {
      query,
      features: ['keyword', 'semantic'],
      answer_json_schema: schema,
      show: ['basic', 'origin'],
      // Writing instructions ride the system prompt, never the query: the
      // query is also the retrieval text, and instructions in it drag
      // retrieval towards the instructions rather than the topic.
      ...(opts.instructions?.trim() ? { prompt: { system: opts.instructions.trim() } } : {}),
      // Scope generation to one resource (per-resource enrichment) - the same
      // resource_filters the per-document chat uses. Verified live: it grounds
      // the answer on exactly that resource.
      ...(opts.resourceId
        ? { resource_filters: [opts.resourceId] }
        : opts.resourceIds?.length
        ? { resource_filters: opts.resourceIds.slice(0, 40) }
        : {}),
      ...(opts.extraContext?.length
        ? { extra_context: opts.extraContext.filter((t) => t.trim().length > 0).slice(0, 12) }
        : {}),
      ...(opts.topK && opts.topK > 0 ? { top_k: Math.min(Math.floor(opts.topK), 100) } : {}),
      // A topic scope (an assessment on one knowledge area) keeps retrieval
      // to the resources filed under it, so an off-topic passage cannot seed
      // a question.
      ...(opts.topicIds?.length
        ? { filters: opts.topicIds.map((t) => `/classification.labels/topic/${t}`) }
        : {}),
      // Run a cheap, high-volume job (per-document openers) on the fast tier
      // instead of the box's default model. Omitted -> the box default.
      ...(opts.model ? { generative_model: opts.model } : {}),
      // The default cap triggers 412 "Error generating json: max_tokens" on
      // large payloads like comparison matrices.
      max_tokens: 4096,
    })
    let object: unknown = null
    let sources: ScoredResource[] = []
    const passagesByResource: Record<string, string[]> = {}
    for await (const line of ndjson(res)) {
      const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
      if (!item?.type) continue
      if (item.type === 'retrieval') {
        const results = item.results as {
          resources?: Record<
            string,
            RawResource & {
              fields?: Record<
                string,
                {
                  paragraphs?: Record<
                    string,
                    { score?: number; text?: string; position?: { page_number?: number } }
                  >
                }
              >
            }
          >
        } | undefined
        for (const [id, raw] of Object.entries(results?.resources ?? {})) {
          passagesByResource[id] = Object.values(raw.fields ?? {}).flatMap((field) =>
            Object.values(field.paragraphs ?? {}).flatMap((p) => p.text ? [p.text] : [])
          )
        }
        sources = Object.entries(results?.resources ?? {})
          .map(([id, raw]) => {
            const match = bestParagraphMatch(raw)
            return {
              ...(byId.get(id) ?? this.toSummary(id, raw)),
              relevance: Math.round(calibrateRelevance(match.best) * 100) / 100,
              citedCount: 0,
              matchedPassage: match.passage,
              ...(displayPage(match.page) ? { matchedPage: displayPage(match.page) } : {}),
              ...(match.reference ? { referenceChunk: true } : {}),
            }
          })
          .slice(0, 12)
      } else if (item.type === 'answer_json' && item.object !== undefined) {
        object = item.object
      }
    }
    const grounded = sources.filter((s) => s.relevance >= MIN_GENERATE_GROUNDING)
    if (opts.requireGrounding && grounded.length === 0) {
      return { object: null, sources: grounded, insufficientGrounding: true, passagesByResource }
    }
    if (object === null) {
      throw new Error('The platform returned no structured answer - try a narrower request')
    }
    return {
      object,
      sources: opts.requireGrounding ? grounded : sources,
      insufficientGrounding: false,
      passagesByResource,
    }
  }

  /** Replace a resource's classifications (used by corpus analysis). */
  async patchResourceClassifications(
    tenant: TenantConfig,
    resourceId: string,
    classifications: { labelset: string; label: string }[],
  ): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${resourceId}`, {
      usermetadata: { classifications },
    })
    this.invalidateCatalogue(tenant.slug)
  }

  /**
   * Create a labelset. Labels are plain titles or `{ title, text }` pairs -
   * `text` is the label's definition, written when given.
   */
  async createLabelset(
    tenant: TenantConfig,
    input: {
      id: string
      title: string
      multiple: boolean
      labels: (string | { title: string; text?: string })[]
      kind?: 'RESOURCES' | 'PARAGRAPHS'
    },
  ): Promise<void> {
    await this.client(tenant).postJson(`/labelset/${input.id}`, {
      title: input.title,
      color: '#556b5f',
      multiple: input.multiple,
      kind: [input.kind ?? 'RESOURCES'],
      labels: input.labels.map((label) =>
        typeof label === 'string'
          ? { title: label }
          : label.text === undefined
          ? { title: label.title }
          : { title: label.title, text: label.text }
      ),
    })
  }

  /**
   * Replace a labelset's title, cardinality, labels and per-label definitions
   * (the label's `text`). `POST /labelset/{id}` replaces the whole record, so
   * the existing `color` and `kind` are read first and carried over verbatim.
   */
  async updateLabelset(
    tenant: TenantConfig,
    input: {
      id: string
      title: string
      multiple: boolean
      labels: { title: string; text: string }[]
    },
  ): Promise<void> {
    const existing = (await this.rawLabelsets(tenant))[input.id]
    if (!existing) throw new Error(`Labelset '${input.id}' does not exist on this knowledge box`)
    await this.client(tenant).postJson(`/labelset/${input.id}`, {
      title: input.title,
      color: existing.color ?? '#556b5f',
      multiple: input.multiple,
      kind: existing.kind && existing.kind.length > 0 ? existing.kind : ['RESOURCES'],
      labels: input.labels.map((l) => ({ title: l.title, text: l.text })),
    })
  }

  // -------------------------------------------------------------------------
  // Data-augmentation agents (DA tasks on the data-plane host).
  // -------------------------------------------------------------------------

  /** The box's configured user-facing answer model. DA tasks must not inherit it. */
  async generativeModel(tenant: TenantConfig): Promise<string> {
    try {
      const cfg = await this.client(tenant).getJson<{ generative_model?: string }>(
        '/configuration',
      )
      return cfg.generative_model ?? ''
    } catch {
      return ''
    }
  }

  /** The independently configured cheap model that bulk DA tasks must pin. */
  async augmentationModel(_tenant: TenantConfig): Promise<string> {
    return this.augmentationModelId
  }

  async listAgents(tenant: TenantConfig): Promise<KbAgent[]> {
    const raw = await this.client(tenant).dpJson<Record<string, unknown>>('GET', '/tasks')
    const agents: KbAgent[] = []
    const collect = (entries: unknown) => {
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        const e = entry as {
          id?: string
          task?: { name?: string }
          parameters?: { name?: string }
        }
        const id = e.id
        if (!id || agents.some((a) => a.id === id)) continue
        agents.push({
          id,
          task: e.task?.name ?? 'unknown',
          title: e.parameters?.name ?? e.task?.name ?? id,
        })
      }
    }
    for (const value of Object.values(raw ?? {})) collect(value)
    return agents
  }

  /**
   * The configured agents with the parameters a rebuild needs to reproduce
   * them: task type, name, model, resource filter and the full operation
   * list. Read from the `configs` entries of the data-plane task listing.
   */
  async agentConfigs(tenant: TenantConfig): Promise<AgentConfig[]> {
    const raw = await this.client(tenant).dpJson<{
      configs?: {
        id?: string
        task?: string | { name?: string }
        parameters?: {
          name?: string
          on?: number
          llm?: { model?: string }
          filter?: unknown
          operations?: unknown[]
        }
        enabled?: boolean
      }[]
    }>('GET', '/tasks')
    const out: AgentConfig[] = []
    for (const config of raw.configs ?? []) {
      if (!config.id) continue
      const task = typeof config.task === 'string' ? config.task : config.task?.name
      out.push({
        id: config.id,
        task: task ?? 'unknown',
        title: config.parameters?.name ?? task ?? config.id,
        model: config.parameters?.llm?.model ?? '',
        on: config.parameters?.on,
        filter: config.parameters?.filter,
        operations: Array.isArray(config.parameters?.operations)
          ? config.parameters.operations
          : [],
        enabled: config.enabled ?? true,
      })
    }
    return out
  }

  /**
   * The live knowledge-graph strategy: entity types (NER definitions) and the
   * worked examples that teach relation extraction, read from the registered
   * llm-graph agent's own configuration.
   */
  async graphStrategy(tenant: TenantConfig): Promise<
    {
      taskId: string
      title: string
      ident: string
      entityDefs: { label: string; description?: string }[]
      examples: {
        text: string
        entities: { name: string; label: string }[]
        relations: { source: string; target: string; label: string }[]
      }[]
    } | null
  > {
    const raw = await this.client(tenant).dpJson<{
      configs?: {
        id?: string
        task?: string | { name?: string }
        parameters?: {
          name?: string
          operations?: {
            graph?: {
              ident?: string
              entity_defs?: { label?: string; description?: string }[]
              examples?: {
                text?: string
                entities?: { name?: string; label?: string }[]
                relations?: { source?: string; target?: string; label?: string }[]
              }[]
            }
          }[]
        }
      }[]
    }>('GET', '/tasks')
    for (const config of raw.configs ?? []) {
      const taskName = typeof config.task === 'string' ? config.task : config.task?.name
      if (taskName !== 'llm-graph') continue
      const graph = (config.parameters?.operations ?? []).find((op) => op.graph)?.graph
      if (!graph) continue
      return {
        taskId: config.id ?? '',
        title: config.parameters?.name ?? '',
        ident: graph.ident ?? 'kg1',
        entityDefs: (graph.entity_defs ?? []).map((d) => ({
          label: d.label ?? '',
          description: d.description,
        })).filter((d) => d.label),
        examples: (graph.examples ?? []).map((e) => ({
          text: e.text ?? '',
          entities: (e.entities ?? []).map((en) => ({
            name: en.name ?? '',
            label: en.label ?? '',
          })),
          relations: (e.relations ?? []).map((r) => ({
            source: r.source ?? '',
            target: r.target ?? '',
            label: r.label ?? '',
          })),
        })),
      }
    }
    return null
  }

  async startAgent(
    tenant: TenantConfig,
    input: {
      task: string
      title: string
      operations: unknown[]
      applyExisting: boolean
      model: string
      /**
       * The platform's resource filter (field types, whether agent-generated
       * fields are eligible, ...), passed through verbatim. Omitted for a new
       * agent; set when re-instantiating one so it keeps running on exactly
       * what it ran on before.
       */
      filter?: unknown
      /** The platform's `on` trigger; a re-instantiated agent keeps its own. */
      on?: number
      /**
       * What the agent is applied to: whole fields (resources), the default,
       * or individual text blocks (passages). The platform enum is
       * TEXT_BLOCK = 0, FIELD = 1.
       */
      scope?: 'field' | 'text_block'
    },
  ): Promise<void> {
    const parameters: Record<string, unknown> = {
      name: input.title,
      on: input.on ?? (input.scope === 'text_block' ? 0 : 1),
      operations: input.operations,
    }
    if (input.model) parameters.llm = { model: input.model }
    if (input.filter !== undefined) parameters.filter = input.filter
    await this.client(tenant).dpJson('POST', '/task/start', {
      name: input.task,
      parameters,
      apply: input.applyExisting ? 'ALL' : 'NEW',
      enabled: true,
    })
  }

  /** REMi answer-quality scores (0-5) for a generated answer. */
  async remi(
    tenant: TenantConfig,
    input: { question: string; answer: string; contexts: string[] },
  ): Promise<
    { answerRelevance: number | null; groundedness: number | null; contextRelevance: number | null }
  > {
    const raw = await this.client(tenant).postJson<{
      answer_relevance?: { score?: number } | null
      context_relevance?: (number | null)[] | null
      groundedness?: (number | null)[] | null
    }>('/predict/remi', {
      user_id: 'research-portal',
      question: input.question,
      answer: input.answer,
      contexts: input.contexts.slice(0, 20).map((c) => c.slice(0, 2000)),
    })
    const clean = (values?: (number | null)[] | null): number[] =>
      (values ?? []).filter((v): v is number => typeof v === 'number')
    // Context expansion pads retrieval with neighbouring/graph paragraphs, so
    // averages over ALL contexts under-report. Groundedness asks "is the
    // answer supported by the retrieved material" - the best supporting
    // context answers that (max). Context relevance reports the top five.
    const grounded = clean(raw.groundedness)
    const relevant = clean(raw.context_relevance).sort((a, b) => b - a).slice(0, 5)
    return {
      answerRelevance: raw.answer_relevance?.score ?? null,
      groundedness: grounded.length ? Math.max(...grounded) : null,
      contextRelevance: relevant.length
        ? Math.round((relevant.reduce((a, b) => a + b, 0) / relevant.length) * 10) / 10
        : null,
    }
  }

  /** The REAL extracted knowledge graph: entity-relation-entity paths. */
  async relationsGraph(
    tenant: TenantConfig,
    opts: { entity?: string; topK?: number; includeBuiltin?: boolean } = {},
  ): Promise<RelationsGraphResult> {
    const entity = opts.entity?.trim()
    const cacheKey = `${tenant.slug}|${entity?.toLowerCase() ?? ''}|${
      opts.includeBuiltin ? 'builtin' : 'agent'
    }|${opts.topK ?? ''}`
    const cached = this.graphCache.get(cacheKey)
    if (cached && Date.now() - cached.at < GRAPH_CACHE_TTL_MS) return cached.graph
    try {
      // By default, only agent-extracted relations - the built-in NER pipeline
      // floods the path index (PERSON/DATE/LOC) and would drown the curated
      // graph. With an entity, scope to that node's neighbourhood in either
      // direction. `includeBuiltin` is an explicit opt-in (surfaced as a
      // toggle in the Graph page) that drops the `generated` filter so the
      // raw NER output comes through too - the label-assignment and
      // resource-id exclusions below still apply either way.
      const generated = { prop: 'generated', by: 'data-augmentation' }
      const pathFilter = entity
        ? {
          prop: 'path',
          source: { value: entity, match: 'exact' },
          undirected: true,
        }
        : null
      // NOTE: the /graph endpoint 422s on a missing or empty ({}) query, so
      // "everything" must be an explicit { prop: 'path' } (verified live).
      const queries: unknown[] = []
      if (pathFilter) {
        queries.push(opts.includeBuiltin ? pathFilter : { and: [pathFilter, generated] })
      } else if (opts.includeBuiltin) queries.push({ prop: 'path' })
      else {
        // The generated index is larger than one page and the platform pages
        // it in no stable order, so a single page gave a different map on
        // every load (SCN1A and Dravet, then JME, then a drug-allergy paper).
        // Read one page per entity group plus the ungrouped page, and rank the
        // union by weight: the slice is then the same on every call until the
        // index itself changes.
        queries.push(generated)
        for (const group of await this.entityGroupNames(tenant)) {
          queries.push({ and: [{ prop: 'path', source: { group }, undirected: true }, generated] })
        }
      }
      const topK = Math.min(GRAPH_PAGE, opts.topK ?? GRAPH_PAGE)
      const client = this.client(tenant)
      const pages = await Promise.all(
        queries.map((query) =>
          client.postJson<{
            paths?: {
              source?: { value?: string; group?: string }
              relation?: { label?: string }
              destination?: { value?: string; group?: string }
            }[]
          }>('/graph', { top_k: topK, query })
        ),
      )
      const weight = new Map<string, { group: string; weight: number }>()
      const edges: { source: string; target: string; label: string }[] = []
      const seenEdge = new Set<string>()
      // The graph agent names groups inconsistently ("Program"/"Programs") -
      // canonicalise on a singular key, keeping the first spelling seen.
      const groupSpellings = new Map<string, string>()
      const canonicalGroup = (raw: string): string => {
        if (!raw) return raw
        const key = raw.toLowerCase().replace(/s$/, '')
        const existing = groupSpellings.get(key)
        if (existing) return existing
        groupSpellings.set(key, raw)
        return raw
      }
      for (const path of pages.flatMap((page) => page.paths ?? [])) {
        const s = path.source?.value
        const d = path.destination?.value
        if (!s || !d || s === d) continue
        const sg = path.source?.group ?? ''
        const dg = path.destination?.group ?? ''
        // Entity-entity relations only: skip built-in NER groups unless the
        // caller opted in. Label assignment paths (topic/... targets) and raw
        // resource-id nodes are excluded regardless of mode - never useful.
        if (!opts.includeBuiltin && (/^[A-Z0-9_]+$/.test(sg) || /^[A-Z0-9_]+$/.test(dg))) continue
        if (s.includes('/') || d.includes('/')) continue
        if (/^[0-9a-f]{32}$/.test(s) || /^[0-9a-f]{32}$/.test(d)) continue
        const label = path.relation?.label ?? 'related to'
        const key = `${s}|${label}|${d}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ source: s, target: d, label })
        for (const [value, group] of [[s, sg], [d, dg]] as const) {
          const canonical = canonicalGroup(group)
          const entry = weight.get(value) ?? { group: canonical, weight: 0 }
          entry.weight += 1
          if (canonical) entry.group = canonical
          weight.set(value, entry)
        }
      }
      // The agent extracts the same entity under several case spellings, each
      // with its own relations - merge them before the cut so the merged
      // weight is what earns a place.
      const deduped = dedupeEntityCase(
        [...weight.entries()].map(([id, v]) => ({ id, group: v.group, weight: v.weight })),
        edges,
      )
      // Table numbers, author strings, journals and case vignettes are not
      // entities; the Gene group must hold gene symbols. The entity a reader
      // asked for is always kept, whatever it looks like.
      // The raw NER opt-in is the reader asking for everything, so only the
      // agent-extracted graph is cleaned.
      const asked = entity?.toLowerCase()
      const clean = deduped.nodes.filter((n) =>
        opts.includeBuiltin || n.id.toLowerCase() === asked || keepEntity(n.id, n.group)
      )
      const cleanIds = new Set(clean.map((n) => n.id))
      const cleanEdges = deduped.edges.filter((e) =>
        cleanIds.has(e.source) && cleanIds.has(e.target)
      )
      const degree = new Map<string, number>()
      for (const e of cleanEdges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
      }
      // Weight, then degree, then name: a total order, so the slice is stable.
      const ranked = clean
        .filter((n) => (degree.get(n.id) ?? 0) > 0)
        .sort((a, b) =>
          b.weight - a.weight || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          a.id.localeCompare(b.id)
        )
      const nodes = entity ? ranked : sliceWithGroupFloor(ranked, GRAPH_SLICE, GRAPH_GROUP_FLOOR)
      const keep = new Set(nodes.map((n) => n.id))
      const graph = {
        nodes,
        edges: cleanEdges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      }
      this.graphCache.set(cacheKey, { at: Date.now(), graph })
      return graph
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  /** The custom entity groups on the box, by name - the graph reads one page per group. */
  private async entityGroupNames(tenant: TenantConfig): Promise<string[]> {
    return (await this.allEntityGroups(tenant)).map((g) => g.group)
  }

  /**
   * Every entity name the portal knows for prefix matching: the tenant's
   * configured lexicon plus the cleaned entity groups. Cached with the groups.
   */
  private async entityLexicon(tenant: TenantConfig): Promise<string[]> {
    const groups = await this.allEntityGroups(tenant)
    return dedupeNames([
      ...(tenant.entityTerms ?? []),
      ...groups.flatMap((g) => g.entities),
    ])
  }

  /** Grounded multi-resource summary via the box's summarize endpoint. */
  async summarize(
    tenant: TenantConfig,
    resourceIds: string[],
    kind: 'simple' | 'extended' = 'simple',
  ): Promise<string> {
    const raw = await this.client(tenant).postJson<{
      summary?: string
      resources?: Record<string, { summary?: string }>
    }>('/summarize', { resources: resourceIds.slice(0, 20), summary_kind: kind })
    if (raw.summary?.trim()) return raw.summary
    return Object.values(raw.resources ?? {})
      .map((r) => r.summary ?? '')
      .filter(Boolean)
      .join('\n\n')
  }

  /** The platform's rephrasing of a query; null when unchanged/unavailable. */
  async rephrase(tenant: TenantConfig, question: string): Promise<string | null> {
    try {
      const raw = await this.client(tenant).postJson<unknown>('/predict/rephrase', {
        question,
        user_id: 'research-portal',
      })
      const text = typeof raw === 'string'
        ? raw
        : (raw as { rephrased_query?: string; text?: string }).rephrased_query ??
          (raw as { text?: string }).text ?? ''
      // The predict endpoint appends a single status digit to the rephrased text.
      const cleaned = text.trim().replace(/[01]$/, '').trim().replace(/\?+$/, (m) => m.slice(0, 1))
      if (!cleaned || cleaned.toLowerCase() === question.trim().toLowerCase()) return null
      return cleaned
    } catch {
      return null
    }
  }

  /** Give the platform feedback on an answer (its learning loop). */
  async feedback(
    tenant: TenantConfig,
    input: { learningId: string; good: boolean; text?: string },
  ): Promise<void> {
    await this.client(tenant).postJson('/feedback', {
      ident: input.learningId,
      good: input.good,
      task: 'CHAT',
      ...(input.text ? { feedback: input.text } : {}),
    })
  }

  /** Remove a resource permanently (curation - e.g. replacing a corrupt ingest). */
  /** Retitle and tag a resource (used by the Extraction Lab to mark sandbox uploads). */
  async patchResourceMeta(
    tenant: TenantConfig,
    id: string,
    meta: { title?: string; tags?: string[] },
  ): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${id}`, {
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.tags ? { origin: { tags: meta.tags } } : {}),
    })
  }

  async deleteResource(tenant: TenantConfig, id: string): Promise<void> {
    await this.client(tenant).deleteJson(`/resource/${id}`)
    this.invalidateCatalogue(tenant.slug)
  }

  /** Show or hide a resource from searchers (draft/publish workflow). */
  async setResourceHidden(tenant: TenantConfig, id: string, hidden: boolean): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${id}`, { hidden })
    this.invalidateCatalogue(tenant.slug)
  }

  /**
   * Purge failed-crawl junk (bot-challenge pages, and error-status resources
   * that never got a title) - see `isPurgeEligible` for the exact,
   * deliberately conservative rule. Pages the ENTIRE catalogue (not the
   * health-scan's newest-slice sample), same page/max-page pattern as
   * `listResources`, so a box with thousands of resources is fully scanned.
   *
   * `dryRun` (the caller's default) never calls `deleteResource` - it only
   * reports what WOULD be deleted, so a caller can confirm scope before
   * committing. A real run deletes in bounded waves of
   * `PURGE_DELETE_CONCURRENCY` so the box is never hit with an unbounded
   * burst of parallel deletes; one resource's delete failing is logged and
   * counted but never aborts the rest of the run.
   */
  async purgeFailedResources(
    tenant: TenantConfig,
    opts: { dryRun: boolean },
  ): Promise<
    { scanned: number; eligible: number; deleted: number; failed: number; sampleTitles: string[] }
  > {
    const client = this.client(tenant)
    const candidates: { id: string; title: string }[] = []
    let scanned = 0
    for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
      const catalog = await client.getJson<{ resources?: Record<string, RawResource> }>(
        `/catalog?page_number=${page}&page_size=${CATALOG_PAGE_SIZE}&show=basic`,
      )
      const batch = Object.entries(catalog.resources ?? {})
      scanned += batch.length
      for (const [id, raw] of batch) {
        if (isPurgeEligible(raw)) {
          candidates.push({ id, title: (raw.title ?? '').trim() || '(untitled)' })
        }
      }
      if (batch.length < CATALOG_PAGE_SIZE) break
    }
    const sampleTitles = candidates.slice(0, PURGE_SAMPLE_SIZE).map((r) => `${r.title} (${r.id})`)

    if (opts.dryRun) {
      return { scanned, eligible: candidates.length, deleted: 0, failed: 0, sampleTitles }
    }

    let deleted = 0
    let failed = 0
    for (let start = 0; start < candidates.length; start += PURGE_DELETE_CONCURRENCY) {
      const wave = candidates.slice(start, start + PURGE_DELETE_CONCURRENCY)
      const results = await Promise.allSettled(
        wave.map((r) =>
          this.deleteResource(tenant, r.id).catch((err) => {
            throw new Error(
              `failed to delete "${r.title}" (${r.id}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          })
        ),
      )
      for (const result of results) {
        if (result.status === 'fulfilled') {
          deleted++
        } else {
          failed++
          console.error(`purgeFailedResources(${tenant.slug}):`, result.reason)
        }
      }
    }
    return { scanned, eligible: candidates.length, deleted, failed, sampleTitles }
  }

  /**
   * Corpus health: word count and extraction sanity for every resource, so
   * bot-challenge pages and empty extractions surface in Manage instead of
   * being cited as sources.
   */
  async corpusHealth(tenant: TenantConfig): Promise<{
    id: string
    title: string
    words: number
    status: 'ok' | 'thin' | 'challenge'
    hidden: boolean
  }[]> {
    const client = this.client(tenant)
    const all: Record<string, RawResource & { hidden?: boolean }> = {}
    for (let page = 0; page < 10; page++) {
      const catalog = await client.getJson<{
        resources?: Record<string, RawResource & { hidden?: boolean }>
      }>(`/catalog?page_number=${page}&page_size=100&show=basic`)
      const batch = catalog.resources ?? {}
      Object.assign(all, batch)
      if (Object.keys(batch).length < 100) break
    }
    const CHALLENGE =
      /(cloudflare|enable javascript and cookies|just a moment|performing security verification|ray id|checking your browser)/i
    // Reading every resource's extracted text is one request per document -
    // scan the newest slice and run it in bounded waves so a big corpus is
    // never hammered with thousands of parallel calls.
    const entries = Object.entries(all).slice(0, HEALTH_SCAN_LIMIT)
    const results: {
      id: string
      title: string
      words: number
      status: 'ok' | 'thin' | 'challenge'
      hidden: boolean
    }[] = []
    for (let start = 0; start < entries.length; start += HEALTH_SCAN_CONCURRENCY) {
      const wave = entries.slice(start, start + HEALTH_SCAN_CONCURRENCY)
      results.push(
        ...await Promise.all(wave.map(async ([id, meta]) => {
          try {
            const full = await client.getJson<{
              title?: string
              data?: Record<
                string,
                Record<string, { extracted?: { text?: { text?: string } } }>
              >
            }>(`/resource/${id}?show=extracted&extracted=text&show=basic`)
            const texts: string[] = []
            for (const fieldType of Object.values(full.data ?? {})) {
              for (const field of Object.values(fieldType ?? {})) {
                const text = field.extracted?.text?.text
                if (text) texts.push(text)
              }
            }
            const body = texts.join(' ')
            const words = body.trim() ? body.trim().split(/\s+/).length : 0
            const status = CHALLENGE.test(body.slice(0, 2500))
              ? 'challenge' as const
              : words < 120
              ? 'thin' as const
              : 'ok' as const
            return {
              id,
              title: full.title ?? meta.title ?? id,
              words,
              status,
              hidden: meta.hidden ?? false,
            }
          } catch {
            return {
              id,
              title: meta.title ?? id,
              words: 0,
              status: 'thin' as const,
              hidden: meta.hidden ?? false,
            }
          }
        })),
      )
    }
    return results.sort((a, b) =>
      (a.status === 'ok' ? 1 : 0) - (b.status === 'ok' ? 1 : 0) || b.words - a.words
    )
  }

  /**
   * Type-ahead: entity and title suggestions. The platform's `/suggest`
   * index alone is weak on short prefixes - it can rank author-name/
   * fragment noise over an obviously-relevant title (a query like "abal"
   * never surfacing "abalone"), so every candidate (platform or local) is
   * required to actually contain the query as a prefix or a whole word, and
   * results are backed by a lightweight prefix match over the corpus's own
   * (already-filtered, per isDisplayableResource) titles and the tenant's
   * topic labels when the platform index comes up short.
   */
  async typeahead(
    tenant: TenantConfig,
    query: string,
  ): Promise<{ entities: string[]; titles: string[] }> {
    const trimmed = query.trim()
    if (!trimmed) return { entities: [], titles: [] }
    const q = trimmed.toLowerCase()
    const matchesQuery = (value: string): boolean => {
      const v = value.toLowerCase()
      if (v.startsWith(q)) return true
      return v.split(/[^a-z0-9]+/).some((word) => word.length > 0 && word.startsWith(q))
    }

    const [resources, platform] = await Promise.all([
      this.listResources(tenant).catch(() => [] as ResourceSummary[]),
      this.client(tenant)
        .getJson<{
          entities?: { entities?: { value?: string }[] }
          paragraphs?: { results?: { rid?: string; field?: string; text?: string }[] }
        }>(`/suggest?query=${encodeURIComponent(trimmed)}&features=entities&features=paragraph`)
        .catch(() => ({ entities: undefined, paragraphs: undefined })),
    ])
    const displayableIds = new Set(resources.map((r) => r.id))

    // The graph agent occasionally extracts vague time/direction words as
    // entities - keep suggestions to substantive names that actually match
    // the query, dropping single-fragment noise unrelated to it.
    const NOISE =
      /^(recent|early|late|last|next|this|coming|current|previous)\b|^(north|south|east|west)$|^(january|february|march|april|may|june|july|august|september|october|november|december)\b|^\d{1,4}$/i
    // Platform suggestions plus a prefix match over the portal's own lexicon
    // (the configured terms and the cleaned entity groups): "kaina" reaches
    // "kainate" and "kainic acid" even when the platform offers only a rat.
    // Case variants ("Dravet", "dravet", "DRAVET") collapse onto one entry.
    const lexicon = await this.entityLexicon(tenant).catch(() => [] as string[])
    const candidates = [
      ...(platform.entities?.entities ?? []).map((e) => (e.value ?? '').trim()),
      ...lexicon,
    ].filter((v) =>
      v.length > 2 && !NOISE.test(v) && !v.includes('\n') && !isNoiseEntity(v) && matchesQuery(v)
    )
    const variants = new Map<string, string[]>()
    for (const v of candidates) {
      const key = v.replace(/\s+/g, ' ').toLowerCase()
      const list = variants.get(key)
      if (list) list.push(v)
      else variants.set(key, [v])
    }
    const startsWith = (v: string) => v.toLowerCase().startsWith(q) ? 0 : 1
    const entities = dedupeNames([...variants.values()].map((list) => preferredSpelling(list)))
      .sort((a, b) => startsWith(a) - startsWith(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, 6)

    const seen = new Set<string>()
    const titles: string[] = []
    for (const r of platform.paragraphs?.results ?? []) {
      if (r.field !== 'title' || !r.text || !r.rid || seen.has(r.rid)) continue
      // Drop hits on hidden/junk resources (error status, hash or
      // bot-challenge titles) and anything that doesn't actually match.
      if (!displayableIds.has(r.rid) || !matchesQuery(r.text)) continue
      seen.add(r.rid)
      titles.push(r.text)
      if (titles.length >= 5) break
    }

    // Local fallback/augmentation over real, displayable resource titles.
    if (titles.length < 5) {
      for (const r of resources) {
        if (seen.has(r.id) || titles.includes(r.title) || !matchesQuery(r.title)) continue
        seen.add(r.id)
        titles.push(r.title)
        if (titles.length >= 5) break
      }
    }
    // Known topic/entity terms - a query like "abal" should surface an
    // "Abalone" topic chip even when no title happens to start with it.
    if (entities.length < 6) {
      for (const topic of tenant.topics) {
        if (entities.includes(topic.label) || !matchesQuery(topic.label)) continue
        entities.push(topic.label)
        if (entities.length >= 6) break
      }
    }

    return { entities, titles }
  }

  /** Named search configurations on the box - the wiring for every surface. */
  async listSearchConfigs(tenant: TenantConfig): Promise<Record<string, unknown>> {
    try {
      return await this.client(tenant).getJson<Record<string, unknown>>('/search_configurations')
    } catch {
      return {}
    }
  }

  /**
   * Ensure the portal's named search configurations exist on the box - one per
   * surface, so retrieval behaviour is configured centrally rather than ad hoc.
   *
   * `reranker: 'predict'` on portal-search/portal-ask pins the platform's
   * cross-encoder reranking pass on the stored config too, not just the
   * request body `search`/`ask` already send it in - verified accepted here
   * (`docs/ARAG-DEV.md`'s reranker note; a bad value 422s with
   * `str-enum[RerankerName]` naming exactly `'predict'`/`'noop'`, and a
   * config created with it round-trips 201). Left off portal-typeahead,
   * which is keyword-only prefix matching for short partial queries - not
   * the kind of relevance ranking a semantic reranker is built for, and it
   * is on the typeahead hot path where the platform's own default already
   * applies with no extra round-trip cost from a stored field.
   *
   * DOCUMENTATION ISOLATION (the CENTRAL directive): the research configs
   * (portal-search / portal-ask) carry a stored `filter_expression` that
   * EXCLUDES the `documentation` label, and two doc-scoped configs
   * (portal-doc-search / portal-doc-ask) carry one that includes ONLY it. The
   * documentation surface selects the doc configs; every other surface uses
   * the research configs, so isolation is centrally managed rather than passed
   * per request. A server-side cross-check in `search`/`ask` (see
   * `isDocumentationResource`) is the authoritative safety net for the
   * platform's known weak `/ask` filtering.
   *
   * Idempotent: a config that already exists is PATCHed to the desired shape
   * (a plain POST 409s on an existing name and would leave a previously-stored
   * config without the new filter), so re-running this converges every config
   * - crucially, it back-fills the exclusion filter onto research configs that
   * were created before documentation isolation existed.
   */
  async ensureSearchConfigs(tenant: TenantConfig): Promise<string[]> {
    const client = this.client(tenant)
    const researchExclude = researchExcludeFilterExpression(tenant.searchExclude ?? [])
    const docOnly = docOnlyFilterExpression()
    const desired: Record<string, unknown> = {
      [SEARCH_CONFIG_RESEARCH_FIND]: {
        kind: 'find',
        config: {
          features: ['keyword', 'semantic'],
          top_k: 20,
          reranker: 'predict',
          filter_expression: researchExclude,
        },
      },
      [SEARCH_CONFIG_RESEARCH_ASK]: {
        kind: 'ask',
        config: {
          features: ['keyword', 'semantic'],
          citations: true,
          reranker: 'predict',
          filter_expression: researchExclude,
        },
      },
      [SEARCH_CONFIG_DOC_FIND]: {
        kind: 'find',
        config: {
          features: ['keyword', 'semantic'],
          top_k: 20,
          reranker: 'predict',
          filter_expression: docOnly,
        },
      },
      [SEARCH_CONFIG_DOC_ASK]: {
        kind: 'ask',
        config: {
          features: ['keyword', 'semantic'],
          citations: true,
          reranker: 'predict',
          filter_expression: docOnly,
        },
      },
      'portal-typeahead': {
        kind: 'find',
        config: { features: ['keyword'], top_k: 8 },
      },
      ...intentSearchConfigs(tenant),
    }
    const created: string[] = []
    for (const [name, body] of Object.entries(desired)) {
      try {
        await client.postJson(`/search_configurations/${name}`, body)
        created.push(name)
      } catch {
        // Already exists (or the shape was rejected). Converge it in place so a
        // pre-existing research config picks up the exclusion filter.
        try {
          await client.patchJson(`/search_configurations/${name}`, body)
          created.push(name)
        } catch {
          // Deployment rejects the shape entirely - not fatal; the server-side
          // cross-check still enforces isolation.
        }
      }
    }
    return created
  }

  /**
   * Ingest (or update) the in-app documentation into the knowledge box as
   * resources labelled `documentation`, so the Help section's scoped search and
   * assistant can retrieve them. Built as a clean admin action the orchestrator
   * runs once the box is free (it is back-pressured during a corpus reload), NOT
   * on the request path.
   *
   * Every page becomes one text resource carrying:
   *  - the `content-type/documentation` classification label (the primary
   *    isolation signal the stored filters key on),
   *  - a stable slug `doc-<pageId>` and origin `portal-doc:<pageId>` (the
   *    deterministic signals the server-side cross-check trusts),
   *  - the page rendered to Markdown as the field body.
   *
   * Idempotent by page id: a first run creates the resources; a re-run finds
   * each by slug and PATCHes it in place, so editing the docs and re-running
   * updates rather than duplicating. Honours the platform's ingestion
   * back-pressure with the same bounded retry as the other write paths.
   */
  async ingestDocumentation(
    tenant: TenantConfig,
    pages: DocPage[] = DOC_PAGES,
  ): Promise<{ created: string[]; updated: string[]; failed: { id: string; error: string }[] }> {
    const client = this.client(tenant)
    const created: string[] = []
    const updated: string[] = []
    const failed: { id: string; error: string }[] = []
    const classifications = [{ labelset: DOCUMENTATION_LABELSET, label: DOCUMENTATION_LABEL }]
    for (const page of pages) {
      const slug = docResourceSlug(page.id)
      const markdown = docPageToMarkdown(page)
      const createBody = {
        title: page.title,
        slug,
        icon: 'text/plain',
        origin: { url: docResourceOrigin(page.id) },
        texts: { body: { body: markdown, format: 'MARKDOWN' } },
        usermetadata: { classifications },
      }
      try {
        await withBackpressureRetry(() => client.postJson('/resources', createBody))
        created.push(page.id)
        continue
      } catch (err) {
        // A slug clash (or another write conflict) means the page already
        // exists - update it in place so ingestion is idempotent by page id.
        const status = err instanceof AragApiError ? err.status : 0
        const conflict = status === 409 || status === 419 || status === 422
        if (!conflict) {
          failed.push({ id: page.id, error: err instanceof Error ? err.message : 'create failed' })
          continue
        }
      }
      try {
        const existing = await client.getJson<{ id?: string; uuid?: string }>(`/slug/${slug}`)
        const id = existing.id ?? existing.uuid
        if (!id) throw new Error('could not resolve the existing documentation resource id')
        await withBackpressureRetry(() =>
          client.patchJson(`/resource/${id}`, {
            title: page.title,
            origin: { url: docResourceOrigin(page.id) },
            texts: { body: { body: markdown, format: 'MARKDOWN' } },
            usermetadata: { classifications },
          })
        )
        updated.push(page.id)
      } catch (err) {
        failed.push({ id: page.id, error: err instanceof Error ? err.message : 'update failed' })
      }
    }
    this.invalidateCatalogue(tenant.slug)
    return { created, updated, failed }
  }

  /** Entity groups the graph agent has extracted (native knowledge graph). */
  async entityGroups(
    tenant: TenantConfig,
  ): Promise<{ group: string; entities: string[] }[]> {
    const groups = await this.allEntityGroups(tenant)
    return groups.map((g) => ({ group: g.group, entities: g.entities.slice(0, 100) }))
  }

  private async allEntityGroups(
    tenant: TenantConfig,
  ): Promise<{ group: string; entities: string[] }[]> {
    const cached = this.entityGroupsCache.get(tenant.slug)
    if (cached && Date.now() - cached.at < GRAPH_CACHE_TTL_MS) return cached.groups
    try {
      const client = this.client(tenant)
      const raw = await client.getJson<{
        groups?: Record<string, { entities?: Record<string, unknown> }>
      }>('/entitiesgroups')
      // Only custom-created groups (from the box's own graph agents). The
      // platform's built-in NER groups use ALL-CAPS codes (ORG, LOC, DATE...)
      // and are excluded from the portal's graph views.
      const names = Object.keys(raw.groups ?? {})
        .filter((name) => !/^[A-Z0-9_]+$/.test(name))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 16)
      const out = await Promise.all(names.map(async (group) => {
        let inline = Object.keys(raw.groups?.[group]?.entities ?? {})
        if (inline.length === 0) {
          try {
            const detail = await client.getJson<{ entities?: Record<string, unknown> }>(
              `/entitiesgroup/${encodeURIComponent(group)}`,
            )
            inline = Object.keys(detail.entities ?? {})
          } catch {
            inline = []
          }
        }
        return { group, entities: cleanEntityNames(inline, group) }
      }))
      const groups = out.filter((g) => g.entities.length > 0)
      this.entityGroupsCache.set(tenant.slug, { at: Date.now(), groups })
      return groups
    } catch {
      return []
    }
  }

  /**
   * Remove an agent's configuration. The platform's `cleanup` flag would also
   * delete every field the agent generated; it is pinned off so removing or
   * re-instantiating an agent never touches data already on resources.
   */
  async deleteAgent(tenant: TenantConfig, id: string): Promise<void> {
    await this.client(tenant).dpJson('DELETE', `/task/${id}?cleanup=false`)
  }

  /** Typed full content of a resource for the detail view. */
  async resourceContent(tenant: TenantConfig, id: string): Promise<ResourceContent | null> {
    let raw: RawResource & {
      icon?: string
      origin?: { url?: string }
      summary?: string
      data?: Record<
        string,
        Record<string, {
          value?: { body?: string; file?: { content_type?: string } }
          extracted?: {
            text?: { text?: string }
            metadata?: {
              metadata?: {
                paragraphs?: { start?: number; end?: number; start_seconds?: number[] }[]
              }
            }
          }
        }>
      >
    }
    try {
      raw = await this.client(tenant).getJson(
        `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
      )
    } catch (err) {
      if (err instanceof AragApiError && err.status === 404) return null
      throw err
    }
    const icon = raw.icon ?? ''
    const texts: { fieldId: string; text: string }[] = []
    const files: { group: string; fieldId: string; contentType?: string }[] = []
    const transcript: { text: string; startSec?: number }[] = []
    for (const [group, fields] of Object.entries(raw.data ?? {})) {
      for (const [fieldId, field] of Object.entries(fields ?? {})) {
        // Prefer the authored body (a text field's original markdown, with its
        // real paragraph breaks and headings) over the platform's flattened
        // extracted text; fall back to extracted text for crawled links and
        // uploaded files, which have no authored body. See docs/ARAG-DEV.md on
        // the extracted text flattening markdown line breaks into whitespace.
        const text = field.value?.body ?? field.extracted?.text?.text ?? ''
        if (text.trim()) texts.push({ fieldId: `${group}/${fieldId}`, text })
        // Detect a downloadable file field by the presence of a stored file
        // value, not by the group name alone - the file-proxy route
        // (`/resource/{id}/file/{fieldId}/download/field`) resolves the bare
        // field id regardless of which data group it lives under.
        if (field.value?.file) {
          files.push({ group, fieldId, contentType: field.value.file.content_type })
        }
        const paragraphs = field.extracted?.metadata?.metadata?.paragraphs ?? []
        for (const p of paragraphs) {
          const startSec = Array.isArray(p.start_seconds) ? p.start_seconds[0] : undefined
          if (startSec === undefined) continue
          const chunk = text.slice(p.start ?? 0, p.end ?? 0).trim()
          if (chunk) transcript.push({ text: chunk, startSec })
        }
      }
    }
    const originUrl = raw.origin?.url
    const kind: ResourceContent['kind'] = detectContentKind({
      icon,
      isLink: Boolean(originUrl) && Object.keys(raw.data?.links ?? {}).length > 0,
      fileMimes: files.map((f) => f.contentType ?? ''),
    })
    const primaryFile = files[0]
    const preview = kind === 'office' ? selectPreviewFile(files, primaryFile?.fieldId) : undefined
    // The platform DA page-summary agent already wrote a real per-resource
    // summary (field `da-pagesummary-f-*`) at ingest - reuse it as the
    // merchandised summary source before any richer enrichment is generated.
    const pageSummary = extractPageSummary(texts)
    const rawSummary = raw.summary ||
      (raw.extra?.metadata as { summary?: string } | undefined)?.summary
    const safe = displayTitle(raw.title, id)
    const rawTitle = safe === 'Untitled resource' ? '' : (raw.title ?? '')
    const merch = baselineMerchandising(rawTitle, pageSummary || rawSummary)
    return {
      id,
      title: merch.title,
      kind,
      originUrl,
      summary: merch.summary,
      ...(pageSummary ? { pageSummary } : {}),
      ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
      texts,
      transcript,
      files,
      enriched: false,
      ...(preview ? { preview } : {}),
    }
  }

  /** Stream the platform-generated thumbnail for a resource, if any. */
  async thumbnailResponse(tenant: TenantConfig, id: string): Promise<Response | null> {
    const client = this.client(tenant)
    let raw: { thumbnail?: string }
    try {
      raw = await client.getJson<{ thumbnail?: string }>(`/resource/${id}?show=basic`)
    } catch {
      return null
    }
    const thumb = raw.thumbnail
    if (!thumb) return null
    // The platform returns a path like /kb/<id>/resource/<rid>/... - strip the
    // kb prefix since our client base already ends at /kb/<id>.
    const path = thumb.replace(/^\/kb\/[^/]+/, '')
    if (!path.startsWith('/')) return null
    try {
      return await client.fileResponse(path)
    } catch {
      return null
    }
  }

  /** Proxy a stored file field (range-aware) for inline rendering. */
  fileStream(tenant: TenantConfig, id: string, fieldId: string, range?: string) {
    return this.client(tenant).fileResponse(
      `/resource/${id}/file/${fieldId}/download/field`,
      range,
    )
  }

  async *ask(
    tenant: TenantConfig,
    query: string,
    opts: AskOptions = {},
  ): AsyncIterable<AskEvent> {
    const client = this.client(tenant)
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }

    // A retrieved resource is kept only if its documentation membership matches
    // the requested scope: the Help assistant (docScope) keeps ONLY
    // documentation; the research assistant DROPS any documentation that leaked
    // through the platform's known weak `/ask` filtering (docs/ARAG-DEV.md). The
    // stored config carries the label filter; this is the authoritative
    // cross-check that guarantees isolation regardless.
    const inScope = (raw: { slug?: string; origin?: { url?: string } } & RawResource): boolean =>
      isDocumentationResource(raw) === Boolean(opts.docScope)
    // Ids that passed the cross-check this attempt, and whether any excluded
    // resource appeared in the grounding set - the withhold decision below
    // refuses an answer grounded ONLY in excluded content.
    const validSourceIds = new Set<string>()
    // Ids POSITIVELY known to be out of scope: they appeared in a retrieval
    // item and failed `inScope`. Tracked separately from "not in
    // validSourceIds" because those are not the same thing - see
    // `citable` below.
    const excludedSourceIds = new Set<string>()
    let excludedGroundingSeen = false

    const intent = opts.intent && !opts.docScope
      ? tenant.intents?.find((i) => i.id === opts.intent && i.answer.surfaces.includes('ask'))
      : undefined
    const body: Record<string, unknown> = {
      query,
      features: ['keyword', 'semantic'],
      citations: true,
      show: ['basic', 'origin'],
      // A sandbox box (the Extraction Lab) has none of the portal's stored
      // configurations - naming one 400s "Search configuration not found" -
      // and its single scoped document must ground the answer whatever its
      // retrieval score, so no configuration and no score floor are sent.
      ...(opts.sandbox ? { min_score: { semantic: 0, bm25: 0 } } : {
        search_configuration: opts.docScope
          ? SEARCH_CONFIG_DOC_ASK
          : intent
          ? intentConfigurationName(tenant, intent.id, 'ask')
          : SEARCH_CONFIG_RESEARCH_ASK,
      }),
      // Cross-encoder reranking of the grounding candidates - verified live
      // (see the reranker note in docs/ARAG-DEV.md and search()'s comment
      // above). Pinned defensively: it is already the platform's default
      // when omitted, so this guards against that default changing rather
      // than being a new capability. Shed on a pre-emission 4xx below, same
      // as rag_strategies/search_configuration/rag_images_strategies.
      reranker: 'predict',
      // Nuclia's default RAG prompt answers "Not enough data to answer this."
      // as a guardrail even when relevant sources were retrieved - override it.
      prompt: {
        system: variantPreamble(intent?.answer.promptVariant) + (opts.systemPrompt?.trim() ||
          (opts.docScope
            ? `You are the help assistant for the ${tenant.branding.productName} research ` +
              'portal. Answer the user\'s "how do I..." question about using the portal, using ' +
              'ONLY the provided help documentation as your source. Be clear, concise and ' +
              'practical, in Australian English, and write well-structured Markdown. Cite the ' +
              'documentation at claim level with a bracketed marker like [1] after each step or ' +
              'fact - the application assigns the real citation numbers itself. If the ' +
              'documentation does not cover the question, say so plainly and suggest where in the ' +
              'portal to look; never invent a feature that is not described in the documentation. ' +
              'Call the material "the documentation" or "the Help pages", never "the context" ' +
              'or "the provided context" - a reader never sees a context. Never write "Not ' +
              'enough data to answer this": when the documentation does not describe something, ' +
              'say that in plain words and name the nearest feature it does describe.'
            : `You are a research analyst for ${tenant.branding.organisation}. Always answer the ` +
              'question using the provided context. Synthesise across sources even when the ' +
              'context is partial - surface what IS known and be specific. Never reply that there ' +
              'is not enough data, and never refuse, when any relevant context is present. For any ' +
              "part of the question the context does not address, say plainly that the portal's " +
              'sources do not cover it rather than answering that part from general knowledge. Write ' +
              'clear, well-structured prose with Markdown, in Australian English. Cite evidence ' +
              'at claim level: after each factual claim, add a bracketed marker like [1] to show ' +
              'a citation belongs there. The number itself does not matter and does not need to ' +
              'be in any particular order - this application assigns the real, correctly-bound ' +
              "citation numbers itself from the platform's own source attribution, independently " +
              'of whatever you write here. If a statement is your inference rather than something ' +
              'the context states, mark it (inference). When the context ' +
              'contains conflicting, negative or nuanced findings (adverse observations, ' +
              'non-detections, disagreements between studies), state them explicitly with their ' +
              'specifics - a researcher needs the tension, never a smoothed summary. Refer to the ' +
              'material as "the cited sources", never as "the context"; a reader never sees the ' +
              'context, only the sources. Never write "Not enough data to answer this".')) +
          (opts.promptAddendum?.trim() ? `\n\n${opts.promptAddendum.trim()}` : ''),
      },
    }
    if (opts.extraContext && opts.extraContext.length > 0) {
      body.extra_context = opts.extraContext.filter((t) => t.trim().length > 0).slice(0, 12)
    }
    if (intent) {
      // The stored configuration's features win over the request's; never
      // send both (docs/ARAG-DEV.md).
      delete body.features
      body.reranker = intent.retrieval.reranker
    }
    if (opts.context && opts.context.length > 0) {
      // The app models turns as USER/AGENT; this deployment's /ask context
      // enum is NUCLIA | USER (422 otherwise) - translate at the boundary.
      body.context = opts.context.map((turn) => ({
        author: turn.author === 'AGENT' ? 'NUCLIA' : 'USER',
        text: turn.text,
      }))
    }
    if (opts.resourceId) body.resource_filters = [opts.resourceId]
    else if (opts.resourceIds && opts.resourceIds.length > 0) {
      // An author's papers: the platform's resource filter takes a list.
      body.resource_filters = opts.resourceIds.slice(0, 80)
    }
    if (opts.topicIds && opts.topicIds.length > 0) {
      body.filters = opts.topicIds.map((t) => `/classification.labels/topic/${t}`)
    }
    // Agentic retrieval upgrades: widen grounding windows around each hit and
    // walk the knowledge graph from entities detected in the query (uses the
    // box's graph extraction agent). Degrades gracefully if unsupported.
    const depth = intent?.answer.depth === 'deep' ? 'deep' : opts.depth
    let strategies: Record<string, unknown>[] = opts.lean
      // A reformatting turn's material is in extra_context; retrieval
      // only has to bind citations, so no expansion and no walk (D5-05).
      ? []
      : opts.light
      // A terse question: one neighbour each side, no graph walk.
      ? [{ name: 'neighbouring_paragraphs', before: 1, after: 1 }]
      : intent
      ? intentStrategies(intent)
      : depth === 'deep'
      ? [{ name: 'full_resource' }]
      : [
        { name: 'neighbouring_paragraphs', before: 2, after: 2 },
        { name: 'graph_beta', hops: 2, agentic_graph_only: true },
      ]
    if (opts.lean) body.reranker = 'noop'
    if (opts.topK && opts.topK > 0) {
      // A request-level paragraph budget wins over the stored
      // configuration's (verified for /find; the author-scoped review
      // needs more than twenty paragraphs across forty papers). Whole
      // resources and a wide budget do not fit one context, so the full
      // text strategy gives way to neighbouring paragraphs.
      body.top_k = Math.min(Math.floor(opts.topK), 100)
      if (strategies.some((st) => st.name === 'full_resource')) {
        strategies = [
          { name: 'neighbouring_paragraphs', before: 1, after: 1 },
          ...strategies.filter((st) => st.name !== 'full_resource'),
        ]
      }
    }
    const prequeries = groundingPrequeries(query, {
      pinnedResourceIds: opts.pinnedResourceIds,
      pinnedQueries: opts.pinnedQueries,
      scopedQueries: opts.scopedQueries,
      prefer: intent?.retrieval.prefer,
      prequeries: opts.prequeries,
      priorResourceIds: opts.priorResourceIds,
      // A Help prequery is a full find request of its own: it carries the
      // documentation-only filter, or it would read the research corpus.
      ...(opts.docScope ? { filterExpression: docOnlyFilterExpression() } : {}),
    })
    if (prequeries.length > 0) strategies.push({ name: 'prequeries', queries: prequeries })
    body.rag_strategies = strategies
    if (opts.images) {
      body.rag_images_strategies = [{ name: 'page_image' }, { name: 'tables' }]
    }
    // A table over three studies needs more than the default generation
    // budget, or its last row is cut (D4-06).
    if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = Math.min(opts.maxTokens, 4096)

    let sources: ScoredResource[] = []
    const contextTexts: string[] = []
    let fullAnswer = ''
    let refusalPossible = true
    let generating = false
    let emitted = false
    // The start of a marker the next chunk completes, held back from the
    // provisional text (see splitPartialMarker).
    let heldTail = ''
    // See MIN_REFUSAL_OVERRIDE_RELEVANCE: at most one retry when the model
    // refuses despite a genuinely relevant retrieved source - never more,
    // so a true out-of-corpus question (no strong source to trigger it)
    // refuses exactly as before.
    let refusalRetried = false
    // Raw citations-map entries accumulate across every `citations` NDJSON
    // item (the platform can stream them progressively). Binding only runs
    // once, on the complete map against the complete answer text - see
    // `spliceCitationMarkers` for why: offsets are only meaningful once both
    // are final.
    let citationsMapAccum: Record<string, unknown> = {}

    const toSources = (
      retrieved: Record<
        string,
        RawResource & {
          fields?: Record<
            string,
            { paragraphs?: Record<string, { score?: number; text?: string }> }
          >
        }
      >,
    ): ScoredResource[] =>
      Object.entries(retrieved).map(([id, raw]) => {
        let best = 0
        let passage: string | undefined
        let page: number | undefined
        let matchedField: 'body' | 'summary' = 'body'
        // The best paragraph that is not a reference-list chunk: papers in
        // one group cite each other, so an author-scoped question's top hit
        // in a paper is often its bibliography. A paper with any body hit
        // shows that hit and is never a reference hit (D1-05).
        let bodyBest = -1
        let bodyPassage: string | undefined
        let bodyPage: number | undefined
        let bodyField: 'body' | 'summary' = 'body'
        // Every body paragraph retrieval returned, best first: the evidence
        // card chooses among them for the paragraph that carries the claim.
        const paged: { score: number; text: string; page?: number }[] = []
        for (const [fieldKey, field] of Object.entries(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            if (paragraph.text) contextTexts.push(paragraph.text)
            const paragraphPage = displayPage(
              (paragraph as { position?: { page_number?: number } }).position?.page_number,
            )
            if (
              paragraph.text && !isGeneratedField(fieldKey) &&
              !looksLikeDeclarationsChunk(paragraph.text)
            ) {
              paged.push({
                score: paragraph.score ?? 0,
                text: paragraph.text.slice(0, 2000),
                ...(paragraphPage ? { page: paragraphPage } : {}),
              })
            }
            const score = paragraph.score ?? 0
            if (score >= best) {
              best = score
              passage = paragraph.text ?? passage
              page = (paragraph as { position?: { page_number?: number } }).position?.page_number
              matchedField = isGeneratedField(fieldKey) ? 'summary' : 'body'
            }
            if (paragraph.text && score >= bodyBest && !isNonEvidenceChunk(paragraph.text)) {
              bodyBest = score
              bodyPassage = paragraph.text
              bodyPage = (paragraph as { position?: { page_number?: number } }).position
                ?.page_number
              bodyField = isGeneratedField(fieldKey) ? 'summary' : 'body'
            }
          }
        }
        let swapped = false
        if (passage !== undefined && bodyPassage !== undefined && isNonEvidenceChunk(passage)) {
          passage = bodyPassage
          page = bodyPage
          matchedField = bodyField
          swapped = true
        }
        const reference = passage ? isNonEvidenceChunk(passage) : false
        const shown = reference ? best * 0.4 : swapped ? bodyBest : best
        const passages = paged
          .sort((a, b) => b.score - a.score)
          .slice(0, 12)
          .map(({ text, page }) => ({ text, ...(page ? { page } : {}) }))
        return {
          ...(byId.get(id) ?? this.toSummary(id, raw)),
          // Same calibration as search: semantic scores pass through, BM25
          // squashes - a weak grounding source must LOOK weak.
          relevance: Math.round((shown <= 1 ? Math.max(0, shown) : shown / (shown + 2)) * 100) /
            100,
          citedCount: 0,
          matchedPassage: passage,
          ...(displayPage(page) ? { matchedPage: displayPage(page) } : {}),
          ...(passages.length > 0 ? { passages } : {}),
          ...(reference ? { referenceChunk: true } : {}),
          ...(passage ? { matchedField } : {}),
        }
      })

    // Transient 412/5xx "unknown generative exception" happens before any text
    // streams; retry up to 3 times then, but never after output has started.
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A retried attempt starts clean - no half-accumulated answer, contexts
      // or citations from the failed one.
      if (attempt > 1) {
        sources = []
        contextTexts.length = 0
        fullAnswer = ''
        refusalPossible = true
        generating = false
        heldTail = ''
        citationsMapAccum = {}
        validSourceIds.clear()
        excludedSourceIds.clear()
        excludedGroundingSeen = false
      }
      try {
        const res = await client.postStream('/ask', body, { 'x-show-consumption': 'true' })
        const learningId = res.headers.get('nuclia-learning-id')
        if (learningId) yield { type: 'learning', id: learningId }
        for await (const line of ndjson(res)) {
          const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
          if (!item?.type) continue
          if (item.type === 'retrieval') {
            const results = item.results as {
              resources?: Record<string, RawResource & { slug?: string; origin?: { url?: string } }>
            } | undefined
            // Documentation cross-check: keep only resources whose scope
            // matches (see `inScope`). Excluded resources never reach the
            // sources, the grounding context or the citations, and their
            // presence flags a potential isolation breach for the withhold
            // decision below.
            const kept: Record<string, RawResource> = {}
            for (const [id, raw] of Object.entries(results?.resources ?? {})) {
              if (inScope(raw)) {
                kept[id] = raw
                validSourceIds.add(id)
              } else {
                excludedGroundingSeen = true
                excludedSourceIds.add(id)
              }
            }
            sources = shapeSourcesForIntent(toSources(kept), intent)
            yield { type: 'sources', resources: sources }
            if (!generating) {
              generating = true
              yield { type: 'stage', stage: 'retrieval', status: 'completed' }
              yield { type: 'stage', stage: 'generating', status: 'started' }
            }
          } else if (item.type === 'answer' && typeof item.text === 'string') {
            if (!generating) {
              generating = true
              yield { type: 'stage', stage: 'retrieval', status: 'completed' }
              yield { type: 'stage', stage: 'generating', status: 'started' }
            }
            fullAnswer += item.text
            // Hold back the platform's bare guardrail refusal: buffer while
            // the answer is still a prefix of it, and swap in honest guidance
            // if that is all the model produced.
            if (refusalPossible) {
              const lowered = fullAnswer.replace(/\s+/g, ' ').trim().toLowerCase()
              // Keep buffering while the text is still a prefix of the
              // guardrail sentence, or is the full sentence with only a few
              // trailing characters - but the moment real content follows it,
              // release everything (the model refused then kept going). This
              // is a display-only heuristic to avoid flashing the bare
              // guardrail sentence mid-stream; the authoritative refused/
              // done.text decision below always re-checks the COMPLETE
              // answer with `isGuardrailRefusal`, so a chunk boundary this
              // heuristic guesses wrong on can never leak the guardrail
              // sentence into the client as if it were a real answer (BUG 2).
              if (
                REFUSAL_TEXT.startsWith(lowered) ||
                (lowered.startsWith(REFUSAL_TEXT) && lowered.length <= REFUSAL_TEXT.length + 12)
              ) {
                continue
              }
              refusalPossible = false
              emitted = true
              // Transient display only: strip whatever bracket markers the
              // model has written so far so nothing wrongly-bound is ever
              // shown mid-stream. The authoritative, correctly-bound text
              // (spliced from the platform's own char-offsets) replaces this
              // once generation and citation binding both finish - see the
              // `done` event below. A marker split across chunks is held
              // back until the chunk that completes it (D2-14).
              const first = splitPartialMarker(fullAnswer)
              heldTail = first.hold
              yield { type: 'delta', text: stripInlineMarkers(first.emit) }
              continue
            }
            emitted = true
            const chunk = splitPartialMarker(heldTail + item.text)
            heldTail = chunk.hold
            const visible = stripInlineMarkers(chunk.emit)
            if (visible) yield { type: 'delta', text: visible }
          } else if (item.type === 'citations' && item.citations) {
            // Accumulate only - numbering and marker placement need the
            // complete map plus the complete answer text, computed once the
            // stream finishes (see spliceCitationMarkers below).
            citationsMapAccum = {
              ...citationsMapAccum,
              ...(item.citations as Record<string, unknown>),
            }
          } else if (item.type === 'metadata') {
            const tokens = item.tokens as { input?: number; output?: number } | undefined
            const timings = item.timings as
              | { generative_first_chunk?: number; generative_total?: number }
              | undefined
            if (tokens || timings) {
              yield {
                type: 'usage',
                inputTokens: tokens?.input ?? 0,
                outputTokens: tokens?.output ?? 0,
                firstChunkSec: timings?.generative_first_chunk,
                totalSec: timings?.generative_total,
              }
            }
          } else if (
            item.type === 'status' && typeof item.code === 'number' && item.code >= 400
          ) {
            yield { type: 'error', message: `Answer service returned status ${item.code}` }
            return
          }
        }
        // A configured ask that retrieved nothing looks exactly like an
        // off-corpus question - but a broken stored 'portal-ask' config
        // (seen live on admin-connected boxes) produces the same shape for
        // EVERY query. Nothing user-visible has streamed in that case, so
        // shed the named config once and ask again before accepting a
        // refusal. The deleted key cannot re-trigger this branch.
        if (
          sources.length === 0 && !emitted && body.search_configuration &&
          isGuardrailRefusal(fullAnswer) && attempt < MAX_ATTEMPTS
        ) {
          delete body.search_configuration
          continue
        }
        // Refusal-calibration fix: the model produced only the guardrail
        // sentence, but a genuinely relevant source WAS retrieved (above
        // MIN_REFUSAL_OVERRIDE_RELEVANCE) - this is the inconsistency a
        // rephrased question sails past. One retry with a firmer directive
        // before an honest refusal is accepted; never more than once, so a
        // true out-of-corpus question (nothing this relevant retrieved)
        // refuses exactly as before.
        if (
          isGuardrailRefusal(fullAnswer) && !refusalRetried && !opts.noRefusalRetry &&
          attempt < MAX_ATTEMPTS &&
          sources.some((s) => s.relevance >= MIN_REFUSAL_OVERRIDE_RELEVANCE)
        ) {
          refusalRetried = true
          const prompt = body.prompt as { system: string }
          body.prompt = {
            system: `${prompt.system} Relevant sources WERE retrieved for this exact question - ` +
              'you must not refuse or say there is not enough data; answer directly from the ' +
              'context provided.',
          }
          continue
        }
        // BUG 2/3: the guardrail refusal is detected against the COMPLETE
        // answer text via `isGuardrailRefusal` here - not the incremental
        // `refusalPossible` streaming heuristic above, which only decides
        // when to START showing delta text and can diverge from the final
        // text on an unlucky chunk boundary. This is the one place `refused`
        // and the reader-facing refusal message are decided, so `done.text`
        // (BUG 3) and the retry gates above always agree with it.
        if (heldTail && !isGuardrailRefusal(fullAnswer)) {
          const tail = stripInlineMarkers(heldTail)
          heldTail = ''
          if (tail) yield { type: 'delta', text: tail }
        }
        let refused = false
        let refusalMessage: string | undefined
        // Withhold an answer grounded ONLY in excluded content (docs/ARAG-DEV.md:
        // `/ask` honours the stored filter weakly). If every retrieved grounding
        // source failed the scope cross-check, the answer stands on content this
        // surface must not use - refuse rather than present it.
        const groundedOnlyOnExcluded = excludedGroundingSeen && validSourceIds.size === 0 &&
          fullAnswer.trim().length > 0
        if (isGuardrailRefusal(fullAnswer) || groundedOnlyOnExcluded) {
          // The model produced only the guardrail sentence, or grounded solely
          // in out-of-scope content - replace it with guidance the reader can
          // act on, matched to the surface.
          refused = true
          fullAnswer = ''
          refusalMessage = opts.docScope
            ? 'The help documentation does not cover this yet. Try rephrasing your question, or ' +
              'browse the Help sections for the feature you are after.'
            : "This portal's content does not hold enough relevant material to answer this " +
              'confidently. Try rephrasing the question, narrowing it to a topic, or browsing ' +
              'the Library to see what it covers.'
          yield { type: 'delta', text: refusalMessage }
          // A refusal must never carry the sources/citations retrieved for
          // it - they did not ground an answer, so showing them beside "not
          // enough data" reads as contradictory evidence (BUG 2). The
          // `sources` event already streamed during retrieval, before this
          // was known to be a refusal - this corrective empty one supersedes
          // it; every client here replaces its source list on `sources`
          // rather than appending, so this reliably clears it.
          if (sources.length > 0) yield { type: 'sources', resources: [] }
        }
        // Deterministic citation binding: only runs once, here, against the
        // COMPLETE answer text and the COMPLETE accumulated citations map -
        // both are only meaningful once generation has finished. Emits the
        // canonical Citation[] (evidence table + click-through targets) and
        // the corrected answer text (model's own [n] markers stripped,
        // authoritative markers spliced at the platform's char-offsets) so
        // every rendering of a given citation index agrees by construction.
        let boundText: string | undefined
        if (!refused && fullAnswer.trim()) {
          // Scope cross-check, applied to the citations map BEFORE binding so
          // that numbering, in-text markers and citation events all derive
          // from one set. Filtering only at emit time (as this once did) let
          // spliceCitationMarkers number and splice a marker for a resource
          // whose event was then suppressed - a dead `[n]` the reader can
          // click and get nothing from, measured at 7.3% of all markers.
          //
          // "Not in validSourceIds" is NOT evidence of a breach: graph_beta
          // and full_resource grounding legitimately cite resources that never
          // appear in a `retrieval` item. Only drop a citation when something
          // positively says it is out of scope:
          //   - it was retrieved and failed `inScope`, or
          //   - (research scope) it is absent from the research catalogue,
          //     which listResources builds documentation-free and
          //     junk-free by construction, so membership IS a scope proof.
          // Under docScope the research catalogue proves nothing, so an
          // unretrieved id stays excluded rather than being guessed at.
          const citable = (resourceId: string): boolean => {
            if (validSourceIds.has(resourceId)) return true
            if (excludedSourceIds.has(resourceId)) return false
            return opts.docScope ? false : byId.has(resourceId)
          }
          const scopedCitations: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(citationsMapAccum)) {
            const resourceId = key.split('/')[0]
            if (resourceId && citable(resourceId)) scopedCitations[key] = value
          }
          const bound = spliceCitationMarkers(
            fullAnswer,
            scopedCitations,
            // Both branches already resolve through toSummary/displayTitle,
            // so this never surfaces a raw hash - but a resource id absent
            // from both (never retrieved as a scored source) still needs a
            // clean fallback rather than citations.ts's own last-resort
            // `?? resourceId`.
            (resourceId) =>
              byId.get(resourceId)?.title ?? sources.find((s) => s.id === resourceId)?.title ??
                'Untitled resource',
          )
          // No filtering here: `scopedCitations` already applied it, so every
          // marker in `bound.text` has an event by construction.
          for (const citation of bound.citations) yield { type: 'citation', citation }
          boundText = bound.text
        }
        yield { type: 'stage', stage: 'generating', status: 'completed' }
        // BUG 3: done.text always carries the final answer text, refusal
        // included - a client that reads done.text as canonical (replacing
        // its accumulated streamed text, as the delta contract intends)
        // must get the honest refusal message here too, not nothing.
        //
        // `done` goes out BEFORE the quality judge runs: the answer is
        // complete the moment the text and its citations are, and the REMi
        // scores follow as their own event. Holding `done` for the judge
        // was a flat 10 to 12 second "validating" tail on every answer
        // with the composer still locked. Consumers keep reading after
        // `done` for the trailing `quality` event.
        const doneText = refused ? refusalMessage : boundText
        // REMi trust signal: score the finished answer against the full
        // retrieved context. Best effort with a hard time cap - the answer is
        // never held hostage by the scorer. The request starts BEFORE `done`
        // goes out, so it runs alongside the consumer's own audit of the
        // answer rather than after it: awaited only once `done` has been
        // consumed, it adds the cap minus the audit's own time at most, not
        // a fixed tail on every answer (D2-17).
        let capTimer: ReturnType<typeof setTimeout> | undefined
        const qualityPending = fullAnswer.trim() && contextTexts.length > 0
          ? Promise.race([
            this.remi(tenant, {
              question: query,
              answer: fullAnswer,
              contexts: contextTexts,
            }),
            new Promise<null>((resolve) => {
              capTimer = setTimeout(() => resolve(null), REMI_CAP_MS)
            }),
          ]).catch(() => null)
          : null
        yield { type: 'done', refused, ...(doneText !== undefined ? { text: doneText } : {}) }
        yield { type: 'stage', stage: 'validating', status: 'started' }
        if (qualityPending) {
          const quality = await qualityPending
          clearTimeout(capTimer)
          if (quality) yield { type: 'quality', ...quality }
        }
        yield { type: 'stage', stage: 'validating', status: 'completed' }
        return
      } catch (err) {
        const status = err instanceof AragApiError ? err.status : 0
        // A 4xx before any output usually means an optional capability
        // (graph strategy, reranker) is unsupported here - shed it and go
        // again. MAX_ATTEMPTS still bounds the loop, so this and the
        // attempt-count retries below can't run indefinitely together.
        if (
          !emitted && status >= 400 && status < 500 &&
          (body.rag_strategies || body.search_configuration || body.rag_images_strategies ||
            body.reranker)
        ) {
          delete body.rag_strategies
          delete body.search_configuration
          delete body.rag_images_strategies
          delete body.reranker
          continue
        }
        const retryable = status === 412 || status >= 500
        if (!emitted && retryable && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
          continue
        }
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : 'The answer service is unavailable',
        }
        return
      }
    }
  }
}
