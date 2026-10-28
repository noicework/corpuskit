import { AnswerRecordLink } from './AnswerRecordLink.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from './AccessProvider.tsx'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import { ApiError, RATE_LIMIT_MESSAGE, sendAnswerFeedback, streamAsk } from '../api/client.ts'
import { secondsUntilRetry, shouldDeferAutomaticAsk } from '../lib/ask-budget.ts'
import { applyAnswerEvent, EMPTY_ANSWER, type StreamedAnswer } from '../lib/answer-trust.ts'
import { AnswerText, AuditBadge, TruncatedNotice } from './AnswerInline.tsx'
import { CurrencyNote } from './CurrencyNote.tsx'
import { ConfidenceIndicator } from './QualityGauge.tsx'
import { Button, ErrorCard, IconButton, LiveStatus } from './ui.tsx'
import { StageTimeline, statusesFor, useAnswerPhase } from './StageTimeline.tsx'
import { ArrowRight, Check, Copy, Eye, EyeOff, RotateCw, ThumbsDown, ThumbsUp } from './icons.tsx'

/** Matches AskPage's own stage copy, duplicated here (not exported there). */
const STAGE_LABELS: Record<string, string> = {
  preprocessing: 'Preparing your question…',
  retrieval: 'Retrieving sources…',
  generating: 'Generating…',
  validating: 'Checking the answer…',
}

type Status = 'idle' | 'streaming' | 'done' | 'error' | 'deferred'

export interface SearchAnswerResult {
  citations: Citation[]
  sources: ScoredResource[]
}

export interface SearchAnswerProps {
  slug: string
  /**
   * The submitted (not draft) search query - a stream starts only when this
   * changes, and never at all while it is empty, so an unsearched page costs
   * nothing.
   */
  query: string
  /**
   * Fires whenever the streamed answer's citations or sources change -
   * including back to empty arrays the moment a new query starts - so the
   * result cards above/below can show "Cited [n]" badges and power the
   * Resources/Citations toggle without re-implementing the stream.
   */
  onResult?: (result: SearchAnswerResult) => void
}

/**
 * The AI Answer panel on the search results page: a streamed, cited answer for
 * the same query the results below are for. This is the DEFAULT state of a
 * search that has a query - the page mounts it without being asked, and only an
 * explicit "Results only" opt-out (`?answer=0`) unmounts it. An empty query
 * still streams nothing, so the unsearched page spends no LLM call. Collapsible,
 * honest about refusal (the portal's "no direct evidence" pattern rather than a
 * fake answer), surfaces rate-limiting plainly, and always offers a path to
 * continue the same question in Ask.
 *
 * Deliberately its own small stream state machine rather than reusing
 * `AnswerStream` - this panel needs to branch on `refused` and turn a 429
 * into the portal's rate-limit copy, which the shared component does not
 * do. Reports citations/sources up
 * via `onResult` so SearchPage can badge result cards and power the
 * Resources/Citations toggle without duplicating the stream itself.
 */
/**
 * The results-only fallback: the automatic answer stood down because the ask
 * budget is nearly spent or the server asked us to wait. Says so plainly, with
 * the wait when there is one, and lets the reader run it anyway.
 */
