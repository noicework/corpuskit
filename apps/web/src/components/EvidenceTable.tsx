import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { type EvidenceVerdict } from '../api/client.ts'
import { assessCurrency } from '../lib/currency.ts'
import { citationHref, EvidenceDisclosure } from './AnswerStream.tsx'
import { SaveEvidenceButton } from './SaveEvidence.tsx'

// ---------------------------------------------------------------------------
// Evidence table - the persistent, scannable record of "what did we actually
// retrieve, and does it hold up" that sits under every answer. It replaces
// the Journey modal's per-source AI relevance judgement (good idea, but
// ephemeral - gone the moment the modal closes) with a static table anyone
// can scan without playing a walk-through, and a one-click "Save" straight
// into an investigation's evidence log.
//
// When the caller knows which sources the answer actually cited, it passes
// `citations` and the table partitions itself: cited sources first, each
// carrying the same bracketed [n] badge as the inline marker in the answer,
// then a quiet separator, then everything else that was retrieved but never
// used. Without `citations` the table renders one flat, unordered list (the
// "closest passages found" case under a refusal, where nothing was cited).
//
// The per-source AI verdict (Supports / Not relevant) and its one-line "why"
// are NOT generated here and are NOT produced on every answer: that judge
// call costs tokens, so it runs only when the reader opens "Journey through
// the context". This table is display-only - it shows verdicts the caller has
// already obtained (`verdicts`), a shimmer while a judgement is in flight
// (`judging`), and nothing at all in the verdict slot until one exists.
//
// PROGRESSIVE DISCLOSURE. Raw retrieved chunks are the bulkiest thing on the
// page and they were burying the prose they exist to support, so the table
// collapses by default behind a summary the reader can act on ("7 sources ·
// 3 cited · 1980-2010") and opens on their say-so. Even open, each passage is
// clamped to three lines with its own "Show more"; nothing is deleted, only
// deferred, and every row is one click away.
// ---------------------------------------------------------------------------

export interface EvidenceSource {
  id: string
  title: string
  /** The passage the retrieval matched, when known. Falls back to the title as the saved passage. */
  passage?: string
  /** Retrieval relevance in [0, 1], rendered as a percentage. */
  score?: number | null
  /** Page the matched passage sits on (PDFs), for open-at-page links. */
  matchedPage?: number
  /** True when the matched passage looks like a reference list or front matter. */
  referenceChunk?: boolean
  /** ISO publication date, when known - read only to date the collapsed summary's year span. */
  published?: string
  /**
   * The raw source name / project code (e.g. "1975-022-DLD.pdf"). Read only as
   * the fallback year for the collapsed summary, the way `CurrencyNote` does.
   */
  sourceName?: string
}

export interface EvidenceVerdictInfo {
  verdict: string
  /** One-line AI sentence on how this source relates to the question. */
  relevance: string
}

/** A citation as it appears in the answer text: `[index]` pointing at `resourceId`. */
export interface EvidenceCitation {
  index: number
  resourceId: string
}

const VERDICT_BADGE_CLASS: Record<string, string> = {
  supports: 'rp-badge-ok',
  partial: 'rp-badge-warn',
  contradicts: 'rp-badge-bad',
  'not-relevant': 'rp-badge-quiet',
}

const VERDICT_LABEL: Record<string, string> = {
  supports: 'Supports',
  partial: 'Partial',
  contradicts: 'Contradicts',
  'not-relevant': 'Not relevant',
}

function verdictBadgeClass(verdict: string): string {
  return VERDICT_BADGE_CLASS[verdict] ?? 'rp-badge-quiet'
}

function verdictLabel(verdict: string): string {
  return VERDICT_LABEL[verdict] ?? verdict
}

/**
 * The one-line, act-on-it summary of a collapsed evidence block - what the
 * reader needs to decide whether to open it, and nothing more:
 * "7 sources · 3 cited · 1980-2010".
 *
 * The year span comes from `assessCurrency`, so it uses the same
 * published -> project code -> title fallback as the recency line and simply
 * omits the span when no source carries a usable year rather than guessing.
 * Pure, so both the outer panel and the table header can render the same words.
 */
