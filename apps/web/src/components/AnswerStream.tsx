import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from './AccessProvider.tsx'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import { type AskRequest, streamAsk } from '../api/client.ts'
import { AnswerJourney } from './AnswerJourney.tsx'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { CurrencyNote } from './CurrencyNote.tsx'
import { type QualityScores, TrustSignals } from './QualityGauge.tsx'
import { type AnswerAudit, auditBadge } from '../lib/answer-marks.ts'
import { StageTimeline, statusesFor, useAnswerPhase } from './StageTimeline.tsx'
import { ChevronDown, Compass, RotateCcw, ShieldCheck } from './icons.tsx'
import { Button, IconButton } from './ui.tsx'

type Status = 'idle' | 'streaming' | 'done' | 'error'
type UsageEvent = Extract<AskEvent, { type: 'usage' }>

export interface AnswerStreamProps {
  slug: string
  request: AskRequest
  /**
   * Fires whenever the streamed answer's source list (or citation counts on
   * it) change, so a parent results list can show "Cited n" badges without
   * re-implementing the stream itself.
   */
  onSources?: (resources: ScoredResource[]) => void
  /** Optional hook fired when the reader retries a failed answer - the stream itself always retries the same request either way. */
  onRetry?: () => void
  /**
   * Opt-in, set only by a page that is already showing the single document
   * this answer was built from. The answer's meta block - the numbered source
   * chips, the "n cited" line, the currency note, the usage line, the quality
   * gauge and the journey through the context - exists to tell a reader which
   * documents an answer came from and how far to trust the spread of them.
   * On a page scoped to one document, all of it names the document already on
   * screen, so it is noise rather than evidence and is suppressed.
   *
   * Off by default: a whole-corpus caller keeps the full block.
   */
  scopedToResource?: boolean
  /**
   * Opt-in, called when the reader activates an inline `[n]` marker. Return
   * true to say the jump was handled in the page itself (the caller scrolled
   * its own reader to the passage) and the marker's navigation is suppressed;
   * return false to let the marker follow its deep link as usual. Absent, the
   * marker is a plain deep link.
   */
  onCitationJump?: (
    citation: Citation,
    passage: string | undefined,
    /** The page the marker's link opens at, when it names one. */
    page?: number,
  ) => boolean
}

/**
 * Deep link into the resource view for a citation, carrying the matched
 * passage (truncated) so the resource page can highlight/scroll to it. The
 * passage param is omitted entirely when there's no matched passage.
 */
export function citationHref(
  slug: string,
  resourceId: string,
  matchedPassage: string | undefined,
  /** The page the passage sits on, so the reader's PDF pane opens there too. */
  page?: number,
): string {
  const params: string[] = []
  if (matchedPassage) params.push(`passage=${encodeURIComponent(matchedPassage.slice(0, 300))}`)
  if (page && matchedPassage) params.push(`page=${page}`)
  return `/t/${slug}/library/${resourceId}${params.length > 0 ? `?${params.join('&')}` : ''}`
}

/**
 * Where a citation opens: the paragraph the answer cited and its page, when
 * the platform named that paragraph; otherwise the source's own matched
 * passage and page. Passage and page always come from one paragraph, so the
 * reader lands on a page that carries the highlight. A source matched only
 * on its generated summary has no place in the document to open at.
 */
export function citationTarget(
  citation: Citation,
  source: ScoredResource | undefined,
): { passage?: string; page?: number } {
  if (citation.passage) {
    return { passage: citation.passage, ...(citation.page ? { page: citation.page } : {}) }
  }
  if (!source?.matchedPassage || source.matchedField === 'summary') return {}
  return {
    passage: source.matchedPassage,
    ...(source.matchedPage ? { page: source.matchedPage } : {}),
  }
}

/** The deep link a citation opens, at its cited passage and page (see `citationTarget`). */
export function citationLink(
  slug: string,
  citation: Citation,
  source: ScoredResource | undefined,
): string {
  const target = citationTarget(citation, source)
  return citationHref(slug, citation.resourceId, target.passage, target.page)
}

/**
 * The model's own hedge, shown as a mark rather than as prose: a reader sees
 * a small "inference" flag with its meaning on hover and for screen readers,
 * never the literal "(inference)" the prompt asked the model to write.
 */
