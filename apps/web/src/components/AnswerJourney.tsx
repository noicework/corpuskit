import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { AskEvent, ResourceType, ScoredResource } from '@research-portal/core'
import { streamAsk } from '../api/client.ts'
import { ResourceThumb } from './ResourceThumb.tsx'
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw, Sparkles, X } from './icons.tsx'
import { Button, IconButton } from './ui.tsx'

/** At most eight stops - past that the walk stops feeling like a story. */
const MAX_STOPS = 8
/** How long the intro holds before the first stop, when playing. */
const INTRO_MS = 2400
/** How long a stop holds once its relation answer has finished streaming. */
const DWELL_MS = 5600

interface Stop {
  resourceId: string
  title: string
  quote: string
  score: number
  labels: string[]
  cited: boolean
  type: ResourceType | string
}

type RelationState = 'streaming' | 'done' | 'error'

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/** Confidence bands - the same three colours everywhere a score is shown. */
function scoreColour(score: number): string {
  if (score >= 0.7) return 'var(--rp-ok-ink)'
  if (score >= 0.4) return 'var(--rp-warn-ink)'
  return 'var(--rp-bad-ink)'
}

function scoreWord(score: number): string {
  if (score >= 0.7) return 'Strong match'
  if (score >= 0.4) return 'Partial match'
  return 'Loose match'
}