export function evidenceSummary(
  sources: readonly EvidenceSource[],
  citedCount?: number,
): string {
  const parts: string[] = []
  if (sources.length > 0) {
    parts.push(`${sources.length} retrieved`)
    if (citedCount !== undefined && citedCount > 0) parts.push(`${citedCount} cited`)
  } else if (citedCount !== undefined && citedCount > 0) {
    parts.push(`${citedCount} cited`)
  }

  const { span } = assessCurrency(sources)
  if (span) {
    parts.push(span.earliest === span.latest ? `${span.latest}` : `${span.earliest}-${span.latest}`)
  }

  return parts.join(' · ')
}

/** Appends `?page=<n>` (or `&page=<n>` alongside an existing `?passage=`) so the reader lands on the matched page. */
function withPage(href: string, page: number | undefined): string {
  if (page === undefined) return href
  return `${href}${href.includes('?') ? '&' : '?'}page=${page}`
}

/** One row: a retrieved source, its match strength, its AI verdict, and a save action. */
function EvidenceRow({
  slug,
  question,
  source,
  verdict,
  judging,
  verdictsKnown,
  citationIndices,
  citationsKnown,
  anchorId,
}: {
  slug: string
  question: string
  source: EvidenceSource
  verdict?: EvidenceVerdictInfo
  judging: boolean
  /** True once a judgement pass has run for this answer - gates the "Verdict unavailable" fallback. */
  verdictsKnown: boolean
  /** Inline `[n]` marker(s) in the answer that point at this source, in ascending order. */
  citationIndices: number[]
  /** Whether the caller supplied `citations` at all - without it "not cited" can't be claimed. */
  citationsKnown: boolean
  anchorId?: string
}) {
  const [expanded, setExpanded] = useState(false)
  // Whether the three-line clamp is actually hiding anything. Measured rather
  // than guessed from a character count: the same passage clamps on a 390px
  // phone and doesn't on a 27-inch monitor, and a length threshold would either
  // hide text with no way to reach it or offer a "Show more" that does nothing.
  const [isClamped, setIsClamped] = useState(false)
  const passageRef = useRef<HTMLParagraphElement | null>(null)
  const rowId = useId()
  const passageId = `${rowId}-passage`
  const passage = source.passage?.trim() || undefined
  const scorePct = typeof source.score === 'number' ? Math.round(source.score * 100) : null
  const isWeak = scorePct !== null && scorePct < 35
  const isCited = citationIndices.length > 0
  const href = withPage(citationHref(slug, source.id, passage), source.matchedPage)
  const showUnusedFlag = citationsKnown && !isCited && verdict?.verdict === 'supports'

  useEffect(() => {
    // Only the clamped state can be measured; while expanded there is nothing
    // overflowing, so the flag simply holds its last value and keeps the
    // "Show less" control on screen.
    const element = passageRef.current
    if (!element || expanded) return
    const measure = () => setIsClamped(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, passage])

  return (
    <div
      id={anchorId}
      className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'
    >
      <div className='flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5'>
        <div className='flex min-w-0 flex-1 items-start gap-1.5'>
          {isCited
            ? (
              <span className='mt-0.5 flex shrink-0 items-center gap-1'>
                {citationIndices.map((n) => (
                  <span
                    key={n}
                    className='inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold text-[var(--rp-on-accent)]'
                    style={{ backgroundColor: 'var(--rp-accent)' }}
                  >
                    {n}
                  </span>
                ))}
              </span>
            )
            : null}
          <Link
            to={href}
            className='rp-clamp-2 min-w-0 flex-1 text-sm font-medium text-ink underline-offset-2 hover:underline'
          >
            {source.title}
          </Link>
        </div>
        <div className='flex shrink-0 flex-wrap items-center gap-1.5'>
          {scorePct !== null
            ? <span className='text-xs tabular-nums text-ink-3'>{scorePct}%</span>
            : null}
          {source.referenceChunk
            ? <span className='text-[11px] text-ink-3'>reference list</span>
            : null}
          {isWeak ? <span className='rp-badge rp-badge-warn'>weak match</span> : null}
          {judging
            ? (
              <span
                className='rp-shimmer h-[18px] w-16 rounded-[var(--rp-radius)] bg-surface-3'
                aria-hidden='true'
              />
            )
            : verdict
            ? (
              <span className={`rp-badge ${verdictBadgeClass(verdict.verdict)}`}>
                {verdictLabel(verdict.verdict)}
              </span>
            )
            : verdictsKnown
            ? <span className='text-xs text-ink-3'>Verdict unavailable</span>
            : null}
        </div>
      </div>

      {showUnusedFlag
        ? (
          <p className='mt-1.5'>
            <span className='rp-badge rp-badge-warn'>
              Supporting evidence not used in the answer
            </span>
          </p>
        )
        : null}

      {passage
        ? (
          <div className='mt-1.5'>
            <p
              id={passageId}
              ref={passageRef}
              className={`text-xs leading-relaxed text-ink-2 ${expanded ? '' : 'rp-clamp-3'}`}
            >
              {passage}
            </p>
          </div>
        )
        : null}

      {judging
        ? (
          <div
            className='mt-1.5 h-3 w-3/4 rounded-[var(--rp-radius)] rp-shimmer bg-surface-3'
            aria-hidden='true'
          />
        )
        : verdict?.relevance
        ? <p className='mt-1.5 text-xs italic text-ink-3'>{verdict.relevance}</p>
        : null}

      {
        /* Show more and Save share a row. On a phone each row of chrome costs a
        * whole line of the screen, and a twelve-source list was spending one
        * per card on a control that sits happily beside the Save button. */
      }
      <div className='mt-2 flex items-center justify-between gap-2'>
        {isClamped
          ? (
            <button
              type='button'
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-controls={passageId}
              aria-label={expanded
                ? `Show less of the passage from ${source.title}`
                : `Show more of the passage from ${source.title}`}
              className='rp-focus rounded-[var(--rp-radius)] text-xs font-medium text-[var(--rp-accent-fg)] hover:underline'
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )
          : <span />}
        <SaveEvidenceButton
          slug={slug}
          compact
          evidence={{
            passage: passage || source.title,
            resourceId: source.id,
            resourceTitle: source.title,
            score: source.score ?? undefined,
            question,
            verdict: (verdict?.verdict as EvidenceVerdict | undefined) ?? undefined,
            aiRelevance: verdict?.relevance,
          }}
        />
      </div>
    </div>
  )
}

export interface EvidenceTableProps {
  slug: string
  question: string
  sources: EvidenceSource[]
  /**
   * Per-source AI verdicts, when they exist. Generated on demand by opening
   * "Journey through the context" (not on every answer), so the table renders
   * with no verdict column until the reader asks for one.
   */
  verdicts?: Record<string, EvidenceVerdictInfo>
  /** True while a judgement pass is in flight - rows show a shimmer in the verdict slot. */
  judging?: boolean
  /**
   * The disclosure's noun phrase, in lower case - defaults to `'evidence'`
   * ("Show evidence"), overridable for e.g. `'closest passages found'`.
   */
  title?: string
  /** The answer's inline `[n]` citations - when supplied, cited sources render first with a matching badge. */
  citations?: EvidenceCitation[]
  /** Prefix for each row's DOM id (`${anchorPrefix}-src-${resourceId}`), so a page can scroll to a row. */
  anchorPrefix?: string
  /**
   * Whether the table brings its own disclosure. On by default (collapsed):
   * the raw passages are the bulkiest thing on the page, so the reader opens
   * them deliberately.
   *
   * Pass `false` where the table already sits inside a panel the reader has
   * just opened - a second, near-identical control there would only make them
   * click twice for the same evidence and repeat the same summary line. The
   * rows then render under a plain section heading, and the enclosing panel
   * owns the collapse.
   */
  collapsible?: boolean
}

/**
 * Persistent, scannable record of every source behind an answer: title,
 * matched passage, retrieval score, and a one-click save into an
 * investigation. Static - nothing autoplays, and it never calls the AI judge
 * itself. The per-source verdict + "why" are token-costing, so they are
 * produced only when the reader opens "Journey through the context"; this
 * table just displays whatever `verdicts` the caller has obtained, a shimmer
 * per row while `judging`, and nothing in the verdict slot until then.
 *
 * Collapsed by default behind a summary the reader can act on ("7 sources ·
 * 3 cited · 1980-2010") so the raw passages never bury the answer above them.
 */
export function EvidenceTable({
  slug,
  question,
  sources,
  verdicts,
  judging = false,
  title = 'retrieved sources',
  citations,
  anchorPrefix,
  collapsible = true,
}: EvidenceTableProps) {
  const reactId = useId()
  const [open, setOpen] = useState(false)
  const knownVerdicts = verdicts ?? {}
  const verdictsKnown = Object.keys(knownVerdicts).length > 0

  if (sources.length === 0) return null

  // Partition into cited (ordered by their inline marker) and uncited, only
  // when the caller actually knows which sources were cited - otherwise
  // (e.g. the refusal path's "closest passages") every row renders in
  // retrieval order with no separator.
  const citationsBySource = new Map<string, number[]>()
  for (const citation of citations ?? []) {
    const list = citationsBySource.get(citation.resourceId)
    if (list) list.push(citation.index)
    else citationsBySource.set(citation.resourceId, [citation.index])
  }
  for (const list of citationsBySource.values()) list.sort((a, b) => a - b)

  const citationsKnown = citations !== undefined
  const citedSources = citationsKnown
    ? sources
      .filter((source) => citationsBySource.has(source.id))
      .sort((a, b) =>
        Math.min(...citationsBySource.get(a.id)!) - Math.min(...citationsBySource.get(b.id)!)
      )
    : sources
  const uncitedSources = citationsKnown
    ? sources.filter((source) => !citationsBySource.has(source.id))
    : []

  function renderRow(source: EvidenceSource) {
    return (
      <EvidenceRow
        key={source.id}
        slug={slug}
        question={question}
        source={source}
        verdict={knownVerdicts[source.id]}
        judging={judging && !knownVerdicts[source.id]}
        verdictsKnown={verdictsKnown}
        citationIndices={citationsBySource.get(source.id) ?? []}
        citationsKnown={citationsKnown}
        anchorId={anchorPrefix ? `${anchorPrefix}-src-${source.id}` : undefined}
      />
    )
  }

  const advisoryNote = verdictsKnown || judging
    ? (
      <p className='text-[11px] text-ink-3'>
        AI verdicts are advisory - open a source to judge for yourself.
      </p>
    )
    : null

  const rows = (
    <div className='space-y-2'>
      {citedSources.map(renderRow)}

      {uncitedSources.length > 0
        ? (
          <>
            <div className='flex items-center gap-2 pt-1' role='separator'>
              <span className='h-px flex-1' style={{ backgroundColor: 'var(--rp-line)' }} />
              <span className='shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink-3'>
                Retrieved, but not cited in the answer
              </span>
              <span className='h-px flex-1' style={{ backgroundColor: 'var(--rp-line)' }} />
            </div>
            {uncitedSources.map(renderRow)}
          </>
        )
        : null}
    </div>
  )

  // Inside a panel the reader has already opened, the enclosing disclosure owns
  // the collapse - so the table is a plain titled section rather than a second
  // control repeating the same words one line below the first.
  if (!collapsible) {
    return (
      <div>
        <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
          <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
            {title}: {sources.length}
          </h3>
          {advisoryNote}
        </div>
        <div className='mt-2'>{rows}</div>
      </div>
    )
  }

  return (
    <EvidenceDisclosure
      regionId={`${anchorPrefix ?? reactId}-evidence-rows`}
      open={open}
      onToggle={() => setOpen((prev) => !prev)}
      label={title}
      summary={evidenceSummary(sources, citationsKnown ? citedSources.length : undefined)}
      heading
    >
      {advisoryNote ? <div className='mb-2'>{advisoryNote}</div> : null}
      {rows}
    </EvidenceDisclosure>
  )
}