export function InferenceMark() {
  const { ui } = usePortalLocale()
  return (
    <sup
      className='ml-0.5 select-none rounded-[var(--rp-radius-chip)] px-1 text-2xs font-semibold uppercase tracking-wide text-ink-3'
      style={{ backgroundColor: 'var(--rp-surface-3)' }}
      title={ui("The model's own inference, not a statement in the cited sources")}
    >
      {ui('inference')}
    </sup>
  )
}

/**
 * The disclosure chevron: points right when closed, down when open. The
 * rotation is decoration, so it stops entirely under `prefers-reduced-motion`.
 */
function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size='sm'
      className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
        open ? '' : '-rotate-90'
      }`}
    />
  )
}

export interface EvidenceDisclosureProps {
  /** DOM id of the region this control shows and hides - the `aria-controls` target. */
  regionId: string
  open: boolean
  onToggle: () => void
  /**
   * The noun phrase for what is inside, in sentence case and lower case -
   * e.g. `'sources and evidence'`. Rendered as "Show ..." / "Hide ...".
   */
  label: string
  /**
   * The compact, act-on-it line - e.g. "7 sources · 3 cited · 1980-2010". Shown
   * in both states so a collapsed panel still says what it holds and whether it
   * is worth opening.
   */
  summary?: string
  /** Renders the control inside an `<h3>` so it keeps its place in the heading order. */
  heading?: boolean
  children: ReactNode
}

/**
 * The house progressive-disclosure control for the bulky end of an answer -
 * the retrieved passages, the pipeline detail, anything that would otherwise
 * bury the prose it is meant to support.
 *
 * A real `<button>` carrying `aria-expanded` + `aria-controls`, keyboard
 * reachable with a visible focus ring (`rp-focus`), and a chevron whose motion
 * stops under `prefers-reduced-motion`. The controlled region is always in the
 * DOM (hidden while closed) so `aria-controls` always resolves, while its
 * children mount only while open - a closed panel costs nothing to render.
 *
 * Nothing is lost by collapsing: the summary line carries the shape of what is
 * inside, and one click restores every row in full.
 */
export function EvidenceDisclosure({
  regionId,
  open,
  onToggle,
  label,
  summary,
  heading = false,
  children,
}: EvidenceDisclosureProps) {
  const { ui } = usePortalLocale()
  const control = (
    <Button
      variant='ghost'
      size='sm'
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={regionId}
      className='rp-answer-evidence-toggle w-full flex-wrap gap-x-2 gap-y-1 text-left'
    >
      <span className='flex min-w-0 items-center gap-1.5'>
        <DisclosureChevron open={open} />
        <span className='min-w-0'>
          {ui(open ? 'Hide {label}' : 'Show {label}', { label })}
        </span>
      </span>
      {summary
        ? (
          <span className='rounded-[var(--rp-radius-chip)] border border-line bg-surface-2 px-1.5 py-0.5 text-2xs font-normal tabular-nums text-ink-3'>
            {summary}
          </span>
        )
        : null}
    </Button>
  )

  return (
    <div>
      {heading ? <h3 className='m-0'>{control}</h3> : control}
      <div id={regionId} hidden={!open} className='mt-3'>
        {open ? children : null}
      </div>
    </div>
  )
}

/**
 * The figure-check badge under a document-scoped answer: the same check
 * the Ask page badges, run against the open document (D4-21). Nothing is
 * shown when the answer stated no figure.
 */
function ScopedAuditBadge({ audit }: { audit: AnswerAudit | null }) {
  const { ui } = usePortalLocale()
  const badge = auditBadge(audit ?? undefined, ui)
  if (!badge) return null
  return (
    <div className='mt-3 flex flex-wrap items-center gap-2'>
      <span
        className={`rp-badge ${badge.tone === 'ok' ? 'rp-badge-ok' : 'rp-badge-warn'}`}
        title={badge.title}
      >
        <ShieldCheck size='sm' />
        {badge.label}
      </span>
      <span className='text-xs text-ink-3'>{ui("Checked against this document's text")}</span>
    </div>
  )
}

/**
 * Renders one bound `[n]` marker found in the prose, or null when `n` has no
 * matching citation - an unbound number is left as the literal text it was.
 */
type MarkerRenderer = (label: string, index: number, key: string) => ReactNode | null

/**
 * Splits a plain run on `[n]` markers and hands each one to `renderMarker`.
 * A marker the renderer declines (no such citation) stays literal text, so a
 * number the model invented never becomes a link to nowhere.
 */
function renderCitationMarkers(
  text: string,
  renderMarker: MarkerRenderer,
  keyPrefix: string,
): ReactNode[] {
  return text.split(/(\[\d+\]|\[inference\]|\(inference\))/gi).map((segment, index) => {
    const key = `${keyPrefix}-${index}`
    // The model's own hedge, rendered as a mark rather than as prose.
    if (/^[[(]inference[\])]$/i.test(segment)) return <InferenceMark key={key} />
    const match = /^\[(\d+)\]$/.exec(segment)
    const marker = match?.[1] ? renderMarker(segment, Number(match[1]), key) : null
    return marker ?? <span key={key}>{segment}</span>
  })
}

/** Renders `**bold**` and `*italic*` spans, and `[n]` markers, within one line/paragraph. */
function renderInline(
  text: string,
  renderMarker: MarkerRenderer,
  keyPrefix: string,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g)
  return parts.flatMap((part, index): ReactNode[] =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? [
        <strong key={`${keyPrefix}-${index}`}>
          {renderCitationMarkers(part.slice(2, -2), renderMarker, `${keyPrefix}-${index}`)}
        </strong>,
      ]
      : part.startsWith('*') && part.endsWith('*') && part.length > 2
      ? [
        <em key={`${keyPrefix}-${index}`}>
          {renderCitationMarkers(part.slice(1, -1), renderMarker, `${keyPrefix}-${index}`)}
        </em>,
      ]
      : renderCitationMarkers(part, renderMarker, `${keyPrefix}-${index}`)
  )
}

/** Streamed answer text: shared block structure, with bold and `[n]` markers inline. */
function renderAnswerText(text: string, renderMarker: MarkerRenderer): ReactNode {
  return (
    <AnswerMarkdown
      text={text}
      renderInline={(run, keyPrefix) => renderInline(run, renderMarker, keyPrefix)}
      bodyClassName='rp-measure leading-relaxed'
    />
  )
}

/**
 * Tracks which `#result-<id>` elements currently exist on the page for the
 * given resource ids. The results list is a sibling component that can mount
 * (or finish loading) after citations have already arrived, so this watches
 * the DOM rather than trusting a one-off lookup.
 */
