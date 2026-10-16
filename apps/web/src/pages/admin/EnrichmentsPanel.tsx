import { enrichmentDisplay } from '../../lib/enrichment-display.ts'
import { createPortalLocale, type Locale, usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError, adminFetch, type AdminRequestAccess } from '../../api/break-glass.ts'
import { EnrichmentAgentStatusSchema } from '@research-portal/core'
import { useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  EnrichmentAgent,
  EnrichmentAgentStatus,
  EnrichmentRunEvent,
} from '@research-portal/core'
import { getEnrichmentAgents, runEnrichment } from '../../api/client.ts'
import {
  type EnrichmentArchiveReview,
  importEnrichmentArchive,
  readEnrichmentArchive,
} from '../../api/enrichment-import.ts'
import { ErrorCard, Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { failedJobMessage, StreamedJob } from './streamed-job.ts'

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
  const { ui } = usePortalLocale()
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
              {ui(KIND_LABEL[field.kind] ?? field.kind)}
            </span>
          </div>
          <p className='mt-1 text-xs leading-relaxed text-ink-3'>{field.description}</p>
        </li>
      ))}
    </ul>
  )
}

function Coverage({ done, total }: { done: number; total: number }) {
  const { ui, number } = usePortalLocale()

  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className='mt-4'>
      <div className='flex flex-wrap items-baseline justify-between gap-2 text-sm'>
        <span className='font-medium text-ink-2'>{ui('Coverage')}</span>
        <span className='tabular-nums text-ink-3'>
          {ui('{done} of {total} resources', { done: number(done), total: number(total) })}
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

type RunDone = Extract<EnrichmentRunEvent, { type: 'done' }>
type RunProgress = { done: number; total: number; errors: number }

/**
 * Follows one enrichment run: progress as items arrive, and the run's result
 * or the reason it stopped - a paused or read-only portal, disabled agents,
 * a platform failure - in the server's words.
 */
export function followEnrichmentRun(
  job: StreamedJob<RunDone>,
  onProgress: (update: (previous: RunProgress | null) => RunProgress | null) => void,
): (event: EnrichmentRunEvent) => void {
  return job.events((event: EnrichmentRunEvent) => {
    if (event.type === 'start') onProgress(() => ({ done: 0, total: event.total, errors: 0 }))
    else if (event.type === 'item') {
      onProgress((prev) =>
        prev
          ? {
            ...prev,
            done: prev.done + 1,
            errors: prev.errors + (event.outcome === 'error' ? 1 : 0),
          }
          : prev
      )
    } else if (event.type === 'error') job.fail(event)
    else if (event.type === 'done') {
      if (Number.isFinite(event.enriched) && Number.isFinite(event.errors)) job.complete(event)
      else job.uncertain()
    }
  })
}

/** The message a finished run leaves. */
export function enrichmentDoneMessage(
  done: RunDone,
  locale: Pick<Locale, 'ui' | 'number'> = createPortalLocale('en'),
): Message {
  const { ui, number } = locale
  return {
    tone: done.errors > 0 ? 'error' : 'ok',
    text: done.enriched === 0 && done.errors === 0
      ? ui('Every resource in scope is already enriched.')
      : ui(done.enriched === 1 ? 'Enriched {count} resource' : 'Enriched {count} resources', {
        count: number(done.enriched),
      }) + (done.errors > 0
        ? ui(', {count} could not be generated.', { count: number(done.errors) })
        : '.'),
  }
}

function AgentCard(
  { slug, status }: { slug: string; status: EnrichmentAgentStatus },
) {
  const { ui, number, error: localError } = usePortalLocale()

  const { runExplicit, sessionAllowed } = usePermissionAdminAccess('enrichments.write', {
    kind: 'portal',
    slug,
  })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const agent = enrichmentDisplay(status.agent, ui)
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
    const job = new StreamedJob<RunDone>(assertCurrent, 'Enrichment run failed - please retry.')
    try {
      const result = await runExplicit(
        scope === 'missing' ? ui('Generate missing enrichments') : ui('Regenerate all enrichments'),
        async (access) => {
          await runEnrichment(
            slug,
            access,
            { agentId: agent.id, scope },
            followEnrichmentRun(job, setProgress),
          )
          return job.result()
        },
      )
      assertCurrent()
      if (result === undefined) return
      setMessage(enrichmentDoneMessage(result, { ui, number }))
      if (sessionAllowed) {
        await queryClient.invalidateQueries({ queryKey: ['enrichment-agents', slug] })
      }
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(failedJobMessage(job, err, 'Enrichment run failed - please retry.', localError))
    } finally {
      if (context === authority.controller.context) setRunning(false)
    }
  }

  return (
    <div className='rp-card p-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='rp-display text-lg text-ink'>{agent.title}</h3>
            {agent.isDefault
              ? <span className='rp-badge rp-badge-quiet'>{ui('Default')}</span>
              : null}
            <span className='rp-badge rp-badge-quiet'>
              {agent.scope === 'resource' ? ui('Resource level') : ui('Paragraph level')}
            </span>
            <span className='rp-badge rp-badge-quiet'>
              {agent.cardinality === 'single' ? ui('One per resource') : ui('Multiple')}
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
          <p className='rp-eyebrow text-ink-3'>{ui('JSON schema')}</p>
          <button
            type='button'
            onClick={() => setShowSchema((v) => !v)}
            className='rp-focus rounded-[var(--rp-radius-btn)] text-xs font-medium text-ink-3 hover:text-ink'
          >
            {showSchema ? ui('Hide raw schema') : ui('Show raw schema')}
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
        {ui(status.generationNote)}
      </p>

      <div className='mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4'>
        <div
          className='flex overflow-hidden rounded-[var(--rp-radius)] border border-line'
          role='group'
          aria-label={ui('Run scope')}
        >
          {(['missing', 'all'] as const).map((value) => (
            <button
              key={value}
              type='button'
              disabled={running}
              onClick={() => setScope(value)}
              data-enrichment-scope={value}
              aria-pressed={scope === value}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                scope === value
                  ? 'bg-[var(--rp-accent)] text-[var(--rp-on-accent)]'
                  : 'bg-surface text-ink-2 hover:text-ink'
              }`}
            >
              {value === 'missing' ? ui('Missing only') : ui('Regenerate all')}
            </button>
          ))}
        </div>
        <button
          type='button'
          disabled={running}
          data-enrichment-run
          onClick={() => void run()}
          className='rp-btn rp-btn-primary'
        >
          {running
            ? ui('Running…')
            : scope === 'missing'
            ? ui('Generate missing')
            : ui('Regenerate all')}
        </button>
        {running && progress
          ? (
            <span className='text-sm tabular-nums text-ink-3'>
              {progress.done}
              {progress.total > 0 ? ` / ${progress.total}` : ''}
              {ui(' done')}
              {progress.errors > 0 ? ui(', {errors} failed', { errors: progress.errors }) : ''}
            </span>
          )
          : null}
      </div>

      {running && (
        <p role='status' className='mt-3 text-sm text-ink-3'>
          {ui(
            'Waiting for the confirmed result. Progress may arrive together when the action finishes.',
          )}
        </p>
      )}
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

const recordLabel = (count: number, existing: boolean, locale: Pick<Locale, 'ui' | 'number'>) =>
  locale.ui(
    existing
      ? count === 1 ? '{count} existing record' : '{count} existing records'
      : count === 1
      ? '{count} record'
      : '{count} records',
    { count: locale.number(count) },
  )

/** A reviewed archive is submitted only through the current ordinary owner/curator session. */
export function EnrichmentArchiveImport({ slug, access, assertCurrent, onImported }: {
  slug: string
  access: AdminRequestAccess
  assertCurrent(): void
  onImported(): Promise<void>
}) {
  const { ui, number, error: localError } = usePortalLocale()

  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [review, setReview] = useState<EnrichmentArchiveReview | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState<'review' | 'import' | null>(null)
  const sequence = useRef(0)
  const pending = useRef(false)
  const reviewFile = async () => {
    if (!file || pending.current) return
    const attempt = sequence.current
    pending.current = true
    setBusy('review')
    setReview(null)
    setMessage(null)
    try {
      assertCurrent()
      const result = await readEnrichmentArchive(file)
      assertCurrent()
      if (sequence.current === attempt) setReview(result)
    } catch (error) {
      try {
        assertCurrent()
      } catch {
        return
      }
      if (sequence.current === attempt) {
        setMessage({
          tone: 'error',
          text: errorMessage(error, 'Could not read this archive.', localError),
        })
      }
    } finally {
      pending.current = false
      if (sequence.current === attempt) setBusy(null)
    }
  }
  const confirmImport = async () => {
    if (!review || pending.current) return
    const attempt = sequence.current
    pending.current = true
    setBusy('import')
    setMessage(null)
    try {
      assertCurrent()
      const result = await importEnrichmentArchive(slug, review.archive, access)
      assertCurrent()
      if (sequence.current !== attempt) return
      setReview(null)
      setMessage({
        tone: 'ok',
        text: ui('Imported {records}. Kept {existing} unchanged.', {
          records: recordLabel(result.imported, false, { ui, number }),
          existing: recordLabel(result.skipped, true, { ui, number }),
        }),
      })
      try {
        await onImported()
      } catch {
        assertCurrent()
        setMessage({
          tone: 'error',
          text: ui(
            'Imported {records} and kept {existing}. Reload this page to refresh coverage.',
            {
              records: recordLabel(result.imported, false, { ui, number }),
              existing: recordLabel(result.skipped, true, { ui, number }),
            },
          ),
        })
      }
    } catch (error) {
      try {
        assertCurrent()
      } catch {
        return
      }
      if (sequence.current === attempt) {
        setMessage({
          tone: 'error',
          text: errorMessage(
            error,
            'Could not import this archive. Check the result before retrying.',
            localError,
          ),
        })
      }
    } finally {
      pending.current = false
      if (sequence.current === attempt) setBusy(null)
    }
  }
  return (
    <section
      className='rp-card space-y-4 p-5'
      aria-labelledby={`${id}-heading`}
      data-enrichments-import
    >
      <div>
        <h2 id={`${id}-heading`} className='rp-display text-xl text-ink'>
          {ui('Import enrichment archive')}
        </h2>
        <p id={`${id}-help`} className='mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink-2'>
          {ui(
            'Restore reviewed titles, summaries and other enrichments from an exported JSON archive. Existing records stay unchanged. Maximum file size: 8 MB.',
          )}
        </p>
      </div>
      <div className='space-y-2'>
        <p className='text-sm font-medium text-ink'>{ui('Archive file')}</p>
        <button
          type='button'
          className='rp-btn rp-btn-outline'
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {ui('Choose archive file')}
        </button>
        <input
          ref={fileInput}
          id={`${id}-file`}
          type='file'
          tabIndex={-1}
          accept='.json,application/json'
          className='sr-only'
          aria-label={ui('Choose archive file')}
          aria-describedby={`${id}-help ${id}-filename`}
          disabled={busy !== null}
          data-enrichments-import-file
          onChange={(event) => {
            sequence.current++
            setFile(event.currentTarget.files?.[0] ?? null)
            setReview(null)
            setMessage(null)
          }}
        />
        <p id={`${id}-filename`} className='break-words text-sm text-ink-2'>
          {file?.name ?? ui('No file selected')}
        </p>
      </div>
      <button
        type='button'
        className='rp-btn rp-btn-outline'
        disabled={!file || busy !== null}
        data-enrichments-import-review
        onClick={() => void reviewFile()}
      >
        {busy === 'review' ? ui('Reviewing…') : ui('Review archive')}
      </button>
      {review
        ? (
          <div
            className='space-y-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 p-4'
            data-enrichments-import-preview
          >
            <p className='break-words text-sm font-medium text-ink'>{file?.name}</p>
            <p role='status' className='text-sm text-ink-2'>
              {ui('Ready to import {records} from {schemas} into {slug}.', {
                records: recordLabel(review.recordCount, false, { ui, number }),
                schemas: ui(review.agentCount === 1 ? '{count} schema' : '{count} schemas', {
                  count: number(review.agentCount),
                }),
                slug,
              })}
            </p>
            <button
              type='button'
              className='rp-btn rp-btn-primary'
              disabled={busy !== null}
              data-enrichments-import-confirm
              onClick={() => void confirmImport()}
            >
              {busy === 'import' ? ui('Importing…') : ui('Import reviewed archive')}
            </button>
          </div>
        )
        : null}
      {busy
        ? (
          <p role='status' className='text-sm text-ink-3'>
            {busy === 'review'
              ? ui('Checking the archive before import.')
              : ui('Waiting for the confirmed import result.')}
          </p>
        )
        : null}
      {message ? <MessagePanel message={message} /> : null}
    </section>
  )
}

function EnrichmentsPanelContent({ slug }: { slug: string }) {
  const { ui, error: localError } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed } = usePermissionAdminAccess(
    'enrichments.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const queryClient = useQueryClient()
  const [snapshot, setSnapshot] = useState<EnrichmentAgentStatus[]>()
  const [message, setMessage] = useState<Message | null>(null)
  const { data: sessionData, isLoading, isError, error } = useQuery({
    queryKey: ['enrichment-agents', slug],
    queryFn: async () =>
      EnrichmentAgentStatusSchema.array().parse(await getEnrichmentAgents(slug, sessionAccess)),
    enabled: sessionAllowed,
    retry: false,
  })

  const data = sessionAllowed ? sessionData : snapshot
  const load = async () => {
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Load enrichment schemas and coverage'),
        async (access) =>
          EnrichmentAgentStatusSchema.array().parse(await getEnrichmentAgents(slug, access)),
      )
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['enrichment-agents', slug], result)
      else setSnapshot(result)
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not load enrichments.', localError),
      })
    }
  }

  const exportArchive = async () => {
    setMessage(null)
    try {
      const response = await adminFetch(
        sessionAccess,
        `/api/admin/t/${encodeURIComponent(slug)}/enrichments/export`,
      )
      if (!response.ok) throw new AdminAccessError(response.status)
      const records: unknown = await response.json()
      assertCurrent()
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new AdminAccessError()
      }
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }),
      )
      try {
        assertCurrent()
        const link = document.createElement('a')
        link.href = url
        link.download = `${slug}-enrichments.json`
        link.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not export enrichments.', localError),
      })
    }
  }

  return (
    <div className='space-y-4'>
      <button
        type='button'
        data-enrichments-read
        className='rp-btn rp-btn-outline'
        onClick={() => void load()}
      >
        {ui('Load enrichment schemas')}
      </button>
      {message && <MessagePanel message={message} />}
      <button
        type='button'
        data-enrichments-export
        className='rp-btn rp-btn-outline'
        onClick={() => void exportArchive()}
      >
        {ui('Export enrichment archive')}
      </button>
      {sessionAllowed
        ? (
          <EnrichmentArchiveImport
            slug={slug}
            access={sessionAccess}
            assertCurrent={assertCurrent}
            onImported={async () => {
              assertCurrent()
              await queryClient.invalidateQueries({
                predicate: (query) => query.queryKey[1] === slug,
              })
            }}
          />
        )
        : null}
      <div className='rp-card p-5'>
        <h2 className='rp-display text-xl text-ink'>{ui('Enrichments')}</h2>
        <p className='mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink-2'>
          {ui(
            'Enrichments are schema-driven generator agents that read each resource and write a real title, summary, key takeaways and quotes, so the library never shows a raw filename. The app renders whatever fields a schema defines, so new fields flow through everywhere. Run the default agent below to merchandise the corpus.',
          )}
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
            message={error instanceof Error ? error.message : ui('Could not load enrichments.')}
            onRetry={() => void load()}
          />
        )
        : null}

      {data?.map((status) => <AgentCard key={status.agent.id} slug={slug} status={status} />)}
    </div>
  )
}

export function EnrichmentsPanel(props: { slug: string }) {
  const access = useAccess()
  const permission = usePermissionAdminAccess('enrichments.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (
    access.state.status !== 'ready' || (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <EnrichmentsPanelContent key={`${props.slug}:${access.generation}`} {...props} />
}
