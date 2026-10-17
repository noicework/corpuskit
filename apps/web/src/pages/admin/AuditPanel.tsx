import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { Button, SectionHeader } from '../../components/ui.tsx'
import {
  AlertCircle,
  ChevronDown,
  Download,
  RotateCw,
  SlidersHorizontal,
  X,
} from '../../components/icons.tsx'

export function AuditPanel({ scope, name }: { scope: Scope; name: string }) {
  const { ui } = usePortalLocale()

  const access = useAccess()
  const kind = scope.kind, slug = scope.kind === 'portal' ? scope.slug : null
  const fixed = useMemo<Scope>(
    () => Object.freeze(kind === 'portal' ? { kind, slug: slug! } : { kind }),
    [kind, slug],
  )
  const read = access.can('audit.read', scope), exporting = access.can('audit.export', scope)
  if (!read && !exporting) return null
  return (
    <section className='min-w-0 space-y-6 lg:space-y-8' data-audit-panel>
      <div className='rp-card p-5 lg:p-6'>
        <SectionHeader
          className='rp-admin-section-head'
          title={ui('Audit')}
          description={scope.kind === 'platform'
            ? ui('All portals and platform events')
            : ui('Events for {name}', { name: name })}
        />
        {!read && (
          <p className='mt-4 text-sm text-ink-2' data-audit-export-only>
            {ui('Audit export access is available for this scope. Event viewing is unavailable.')}
          </p>
        )}
      </div>
      <AuditWorkspace key={`${access.generation}:${scope.kind}:${slug}`} scope={fixed} />
    </section>
  )
}
function AuditWorkspace({ scope }: { scope: Scope }) {
  const { ui, error: localError } = usePortalLocale()
  const id = useId()

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
      <span className='mb-2 block'>{ui(label)}</span>
      {choices
        ? (
          <select
            className='rp-input rp-select w-full min-w-0'
            aria-label={ui(label)}
            value={draft[key] ?? ''}
            onChange={(e) => {
              resetExport()
              setDraft({ ...draft, [key]: e.target.value })
            }}
          >
            <option value=''>{ui('Any')}</option>
            {choices.map((choice) => <option key={choice} value={choice}>{ui(choice)}</option>)}
          </select>
        )
        : (
          <input
            className='rp-input w-full min-w-0'
            aria-label={ui(label)}
            aria-describedby={[
              key === 'from' || key === 'to' ? `${id}-time-help` : '',
              validation ? `${id}-filter-error` : '',
            ].filter(Boolean).join(' ') || undefined}
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
    <div className='min-w-0 space-y-6 lg:space-y-8' data-audit-reader={read ? '' : undefined}>
      <form
        className='rp-card p-5 lg:p-6'
        aria-label={ui('Audit filters')}
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <SectionHeader
          className='rp-admin-section-head'
          title={ui('Audit filters')}
          headingLevel={3}
        />
        <div className='mt-4 grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          {field('actorKind', 'Actor kind', AUDIT_ACTORS)}
          {field('actorId', 'Actor ID')}
          {field('action', 'Action', AUDIT_ACTIONS)}
          {field('outcome', 'Outcome', AUDIT_OUTCOMES)}
          {field('requestId', 'Request ID')}
          {field('from', 'From (UTC)')}
          {field('to', 'To (UTC)')}
          {field('limit', 'Events per page', ['25', '100', '250', '1000'])}
        </div>
        <p id={`${id}-time-help`} className='mt-4 break-words text-xs text-ink-3'>
          {ui('Use UTC timestamps, for example 2026-09-12T00:00:00.000Z.')}
        </p>
        {validation && (
          <p
            id={`${id}-filter-error`}
            role='alert'
            className='mt-3 flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'
          >
            <AlertCircle size='sm' className='shrink-0' />
            <span>
              {ui('Check the filters, identifiers and UTC time range, then apply again.')}
            </span>
          </p>
        )}
        <div className='mt-4 flex flex-wrap gap-3'>
          <Button type='submit' leadingIcon={SlidersHorizontal}>{ui('Apply filters')}</Button>
          <Button
            variant='ghost'
            leadingIcon={X}
            onClick={() => {
              setDraft({ limit: '100' })
              setValidation(false)
              select({})
              resetExport({})
            }}
          >
            {ui('Clear filters')}
          </Button>
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
        <p role='status' className='mt-6 text-base text-ink-2'>{ui('Loading audit events...')}</p>
      )}
      {error && (
        <div className='rp-card p-5 lg:p-6'>
          <p role='alert' className='flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'>
            <AlertCircle size='sm' className='shrink-0' />
            <span>{localError(error, 'Could not load audit events. Try again.')}</span>
          </p>
          <Button
            variant='outline'
            leadingIcon={RotateCw}
            className='mt-4'
            onClick={() => {
              const { cursor: _cursor, ...filters } = selection.query
              select(
                error.status === 410 ? filters : selection.query,
                error.status === 410 ? undefined : selection.snapshot,
              )
            }}
          >
            {error.status === 410 ? ui('Restart events') : ui('Try again')}
          </Button>
        </div>
      )}
      {page && (
        <section className='rp-card min-w-0 p-5 lg:p-6' data-audit-results>
          <SectionHeader
            className='rp-admin-section-head'
            title={ui('Audit events')}
            headingLevel={3}
          />
          <p role='status' className='my-4 text-sm text-ink-2'>
            {page.items.length}
            {ui(' events on this page.')}{' '}
            {page.complete ? ui('End of snapshot.') : ui('More events available.')}
          </p>
          {!page.items.length
            ? (
              <div className='border-t border-line pt-4'>
                <SectionHeader
                  className='rp-admin-section-head'
                  title={ui('No events match these filters')}
                  description={ui('Change the time range or clear filters to check again.')}
                  headingLevel={4}
                />
              </div>
            )
            : (
              <>
                <div
                  role='region'
                  aria-label={ui('Audit events in the selected scope')}
                  tabIndex={0}
                  className='rp-focus hidden min-w-0 overflow-x-auto xl:block'
                >
                  <table className='w-full min-w-[60rem] table-fixed text-left text-sm'>
                    <caption className='sr-only'>
                      {ui('Audit events in the selected scope')}
                    </caption>
                    <thead className='text-xs font-semibold text-ink-2'>
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
                            {ui(label)}
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
                            row.scope_slug ?? ui('Platform'),
                            [row.target_kind, row.target_id].filter(Boolean).join(': '),
                            row.outcome,
                          ].map((value, i) => (
                            <td
                              className='break-words border-b border-line p-3 align-top [overflow-wrap:anywhere]'
                              key={i}
                            >
                              {i === 5
                                ? (
                                  <span className={`rp-badge ${outcomeBadge(row.outcome)}`}>
                                    {value}
                                  </span>
                                )
                                : value}
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
                <ul className='divide-y divide-line xl:hidden' aria-label={ui('Audit events')}>
                  {page.items.map((row) => (
                    <li className='min-w-0 py-4' key={row.id} data-audit-event={row.id}>
                      <h4 className='break-words text-base font-semibold'>{row.action}</h4>
                      <dl className='mt-3 space-y-2 text-sm'>
                        {[
                          ['Time (UTC)', row.at],
                          ['Actor', row.actor_label ?? row.actor_id ?? row.actor_kind],
                          ['Scope', row.scope_slug ?? ui('Platform')],
                          ['Target', [row.target_kind, row.target_id].filter(Boolean).join(': ')],
                          ['Outcome', row.outcome],
                          ['Request ID', row.request_id],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className='text-ink-2'>{ui(label ?? '')}</dt>
                            <dd className='break-words [overflow-wrap:anywhere]'>
                              {label === 'Outcome'
                                ? (
                                  <span className={`rp-badge ${outcomeBadge(row.outcome)}`}>
                                    {value}
                                  </span>
                                )
                                : value}
                            </dd>
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
            <Button
              variant='outline'
              className='mt-4'
              onClick={() =>
                select({ ...selection.query, cursor: page.nextCursor! }, page.snapshot)}
            >
              {ui('Next events page')}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
function AuditExporter({ scope, filters }: { scope: Scope; filters: AuditQuery }) {
  const { ui } = usePortalLocale()

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
    <section
      className='rp-card min-w-0 p-5 lg:p-6'
      data-audit-export
      aria-label={ui('Audit export')}
    >
      <SectionHeader
        className='rp-admin-section-head'
        title={ui('Export audit events')}
        description={ui(
          'Each action downloads one page, up to 512 KiB, using the applied filters. Partial pages need a separate action to continue. Stopping cannot remove files already saved.',
        )}
        headingLevel={3}
        actions={
          <>
            <Button
              variant='ghost'
              size='sm'
              leadingIcon={Download}
              disabled={pending}
              onClick={() => void run('csv')}
            >
              {ui('Export CSV')}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              leadingIcon={Download}
              disabled={pending}
              onClick={() => void run('json')}
            >
              {ui('Export JSON')}
            </Button>
            {pending && (
              <Button
                variant='ghost'
                size='sm'
                leadingIcon={X}
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
                {ui('Stop export')}
              </Button>
            )}
          </>
        }
      />
      {pending && (
        <p role='status' className='mt-4 text-sm text-ink-2'>{ui('Preparing export page...')}</p>
      )}
      {stopped && <p role='status' className='mt-4 text-sm text-ink-2'>{ui('Export stopped.')}</p>}
      {result && (
        <div className='mt-4' data-audit-export-result>
          <p role='status' className='text-sm text-ink-2'>
            {result.page.complete
              ? ui('Complete: final export page downloaded.')
              : ui('Partial: export page downloaded. More events remain in this snapshot.')}
          </p>
          {!result.page.complete && result.page.nextCursor && (
            <Button
              variant='outline'
              leadingIcon={Download}
              className='mt-4'
              onClick={() => void run(result.format, result.page)}
            >
              {ui('Export next ')}
              {result.format.toUpperCase()}
              {ui(' page')}
            </Button>
          )}
        </div>
      )}
      {error && (
        <div className='mt-4'>
          <p role='alert' className='flex items-start gap-2 text-xs text-[var(--rp-bad-ink)]'>
            <AlertCircle size='sm' className='shrink-0' />
            <span>
              {error.status === 410
                ? ui('This export snapshot has expired. Restart export to begin a new snapshot.')
                : error.status === 429
                ? ui('Too many event snapshots are open. Wait before trying again.')
                : ui('Could not download the audit page. Restart export to try a new snapshot.')}
            </span>
          </p>
          <Button
            variant='outline'
            leadingIcon={RotateCw}
            className='mt-4'
            onClick={() => void run(error.format)}
          >
            {ui('Restart export')}
          </Button>
        </div>
      )}
    </section>
  )
}
function Detail({ row }: { row: AuditEvent }) {
  const { ui } = usePortalLocale()

  return (
    <details className='group mt-3 min-w-0'>
      <summary className='rp-btn rp-btn-ghost rp-btn-sm list-none [&::-webkit-details-marker]:hidden'>
        <ChevronDown
          size='sm'
          className='transition-transform duration-150 ease-[var(--rp-ease)] group-open:rotate-180 motion-reduce:transition-none'
        />
        {ui('Event details')}
      </summary>
      <dl className='mt-3 space-y-2 text-sm'>
        {[['Event ID', row.id], ['Actor kind', row.actor_kind], [
          'Actor ID',
          row.actor_id ?? ui('None'),
        ]].map(([label, value]) => (
          <div key={label}>
            <dt className='text-ink-2'>{ui(label ?? '')}</dt>
            <dd className='break-words [overflow-wrap:anywhere]'>{value}</dd>
          </div>
        ))}
      </dl>
      <pre className='mt-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]'>{JSON.stringify(JSON.parse(row.detail_json), null, 2)}</pre>
    </details>
  )
}

function outcomeBadge(outcome: AuditEvent['outcome']): string {
  if (outcome === 'success') return 'rp-badge-ok'
  if (outcome === 'denied' || outcome === 'failure') return 'rp-badge-bad'
  if (outcome === 'uncertain') return 'rp-badge-warn'
  return 'rp-badge-quiet'
}