function DeferredNotice({ onRun }: { onRun: () => void }) {
  const { ui } = usePortalLocale()
  const [wait, setWait] = useState(secondsUntilRetry())
  useEffect(() => {
    if (wait <= 0) return
    const timer = setInterval(() => setWait(secondsUntilRetry()), 500)
    return () => clearInterval(timer)
  }, [wait])
  return (
    <div
      role='status'
      className='rounded-[var(--rp-radius)] border p-4'
      style={{ borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
    >
      <p className='text-sm font-medium' style={{ color: 'var(--rp-warn-ink)' }}>
        {ui('Answer paused - showing results only')}
      </p>
      <p className='mt-1 text-sm leading-relaxed' style={{ color: 'var(--rp-warn-ink)' }}>
        {ui(RATE_LIMIT_MESSAGE)}
        {wait > 0 ? ui(' The portal will take another question in {wait} s.', { wait: wait }) : ''}
      </p>
      <Button
        variant='outline'
        leadingIcon={RotateCw}
        onClick={onRun}
        disabled={wait > 0}
        className='mt-3'
      >
        {wait > 0 ? ui('Answer in {wait} s', { wait: wait }) : ui('Answer this search')}
      </Button>
    </div>
  )
}

export function SearchAnswer(props: SearchAnswerProps) {
  const access = useAccess()
  return access.can('portal.ask', { kind: 'portal', slug: props.slug })
    ? <PermittedSearchAnswer key={`${access.generation}:${props.slug}:${props.query}`} {...props} />
    : null
}

function PermittedSearchAnswer({ slug, query, onResult }: SearchAnswerProps) {
  const { ui } = usePortalLocale()
  const access = useAccess()
  const context = access.controller.context
  const canAsk = () =>
    access.controller.context === context &&
    access.controller.can('portal.ask', { kind: 'portal', slug })
  const [status, setStatus] = useState<Status>('idle')
  // Folded by the same reducer as Ask (lib/answer-trust.ts), so the audit,
  // quality and truncation this panel shows are the ones Ask would show.
  const [answer, setAnswer] = useState<StreamedAnswer>(EMPTY_ANSWER)
  const { text, sources, citations, quality, audit } = answer
  const refused = answer.refused === true
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [stageLabel, setStageLabel] = useState<string | null>(null)
  const [activeStage, setActiveStage] = useState<AskStage | null>(null)
  const [seenStages, setSeenStages] = useState<Set<AskStage>>(() => new Set())
  const [collapsed, setCollapsed] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [answerRecordId, setAnswerRecordId] = useState<string | null>(null)
  const [learningId, setLearningId] = useState<string | null>(null)
  const [rating, setRating] = useState<boolean | null>(null)
  const [ratingBusy, setRatingBusy] = useState(false)
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
  }, [])

  const trimmed = query.trim()
  const key = `${slug}|${trimmed}|${retryToken}`

  // Stream (or reset) whenever the submitted query, tenant or retry token
  // changes. Aborts any in-flight stream first - covers both a genuinely new
  // query and unmount, since the effect cleanup runs the same abort.
  useEffect(() => {
    abortRef.current?.abort()
    if (!canAsk()) return

    if (trimmed.length === 0) {
      setStatus('idle')
      setAnswer(EMPTY_ANSWER)
      setErrorMessage(null)
      setStageLabel(null)
      return
    }

    setAnswer(EMPTY_ANSWER)
    setErrorMessage(null)
    setStageLabel(null)
    setActiveStage(null)
    setSeenStages(new Set())
    setLearningId(null)
    setAnswerRecordId(null)
    setRating(null)
    setRatingBusy(false)
    setRatingError(null)
    setCopied(false)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)

    // This summary runs by itself on every search and shares the reader's
    // ask budget. Near the limit, or while the server has asked us to wait,
    // it stands down so the results still load and the reader's own next
    // ask is not the one refused. A retry click (retryToken) always runs.
    if (retryToken === 0 && shouldDeferAutomaticAsk()) {
      setStatus('deferred')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('streaming')

    streamAsk(slug, { query: trimmed }, (event: AskEvent) => {
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      setAnswer((prev) => applyAnswerEvent(prev, event))
      switch (event.type) {
        case 'answer-record':
          setAnswerRecordId(event.answerId)
          break
        case 'learning':
          setLearningId(event.id)
          break
        case 'stage':
          setStageLabel(event.status === 'started' ? STAGE_LABELS[event.stage] ?? null : null)
          if (event.status === 'started') {
            setActiveStage(event.stage)
          } else {
            setSeenStages((prev) => new Set(prev).add(event.stage))
          }
          break
        case 'done':
          setStageLabel(null)
          setStatus('done')
          break
        case 'error':
          setStageLabel(null)
          setErrorMessage(event.message)
          setStatus('error')
          break
        default:
          break
      }
    }, controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      setStageLabel(null)
      setErrorMessage(
        err instanceof ApiError && err.status === 429
          ? RATE_LIMIT_MESSAGE
          : err instanceof Error
          ? err.message
          : ui('The answer service is unavailable.'),
      )
      setStatus('error')
    })

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (canAsk() && !abortRef.current?.signal.aborted) onResult?.({ citations, sources })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citations, sources])

  // Must sit above the early return below: a hook after a conditional return
  // changes the hook count between renders (React error #310).
  const phase = useAnswerPhase(text.length > 0, status === 'streaming' || status === 'done')

  if (status === 'idle') return null

  function retry() {
    if (!canAsk()) return
    setRetryToken((prev) => prev + 1)
  }

  async function rate(good: boolean) {
    const controller = abortRef.current
    if (!learningId || !controller || controller.signal.aborted || !canAsk()) return
    setRatingBusy(true)
    setRatingError(null)
    try {
      await sendAnswerFeedback(slug, { learningId, good }, controller.signal)
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      setRating(good)
    } catch {
      if (controller.signal.aborted || abortRef.current !== controller || !canAsk()) return
      setRatingError(ui('Could not send feedback - try again.'))
    } finally {
      if (!controller.signal.aborted && abortRef.current === controller && canAsk()) {
        setRatingBusy(false)
      }
    }
  }

  async function copyAnswer() {
    const controller = abortRef.current
    try {
      await navigator.clipboard.writeText(text)
      if (!controller || controller.signal.aborted || abortRef.current !== controller) return
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // The answer remains available to select when clipboard access is refused.
    }
  }

  const liveMessage = status === 'streaming'
    ? (stageLabel ? ui(stageLabel) : ui('Answer in progress'))
    : status === 'done'
    // Once, on completion, with the counts that appear beside it (WCAG 4.1.3).
    ? (refused
      ? ui('No direct evidence found')
      : `${ui('Answer complete')} ${
        ui('{retrieved} sources retrieved, {cited} cited.', {
          retrieved: sources.length,
          cited: citations.length,
        })
      }`)
    : status === 'error'
    ? ui('Answer unavailable')
    : status === 'deferred'
    ? ui('Answer paused - results only')
    : ''

  const headerSummary = status === 'streaming'
    ? (stageLabel ? ui(stageLabel) : '')
    : status === 'error'
    ? ui('Unavailable')
    : status === 'deferred'
    ? ui('Paused')
    : refused
    ? ui('No direct evidence found')
    : ui(citations.length === 1 ? '{count} citation' : '{count} citations', {
      count: citations.length,
    })

  const askHref = `/t/${slug}/ask?ask=${encodeURIComponent(trimmed)}`

  return (
    <section className='rp-card min-w-0 p-5 lg:p-6' aria-label={ui('AI answer')}>
      <LiveStatus message={liveMessage} />
      <LiveStatus
        message={copied
          ? ui('Answer copied')
          : rating !== null
          ? ui('Thanks - your feedback was sent.')
          : ''}
      />
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <span
            className='h-2 w-2 shrink-0 rounded-full'
            style={{ backgroundColor: 'var(--rp-accent)' }}
            aria-hidden='true'
          />
          <p className='rp-eyebrow shrink-0 text-ink-3'>{ui('AI answer')}</p>
          {collapsed
            ? (
              <p className='flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-3'>
                &middot; {headerSummary}
                {status === 'streaming'
                  ? (
                    <span className='rp-dots' aria-hidden='true'>
                      <span />
                      <span />
                      <span />
                    </span>
                  )
                  : null}
              </p>
            )
            : null}
        </div>
        <Button
          variant='ghost'
          size='sm'
          leadingIcon={collapsed ? Eye : EyeOff}
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-controls='search-answer-body'
          className='shrink-0'
        >
          {collapsed ? ui('Show') : ui('Hide')}
        </Button>
      </div>

      {!collapsed
        ? (
          <div id='search-answer-body' className='mt-3'>
            {status === 'deferred' ? <DeferredNotice onRun={retry} /> : status === 'error'
              ? (
                <ErrorCard
                  message={errorMessage ?? ui('The answer service is unavailable.')}
                  onRetry={retry}
                />
              )
              : status === 'streaming' && phase !== 'answer'
              ? (
                <StageTimeline
                  statuses={statusesFor(activeStage, seenStages)}
                  exiting={phase === 'handoff'}
                />
              )
              : (
                <>
                  {refused
                    ? (
                      <div className='mb-3'>
                        <span className='rp-badge rp-badge-quiet'>
                          {ui('No direct evidence found')}
                        </span>
                      </div>
                    )
                    : null}

                  {text.length > 0
                    ? (
                      <div className='rp-measure rp-answer-in rp-prose text-base text-ink sm:text-sm'>
                        <AnswerText
                          text={text}
                          citations={citations}
                          sources={sources}
                          slug={slug}
                          audit={audit}
                          streaming={status === 'streaming'}
                          bodyClassName='text-base leading-relaxed text-ink sm:text-sm'
                        />
                      </div>
                    )
                    : null}

                  {status === 'done' && answer.truncated
                    ? <TruncatedNotice onAskAgain={retry} className='rp-answer-in mt-3' />
                    : null}

                  {status === 'done' && !refused
                    ? (
                      <div className='rp-answer-in mt-3 flex flex-wrap items-center gap-x-4 gap-y-2'>
                        <AuditBadge audit={audit} />
                        <p className='text-xs text-ink-3'>{citations.length} {ui('cited')}</p>
                        <CurrencyNote
                          sources={sources.filter((source) =>
                            citations.some((citation) => citation.resourceId === source.id)
                          )}
                        />
                      </div>
                    )
                    : null}

                  {status === 'done'
                    ? (
                      <>
                        <div
                          role='group'
                          aria-label={ui('AI answer')}
                          className='rp-library-answer-toolbar mt-4 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line pt-3'
                        >
                          <div className='rp-library-answer-confidence min-w-0 flex-auto'>
                            <ConfidenceIndicator quality={quality} audit={audit} />
                            <AnswerRecordLink slug={slug} answerId={answerRecordId} />
                          </div>
                          <div className='ml-auto flex max-w-full shrink-0 items-center justify-end'>
                            <IconButton
                              label={ui('Helpful answer')}
                              icon={ThumbsUp}
                              size='sm'
                              onClick={() => void rate(true)}
                              disabled={!learningId || ratingBusy || rating !== null}
                              aria-pressed={rating === true}
                            />
                            <IconButton
                              label={ui('Not a helpful answer')}
                              icon={ThumbsDown}
                              size='sm'
                              onClick={() => void rate(false)}
                              disabled={!learningId || ratingBusy || rating !== null}
                              aria-pressed={rating === false}
                            />
                            <IconButton
                              label={copied ? ui('Answer copied') : ui('Copy the answer')}
                              icon={copied ? Check : Copy}
                              size='sm'
                              onClick={() => void copyAnswer()}
                              disabled={text.trim().length === 0}
                            />
                            <IconButton
                              label={ui('Ask this again')}
                              icon={RotateCw}
                              size='sm'
                              onClick={retry}
                            />
                          </div>
                        </div>
                        {ratingError
                          ? (
                            <p role='alert' className='mt-2 text-xs text-[var(--rp-bad-ink)]'>
                              {ratingError}
                            </p>
                          )
                          : null}
                      </>
                    )
                    : null}
                </>
              )}

            <div className='mt-3 flex justify-end'>
              <Link
                to={askHref}
                className='rp-link-standalone text-sm font-semibold'
              >
                {ui('Continue in Ask')}
                <ArrowRight size='sm' />
              </Link>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
