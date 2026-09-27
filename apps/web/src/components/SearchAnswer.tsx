import { useAccess } from './AccessProvider.tsx'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import { ApiError, RATE_LIMIT_MESSAGE, streamAsk } from '../api/client.ts'
import { secondsUntilRetry, shouldDeferAutomaticAsk } from '../lib/ask-budget.ts'
import { applyAnswerEvent, EMPTY_ANSWER, type StreamedAnswer } from '../lib/answer-trust.ts'
import { AnswerText, AuditBadge, TruncatedNotice } from './AnswerInline.tsx'
import { CurrencyNote } from './CurrencyNote.tsx'
import { ConfidenceIndicator } from './QualityGauge.tsx'
import { ErrorCard, LiveStatus } from './ui.tsx'
import { StageTimeline, statusesFor, useAnswerPhase } from './StageTimeline.tsx'

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
        Answer paused - showing results only
      </p>
      <p className='mt-1 text-sm leading-relaxed' style={{ color: 'var(--rp-warn-ink)' }}>
        {RATE_LIMIT_MESSAGE}
        {wait > 0 ? ` The portal will take another question in ${wait} s.` : ''}
      </p>
      <button
        type='button'
        onClick={onRun}
        disabled={wait > 0}
        className='rp-btn rp-btn-outline mt-3'
      >
        {wait > 0 ? `Answer in ${wait} s` : 'Answer this search'}
      </button>
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
  const abortRef = useRef<AbortController | null>(null)

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
          : 'The answer service is unavailable.',
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

  const liveMessage = status === 'streaming'
    ? (stageLabel ?? 'Answer in progress')
    : status === 'done'
    ? (refused ? 'No direct evidence found' : 'Answer complete')
    : status === 'error'
    ? 'Answer unavailable'
    : status === 'deferred'
    ? 'Answer paused - results only'
    : ''

  const headerSummary = status === 'streaming'
    ? (stageLabel ?? '')
    : status === 'error'
    ? 'Unavailable'
    : status === 'deferred'
    ? 'Paused'
    : refused
    ? 'No direct evidence found'
    : `${citations.length} ${citations.length === 1 ? 'citation' : 'citations'}`

  const askHref = `/t/${slug}/ask?ask=${encodeURIComponent(trimmed)}`

  return (
    <section className='rp-card p-5' aria-label='AI answer'>
      <LiveStatus message={liveMessage} />
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <span
            className='h-2 w-2 shrink-0 rounded-full'
            style={{ backgroundColor: 'var(--rp-accent)' }}
            aria-hidden='true'
          />
          <p className='rp-eyebrow shrink-0 text-ink-3'>AI answer</p>
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
        <button
          type='button'
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-controls='search-answer-body'
          className='rp-focus inline-flex min-h-6 shrink-0 items-center rounded-[var(--rp-radius)] px-1.5 text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed
        ? (
          <div id='search-answer-body' className='mt-3'>
            {status === 'deferred' ? <DeferredNotice onRun={retry} /> : status === 'error'
              ? (
                <ErrorCard
                  message={errorMessage ?? 'The answer service is unavailable.'}
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
                        <span className='rp-badge rp-badge-quiet'>No direct evidence found</span>
                      </div>
                    )
                    : null}

                  {text.length > 0
                    ? (
                      <div className='rp-answer-in rp-prose text-sm text-ink'>
                        <AnswerText
                          text={text}
                          citations={citations}
                          sources={sources}
                          slug={slug}
                          audit={audit}
                          streaming={status === 'streaming'}
                          bodyClassName='text-sm leading-relaxed text-ink'
                        />
                      </div>
                    )
                    : null}

                  {status === 'done' && answer.truncated
                    ? <TruncatedNotice onAskAgain={retry} className='rp-answer-in mt-3' />
                    : null}

                  {
                    /* Confidence, what the audit checked, citation count and
                    * source range read as one fact about the answer, so they
                    * sit on one line and arrive together rather than stacking
                    * up as separate rows. Confidence reads the audit exactly as
                    * Ask's does, so the same answer is rated the same here. */
                  }
                  {status === 'done' && !refused
                    ? (
                      <div className='rp-answer-in mt-3 flex flex-wrap items-center gap-x-4 gap-y-2'>
                        <ConfidenceIndicator quality={quality} audit={audit} />
                        <AuditBadge audit={audit} />
                        <p className='text-xs text-ink-3'>{citations.length} cited</p>
                        <CurrencyNote
                          sources={sources.filter((source) =>
                            citations.some((citation) => citation.resourceId === source.id)
                          )}
                        />
                      </div>
                    )
                    : null}
                </>
              )}

            <div className='mt-4 flex justify-end border-t border-line pt-3'>
              <Link
                to={askHref}
                className='rp-chip inline-flex h-9 items-center gap-1.5 font-semibold sm:h-7'
              >
                Continue in Ask
                <span aria-hidden='true'>&rarr;</span>
              </Link>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
