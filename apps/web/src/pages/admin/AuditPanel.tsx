import { useEffect, useMemo, useRef, useState } from 'react'
import type { Scope } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_OUTCOMES,
  AuditError,
  type AuditEvent,
  type AuditFormat,
  type AuditPage,
  type AuditQuery,
  auditQuery,
  listAudit,
} from '../../api/audit.ts'
import { AuditDownload, type AuditDownloadResult } from '../../lib/audit-download.ts'

export function AuditPanel({ scope, name }: { scope: Scope; name: string }) {
  const access = useAccess()
  const kind = scope.kind, slug = scope.kind === 'portal' ? scope.slug : null
  const fixed = useMemo<Scope>(
    () => Object.freeze(kind === 'portal' ? { kind, slug: slug! } : { kind }),
    [kind, slug],
  )
  const read = access.can('audit.read', scope), exporting = access.can('audit.export', scope)
  if (!read && !exporting) return null
  return (
    <section className='min-w-0' data-audit-panel>
      <h2 className='rp-display text-xl'>Audit</h2>
      <p className='mt-2 break-words text-base text-ink-2'>
        {scope.kind === 'platform' ? 'All portals and platform events' : `Events for ${name}`}
      </p>
      {!read && (
        <p className='mt-4 text-base text-ink-2' data-audit-export-only>
          Audit export access is available for this scope. Event viewing is unavailable.
        </p>
      )}
      <AuditWorkspace key={`${access.generation}:${scope.kind}:${slug}`} scope={fixed} />
    </section>
  )
}
function AuditWorkspace({ scope }: { scope: Scope }) {
  const access = useAccess(), controller = access.controller
  const read = access.can('audit.read', scope)
  const [exportSelection, setExportSelection] = useState<{ sequence: number; query: AuditQuery }>({
    sequence: 0,
    query: {},
  })
  const resetExport = (query?: AuditQuery) =>
    setExportSelection((value) => ({ sequence: value.sequence + 1, query: query ?? value.query }))
  const [draft, setDraft] = useState<Record<string, string>>({ limit: '100' })
  const [selection, setSelection] = useState<
    { sequence: number; query: AuditQuery; snapshot?: AuditPage['snapshot'] }
  >({ sequence: 0, query: {} })
  const [result, setResult] = useState<
    { sequence: number; page?: AuditPage; error?: AuditError } | null
  >(null)
  const [validation, setValidation] = useState(false)
  const operation = useRef(0), pending = useRef<AbortController | null>(null)
  const clear = () => {
    operation.current++
    pending.current?.abort()
    pending.current = null
    setResult(null)
  }
  useEffect(() => {
    if (!read) return
    // Each setup owns a fresh controller, including StrictMode effect replay.
    const abort = new AbortController(), token = ++operation.current, context = controller.context
    pending.current = abort
    const unregister = controller.registerCleanup(() => {
      operation.current++
      abort.abort()
      setResult(null)
    })
    const current = () =>
      operation.current === token && !abort.signal.aborted && controller.context === context &&
      controller.can('audit.read', scope)
    void listAudit(scope, selection.query, { authority: controller, context, signal: abort.signal })
      .then((page) => {
        if (!current()) return
        if (
          selection.snapshot &&
          (page.snapshot.id !== selection.snapshot.id ||
            page.snapshot.expiresAt !== selection.snapshot.expiresAt)
        ) throw new AuditError()
        setResult({ sequence: selection.sequence, page })
      }).catch((error) => {
        if (current()) {
          setResult({
            sequence: selection.sequence,
            error: error instanceof AuditError ? error : new AuditError(),
          })
        }
      })
    return () => {
      unregister()
      operation.current++
      abort.abort()
    }
  }, [controller, selection, scope, read])
  const page = result?.sequence === selection.sequence ? result.page : undefined
  const error = result?.sequence === selection.sequence ? result.error : undefined
  const select = (query: AuditQuery, snapshot?: AuditPage['snapshot']) => {
    clear()
    setSelection((value) => ({ sequence: value.sequence + 1, query, snapshot }))
  }
  const apply = () => {
    clear()
    resetExport()
    try {
      const query = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => v !== '').map((
          [k, v],
        ) => [k, k === 'limit' ? Number(v) : v]),
      ) as AuditQuery
      auditQuery(query)
      setValidation(false)
      select(query)
      resetExport(query)
    } catch {
      setValidation(true)
    }
  }
  const field = (key: string, label: string, choices?: readonly string[]) => (
    <label className='min-w-0 text-sm text-ink-2' key={key}>
      <span className='mb-2 block'>{label}</span>
      {choices
        ? (
          <select
            className='rp-input w-full min-w-0'
            aria-label={label}
            value={draft[key] ?? ''}
            onChange={(e) => {
              resetExport()
              setDraft({ ...draft, [key]: e.target.value })
            }}
          >
            <option value=''>Any</option>
            {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        )
        : (
          <input
            className='rp-input w-full min-w-0'
            aria-label={label}
            aria-describedby={key === 'from' || key === 'to' ? 'audit-time-help' : undefined}
            aria-invalid={validation || undefined}
            maxLength={key === 'from' || key === 'to' ? 24 : 160}
            value={draft[key] ?? ''}
            onChange={(e) => {
              resetExport()
              setDraft({ ...draft, [key]: e.target.value })
            }}
          />
        )}
    </label>
  )
  return (
    <div className='mt-6 min-w-0' data-audit-reader={read ? '' : undefined}>
      <form
        className='rp-card p-4'
        aria-label='Audit filters'
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <div className='grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          {field('actorKind', 'Actor kind', AUDIT_ACTORS)}
          {field('actorId', 'Actor ID')}
          {field('action', 'Action', AUDIT_ACTIONS)}
          {field('outcome', 'Outcome', AUDIT_OUTCOMES)}
          {field('requestId', 'Request ID')}
          {field('from', 'From (UTC)')}
          {field('to', 'To (UTC)')}
          {field('limit', 'Events per page', ['25', '100', '250', '1000'])}
        </div>
        <p id='audit-time-help' className='mt-4 break-words text-sm text-ink-2'>
          Use UTC timestamps, for example 2026-09-12T00:00:00.000Z.
        </p>
        {validation && (
          <p role='alert' className='mt-3 text-sm text-ink'>
            Check the filters, identifiers and UTC time range, then apply again.
          </p>
        )}
        <div className='mt-4 flex flex-wrap gap-3'>
          <button className='rp-btn rp-btn-primary' type='submit'>Apply filters</button>
          <button
            type='button'
            className='rp-btn'
            onClick={() => {
              setDraft({ limit: '100' })
              setValidation(false)
              select({})
              resetExport({})
            }}
          >
            Clear filters
          </button>
        </div>
      </form>
      {access.can('audit.export', scope) && !validation && (
        <AuditExporter
          key={exportSelection.sequence}
          scope={scope}
          filters={exportSelection.query}
        />
      )}
      {read && !validation && !page && !error && (
        <p role='status' className='mt-6 text-base text-ink-2'>Loading audit events...</p>
      )}
      {error && (
        <div className='rp-card mt-6 p-4'>
          <p role='alert' className='text-base text-ink'>{error.message}</p>
          <button
            type='button'
            className='rp-btn mt-4'
            onClick={() => {
              const { cursor: _cursor, ...filters } = selection.query
              select(
                error.status === 410 ? filters : selection.query,
                error.status === 410 ? undefined : selection.snapshot,
              )
            }}
          >
            {error.status === 410 ? 'Restart events' : 'Try again'}
          </button>
        </div>
      )}
      {page && (
        <div className='mt-6 min-w-0' data-audit-results>
          <p role='status' className='mb-4 text-sm text-ink-2'>
            {page.items.length} events on this page.{' '}
            {page.complete ? 'End of snapshot.' : 'More events available.'}
          </p>
          {!page.items.length
            ? (
              <div className='rp-card p-6'>
                <h3 className='rp-display text-lg'>No events match these filters</h3>
                <p className='mt-2 text-base text-ink-2'>
                  Change the time range or clear filters to check again.
                </p>
              </div>
            )
            : (
              <>
                <div className='hidden min-w-0 xl:block'>
                  <table className='w-full table-fixed text-left text-sm'>
                    <caption className='sr-only'>Audit events in the selected scope</caption>
                    <thead>
                      <tr>
                        {[
                          'Time (UTC)',
                          'Actor',
                          'Action',
                          'Scope',
                          'Target',
                          'Outcome',
                          'Request ID and details',
                        ].map((label) => (
                          <th
                            className='border-b border-line p-3 align-top'
                            key={label}
                            scope='col'
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((row) => (
                        <tr key={row.id} data-audit-event={row.id}>
                          {[
                            row.at,
                            row.actor_label ?? row.actor_id ?? row.actor_kind,
                            row.action,
                            row.scope_slug ?? 'Platform',
                            [row.target_kind, row.target_id].filter(Boolean).join(': '),
                            row.outcome,
                          ].map((value, i) => (
                            <td
                              className='break-words border-b border-line p-3 align-top [overflow-wrap:anywhere]'
                              key={i}
                            >
                              {value}
                            </td>
                          ))}
                          <td className='break-words border-b border-line p-3 align-top [overflow-wrap:anywhere]'>
                            {row.request_id}
                            <Detail row={row} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className='space-y-4 xl:hidden' aria-label='Audit events'>
                  {page.items.map((row) => (
                    <li className='rp-card min-w-0 p-4' key={row.id} data-audit-event={row.id}>
                      <h3 className='rp-display break-words text-lg'>{row.action}</h3>
                      <dl className='mt-3 space-y-2 text-sm'>
                        {[
                          ['Time (UTC)', row.at],
                          ['Actor', row.actor_label ?? row.actor_id ?? row.actor_kind],
                          ['Scope', row.scope_slug ?? 'Platform'],
                          ['Target', [row.target_kind, row.target_id].filter(Boolean).join(': ')],
                          ['Outcome', row.outcome],
                          ['Request ID', row.request_id],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className='text-ink-2'>{label}</dt>
                            <dd className='break-words [overflow-wrap:anywhere]'>{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <Detail row={row} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          {page.nextCursor && (
            <button
              type='button'
              className='rp-btn mt-4'
              onClick={() =>
                select({ ...selection.query, cursor: page.nextCursor! }, page.snapshot)}
            >
              Next events page
            </button>
          )}
        </div>
      )}
    </div>
  )
}
function AuditExporter({ scope, filters }: { scope: Scope; filters: AuditQuery }) {
  const access = useAccess(), download = useRef<AuditDownload | null>(null), operation = useRef(0)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ format: AuditFormat; page: AuditDownloadResult } | null>(
    null,
  )
  const [error, setError] = useState<{ format: AuditFormat; status: number } | null>(null)
  const [stopped, setStopped] = useState(false)
  useEffect(() => () => {
    operation.current++
    download.current?.dispose()
    download.current = null
  }, [])
  const run = async (format: AuditFormat, previous?: AuditDownloadResult) => {
    download.current?.dispose()
    const token = ++operation.current, context = access.controller.context
    const task = new AuditDownload(access.controller, scope, filters, format)
    download.current = task
    setPending(true)
    setResult(null)
    setError(null)
    setStopped(false)
    const current = () =>
      operation.current === token && access.controller.context === context &&
      access.controller.can('audit.export', scope)
    try {
      const page = await task.download(previous)
      if (current()) setResult({ format, page })
    } catch (cause) {
      if (current() && !(cause instanceof Error && cause.name === 'AbortError')) {
        setError({ format, status: cause instanceof AuditError ? cause.status : 0 })
      }
    } finally {
      task.dispose()
      if (current()) setPending(false)
    }
  }
  return (
    <section className='rp-card mt-6 min-w-0 p-4' data-audit-export aria-label='Audit export'>
      <h3 className='rp-display text-lg'>Export audit events</h3>
      <p className='mt-2 text-sm text-ink-2'>
        Each action downloads one page, up to 512 KiB, using the applied filters. Partial pages need
        a separate action to continue. Stopping cannot remove files already saved.
      </p>
      <div className='mt-4 flex flex-wrap gap-3'>
        <button type='button' className='rp-btn' disabled={pending} onClick={() => void run('csv')}>
          Export CSV
        </button>
        <button
          type='button'
          className='rp-btn'
          disabled={pending}
          onClick={() => void run('json')}
        >
          Export JSON
        </button>
        {pending && (
          <button
            type='button'
            className='rp-btn'
            onClick={() => {
              operation.current++
              download.current?.dispose()
              download.current = null
              setPending(false)
              setResult(null)
              setError(null)
              setStopped(true)
            }}
          >
            Stop export
          </button>
        )}
      </div>
      {pending && <p role='status' className='mt-4 text-sm text-ink-2'>Preparing export page...</p>}
      {stopped && <p role='status' className='mt-4 text-sm text-ink-2'>Export stopped.</p>}
      {result && (
        <div className='mt-4' data-audit-export-result>
          <p role='status' className='text-sm text-ink-2'>
            {result.page.complete
              ? 'Complete: final export page downloaded.'
              : 'Partial: export page downloaded. More events remain in this snapshot.'}
          </p>
          {!result.page.complete && result.page.nextCursor && (
            <button
              type='button'
              className='rp-btn mt-4'
              onClick={() => void run(result.format, result.page)}
            >
              Export next {result.format.toUpperCase()} page
            </button>
          )}
        </div>
      )}
      {error && (
        <div className='mt-4'>
          <p role='alert' className='text-sm text-ink'>
            {error.status === 410
              ? 'This export snapshot has expired. Restart export to begin a new snapshot.'
              : error.status === 429
              ? 'Too many event snapshots are open. Wait before trying again.'
              : 'Could not download the audit page. Restart export to try a new snapshot.'}
          </p>
          <button type='button' className='rp-btn mt-4' onClick={() => void run(error.format)}>
            Restart export
          </button>
        </div>
      )}
    </section>
  )
}
function Detail({ row }: { row: AuditEvent }) {
  return (
    <details className='mt-3 min-w-0'>
      <summary className='rp-focus cursor-pointer text-sm'>Event details</summary>
      <dl className='mt-3 space-y-2 text-sm'>
        {[['Event ID', row.id], ['Actor kind', row.actor_kind], [
          'Actor ID',
          row.actor_id ?? 'None',
        ]].map(([label, value]) => (
          <div key={label}>
            <dt className='text-ink-2'>{label}</dt>
            <dd className='break-words [overflow-wrap:anywhere]'>{value}</dd>
          </div>
        ))}
      </dl>
      <pre className='mt-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]'>{JSON.stringify(JSON.parse(row.detail_json), null, 2)}</pre>
    </details>
  )
}
