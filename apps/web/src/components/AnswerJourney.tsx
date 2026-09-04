import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { AskEvent, ResourceType, ScoredResource } from '@research-portal/core'
import { streamAsk } from '../api/client.ts'
import { ResourceThumb } from './ResourceThumb.tsx'

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
  if (score >= 0.7) return '#34d399'
  if (score >= 0.4) return '#fbbf24'
  return '#fb7185'
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
      className='flex h-12 w-12 items-center justify-center rounded-[var(--rp-radius)] bg-white/10 ring-1 ring-inset ring-white/15'
    >
      <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
        className='h-6 w-6 text-white'
      >
        <path d='M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z' />
        <path d='M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' />
      </svg>
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
      className={`relative shrink-0 ${className}`}
      role='img'
      aria-label={`${scoreWord(score)} - ${percent} per cent confidence`}
    >
      <svg viewBox='0 0 96 96' className='h-full w-full -rotate-90'>
        <circle cx='48' cy='48' r={radius} fill='rgba(10, 10, 12, 0.5)' />
        <circle
          cx='48'
          cy='48'
          r={radius}
          fill='none'
          stroke='rgba(255, 255, 255, 0.16)'
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
        <span className='text-sm font-semibold tabular-nums text-white sm:text-base'>
          {percent}%
        </span>
      </span>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className='rp-focus-inverse flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] text-white/70 ring-1 ring-inset ring-white/15 transition-colors duration-150 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent sm:h-9 sm:w-9'
    >
      {children}
    </button>
  )
}

