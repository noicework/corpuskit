import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AgentChunk, AgentSource } from '@research-portal/core'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  type AgentAskStatus,
  type AgentCitation,
  type AgentSourceGroup,
  type AgentStep,
  chunkHref,
  passageCount,
  type SourceFailure,
  sourceKindLabel,
  sourceState,
} from '../lib/agent-ask-state.ts'
import { ArrowRight, ExternalLink, FileText } from './icons.tsx'

/** The reader's sentence for a source that could not be searched. */
export function sourceFailureSentence(reason: SourceFailure, ui: (text: string) => string): string {
  switch (reason) {
    case 'timeout':
      return ui('Did not answer in time.')
    case 'unauthorised':
      return ui('This partner could not be reached.')
    case 'error':
      return ui('Could not be searched.')
  }
}

/**
 * One passage, in the shape the Ask page gives a retrieved source: the citation numbers it
 * carries, the document cue, its title, the passage, and a plain "open" line. A portal resource
 * of this deployment opens in the library; a passage with its own address opens in a new tab;
 * a federated partner's passage opens nowhere, by the partner's choice.
 */
export function PassageCard(
  { source, chunk, numbers }: {
    source: AgentSource
    chunk: AgentChunk
    /** The numbers the answer cites this passage as, in order; empty when it is not cited. */
    numbers: readonly number[]
  },
) {
  const { ui } = usePortalLocale()
  const title = chunk.title.trim() || ui('Untitled passage')
  const href = chunkHref(source, chunk)
  const internal = href?.startsWith('/') === true
  const titleClass =
    'rp-answer-source-title rp-link-standalone min-w-0 flex-1 text-sm font-medium text-ink underline-offset-2 hover:underline'
  const openClass =
    'rp-answer-source-link rp-link-standalone rp-agent-target min-w-0 gap-1 text-xs font-medium hover:underline'
  return (
    <li
      className='rp-agent-passage rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'
      data-cited={numbers.length > 0 ? 'true' : undefined}
    >
      <div className='flex min-w-0 items-start gap-1.5'>
        <FileText size='sm' className='mt-0.5 shrink-0 text-ink-3' />
        {href && internal
          ? (
            <Link to={href} className={titleClass}>
              <span className='rp-clamp-2'>{title}</span>
            </Link>
          )
          : href
          ? (
            <a href={href} target='_blank' rel='noopener noreferrer' className={titleClass}>
              <span className='rp-clamp-2'>{title}</span>
              <span className='sr-only'>({ui('opens in a new tab')})</span>
            </a>
          )
          : (
            <span className='min-w-0 flex-1 text-sm font-medium text-ink'>
              <span className='rp-clamp-2'>{title}</span>
            </span>
          )}
        {/* After the title, so the title holds still as citations land. */}
        {numbers.length > 0
          ? (
            <span className='mt-0.5 flex shrink-0 items-center gap-1'>
              {numbers.map((n) => (
                <span
                  key={n}
                  className='inline-flex min-h-[1.25rem] min-w-[1.25rem] items-center justify-center rounded-full px-1 text-2xs font-semibold text-[var(--rp-on-accent)]'
                  style={{ backgroundColor: 'var(--rp-accent)' }}
                >
                  {n}
                </span>
              ))}
            </span>
          )
          : null}
      </div>
      {chunk.text.trim()
        ? <p className='rp-clamp-3 mt-1.5 text-xs leading-relaxed text-ink-2'>{chunk.text}</p>
        : null}
      {href
        ? (
          <div className='mt-1.5'>
            {internal
              ? (
                <Link
                  to={href}
                  className={openClass}
                  aria-label={`${ui('Open in the Library')}: ${title}`}
                >
                  {ui('Open in the Library')}
                  <ArrowRight size='sm' className='shrink-0' />
                </Link>
              )
              : (
                <a
                  href={href}
                  target='_blank'
                  rel='noopener noreferrer'
                  className={openClass}
                  aria-label={`${ui('Open the document')}: ${title} (${ui('opens in a new tab')})`}
                >
                  {ui('Open the document')}
                  <ExternalLink size='sm' className='shrink-0' />
                </a>
              )}
          </div>
        )
        : null}
    </li>
  )
}