/** Topic ids are slugs; soften them for display without inventing labels. */
function labelText(id: string): string {
  return id.replace(/[-_]+/g, ' ')
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/* -------------------------------------------------------------------------
 * Small pieces
 * ---------------------------------------------------------------------- */

function SparkleMark() {
  return (
    <span
      aria-hidden='true'
      className='inline-flex h-12 w-12 items-center justify-center rounded-[var(--rp-radius)] border border-line bg-surface-2 text-[var(--rp-brand-fg)]'
    >
      <Sparkles size='lg' />
    </span>
  )
}

/**
 * The confidence ring: an SVG progress arc with the percentage in the middle.
 * Drawn on a 96 unit viewBox and sized by CSS so it can shrink on a phone
 * without any of the maths changing.
 */
function ConfidenceRing({
  score,
  className = '',
  reducedMotion,
}: {
  score: number
  className?: string
  reducedMotion: boolean
}) {
  const { ui } = usePortalLocale()
  const percent = Math.round(score * 100)
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const colour = scoreColour(score)

  // Sweep the arc in from zero on mount, unless motion is turned down.
  const [shown, setShown] = useState(reducedMotion ? score : 0)
  useEffect(() => {
    if (reducedMotion) {
      setShown(score)
      return
    }
    const id = globalThis.setTimeout(() => setShown(score), 60)
    return () => globalThis.clearTimeout(id)
  }, [score, reducedMotion])

  return (
    <div
      className={`relative shrink-0 rounded-full bg-surface ${className}`}
      role='img'
      aria-label={ui('{value1} - {percent} per cent confidence', {
        value1: ui(scoreWord(score)),
        percent: percent,
      })}
    >
      <svg viewBox='0 0 96 96' className='h-full w-full -rotate-90'>
        <circle cx='48' cy='48' r={radius} fill='var(--rp-surface)' />
        <circle
          cx='48'
          cy='48'
          r={radius}
          fill='none'
          stroke='var(--rp-line-2)'
          strokeWidth='6'
        />
        <circle
          cx='48'
          cy='48'
          r={radius}
          fill='none'
          stroke={colour}
          strokeWidth='6'
          strokeLinecap='round'
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - shown)}
          style={{
            transition: reducedMotion
              ? undefined
              : 'stroke-dashoffset 900ms cubic-bezier(0.2, 0.7, 0.2, 1)',
          }}
        />
      </svg>
      <span className='absolute inset-0 flex items-center justify-center'>
        <span className='text-sm font-semibold tabular-nums text-ink sm:text-base'>
          {percent}%
        </span>
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * The journey
 * ---------------------------------------------------------------------- */

export interface AnswerJourneyProps {
  open: boolean
  onClose: () => void
  slug: string
  query: string
  sources: ScoredResource[]
  citedIds: string[]
}

/**
 * "Journey through the context" - a full-screen, cinematic walk through the
 * sources an answer was built from. One screen per source, strongest match
 * first: its artwork, the passage that matched, a live per-source answer to
 * "how does this relate to my question", and a confidence ring. It plays
 * itself, or the reader drives with the chevrons, the dot rail or the arrow
 * keys.
 */
export function AnswerJourney({
  open,
  onClose,
  slug,
  query,
  sources,
  citedIds,
}: AnswerJourneyProps) {
  const { ui } = usePortalLocale()
  const reducedMotion = usePrefersReducedMotion()
  const citedKey = citedIds.join(',')

  const stops = useMemo<Stop[]>(() => {
    const cited = new Set(citedKey.length > 0 ? citedKey.split(',') : [])
    return [...sources]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_STOPS)
      .map((source) => ({
        resourceId: source.id,
        title: source.title,
        quote: source.matchedPassage ?? '',
        score: source.relevance,
        labels: source.topicIds,
        cited: cited.has(source.id),
        type: source.type,
      }))
  }, [sources, citedKey])

  // -1 is the intro, stops.length is the outro.
  const [index, setIndex] = useState(-1)
  const [playing, setPlaying] = useState(true)
  const [relations, setRelations] = useState<Record<number, string>>({})
  const [relationState, setRelationState] = useState<Record<number, RelationState>>({})
  const [dwellKey, setDwellKey] = useState(0)
  const [dwellDuration, setDwellDuration] = useState(0)

  const relationsRef = useRef<Record<number, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const dwellStartRef = useRef(0)
  const dwellRemainingRef = useRef(0)
  const advanceRef = useRef<() => void>(() => {})
  const cardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const total = stops.length
  const current = index >= 0 && index < total ? stops[index] : undefined

  const goTo = useCallback((next: number) => {
    setIndex(Math.max(-1, Math.min(total, next)))
  }, [total])

  const advance = useCallback(() => {
    setIndex((prev) => (prev < total ? prev + 1 : prev))
  }, [total])
  advanceRef.current = advance

  // --- lifecycle -----------------------------------------------------------

  // Every opening starts a fresh walk; a stale relation answer from a previous
  // question would be worse than none.
  useEffect(() => {
    if (!open) return
    relationsRef.current = {}
    setRelations({})
    setRelationState({})
    setIndex(-1)
    setPlaying(!reducedMotion)
    setDwellDuration(0)
    setDwellKey((key) => key + 1)
  }, [open, slug, query, reducedMotion])

  // Lock the page behind the modal.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Move focus into the dialog so keyboard users land in the right place.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    cardRef.current?.focus()
    return () => {
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [open])

  // Autoplay can replace the focused source action as it moves to the next stop.
  useEffect(() => {
    const card = cardRef.current
    if (open && card && !card.contains(document.activeElement)) card.focus()
  }, [open, index])

  // Keyboard, captured so a focused control never sees the same key twice.
  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }

      if (event.key === 'Tab') {
        const card = cardRef.current
        const controls = [
          ...(card?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
          ) ?? []),
        ]
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (first && last) {
          if (!card?.contains(document.activeElement)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          } else if (
            event.shiftKey && (document.activeElement === first || document.activeElement === card)
          ) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        return
      }

      // Don't swallow keys a focused control needs for its own behaviour -
      // Space/Enter to activate a button, arrow keys inside an input, etc.
      const target = event.target as HTMLElement | null
      if (target?.closest('button, input, textarea, select, a[href]')) {
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        advanceRef.current()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        event.stopPropagation()
        setIndex((prev) => Math.max(-1, prev - 1))
        return
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        event.stopPropagation()
        setPlaying((prev) => !prev)
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Return the reader to the top of a new stop.
  useEffect(() => {
    if (!open) return
    const body = bodyRef.current
    if (!body) return
    body.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [index, open, reducedMotion])

  // --- the live per-source relation ---------------------------------------

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null

    if (!open) return
    const stop = index >= 0 && index < stops.length ? stops[index] : undefined
    if (!stop) return

    // Already walked this stop - reuse what we streamed the first time.
    if (relationsRef.current[index] !== undefined) {
      setRelationState((prev) => (prev[index] ? prev : { ...prev, [index]: 'done' }))
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setRelationState((prev) => ({ ...prev, [index]: 'streaming' }))

    let text = ''
    const settle = (state: RelationState) => {
      if (controller.signal.aborted) return
      setRelationState((prev) => prev[index] === 'streaming' ? { ...prev, [index]: state } : prev)
    }

    // Callers that cannot supply the original question still get a useful
    // per-source read, just framed against the answer rather than the query.
    const prompt = query
      ? `How does this source relate to the question: "${query}"? ` +
        'Answer in two or three sentences, grounded only in this source.'
      : 'What does this source contribute to the answer? ' +
        'Answer in two or three sentences, grounded only in this source.'

    streamAsk(
      slug,
      { query: prompt, resourceId: stop.resourceId },
      (event: AskEvent) => {
        if (controller.signal.aborted) return
        if (event.type === 'delta') {
          text += event.text
          relationsRef.current = { ...relationsRef.current, [index]: text }
          setRelations(relationsRef.current)
        } else if (event.type === 'done') {
          settle('done')
        } else if (event.type === 'error') {
          settle('error')
        }
      },
      controller.signal,
    )
      .then(() => settle('done'))
      .catch(() => settle('error'))

    return () => {
      controller.abort()
      // Leaving mid-stream still counts as settled, so returning to this stop
      // shows the partial answer instead of waiting on a stream that is gone.
      setRelationState((prev) =>
        prev[index] === 'streaming' && relationsRef.current[index] !== undefined
          ? { ...prev, [index]: 'done' }
          : prev
      )
    }
  }, [open, index, stops, slug, query])

  // --- the dwell timer -----------------------------------------------------

  const relationSettled = current
    ? relationState[index] === 'done' || relationState[index] === 'error'
    : true
  const dwellArmed = open && total > 0 && (index === -1 || (index < total && relationSettled))
  const dwellMs = index === -1 ? INTRO_MS : DWELL_MS

  // Arm a fresh dwell whenever the phase changes.
  useEffect(() => {
    if (!dwellArmed) {
      setDwellDuration(0)
      return
    }
    dwellRemainingRef.current = dwellMs
    setDwellDuration(dwellMs)
    setDwellKey((key) => key + 1)
  }, [dwellArmed, dwellMs, index])

  // Run it while playing; pausing banks the time already spent so resuming
  // picks up where the bar left off rather than starting over.
  useEffect(() => {
    if (!dwellArmed || !playing) return
    dwellStartRef.current = Date.now()
    const id = globalThis.setTimeout(() => advanceRef.current(), dwellRemainingRef.current)
    return () => {
      globalThis.clearTimeout(id)
      dwellRemainingRef.current = Math.max(
        0,
        dwellRemainingRef.current - (Date.now() - dwellStartRef.current),
      )
    }
  }, [dwellArmed, playing, dwellKey])

  if (!open) return null

  // --- render --------------------------------------------------------------

  const phaseLabel = index === -1
    ? ui('How this answer was built')
    : index >= total
    ? ui('The trail')
    : ui('Source {index} of {total}', { index: index + 1, total })

  const accent = current ? scoreColour(current.score) : 'var(--rp-accent-fg)'
  const relationText = relations[index] ?? ''
  const relationStatus = relationState[index]

  const libraryHref = (stop: Stop) =>
    `/t/${slug}/library/${stop.resourceId}${
      stop.quote ? `?passage=${encodeURIComponent(stop.quote.slice(0, 300))}` : ''
    }`

  return createPortal(
    <div
      className='rp-anim-fade rp-scrim fixed inset-0 z-[80] flex items-center justify-center backdrop-blur-sm sm:p-6'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        role='dialog'
        aria-modal='true'
        aria-label={ui('Journey through the context')}
        tabIndex={-1}
        className='rp-card rp-shadow-xl rp-focus fixed inset-2 flex flex-col overflow-hidden text-ink sm:static sm:max-h-[88vh] sm:w-full sm:max-w-3xl'
      >
        {/* Top bar */}
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5'>
          <p className='rp-eyebrow min-w-0 truncate text-ink-3'>{phaseLabel}</p>
          <div className='flex shrink-0 items-center gap-2'>
            {total > 0
              ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setPlaying((prev) => !prev)}
                  aria-pressed={playing}
                >
                  {playing ? ui('Pause') : ui('Play')}
                </Button>
              )
              : null}
            <IconButton label={ui('Close the journey')} icon={X} onClick={onClose} />
          </div>
        </div>

        {/* Body */}
        <div ref={bodyRef} className='min-h-0 flex-1 overflow-y-auto'>
          {total === 0
            ? (
              <div className='px-6 py-16 text-center'>
                <SparkleMark />
                <h2 className='rp-display mt-5 text-2xl text-ink'>{ui('Nothing to walk yet')}</h2>
                <p className='mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-3'>
                  {ui(
                    'This answer did not come back with any retrieved sources, so there is no trail to follow.',
                  )}
                </p>
                <Button
                  onClick={onClose}
                  className='mt-6'
                >
                  {ui('Close')}
                </Button>
              </div>
            )
            : index === -1
            ? (
              <div key='intro' className='rp-anim-rise px-6 py-12 text-center sm:py-16'>
                <div className='flex justify-center'>
                  <SparkleMark />
                </div>
                <h2 className='rp-display mt-5 text-2xl text-ink sm:text-3xl'>
                  {ui('How this answer was built')}
                </h2>
                <p className='mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-3'>
                  {ui(
                    total === 1
                      ? 'We grounded your answer in {count} source. Let’s walk them - strongest match first - and ask each one how it relates.'
                      : 'We grounded your answer in {count} sources. Let’s walk them - strongest match first - and ask each one how it relates.',
                    { count: total },
                  )}
                </p>
                {query
                  ? (
                    <p className='mx-auto mt-6 max-w-lg rounded-[var(--rp-radius)] bg-surface-2 px-5 py-3 text-sm italic leading-relaxed text-ink-2 ring-1 ring-inset ring-line'>
                      &ldquo;{query}&rdquo;
                    </p>
                  )
                  : null}
                <Button
                  onClick={() => goTo(0)}
                  trailingIcon={ArrowRight}
                  className='mt-8'
                >
                  {ui('Begin the journey')}
                </Button>
              </div>
            )
            : index >= total
            ? (
              <div key='outro' className='rp-anim-rise px-5 py-8 sm:px-6'>
                <div className='text-center'>
                  <SparkleMark />
                  <h2 className='rp-display mt-4 text-2xl text-ink sm:text-3xl'>
                    {ui('That’s the trail')}
                  </h2>
                  <p className='mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-3'>
                    {ui(
                      'Every source behind the answer, ranked by how strongly it matched. Open any of them to read it in full.',
                    )}
                  </p>
                </div>

                <ol className='mt-7 space-y-2'>
                  {stops.map((stop, stopIndex) => (
                    <li key={stop.resourceId}>
                      <Link
                        to={libraryHref(stop)}
                        onClick={onClose}
                        className='rp-focus flex items-center gap-3 rounded-[var(--rp-radius-btn)] px-3 py-3 ring-1 ring-inset ring-line transition-colors duration-150 hover:bg-surface-2'
                      >
                        <span className='w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-ink-3'>
                          {stopIndex + 1}
                        </span>
                        <span className='block h-10 w-14 shrink-0 overflow-hidden rounded-[var(--rp-radius)] bg-surface-2'>
                          <ResourceThumb slug={slug} id={stop.resourceId} type={stop.type} />
                        </span>
                        <span className='min-w-0 flex-1'>
                          <span className='rp-clamp-2 block text-sm font-medium leading-snug text-ink'>
                            {stop.title}
                          </span>
                          {stop.cited
                            ? (
                              <span className='mt-1 inline-flex items-center gap-1 text-2xs font-medium text-[var(--rp-ok-ink)]'>
                                <span
                                  aria-hidden='true'
                                  className='h-1.5 w-1.5 rounded-full bg-[var(--rp-ok-ink)]'
                                />
                                {ui('Cited in the answer')}
                              </span>
                            )
                            : null}
                        </span>
                        <span className='shrink-0 text-right'>
                          <span
                            className='block text-sm font-semibold tabular-nums'
                            style={{ color: scoreColour(stop.score) }}
                          >
                            {Math.round(stop.score * 100)}%
                          </span>
                          <span className='block text-2xs text-ink-3'>
                            {ui('confidence')}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>

                <div className='mt-7 flex flex-wrap items-center justify-center gap-3'>
                  <Button
                    variant='outline'
                    leadingIcon={RotateCcw}
                    onClick={() => {
                      setPlaying(!reducedMotion)
                      goTo(-1)
                    }}
                  >
                    {ui('Replay')}
                  </Button>
                  <Button onClick={onClose}>
                    {ui('Done')}
                  </Button>
                </div>
              </div>
            )
            : current
            ? (
              <div key={`stop-${index}`} className='rp-anim-fade'>
                {/* Artwork and identity use separate blocks so the title can grow. */}
                <div className='bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'>
                  <div className='relative h-36 w-full overflow-hidden bg-surface-2 sm:h-52'>
                    <ResourceThumb
                      slug={slug}
                      id={current.resourceId}
                      type={current.type}
                      className={reducedMotion ? '' : 'rp-anim-kenburns'}
                    />
                    {current.cited
                      ? (
                        <span className='rp-badge rp-badge-ok absolute right-3 top-3'>
                          {ui('Cited in the answer')}
                        </span>
                      )
                      : null}
                  </div>
                  <div className='flex items-end gap-3 p-4 sm:p-5'>
                    <div className='min-w-0 flex-1'>
                      <h2 className='rp-display rp-display-bold break-words text-lg sm:text-2xl'>
                        {current.title}
                      </h2>
                      {current.labels.length > 0
                        ? (
                          <div className='mt-2 flex flex-wrap gap-1.5'>
                            {current.labels.slice(0, 4).map((label) => (
                              <span
                                key={label}
                                className='max-w-full break-words rounded-[var(--rp-radius-chip)] border border-[color-mix(in_srgb,var(--rp-on-primary)_25%,transparent)] px-2.5 py-0.5 text-2xs font-medium capitalize text-[var(--rp-on-primary-2)]'
                              >
                                {labelText(label)}
                              </span>
                            ))}
                          </div>
                        )
                        : null}
                    </div>
                    <ConfidenceRing
                      key={current.resourceId}
                      score={current.score}
                      reducedMotion={reducedMotion}
                      className='h-16 w-16 sm:h-24 sm:w-24'
                    />
                  </div>
                </div>

                {/* Stop body */}
                <div className='space-y-6 px-5 py-5 sm:px-6 sm:py-6'>
                  <section>
                    <p className='rp-eyebrow text-ink-3'>{ui('What we found here')}</p>
                    {current.quote
                      ? (
                        <blockquote
                          className='break-words rp-clamp-4 mt-2 border-l-2 pl-4 text-sm leading-relaxed text-ink-2'
                          style={{ borderColor: accent }}
                        >
                          &ldquo;{current.quote}&rdquo;
                        </blockquote>
                      )
                      : (
                        <p className='mt-2 text-sm leading-relaxed text-ink-3'>
                          {ui(
                            'This source matched the question overall, but the retrieval step did not single out one passage.',
                          )}
                        </p>
                      )}
                  </section>

                  <section>
                    <p className='rp-eyebrow text-ink-3'>
                      {query
                        ? ui('How this relates to your question')
                        : ui('What this source contributes')}
                    </p>
                    {relationText
                      ? (
                        <p className='rp-prose rp-measure mt-2 text-sm text-ink-2'>
                          {relationText}
                          {relationStatus === 'streaming'
                            ? (
                              <span
                                aria-hidden='true'
                                className='ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--rp-accent-fg)] align-text-bottom'
                              />
                            )
                            : null}
                        </p>
                      )
                      : relationStatus === 'error'
                      ? (
                        <p className='mt-2 text-sm leading-relaxed text-ink-3'>
                          {ui(
                            'We could not reach the answer service for this source. The passage above is still what matched.',
                          )}
                        </p>
                      )
                      : (
                        <p className='mt-2 flex items-center gap-2 text-sm text-ink-3'>
                          <span
                            aria-hidden='true'
                            className='h-3.5 w-3.5 animate-spin rounded-full border border-line border-t-[var(--rp-accent-fg)]'
                          />
                          {ui('Asking this source…')}
                        </p>
                      )}
                  </section>

                  <Link
                    to={libraryHref(current)}
                    onClick={onClose}
                    className='rp-link-standalone gap-1.5 text-xs font-semibold text-[var(--rp-accent-fg)]'
                  >
                    {ui('View in library')}
                    <ArrowRight size='sm' />
                  </Link>
                </div>
              </div>
            )
            : null}
        </div>

        {/* Footer: dwell bar, chevrons, dot rail */}
        {total > 0
          ? (
            <div className='shrink-0 border-t border-line px-4 py-3 sm:px-5'>
              <div className='h-[3px] w-full overflow-hidden rounded-full bg-surface-2'>
                {dwellArmed && dwellDuration > 0
                  ? (
                    <div
                      key={dwellKey}
                      className='rp-dwell-bar h-full rounded-full'
                      style={{
                        animationDuration: `${dwellDuration}ms`,
                        animationPlayState: playing ? 'running' : 'paused',
                        backgroundColor: accent,
                      }}
                    />
                  )
                  : index >= 0 && index < total
                  ? (
                    // Waiting on this source's relation answer before the dwell starts.
                    <div
                      className='h-full w-1/4 animate-pulse rounded-full bg-surface-3'
                      aria-hidden='true'
                    />
                  )
                  : null}
              </div>

              <div className='mt-3 flex items-center justify-between gap-3'>
                <IconButton
                  label={ui('Previous source')}
                  icon={ChevronLeft}
                  onClick={() => goTo(index - 1)}
                  disabled={index <= -1}
                />

                <div
                  className='rp-no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto px-1'
                  role='group'
                  aria-label={ui('Sources in this journey')}
                >
                  {stops.map((stop, stopIndex) => {
                    const active = stopIndex === index
                    return (
                      <button
                        key={stop.resourceId}
                        type='button'
                        aria-current={active ? 'true' : undefined}
                        aria-label={ui('Source {value1}: {value2}', {
                          value1: stopIndex + 1,
                          value2: stop.title,
                        })}
                        onClick={() => goTo(stopIndex)}
                        title={ui('Source {value1}: {value2}', {
                          value1: stopIndex + 1,
                          value2: stop.title,
                        })}
                        className='rp-btn rp-btn-ghost rp-icon-btn group shrink-0'
                      >
                        <span
                          className={`h-1.5 rounded-full transition-all duration-300 ${
                            active
                              ? 'w-6'
                              : 'w-1.5 bg-[var(--rp-ink-3)] group-hover:bg-[var(--rp-ink-2)]'
                          }`}
                          style={active ? { backgroundColor: scoreColour(stop.score) } : undefined}
                        />
                      </button>
                    )
                  })}
                </div>

                <IconButton
                  label={ui('Next source')}
                  icon={ChevronRight}
                  onClick={() => goTo(index + 1)}
                  disabled={index >= total}
                />
              </div>
            </div>
          )
          : null}
      </div>
    </div>,
    document.body,
  )
}
