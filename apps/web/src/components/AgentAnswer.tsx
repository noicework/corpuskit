import { type ReactNode, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  activeStep,
  type AgentAskState,
  type AgentCitation,
  citationHref,
  citedSources,
  clockLabel,
  durationLabel,
  sourceKindLabel,
  splitAnswerMarkers,
} from '../lib/agent-ask-state.ts'
import { placeMarkersAfterPunctuation } from '../lib/answer-text.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { EvidenceDisclosure } from './AnswerStream.tsx'
import { AlertTriangle, RotateCcw } from './icons.tsx'
import { sourceFailureSentence } from './AgentSources.tsx'
import { Button } from './ui.tsx'

/** The mode line: who wrote the answer, said plainly and never as more than it is. */
export function AgentModeBadge({ state }: { state: Pick<AgentAskState, 'mode' | 'sources'> }) {
  const { ui } = usePortalLocale()
  if (state.mode === 'agent') {
    return <span className='rp-agent-tag' data-agent-mode='agent'>{ui('Research agent')}</span>
  }
  if (state.mode === 'orchestrated') {
    const count = state.sources.length
    return (
      <span className='rp-agent-tag' data-agent-mode='orchestrated'>
        {count === 1
          ? ui('Composed by CorpusKit from 1 collection')
          : ui('Composed by CorpusKit across {count} collections', { count })}
      </span>
    )
  }
  return null
}

/** Bold runs and citation markers within one run of answer text. */
function renderInline(
  text: string,
  renderMarker: (marker: string, key: string) => ReactNode,
  keyPrefix: string,
): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, index): ReactNode[] => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return [
        <strong key={key}>{renderMarkers(part.slice(2, -2), renderMarker, key)}</strong>,
      ]
    }
    return renderMarkers(part, renderMarker, key)
  })
}

function renderMarkers(
  text: string,
  renderMarker: (marker: string, key: string) => ReactNode,
  keyPrefix: string,
): ReactNode[] {
  return splitAnswerMarkers(text).map((segment, index) => {
    const key = `${keyPrefix}-${index}`
    return segment.kind === 'marker'
      ? renderMarker(segment.marker, key)
      : <span key={key}>{segment.text}</span>
  })
}

function CitationMark(
  { number, citation, href }: {
    number: number
    citation: AgentCitation | undefined
    href: string | undefined
  },
) {
  const { ui } = usePortalLocale()
  if (!citation) {
    // Its citation has not arrived yet: numbered already, so nothing shifts when it lands.
    return (
      <sup className='rp-agent-marker rp-agent-marker-pending' title={ui('Citation arriving')}>
        <span className='sr-only'>{ui('Source {index}', { index: number })}</span>
        <span aria-hidden='true'>{number}</span>
      </sup>
    )
  }
  const label = ui('Source {index}, {value2}', { index: number, value2: citation.title })
  if (!href) {
    return (
      <sup className='rp-agent-marker'>
        <span className='sr-only'>{label}</span>
        <span aria-hidden='true'>{number}</span>
      </sup>
    )
  }
  const className = 'rp-agent-marker rp-agent-marker-link rp-focus'
  return (
    <sup>
      {href.startsWith('/')
        ? <Link to={href} aria-label={label} className={className}>{number}</Link>
        : (
          <a
            href={href}
            target='_blank'
            rel='noopener noreferrer'
            aria-label={label}
            className={className}
          >
            {number}
          </a>
        )}
    </sup>
  )
}

function CitationChip(
  { number, citation, href }: {
    number: number
    citation: AgentCitation
    href: string | undefined
  },
) {
  const { ui } = usePortalLocale()
  const title = citation.title.trim() || ui('Untitled passage')
  const inner = (
    <>
      <span
        className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold'
        style={{ backgroundColor: 'var(--rp-accent)', color: 'var(--rp-on-accent)' }}
      >
        {number}
      </span>
      <span className='flex min-w-0 flex-col leading-tight sm:max-w-[16rem]'>
        <span className='truncate'>{title}</span>
      </span>
    </>
  )
  const className = 'rp-chip rp-answer-chip h-auto py-1'
  if (!href) {
    return (
      <span
        className={`${className} cursor-default`}
        title={ui('This partner does not link to its documents')}
      >
        {inner}
      </span>
    )
  }
  if (href.startsWith('/')) {
    return <Link to={href} title={title} className={className}>{inner}</Link>
  }
  return (
    <a href={href} target='_blank' rel='noopener noreferrer' title={title} className={className}>
      {inner}
      <span className='sr-only'>({ui('opens in a new tab')})</span>
    </a>
  )
}

