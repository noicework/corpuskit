import type { AnswerRecord } from '@research-portal/core'
import { usePortalLocale } from '../lib/portal-locale.tsx'

export function AnswerRecordAgentEvidence({ record }: { record: AnswerRecord }) {
  const { ui } = usePortalLocale()
  const agent = record.agent!
  const sourceLabel = (id: string) => agent.sources.find((s) => s.id === id)?.label ?? id
  return (
    <section className='rp-card min-w-0 space-y-4 p-3 sm:p-5' aria-labelledby='agent-evidence'>
      <h2 id='agent-evidence' className='rp-display text-xl'>{ui('Federated answer evidence')}</h2>
      <p>{ui('Mode')}: {agent.mode ?? ui('Not reported')}</p>
      <div role='table' aria-label={ui('Sources')} className='min-w-0 space-y-2 text-sm'>
        <div
          role='row'
          className='sr-only font-semibold sm:not-sr-only sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-2'
        >
          <span role='columnheader' className='min-w-0 break-words'>{ui('Source')}</span>
          <span role='columnheader' className='min-w-0 break-words'>{ui('Kind')}</span>
          <span role='columnheader' className='min-w-0 break-words'>{ui('Transport')}</span>
        </div>
        {agent.sources.map((source) => (
          <div
            key={source.id}
            role='row'
            className='grid grid-cols-1 gap-2 border-t border-[var(--rp-line)] pt-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]'
          >
            <span role='cell' className='min-w-0 break-words'>
              {source.label}
              <br />
              <span className='break-all text-ink-2'>{source.id}</span>
              {source.storeId && (
                <>
                  <br />
                  <span className='break-all text-ink-2'>{source.storeId}</span>
                </>
              )}
              {source.endpoint && (
                <>
                  <br />
                  <span className='break-all text-ink-2'>{source.endpoint}</span>
                </>
              )}
            </span>
            <span role='cell' className='min-w-0 break-words'>
              <span className='sm:hidden' aria-hidden='true'>{`${ui('Kind')}: `}</span>
              {source.kind ?? ui('Not reported')}
            </span>
            <span role='cell' className='min-w-0 break-words'>
              <span className='sm:hidden' aria-hidden='true'>{`${ui('Transport')}: `}</span>
              {source.transport ?? ui('Not reported')}
            </span>
          </div>
        ))}
      </div>
      <h3 className='font-semibold'>{ui('Steps and source questions')}</h3>
      <ol className='space-y-3'>
        {agent.steps.map((step) => (
          <li key={step.id} className='min-w-0 space-y-1 border-t border-[var(--rp-line)] pt-2'>
            <p className='break-words'>{step.title}</p>
            <p className='break-all text-sm text-ink-2'>
              {step.id} · {step.module} · {step.status} · {step.durationMs ?? ui('Unknown')} ms
            </p>
            {step.reason && <p className='break-words text-sm'>{step.reason}</p>}
          </li>
        ))}
      </ol>
      {agent.lookups.map((lookup, index) => (
        <p key={index} className='max-w-prose whitespace-pre-wrap break-words text-sm'>
          {sourceLabel(lookup.sourceId)} ({lookup.stepId}): {lookup.question}
        </p>
      ))}
      <h3 className='font-semibold'>{ui('Sources that failed')}</h3>
      {!agent.failedSources.length && <p className='text-sm'>{ui('None reported')}</p>}
      {agent.failedSources.map((source, index) => (
        <p key={index} className='break-words text-sm'>
          {sourceLabel(source.sourceId)}: {source.reason}
        </p>
      ))}
      <h3 className='font-semibold'>{ui('Citation decisions')}</h3>
      <p className='text-sm'>
        {agent.citationCheck === 'checked' ? ui('Checked') : ui('Not reported by provider')}
      </p>
      {agent.citationDecisions.map((decision, index) => (
        <p key={index} className='break-words text-sm'>
          [{decision.marker}] {decision.outcome}
          {decision.finalMarker ? ` [${decision.finalMarker}]` : ''} ·{' '}
          {decision.sourceId ? sourceLabel(decision.sourceId) : ui('Unknown')}
          {decision.chunkId ? ` / ${decision.chunkId}` : ''}
          {decision.sentenceIndex !== undefined
            ? ` · ${ui('Sentence')} ${decision.sentenceIndex + 1}`
            : ''}
        </p>
      ))}
    </section>
  )
}