function ChevronLeft() {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
      <path
        fillRule='evenodd'
        d='M12.79 5.23a.75.75 0 01-.02 1.06L8.83 10l3.94 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z'
        clipRule='evenodd'
      />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
      <path
        fillRule='evenodd'
        d='M7.21 5.23a.75.75 0 011.06-.02l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.04-1.08L11.17 10 7.23 6.29a.75.75 0 01-.02-1.06z'
        clipRule='evenodd'
      />
    </svg>
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
    cardRef.current?.focus()
  }, [open])

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
    ? 'How this answer was built'
    : index >= total
    ? 'The trail'
    : `Source ${index + 1} of ${total}`

  const accent = current ? scoreColour(current.score) : 'rgba(255, 255, 255, 0.5)'
  const relationText = relations[index] ?? ''
  const relationStatus = relationState[index]

  const libraryHref = (stop: Stop) =>
    `/t/${slug}/library/${stop.resourceId}${
      stop.quote ? `?passage=${encodeURIComponent(stop.quote.slice(0, 300))}` : ''
    }`

  return createPortal(
    <div
      className='rp-anim-fade fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/85 backdrop-blur-sm sm:p-6'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        role='dialog'
        aria-modal='true'
        aria-label='Journey through the context'
        tabIndex={-1}
        className='rp-shadow-xl fixed inset-2 flex flex-col overflow-hidden rounded-[var(--rp-radius)] bg-neutral-900 text-white ring-1 ring-white/10 focus:outline-none sm:static sm:max-h-[88vh] sm:w-full sm:max-w-3xl'
      >
        {/* Top bar */}
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5'>
          <p className='rp-eyebrow min-w-0 truncate text-white/50'>{phaseLabel}</p>
          <div className='flex shrink-0 items-center gap-2'>
            {total > 0
              ? (
                <button
                  type='button'
                  onClick={() => setPlaying((prev) => !prev)}
                  aria-pressed={playing}
                  className='rp-focus-inverse inline-flex min-h-11 items-center gap-1.5 rounded-[var(--rp-radius-btn)] px-3 py-1.5 text-xs font-medium text-white/70 ring-1 ring-inset ring-white/15 transition-colors duration-150 hover:bg-white/10 hover:text-white sm:min-h-0'
                >
                  {playing
                    ? (
                      <svg
                        viewBox='0 0 20 20'
                        fill='currentColor'
                        aria-hidden='true'
                        className='h-3.5 w-3.5'
                      >
                        <path d='M6 4.5h2.5v11H6zM11.5 4.5H14v11h-2.5z' />
                      </svg>
                    )
                    : (
                      <svg
                        viewBox='0 0 20 20'
                        fill='currentColor'
                        aria-hidden='true'
                        className='h-3.5 w-3.5'
                      >
                        <path d='M6.5 4.3l9 5.7-9 5.7z' />
                      </svg>
                    )}
                  {playing ? 'Pause' : 'Play'}
                </button>
              )
              : null}
            <IconButton label='Close the journey' onClick={onClose}>
              <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
                <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
              </svg>
            </IconButton>
          </div>
        </div>

        {/* Body */}
        <div ref={bodyRef} className='min-h-0 flex-1 overflow-y-auto'>
          {total === 0
            ? (
              <div className='px-6 py-16 text-center'>
                <SparkleMark />
                <h2 className='rp-display mt-5 text-2xl text-white'>Nothing to walk yet</h2>
                <p className='mx-auto mt-3 max-w-sm text-sm leading-relaxed text-white/60'>
                  This answer did not come back with any retrieved sources, so there is no trail to
                  follow.
                </p>
                <button
                  type='button'
                  onClick={onClose}
                  className='rp-focus-inverse mt-6 inline-flex items-center rounded-[var(--rp-radius-btn)] bg-white px-5 py-2 text-sm font-semibold text-neutral-900 transition-colors duration-150 hover:bg-white/90'
                >
                  Close
                </button>
              </div>
            )
            : index === -1
            ? (
              <div key='intro' className='rp-anim-rise px-6 py-12 text-center sm:py-16'>
                <div className='flex justify-center'>
                  <SparkleMark />
                </div>
                <h2 className='rp-display mt-5 text-2xl text-white sm:text-3xl'>
                  How this answer was built
                </h2>
                <p className='mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60'>
                  We grounded your answer in {total}{' '}
                  {total === 1 ? 'source' : 'sources'}. Let&rsquo;s walk them - strongest match
                  first - and ask each one how it relates.
                </p>
                {query
                  ? (
                    <p className='mx-auto mt-6 max-w-lg rounded-[var(--rp-radius)] bg-white/[0.06] px-5 py-3 text-sm italic leading-relaxed text-white/80 ring-1 ring-inset ring-white/10'>
                      &ldquo;{query}&rdquo;
                    </p>
                  )
                  : null}
                <button
                  type='button'
                  onClick={() => goTo(0)}
                  className='rp-focus-inverse mt-8 inline-flex items-center gap-2 rounded-[var(--rp-radius-btn)] bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 transition-transform duration-150 hover:-translate-y-px'
                >
                  Begin the journey
                  <ChevronRight />
                </button>
              </div>
            )
            : index >= total
            ? (
              <div key='outro' className='rp-anim-rise px-5 py-8 sm:px-6'>
                <div className='text-center'>
                  <SparkleMark />
                  <h2 className='rp-display mt-4 text-2xl text-white sm:text-3xl'>
                    That&rsquo;s the trail
                  </h2>
                  <p className='mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/60'>
                    Every source behind the answer, ranked by how strongly it matched. Open any of
                    them to read it in full.
                  </p>
                </div>

                <ol className='mt-7 space-y-2'>
                  {stops.map((stop, stopIndex) => (
                    <li key={stop.resourceId}>
                      <Link
                        to={libraryHref(stop)}
                        onClick={onClose}
                        className='rp-focus-inverse flex items-center gap-3 rounded-[var(--rp-radius-btn)] px-3 py-3 ring-1 ring-inset ring-white/10 transition-colors duration-150 hover:bg-white/[0.06]'
                      >
                        <span className='w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-white/40'>
                          {stopIndex + 1}
                        </span>
                        <span className='block h-10 w-14 shrink-0 overflow-hidden rounded-[var(--rp-radius)] bg-white/10'>
                          <ResourceThumb slug={slug} id={stop.resourceId} type={stop.type} />
                        </span>
                        <span className='min-w-0 flex-1'>
                          <span className='rp-clamp-2 block text-sm font-medium leading-snug text-white'>
                            {stop.title}
                          </span>
                          {stop.cited
                            ? (
                              <span className='mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300'>
                                <span
                                  aria-hidden='true'
                                  className='h-1.5 w-1.5 rounded-full bg-emerald-400'
                                />
                                Cited in the answer
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
                          <span className='block text-[11px] text-white/40'>confidence</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>

                <div className='mt-7 flex flex-wrap items-center justify-center gap-3'>
                  <button
                    type='button'
                    onClick={() => {
                      setPlaying(!reducedMotion)
                      goTo(-1)
                    }}
                    className='rp-focus-inverse inline-flex items-center gap-2 rounded-[var(--rp-radius-btn)] px-4 py-2 text-sm font-medium text-white/80 ring-1 ring-inset ring-white/15 transition-colors duration-150 hover:bg-white/10 hover:text-white'
                  >
                    <svg
                      viewBox='0 0 20 20'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.6'
                      strokeLinecap='round'
                      aria-hidden='true'
                      className='h-4 w-4'
                    >
                      <path d='M4 10a6 6 0 106-6' />
                      <path d='M4 5.5V10h4.5' />
                    </svg>
                    Replay
                  </button>
                  <button
                    type='button'
                    onClick={onClose}
                    className='rp-focus-inverse inline-flex items-center rounded-[var(--rp-radius-btn)] bg-white px-5 py-2 text-sm font-semibold text-neutral-900 transition-colors duration-150 hover:bg-white/90'
                  >
                    Done
                  </button>
                </div>
              </div>
            )
            : current
            ? (
              <div key={`stop-${index}`} className='rp-anim-fade'>
                {/* Hero band */}
                <div className='relative h-36 w-full overflow-hidden bg-neutral-800 sm:h-52'>
                  <ResourceThumb
                    slug={slug}
                    id={current.resourceId}
                    type={current.type}
                    className={reducedMotion ? '' : 'rp-anim-kenburns'}
                  />
                  <div className='absolute inset-0 bg-gradient-to-t from-neutral-900 via-neutral-900/45 to-neutral-900/10' />

                  {current.cited
                    ? (
                      <span className='absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-[var(--rp-radius-chip)] bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 ring-1 ring-inset ring-emerald-400/30 backdrop-blur-sm'>
                        <span
                          aria-hidden='true'
                          className='h-1.5 w-1.5 rounded-full bg-emerald-400'
                        />
                        Cited in the answer
                      </span>
                    )
                    : null}

                  <div className='absolute inset-x-0 bottom-0 flex items-end gap-3 p-4 sm:p-5'>
                    <div className='min-w-0 flex-1'>
                      <h2 className='rp-display rp-display-bold rp-clamp-2 text-lg text-white sm:text-2xl'>
                        {current.title}
                      </h2>
                      {current.labels.length > 0
                        ? (
                          <div className='rp-no-scrollbar mt-2 flex gap-1.5 overflow-x-auto'>
                            {current.labels.slice(0, 4).map((label) => (
                              <span
                                key={label}
                                className='shrink-0 rounded-[var(--rp-radius-chip)] bg-white/10 px-2.5 py-0.5 text-[11px] font-medium capitalize text-white/75 ring-1 ring-inset ring-white/15 backdrop-blur-sm'
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
                    <p className='rp-eyebrow text-white/40'>What we found here</p>
                    {current.quote
                      ? (
                        <blockquote
                          className='rp-clamp-4 mt-2 border-l-2 pl-4 text-sm leading-relaxed text-white/80'
                          style={{ borderColor: accent }}
                        >
                          &ldquo;{current.quote}&rdquo;
                        </blockquote>
                      )
                      : (
                        <p className='mt-2 text-sm leading-relaxed text-white/45'>
                          This source matched the question overall, but the retrieval step did not
                          single out one passage.
                        </p>
                      )}
                  </section>

                  <section>
                    <p className='rp-eyebrow text-white/40'>
                      {query ? 'How this relates to your question' : 'What this source contributes'}
                    </p>
                    {relationText
                      ? (
                        <p className='rp-prose mt-2 text-sm text-white/85'>
                          {relationText}
                          {relationStatus === 'streaming'
                            ? (
                              <span
                                aria-hidden='true'
                                className='ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-white/60 align-text-bottom'
                              />
                            )
                            : null}
                        </p>
                      )
                      : relationStatus === 'error'
                      ? (
                        <p className='mt-2 text-sm leading-relaxed text-white/45'>
                          We could not reach the answer service for this source. The passage above
                          is still what matched.
                        </p>
                      )
                      : (
                        <p className='mt-2 flex items-center gap-2 text-sm text-white/45'>
                          <span
                            aria-hidden='true'
                            className='h-3.5 w-3.5 animate-spin rounded-full border border-white/20 border-t-white/70'
                          />
                          Asking this source&hellip;
                        </p>
                      )}
                  </section>

                  <Link
                    to={libraryHref(current)}
                    onClick={onClose}
                    className='rp-focus-inverse inline-flex items-center gap-1.5 rounded-[var(--rp-radius-btn)] px-3.5 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-inset ring-white/15 transition-colors duration-150 hover:bg-white/10 hover:text-white'
                  >
                    View in library
                    <ChevronRight />
                  </Link>
                </div>
              </div>
            )
            : null}
        </div>

        {/* Footer: dwell bar, chevrons, dot rail */}
        {total > 0
          ? (
            <div className='shrink-0 border-t border-white/10 px-4 py-3 sm:px-5'>
              <div className='h-[3px] w-full overflow-hidden rounded-full bg-white/10'>
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
                      className='h-full w-1/4 animate-pulse rounded-full bg-white/25'
                      aria-hidden='true'
                    />
                  )
                  : null}
              </div>

              <div className='mt-3 flex items-center justify-between gap-3'>
                <IconButton
                  label='Previous source'
                  onClick={() => goTo(index - 1)}
                  disabled={index <= -1}
                >
                  <ChevronLeft />
                </IconButton>

                <div
                  className='rp-no-scrollbar flex min-w-0 items-center justify-center gap-1.5 overflow-x-auto px-1'
                  role='group'
                  aria-label='Sources in this journey'
                >
                  {stops.map((stop, stopIndex) => {
                    const active = stopIndex === index
                    return (
                      <button
                        key={stop.resourceId}
                        type='button'
                        aria-current={active ? 'true' : undefined}
                        aria-label={`Source ${stopIndex + 1}: ${stop.title}`}
                        onClick={() => goTo(stopIndex)}
                        className='rp-focus-inverse group flex shrink-0 items-center rounded-full p-2'
                      >
                        <span
                          className={`h-1.5 rounded-full transition-all duration-300 ${
                            active ? 'w-6' : 'w-1.5 bg-white/25 group-hover:bg-white/50'
                          }`}
                          style={active ? { backgroundColor: scoreColour(stop.score) } : undefined}
                        />
                      </button>
                    )
                  })}
                </div>

                <IconButton
                  label='Next source'
                  onClick={() => goTo(index + 1)}
                  disabled={index >= total}
                >
                  <ChevronRight />
                </IconButton>
              </div>
            </div>
          )
          : null}
      </div>
    </div>,
    document.body,
  )
}