/**
 * The answer card: who is answering, how long it has been, the failed-source notice, the
 * answer as it streams with its numbered citations, the agent's reasoning under it, and the
 * cited passages grouped by collection. The end states keep whatever arrived.
 */
export function AgentAnswer(
  { state, question, elapsedMs, numbers, onRetry }: {
    state: AgentAskState
    question: string
    elapsedMs: number
    /** Each citation marker's display number (`citationNumbers`), shared with the rail. */
    numbers: ReadonlyMap<string, number>
    onRetry: () => void
  },
) {
  const { ui, error: localError } = usePortalLocale()
  const units = { seconds: ui('s'), minutes: ui('min') }
  // Markers sit after the punctuation they follow, as every answer in the portal reads.
  const text = useMemo(() => placeMarkersAfterPunctuation(state.text), [state.text])
  const byMarker = useMemo(
    () => new Map(state.citations.map((citation) => [citation.marker, citation])),
    [state.citations],
  )
  const [reasoningOpen, setReasoningOpen] = useState(true)
  const streaming = state.status === 'streaming'
  const hasText = state.text.trim().length > 0
  const current = activeStep(state.steps)
  const reasoning = state.reasoningOpen.trim()
    ? [...state.reasoning, state.reasoningOpen]
    : state.reasoning

  const renderMarker = (marker: string, key: string) => {
    const citation = byMarker.get(marker)
    return (
      <CitationMark
        key={key}
        number={numbers.get(marker) ?? 0}
        citation={citation}
        href={citation ? citationHref(state, citation) : undefined}
      />
    )
  }

  const cited = citedSources(state)
  const remaining = state.sources.length - state.failedSources.length

  return (
    <article
      aria-labelledby='agent-answer-heading'
      className='rp-card rp-agent-answer p-5 sm:p-6'
      data-agent-answer
      data-status={state.status}
    >
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <span className='flex items-center gap-2'>
          <span
            className='h-2 w-2 shrink-0 rounded-full'
            style={{ backgroundColor: 'var(--rp-accent)' }}
            aria-hidden='true'
          />
          <h2 id='agent-answer-heading' className='rp-eyebrow text-ink-3'>{ui('Cited answer')}</h2>
        </span>
        <AgentModeBadge state={state} />
        <span className='ml-auto text-xs tabular-nums text-ink-2' data-agent-clock>
          {streaming
            ? (
              <>
                <span className='sr-only'>{ui('Elapsed')}</span> {clockLabel(elapsedMs)}
              </>
            )
            : state.status === 'done'
            ? ui('Answered in {duration}', {
              duration: durationLabel(state.elapsedMs ?? elapsedMs, units),
            })
            : null}
        </span>
      </div>
      <p className='sr-only'>{ui('Question')}: {question}</p>

      {state.failedSources.length > 0
        ? (
          <div className='rp-agent-notice rp-agent-notice-warn mt-4' data-agent-failed-sources>
            <AlertTriangle size='sm' className='mt-0.5 shrink-0' />
            <div className='min-w-0'>
              <ul className='space-y-0.5'>
                {state.failedSources.map((source) => (
                  <li key={source.id} className='text-sm leading-relaxed'>
                    <span className='font-semibold'>{source.label}</span>{' '}
                    {sourceFailureSentence(source.reason, ui)}
                  </li>
                ))}
              </ul>
              <p className='mt-1 text-sm leading-relaxed'>
                {remaining === 1
                  ? ui('The answer draws on the one remaining collection.')
                  : ui('The answer draws on the other {count} collections.', { count: remaining })}
              </p>
            </div>
          </div>
        )
        : null}

      {streaming && !hasText
        ? (
          <div className='mt-4 flex items-center gap-3 text-sm text-ink-2' data-agent-waiting>
            <span
              aria-hidden='true'
              className='rp-stage-spin h-4 w-4 shrink-0 rounded-full border-2 border-current border-t-transparent'
            />
            <span aria-hidden='true'>
              {current ? current.title : state.mode === null ? ui('Connecting') : ui('Working')}
            </span>
          </div>
        )
        : null}

      {hasText
        ? (
          <div className='rp-answer-in rp-prose mt-4 text-base text-ink sm:text-sm' data-agent-text>
            <AnswerMarkdown
              text={text}
              renderInline={(run, keyPrefix) => renderInline(run, renderMarker, keyPrefix)}
              bodyClassName='rp-measure leading-relaxed'
            />
            {streaming
              ? (
                <span className='rp-dots ml-1' aria-hidden='true'>
                  <span />
                  <span />
                  <span />
                </span>
              )
              : null}
          </div>
        )
        : null}

      {state.status === 'done' && !hasText
        ? (
          <div className='rp-agent-notice rp-agent-notice-warn mt-4' role='status'>
            <AlertTriangle size='sm' className='mt-0.5 shrink-0' />
            <div>
              <p className='text-sm font-semibold'>{ui('No direct evidence found')}</p>
              <p className='mt-1 text-sm leading-relaxed'>
                {ui(
                  'The collections searched do not support an answer to this question. Try a question closer to what they cover.',
                )}
              </p>
            </div>
          </div>
        )
        : null}

      {state.status === 'error' && state.error
        ? (
          <div className='rp-agent-notice rp-agent-notice-bad mt-4' role='alert' data-agent-error>
            <AlertTriangle size='sm' className='mt-0.5 shrink-0' />
            <div className='min-w-0'>
              <p className='text-sm font-semibold'>
                {state.error.code === 'timeout'
                  ? ui('No answer in time')
                  : state.error.code === 'not_configured'
                  ? ui('Agent ask is not set up on this portal')
                  : state.error.code === 'cancelled'
                  ? ui('The answer was stopped')
                  : ui('The answer could not be finished')}
              </p>
              <p className='mt-1 text-sm leading-relaxed'>
                {localError(state.error.message, 'The portal could not finish the answer.')}
              </p>
              {hasText
                ? (
                  <p className='mt-1 text-sm leading-relaxed'>
                    {ui('The text above is what arrived before it stopped; it may be incomplete.')}
                  </p>
                )
                : null}
              {state.error.retryable
                ? (
                  <Button
                    variant='outline'
                    leadingIcon={RotateCcw}
                    onClick={onRetry}
                    className='rp-agent-target mt-3'
                  >
                    {ui('Try again')}
                  </Button>
                )
                : null}
            </div>
          </div>
        )
        : null}

      {state.status === 'cancelled'
        ? (
          <div className='rp-agent-notice mt-4' role='status' data-agent-cancelled>
            <div className='min-w-0'>
              <p className='text-sm font-semibold text-ink'>{ui('Stopped')}</p>
              <p className='mt-1 text-sm leading-relaxed text-ink-2'>
                {hasText
                  ? ui(
                    'The text above is what arrived before you stopped it; it may be incomplete.',
                  )
                  : ui('Everything that had arrived is kept.')}
              </p>
              <Button
                variant='outline'
                leadingIcon={RotateCcw}
                onClick={onRetry}
                className='rp-agent-target mt-3'
              >
                {ui('Ask again')}
              </Button>
            </div>
          </div>
        )
        : null}

      {reasoning.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <EvidenceDisclosure
              regionId='agent-reasoning'
              open={reasoningOpen}
              onToggle={() => setReasoningOpen((prev) => !prev)}
              label={ui('reasoning')}
              summary={reasoning.length === 1
                ? ui('1 note')
                : ui('{count} notes', { count: reasoning.length })}
              heading
            >
              <div className='rp-agent-reasoning space-y-2' data-agent-reasoning>
                {reasoning.map((run, index) => (
                  <p key={index} className='text-sm leading-relaxed text-ink-2'>
                    {run}
                    {streaming && index === reasoning.length - 1 && state.reasoningOpen.trim()
                      ? (
                        <span className='rp-dots ml-1' aria-hidden='true'>
                          <span />
                          <span />
                          <span />
                        </span>
                      )
                      : null}
                  </p>
                ))}
              </div>
            </EvidenceDisclosure>
          </div>
        )
        : null}

      {state.citations.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4' data-agent-citations>
            <h3 className='rp-eyebrow text-ink-3'>
              {state.citations.length === 1
                ? ui('1 citation')
                : ui('{count} citations', { count: state.citations.length })}
            </h3>
            <ul className='mt-3 space-y-3'>
              {cited.map((group) => {
                const kind = sourceKindLabel(group.source)
                const own = state.citations.filter((citation) =>
                  citation.sourceId === group.source.id
                )
                return (
                  <li key={group.source.id}>
                    <p className='text-xs font-semibold text-ink'>
                      {group.source.label}
                      {kind
                        ? <span className='font-normal text-ink-2'>&middot; {ui(kind)}</span>
                        : null}
                    </p>
                    <ul className='mt-1.5 flex flex-wrap gap-2'>
                      {own.map((citation) => (
                        <li key={citation.marker} className='min-w-0 max-w-full'>
                          <CitationChip
                            number={numbers.get(citation.marker) ?? 0}
                            citation={citation}
                            href={citationHref(state, citation)}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </div>
        )
        : null}
    </article>
  )
}
