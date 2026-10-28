import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AgentChunk, AgentSource } from '@research-portal/core'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  type AgentAskStatus,
  type AgentSourceGroup,
  type AgentStep,
  chunkHref,
  passageCount,
  type SourceFailure,
  sourceKindLabel,
  sourceState,
} from '../lib/agent-ask-state.ts'
import { ExternalLink } from './icons.tsx'

/** The reader's sentence for a source that could not be searched. */
export function sourceFailureSentence(reason: SourceFailure, ui: (text: string) => string): string {
  switch (reason) {
    case 'timeout':
      return ui('Did not answer within the time limit.')
    case 'unauthorised':
      return ui('This partner could not be reached.')
    case 'error':
      return ui('Could not be searched.')
  }
}

/**
 * A passage's title, linking to the document where there is somewhere to go: a portal
 * resource of this deployment, or the passage's own address (in a new tab). A federated
 * partner's passage links nowhere, by the partner's choice.
 */
export function PassageTitle(
  { source, chunk }: {
    source: AgentSource
    chunk: Pick<AgentChunk, 'title' | 'url' | 'resourceId'>
  },
) {
  const { ui } = usePortalLocale()
  const title = chunk.title.trim() || ui('Untitled passage')
  const href = chunkHref(source, chunk)
  const className = 'rp-link-standalone rp-agent-passage-title text-sm font-medium'
  if (!href) return <span className='text-sm font-medium text-ink'>{title}</span>
  if (href.startsWith('/')) return <Link to={href} className={className}>{title}</Link>
  return (
    <a href={href} target='_blank' rel='noopener noreferrer' className={className}>
      {title}
      <ExternalLink size='sm' className='shrink-0' />
      <span className='sr-only'>({ui('opens in a new tab')})</span>
    </a>
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
      <span className='rp-badge rp-badge-quiet'>
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
      <span className='rp-badge rp-badge-ok'>
        {count === 1 ? ui('1 passage') : ui('{count} passages', { count })}
      </span>
    )
  }
  return (
    <span className='rp-badge rp-badge-quiet'>
      {status === 'streaming' ? ui('Queued') : ui('No passages')}
    </span>
  )
}

function SourceCard(
  { group, steps, status }: {
    group: AgentSourceGroup
    steps: readonly AgentStep[]
    status: AgentAskStatus
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
                <span className='not-italic font-medium'>{ui('Asked')}</span> {lookup.question}
              </p>
            )
            : null}
          {lookup.chunks.length > 0
            ? (
              <ul className='mt-1.5 space-y-2'>
                {lookup.chunks.map((chunk) => (
                  <li key={chunk.id} className='rp-agent-passage'>
                    <PassageTitle source={group.source} chunk={chunk} />
                    {chunk.text.trim()
                      ? (
                        <p className='rp-clamp-2 mt-0.5 text-xs leading-relaxed text-ink-2'>
                          {chunk.text}
                        </p>
                      )
                      : null}
                  </li>
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
  { sources, steps, status, children }: {
    sources: readonly AgentSourceGroup[]
    steps: readonly AgentStep[]
    status: AgentAskStatus
    /** Rendered under the heading, before the cards: the mode line. */
    children?: ReactNode
  },
) {
  const { ui } = usePortalLocale()
  const contributing = sources.filter((group) => passageCount(group) > 0).length
  return (
    <section aria-labelledby='agent-sources-heading' data-agent-sources>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 id='agent-sources-heading' className='rp-eyebrow text-ink-3'>{ui('Collections')}</h2>
        {sources.length > 0
          ? (
            <span className='text-xs tabular-nums text-ink-2'>
              {ui('{found} of {total} returned passages', {
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
              ? ui('Waiting to hear which collections will be searched.')
              : ui('Each collection searched appears here with the passages it returned.')}
          </p>
        )
        : (
          <ul className='mt-3 space-y-3'>
            {sources.map((group) => (
              <SourceCard key={group.source.id} group={group} steps={steps} status={status} />
            ))}
          </ul>
        )}
    </section>
  )
}