function SourceBadge(
  { group, steps, status }: {
    group: AgentSourceGroup
    steps: readonly AgentStep[]
    status: AgentAskStatus
  },
) {
  const { ui } = usePortalLocale()
  const state = sourceState(group, steps)
  const count = passageCount(group)
  if (state === 'failed') {
    return (
      <span className='rp-badge rp-badge-warn'>
        {group.failed === 'timeout'
          ? ui('Timed out')
          : group.failed === 'unauthorised'
          ? ui('Not reached')
          : ui('Failed')}
      </span>
    )
  }
  if (state === 'searching') {
    return (
      <span className='rp-agent-tag'>
        <span
          aria-hidden='true'
          className='rp-stage-spin h-3 w-3 rounded-full border-2 border-current border-t-transparent'
        />
        {ui('Searching')}
      </span>
    )
  }
  if (state === 'found' || count > 0) {
    return (
      <span className='rp-agent-tag'>
        {count === 1 ? ui('1 passage') : ui('{count} passages', { count })}
      </span>
    )
  }
  const searched = group.lookups.length > 0
  return (
    <span className='rp-agent-tag'>
      {searched
        ? ui('No passages found')
        : status === 'streaming'
        ? ui('Not searched yet')
        : ui('Not searched')}
    </span>
  )
}

/** The numbers the answer cites a passage as, from the citations and their display numbers. */
function citedAs(
  sourceId: string,
  chunkId: string,
  citations: readonly AgentCitation[],
  numbers: ReadonlyMap<string, number>,
): number[] {
  return citations
    .filter((citation) => citation.sourceId === sourceId && citation.chunkId === chunkId)
    .map((citation) => numbers.get(citation.marker) ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
}

function SourceCard(
  { group, steps, status, citations, numbers }: {
    group: AgentSourceGroup
    steps: readonly AgentStep[]
    status: AgentAskStatus
    citations: readonly AgentCitation[]
    numbers: ReadonlyMap<string, number>
  },
) {
  const { ui } = usePortalLocale()
  const kind = sourceKindLabel(group.source)
  return (
    <li
      className='rp-agent-source rounded-[var(--rp-radius)] border border-line bg-surface p-3'
      data-source-id={group.source.id}
      data-source-state={sourceState(group, steps)}
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <h3 className='text-sm font-semibold leading-snug text-ink'>{group.source.label}</h3>
          {kind
            ? <p className='mt-0.5 text-xs text-ink-2' data-source-kind={kind}>{ui(kind)}</p>
            : null}
        </div>
        <SourceBadge group={group} steps={steps} status={status} />
      </div>
      {group.lookups.map((lookup) => (
        <div key={lookup.stepId} className='mt-2.5'>
          {lookup.question
            ? (
              <p className='text-xs italic leading-relaxed text-ink-2'>
                <span className='not-italic font-medium'>{ui('Searched for')}</span>{' '}
                {lookup.question}
              </p>
            )
            : null}
          {lookup.chunks.length > 0
            ? (
              <ul className='mt-1.5 grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3'>
                {lookup.chunks.map((chunk) => (
                  <PassageCard
                    key={chunk.id}
                    source={group.source}
                    chunk={chunk}
                    numbers={citedAs(group.source.id, chunk.id, citations, numbers)}
                  />
                ))}
              </ul>
            )
            : null}
        </div>
      ))}
      {group.failed
        ? (
          <p className='mt-2 text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
            {sourceFailureSentence(group.failed, ui)}
          </p>
        )
        : null}
    </li>
  )
}

/**
 * The collections the answer draws on, one card each, filling in as the agent searches them:
 * the question it put to the collection, the passages that came back (titles linking to the
 * document), and a plain word when one could not be searched.
 */
export function AgentSources(
  { sources, steps, status, citations, numbers, children }: {
    sources: readonly AgentSourceGroup[]
    steps: readonly AgentStep[]
    status: AgentAskStatus
    citations: readonly AgentCitation[]
    /** Each citation marker's display number (`citationNumbers`). */
    numbers: ReadonlyMap<string, number>
    /** Rendered under the heading, before the cards: the mode line. */
    children?: ReactNode
  },
) {
  const { ui } = usePortalLocale()
  const contributing = sources.filter((group) => passageCount(group) > 0).length
  return (
    <section aria-labelledby='agent-sources-heading' data-agent-sources>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 id='agent-sources-heading' className='rp-eyebrow text-ink-3'>
          {ui('Research collections searched')}
        </h2>
        {sources.length > 0
          ? (
            <span className='text-xs tabular-nums text-ink-2'>
              {ui('Passages from {found} of {total}', {
                found: contributing,
                total: sources.length,
              })}
            </span>
          )
          : null}
      </div>
      {children}
      {sources.length === 0
        ? (
          <p className='mt-2 text-sm leading-relaxed text-ink-2'>
            {status === 'streaming'
              ? ui('Waiting for the list of collections to search.')
              : ui('No collections were searched.')}
          </p>
        )
        : (
          <ul className='mt-3 space-y-4'>
            {sources.map((group) => (
              <SourceCard
                key={group.source.id}
                group={group}
                steps={steps}
                status={status}
                citations={citations}
                numbers={numbers}
              />
            ))}
          </ul>
        )}
    </section>
  )
}