function useExistingResultIds(ids: string[]): Set<string> {
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const idsKey = ids.join(',')

  useEffect(() => {
    const watched = idsKey.length > 0 ? idsKey.split(',') : []

    function recompute() {
      const next = new Set<string>()
      for (const id of watched) {
        if (document.getElementById(`result-${id}`)) next.add(id)
      }
      setExisting((prev) => {
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev
        return next
      })
    }

    recompute()
    if (watched.length === 0) return

    const observer = new MutationObserver(recompute)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [idsKey])

  return existing
}

export interface ContextJourneyProps {
  slug: string
  sources: ScoredResource[]
  /**
   * The question the answer was built from. Shown on the journey's opening
   * screen and used to ask each source how it relates. Optional so existing
   * callers keep working; the walk still runs without it.
   */
  query?: string
  /**
   * Fired when the reader opens the journey. The per-source AI relevance
   * judgement is token-costing, so callers use this to run it lazily - only
   * when someone actually asks to walk the context - rather than on every
   * answer. Optional; the walk itself runs regardless.
   */
  onOpen?: () => void
}

/**
 * "Journey through the context" - the quiet trigger that opens the cinematic
 * walk through the sources behind an answer. Standalone and reusable so
 * Search, Ask and the agentic pipeline all offer the same
 * experience from the same one-line call.
 */
export function ContextJourney(props: ContextJourneyProps) {
  const access = useAccess()
  return access.can('portal.ask', { kind: 'portal', slug: props.slug })
    ? (
      <PermittedContextJourney
        key={`${access.generation}:${props.slug}:${props.query}`}
        {...props}
      />
    )
    : null
}

function PermittedContextJourney({ slug, sources, query = '', onOpen }: ContextJourneyProps) {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const context = access.controller.context
  const [isOpen, setIsOpen] = useState(false)

  const citedIds = useMemo(
    () => sources.filter((source) => source.citedCount > 0).map((source) => source.id),
    [sources],
  )

  if (sources.length === 0) return null

  return (
    <>
      <Button
        variant='outline'
        size='sm'
        leadingIcon={Compass}
        onClick={() => {
          if (
            access.controller.context !== context ||
            !access.controller.can('portal.ask', { kind: 'portal', slug })
          ) return
          onOpen?.()
          setIsOpen(true)
        }}
        aria-haspopup='dialog'
        className='rp-answer-journey-toggle max-w-full flex-wrap'
      >
        {ui('Journey through the context')}
        <span className='rounded-[var(--rp-radius-chip)] bg-surface-2 px-1.5 py-0.5 text-2xs tabular-nums text-ink-3'>
          {Math.min(sources.length, 8)}
        </span>
      </Button>

      <AnswerJourney
        open={isOpen}
        onClose={() => setIsOpen(false)}
        slug={slug}
        query={query}
        sources={sources}
        citedIds={citedIds}
      />
    </>
  )
}

/**
 * Self-contained streamed-answer view: input state machine (idle / streaming
 * / done / error), a tiny inline markdown renderer with clickable `[n]`
 * citation markers, numbered source chips that deep-link into the resource
 * view (with a secondary scroll affordance when a matching result is on the
 * page), a "journey through the context" trigger, and a usage line.
 *
 * `scopedToResource` drops the whole evidence-and-diagnostics block for a
 * caller whose page is already the one document being answered from, and
 * `onCitationJump` lets that caller handle a marker click in the page rather
 * than navigating. Both are off by default, so a whole-corpus caller gets
 * exactly what it got before.
 */
export function AnswerStream(props: AnswerStreamProps) {
  const access = useAccess()
  return access.can('portal.ask', { kind: 'portal', slug: props.slug })
    ? (
      <PermittedAnswerStream
        key={`${access.generation}:${props.slug}:${JSON.stringify(props.request)}`}
        {...props}
      />
    )
    : null
}

function PermittedAnswerStream(
  { slug, request, onSources, onRetry, scopedToResource = false, onCitationJump }:
    AnswerStreamProps,
) {
  const { ui, error: localError } = usePortalLocale()
  const access = useAccess()
  const context = access.controller.context
  const canAsk = () =>
    access.controller.context === context &&
    access.controller.can('portal.ask', { kind: 'portal', slug })
  const [status, setStatus] = useState<Status>('idle')
  const [text, setText] = useState('')
  const [sources, setSources] = useState<ScoredResource[]>([])
  const [citations, setCitations] = useState<Citation[]>([])
  const [usage, setUsage] = useState<UsageEvent | null>(null)
  const [quality, setQuality] = useState<QualityScores | null>(null)
  /** What the figure check found, for the badge under a document-scoped answer (D4-21). */
  const [audit, setAudit] = useState<AnswerAudit | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** The corpus (or, scoped, this document) could not answer; guidance was shown instead. */
  const [refused, setRefused] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [activeStage, setActiveStage] = useState<AskStage | null>(null)
  const [seenStages, setSeenStages] = useState<Set<AskStage>>(() => new Set())
  const abortRef = useRef<AbortController | null>(null)

  const key = `${slug}|${request.query}|${request.resourceId ?? ''}|${
    (request.topicIds ?? []).join(',')
  }|${retryToken}`

  function retry() {
    if (!canAsk()) return
    setActiveStage(null)
    setSeenStages(new Set())
    setRetryToken((prev) => prev + 1)
    onRetry?.()
  }

  const phase = useAnswerPhase(text.length > 0, status === 'streaming' || status === 'done')

  // Scoped to one document there are no source chips, so nothing needs the
  // "scroll to this result" affordance - and the hook skips its DOM observer
  // entirely on an empty list.
  const existingResultIds = useExistingResultIds(
    scopedToResource ? [] : citations.map((citation) => citation.resourceId),
  )

  useEffect(() => {
    abortRef.current?.abort()
    if (!canAsk()) return

    if (request.query.trim().length === 0) {
      setStatus('idle')
      setText('')
      setSources([])
      setCitations([])
      setUsage(null)
      setQuality(null)
      setAudit(null)
      setErrorMessage(null)
      setRefused(false)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('streaming')
    setText('')
    setSources([])
    setCitations([])
    setUsage(null)
    setQuality(null)
    setAudit(null)
    setErrorMessage(null)
    setRefused(false)

    streamAsk(slug, request, (event: AskEvent) => {
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      switch (event.type) {
        case 'sources':
          setSources(event.resources)
          break
        case 'delta':
          setText((prev) => prev + event.text)
          break
        case 'citation':
          setCitations((prev) => [...prev, event.citation])
          break
        case 'usage':
          setUsage(event)
          break
        case 'quality':
          setQuality({
            answerRelevance: event.answerRelevance,
            groundedness: event.groundedness,
            contextRelevance: event.contextRelevance,
          })
          break
        case 'audit':
          setAudit(event)
          break
        case 'done':
          // The deterministically citation-bound text replaces the streamed
          // accumulation: the platform strips the model's own inline markers
          // and splices `[n]` at its citation char-offsets, numbered to match
          // the citation events just received. Without this the prose carries
          // the model's unbound numbering, which is what a marker click would
          // have to trust. SearchAnswer and AskPage already do this.
          if (event.text !== undefined) setText(event.text)
          setRefused(Boolean(event.refused))
          setStatus('done')
          break
        case 'error':
          setErrorMessage(event.message)
          setStatus('error')
          break
        case 'stage':
          if (event.status === 'started') {
            setActiveStage(event.stage)
          } else {
            setSeenStages((prev) => new Set(prev).add(event.stage))
          }
          break
      }
    }, controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      // The portal's own words, never the browser's or an upstream one
      // (review loop 8 D8-07). The detail stays in
      // the console, where a developer can read it.
      console.error('ask stream failed', err)
      setErrorMessage(ui('The answer service is unavailable - please try again.'))
      setStatus('error')
    })

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  /** Sources with live citation counts folded in - what the journey walks. */
  const citedSources = useMemo(
    () =>
      sources.map((resource) => ({
        ...resource,
        citedCount: citations.filter((citation) => citation.resourceId === resource.id).length,
      })),
    [sources, citations],
  )

  useEffect(() => {
    if (citedSources.length === 0 || !canAsk() || abortRef.current?.signal.aborted) return
    onSources?.(citedSources)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citedSources])

  if (status === 'idle') return null

  function scrollToResource(resourceId: string) {
    const el = document.getElementById(`result-${resourceId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /**
   * An inline `[n]` in the prose. Rendered as an anchor rather than a button
   * so it keeps a real href: when the caller cannot handle the jump in the
   * page (no extracted text to scroll to, say) the same element still takes
   * the reader to the passage the long way, and middle-click still opens it in
   * a tab. `onCitationJump` gets first refusal on a plain click; only when it
   * says it handled the jump is the navigation suppressed. Space is wired to
   * the anchor as well, since where the jump is handled in-page the marker
   * behaves as a control and readers try both keys.
   */
  const renderMarker: MarkerRenderer = (label, index, key) => {
    const citation = citations.find((item) => item.index === index)
    if (!citation) return null
    const { passage, page } = citationTarget(
      citation,
      sources.find((source) => source.id === citation.resourceId),
    )
    return (
      <sup key={key}>
        <Link
          to={citationHref(slug, citation.resourceId, passage, page)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            if (onCitationJump?.(citation, passage, page)) event.preventDefault()
          }}
          onKeyDown={(event) => {
            if (event.key !== ' ') return
            event.preventDefault()
            event.currentTarget.click()
          }}
          aria-label={onCitationJump
            ? ui('Source {index}, {value2} - show the cited passage', {
              index: index,
              value2: citation.title,
            })
            : ui('Source {index}, {value2}', { index: index, value2: citation.title })}
          className='rp-focus rounded-[var(--rp-radius-chip)] px-0.5 font-semibold no-underline'
          style={{ color: 'var(--rp-accent-fg)' }}
        >
          {label}
        </Link>
      </sup>
    )
  }

  return (
    <div className='rp-card p-5'>
      <div className='flex items-center gap-2'>
        <span
          className='h-2 w-2 shrink-0 rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
          aria-hidden='true'
        />
        <p className='rp-eyebrow text-ink-3'>
          {ui('AI answer')}
        </p>
      </div>

      <div className='rp-prose mt-3 space-y-3 text-base text-ink sm:text-sm'>
        {phase !== 'answer' && status === 'streaming'
          ? (
            <StageTimeline
              statuses={statusesFor(activeStage, seenStages)}
              exiting={phase === 'handoff'}
            />
          )
          : scopedToResource && refused && status === 'done'
          ? (
            /* Document scope: the whole-corpus decline ("browse the Library")
             * makes no sense when the question was checked against one
             * document. Say that plainly and offer the corpus. */
            <div className='rp-answer-in rounded-[var(--rp-radius)] border border-dashed border-line bg-surface-2 p-4'>
              <p className='text-sm font-semibold text-ink'>
                {ui('This document does not answer that')}
              </p>
              <p className='mt-1 text-sm leading-relaxed text-ink-2'>
                {ui(
                  'The question was checked against this document only, and nothing in it addresses it. Try asking about something the document covers, or put the question to the whole corpus.',
                )}
              </p>
              <Link
                to={`/t/${slug}/ask?ask=${encodeURIComponent(request.query)}`}
                className='rp-btn rp-btn-outline mt-3'
              >
                {ui('Ask the whole corpus')}
              </Link>
            </div>
          )
          : text.length > 0
          ? <div className='rp-answer-in'>{renderAnswerText(text, renderMarker)}</div>
          : null}
        {status === 'streaming' && text.length > 0
          ? (
            <span className='rp-dots ml-1' aria-hidden='true'>
              <span />
              <span />
              <span />
            </span>
          )
          : null}
      </div>
      {scopedToResource && status === 'done' && !refused
        ? <ScopedAuditBadge audit={audit} />
        : null}

      {citations.length > 0 && !scopedToResource
        ? (
          <>
            <div className='mt-4 flex flex-wrap items-center gap-2'>
              {citations.map((citation) => {
                const source = sources.find((resource) => resource.id === citation.resourceId)
                return (
                  <div
                    key={citation.index}
                    className='inline-flex min-w-0 max-w-full items-center gap-1'
                  >
                    <Link
                      to={citationLink(slug, citation, source)}
                      className='rp-btn rp-btn-ghost rp-btn-sm min-w-0 max-w-full gap-1.5 border border-line bg-surface-2'
                    >
                      <span
                        className='flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-[var(--rp-radius-chip)] px-1 text-2xs font-semibold tabular-nums text-[var(--rp-on-accent)]'
                        style={{ backgroundColor: 'var(--rp-accent)' }}
                      >
                        {citation.index}
                      </span>
                      <span className='min-w-0 max-w-[16rem] truncate text-left'>
                        {citation.title}
                      </span>
                    </Link>
                    {existingResultIds.has(citation.resourceId)
                      ? (
                        <IconButton
                          icon={ChevronDown}
                          onClick={() => scrollToResource(citation.resourceId)}
                          label={ui('Scroll to {value1} in the results below', {
                            value1: citation.title,
                          })}
                          size='sm'
                        />
                      )
                      : null}
                  </div>
                )
              })}
            </div>
            <p className='mt-2 text-xs text-ink-3'>
              {citations.length} {ui('cited')}
            </p>
            <CurrencyNote
              className='mt-2'
              sources={citedSources.filter((source) => source.citedCount > 0)}
            />
          </>
        )
        : null}

      {errorMessage
        ? (
          <div className='mt-3 flex flex-wrap items-center gap-2'>
            <p className='text-xs text-[var(--rp-bad-ink)]'>
              {ui('Answer unavailable right now -')}{' '}
              {localError(errorMessage, 'The answer service is unavailable.')}
            </p>
            <Button
              variant='outline'
              size='sm'
              leadingIcon={RotateCcw}
              onClick={retry}
            >
              {ui('Try again')}
            </Button>
          </div>
        )
        : null}

      {usage && !scopedToResource
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            {ui('{input} in / {output} out tokens', {
              input: usage.inputTokens.toLocaleString(),
              output: usage.outputTokens.toLocaleString(),
            })}
          </p>
        )
        : null}

      {quality && !scopedToResource
        ? (
          <div className='mt-2'>
            <TrustSignals quality={quality} />
          </div>
        )
        : null}

      {status === 'done' && citedSources.length > 0 && !scopedToResource
        ? (
          <div className='mt-4 border-t border-line pt-3.5'>
            <ContextJourney slug={slug} sources={citedSources} query={request.query} />
          </div>
        )
        : null}
    </div>
  )
}
