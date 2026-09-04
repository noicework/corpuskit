import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  EnrichmentAgent,
  EnrichmentAgentStatus,
  EnrichmentRunEvent,
} from '@research-portal/core'
import { getEnrichmentAgents, runEnrichment } from '../../api/client.ts'
import { ErrorCard, Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Enrichments (merchandising): the schema-driven generator agents that replace
 * raw filenames with a real title, summary, key takeaways and quotes on every
 * surface. Each agent is shown with its JSON schema and a control to run or
 * regenerate it over the corpus. Phase 1 ships the default "research summary"
 * agent; further "lens" agents arrive in Phase 2.
 */

const KIND_LABEL: Record<string, string> = {
  title: 'Title',
  summary: 'Summary',
  list: 'List',
  quotes: 'Quotes',
}

function SchemaFields({ agent }: { agent: EnrichmentAgent }) {
  return (
    <ul className='mt-3 space-y-2'>
      {agent.fields.map((field) => (
        <li
          key={field.key}
          className='rounded-[calc(var(--rp-radius))] border border-line bg-surface px-3 py-2.5'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-sm font-semibold text-ink'>{field.label}</span>
            <code className='rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3'>
              {field.key}
            </code>
            <span className='rp-badge rp-badge-quiet'>
              {KIND_LABEL[field.kind] ?? field.kind}
            </span>
          </div>
          <p className='mt-1 text-xs leading-relaxed text-ink-3'>{field.description}</p>
        </li>
      ))}
    </ul>
  )
}

function Coverage({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className='mt-4'>
      <div className='flex items-baseline justify-between text-sm'>
        <span className='font-medium text-ink-2'>Coverage</span>
        <span className='tabular-nums text-ink-3'>
          {done.toLocaleString()} of {total.toLocaleString()} resources
          {total > 0 ? ` (${pct}%)` : ''}
        </span>
      </div>
      <div
        className='mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2'
        role='progressbar'
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className='h-full rounded-full transition-[width] duration-500'
          style={{ width: `${pct}%`, background: 'var(--rp-accent)' }}
        />
      </div>
    </div>
  )
}

function AgentCard(
  { slug, passcode, status }: { slug: string; passcode: string; status: EnrichmentAgentStatus },
) {
  const queryClient = useQueryClient()
  const { agent } = status
  const [scope, setScope] = useState<'missing' | 'all'>('missing')
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(
    null,
  )
  const [showSchema, setShowSchema] = useState(false)

  const run = async () => {
    setRunning(true)
    setMessage(null)
    setProgress({ done: 0, total: 0, errors: 0 })
    try {
      await runEnrichment(
        slug,
        passcode,
        { agentId: agent.id, scope },
        (event: EnrichmentRunEvent) => {
          if (event.type === 'start') setProgress({ done: 0, total: event.total, errors: 0 })
          if (event.type === 'item') {
            setProgress((prev) =>
              prev
                ? {
                  ...prev,
                  done: prev.done + 1,
                  errors: prev.errors + (event.outcome === 'error' ? 1 : 0),
                }
                : prev
            )
          }
          if (event.type === 'done') {
            setMessage({
              tone: event.errors > 0 ? 'error' : 'ok',
              text: event.enriched === 0 && event.errors === 0
                ? 'Every resource in scope is already enriched.'
                : `Enriched ${event.enriched} resource${event.enriched === 1 ? '' : 's'}` +
                  (event.errors > 0 ? `, ${event.errors} could not be generated.` : '.'),
            })
          }
          if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
        },
      )
      await queryClient.invalidateQueries({ queryKey: ['enrichment-agents', slug] })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Enrichment run failed - please retry.'),
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='rp-card p-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='rp-display text-lg text-ink'>{agent.title}</h3>
            {agent.isDefault ? <span className='rp-badge rp-badge-quiet'>Default</span> : null}
            <span className='rp-badge rp-badge-quiet'>
              {agent.scope === 'resource' ? 'Resource level' : 'Paragraph level'}
            </span>
            <span className='rp-badge rp-badge-quiet'>
              {agent.cardinality === 'single' ? 'One per resource' : 'Multiple'}
            </span>
          </div>
          <p className='mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink-2'>
            {agent.description}
          </p>
        </div>
      </div>

      <Coverage done={status.enrichedCount} total={status.totalCount} />

      <div className='mt-5'>
        <div className='flex items-center justify-between'>
          <p className='rp-eyebrow text-ink-3'>JSON schema</p>
          <button
            type='button'
            onClick={() => setShowSchema((v) => !v)}
            className='rp-focus rounded-[var(--rp-radius-btn)] text-xs font-medium text-ink-3 hover:text-ink'
          >
            {showSchema ? 'Hide raw schema' : 'Show raw schema'}
          </button>
        </div>
        <SchemaFields agent={agent} />
        {showSchema
          ? (
            <pre className='mt-3 overflow-x-auto rounded-[calc(var(--rp-radius))] border border-line bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-2'>
              {JSON.stringify(status.jsonSchema, null, 2)}
            </pre>
          )
          : null}
      </div>

      <p className='mt-4 rounded-[calc(var(--rp-radius))] border border-line bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-3'>
        {status.generationNote}
      </p>

      <div className='mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4'>
        <div
          className='flex overflow-hidden rounded-[var(--rp-radius)] border border-line'
          role='group'
          aria-label='Run scope'
        >
          {(['missing', 'all'] as const).map((value) => (
            <button
              key={value}
              type='button'
              disabled={running}
              onClick={() => setScope(value)}
              aria-pressed={scope === value}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                scope === value
                  ? 'bg-[var(--rp-accent)] text-[var(--rp-on-accent)]'
                  : 'bg-surface text-ink-2 hover:text-ink'
              }`}
            >
              {value === 'missing' ? 'Missing only' : 'Regenerate all'}
            </button>
          ))}
        </div>
        <button
          type='button'
          disabled={running}
          onClick={() => void run()}
          className='rp-btn rp-btn-primary'
        >
          {running ? 'Running…' : scope === 'missing' ? 'Generate missing' : 'Regenerate all'}
        </button>
        {running && progress
          ? (
            <span className='text-sm tabular-nums text-ink-3'>
              {progress.done}
              {progress.total > 0 ? ` / ${progress.total}` : ''} done
              {progress.errors > 0 ? `, ${progress.errors} failed` : ''}
            </span>
          )
          : null}
      </div>

      {running && progress && progress.total > 0
        ? (
          <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2'>
            <div
              className='h-full rounded-full transition-[width] duration-300'
              style={{
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
                background: 'var(--rp-accent)',
              }}
            />
          </div>
        )
        : null}

      {message ? <MessagePanel message={message} className='mt-4' /> : null}
    </div>
  )
}

export function EnrichmentsPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['enrichment-agents', slug],
    queryFn: () => getEnrichmentAgents(slug, passcode),
    enabled: passcode.length > 0,
    retry: false,
  })

  return (
    <div className='space-y-4'>
      <div className='rp-card p-5'>
        <h2 className='rp-display text-xl text-ink'>Enrichments</h2>
        <p className='mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink-2'>
          Enrichments are schema-driven generator agents that read each resource and write a real
          title, summary, key takeaways and quotes, so the library never shows a raw filename. The
          app renders whatever fields a schema defines, so new fields flow through everywhere. Run
          the default agent below to merchandise the corpus.
        </p>
      </div>

      {isLoading
        ? (
          <div className='rp-card space-y-3 p-5'>
            <Skeleton className='h-6 w-48' />
            <Skeleton className='h-3 w-full' />
            <Skeleton className='h-2 w-2/3' />
          </div>
        )
        : null}

      {isError
        ? (
          <ErrorCard
            message={error instanceof Error ? error.message : 'Could not load enrichments.'}
            onRetry={() => void refetch()}
          />
        )
        : null}

      {data?.map((status) => (
        <AgentCard key={status.agent.id} slug={slug} passcode={passcode} status={status} />
      ))}
    </div>
  )
}
