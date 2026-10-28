import { messageFor } from './shared.ts'
import { relativeTime } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { type FormEvent, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PortalSource, SourceSyncEvent } from '../../api/client.ts'
import { addSource, deleteSource, getSources, syncSource, updateSource } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Button, SectionHeader, Skeleton } from '../../components/ui.tsx'
import { Plus, RotateCcw, RotateCw, Trash } from '../../components/icons.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { failedJobMessage, StreamedJob } from './streamed-job.ts'

/** Pages one sync run may ingest. Small by default so a first sync is quick. */
const PAGE_CAPS = [5, 10, 25, 50, 100] as const
const DEFAULT_CAP = 25

type SyncDone = Extract<SourceSyncEvent, { type: 'done' }>

/**
 * Follows one sync stream: every progress line, the finish and the failure go
 * into `log`, which the row keeps whatever the outcome; `job` settles on the
 * sync's result or the reason it failed.
 */
export function followSync(
  job: StreamedJob<SyncDone>,
  log: SourceSyncEvent[],
): (event: SourceSyncEvent) => void {
  return job.events((event: SourceSyncEvent) => {
    if (event.type === 'item') log.push(event)
    else if (event.type === 'error') {
      log.push(event)
      job.fail(event)
    } else if (event.type === 'done') {
      log.push(event)
      if (
        !Number.isFinite(event.added) || event.added < 0 ||
        (event.deferred !== undefined &&
          (!Number.isFinite(event.deferred) || event.deferred < 0))
      ) job.uncertain()
      else job.complete(event)
    } else job.uncertain()
  })
}

function SourceRow({
  source,
  slug,
  onChanged,
  onRemoved,
}: {
  source: PortalSource
  slug: string
  onChanged: () => Promise<unknown>
  onRemoved: () => void
}) {
  const { ui, error: localError } = usePortalLocale()

  const { runExplicit } = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState<SourceSyncEvent[]>([])
  const [deleting, setDeleting] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const patch = async (change: { auto?: boolean; maxPages?: number }) => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Update website source'),
        (access) => updateSource(slug, access, source.id, change),
      )
      assertCurrent()
      if (result === undefined) return
      if (result.id !== source.id) throw new AdminAccessError()
      assertCurrent()
      await onChanged()
    } catch (err) {
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that change.', localError),
        ),
      )
    } finally {
      setSaving(false)
    }
  }

  const onSync = async () => {
    setSyncing(true)
    setLog([])
    setMessage(null)
    const sameContext = () => context === authority.controller.context
    const job = new StreamedJob<SyncDone>(assertCurrent, 'Sync failed - please retry.')
    const events: SourceSyncEvent[] = []
    try {
      const result = await runExplicit(ui('Sync website source'), async (access) => {
        await syncSource(slug, access, source.id, followSync(job, events))
        return job.result()
      })
      assertCurrent()
      if (result === undefined) return
      setMessage(messageFor('ok', ({ ui }) =>
        ui(
          result.added === 1 ? 'Synced - {count} page added.' : 'Synced - {count} pages added.',
          { count: result.added },
        ) + (result.deferred
          ? ui(' {count} left for the next sync.', { count: result.deferred })
          : '')))
    } catch (err) {
      // A late answer after the identity or role changed is not this session's to show. While
      // access is being checked, the message says only that access changed.
      if (!sameContext()) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            failedJobMessage(job, err, 'Sync failed - please retry.', localError).text,
        ),
      )
    } finally {
      if (sameContext()) {
        setSyncing(false)
        // Only while the authority that started the sync still holds: the log is kept whatever
        // the outcome - its last lines say what went wrong - and the row is re-read so "Last
        // sync failed" and the stored reason show at once.
        if (job.authorityError() === undefined) {
          setLog([...events])
          await onChanged().catch(() => {})
        }
      }
    }
  }

  const onDelete = async () => {
    setDeleting(true)
    setRemoveError(null)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Remove website source'),
        (access) => deleteSource(slug, access, source.id),
      )
      assertCurrent()
      if (result === undefined) return
      if (result.ok !== true) throw new AdminAccessError()
      setRemoveOpen(false)
      assertCurrent()
      await onChanged()
      assertCurrent()
      onRemoved()
    } catch (err) {
      setRemoveError(errorMessage(err, 'Could not remove that source.', localError))
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not remove that source.', localError),
        ),
      )
    } finally {
      setDeleting(false)
    }
  }

  const failed = source.lastStatus === 'error'
  const cap = source.maxPages ?? DEFAULT_CAP
  const capOptions = [...new Set<number>([...PAGE_CAPS, cap])].sort((a, b) => a - b)
  const capId = `source-cap-${source.id}`

  return (
    <li className='bg-surface px-2 py-3 sm:px-4'>
      <div className='flex flex-col items-start gap-3 lg:flex-row lg:justify-between'>
        <div className='min-w-0 w-full flex-1'>
          <p className='break-words text-sm font-medium text-ink [overflow-wrap:anywhere]'>
            {source.url}
          </p>
          <div className='mt-1 flex flex-wrap items-center gap-2'>
            {failed
              ? <span className='rp-badge rp-badge-bad'>{ui('Last sync failed')}</span>
              : source.lastSync === null
              ? <span className='rp-badge rp-badge-quiet'>{ui('Not synced yet')}</span>
              : <span className='rp-badge rp-badge-ok'>{ui('Synced')}</span>}
            <span className='rp-badge rp-badge-quiet'>
              {source.auto ? ui('Daily') : ui('Manual only')}
            </span>
          </div>
          <p className='mt-1 text-xs text-ink-3'>
            {ui(source.itemCount === 1 ? '{count} page' : '{count} pages', {
              count: source.itemCount,
            })}
            {ui(' in the library from this source')}
            {source.lastSync
              ? ui(' - last checked {value1}, {lastAdded} added', {
                value1: relativeTime(source.lastSync, ui),
                lastAdded: source.lastAdded,
              })
              : ui(' - never checked')}
          </p>
          {source.lastSummary && (
            <p className='mt-2 text-xs text-ink-2'>
              {ui(
                'Last run: {new} new, {changed} changed, {unchanged} unchanged, {failed} failed.',
                source.lastSummary,
              )}
            </p>
          )}
          {failed && source.lastError && (
            <p className='mt-1.5 text-xs' style={{ color: 'var(--rp-bad-ink)' }}>
              {source.lastError}
            </p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <Button
            type='button'
            disabled={syncing}
            onClick={() => void onSync()}
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
          >
            {syncing ? ui('Sending request...') : ui('Sync now')}
          </Button>
          <Button
            type='button'
            disabled={deleting || syncing}
            onClick={() => {
              setRemoveError(null)
              setRemoveOpen(true)
            }}
            variant='danger'
            size='sm'
            leadingIcon={Trash}
            aria-haspopup='dialog'
          >
            {deleting ? ui('Removing…') : ui('Remove')}
          </Button>
        </div>
      </div>

      <div className='mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-2.5'>
        <label className='rp-check text-sm text-ink-2'>
          <input
            type='checkbox'
            checked={source.auto}
            disabled={saving || syncing}
            onChange={(e) => void patch({ auto: e.target.checked })}
            className='rp-focus'
          />
          {ui('Sync automatically each day')}
        </label>
        <div className='flex flex-wrap items-center gap-2'>
          <label htmlFor={capId} className='text-xs text-ink-2'>{ui('New pages per run')}</label>
          <select
            id={capId}
            className='rp-input rp-select w-24 shrink-0'
            value={cap}
            disabled={saving || syncing}
            onChange={(e) => void patch({ maxPages: Number(e.target.value) })}
          >
            {
              /* The source's stored cap may sit outside the presets (it can be
                set to any value over the API). Including it keeps the control
                honest - otherwise the browser falls back to showing the first
                option and misreports the real setting. */
            }
            {capOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {log.length > 0 && (
        <ol className='mt-3 max-h-40 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3 text-xs'>
          {log.map((event, index) => (
            <li key={index}>
              {event.type === 'item' && <span className='text-ink-2'>{event.label}</span>}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>
                  {ui('Finished - ')}
                  {event.added}
                  {ui(' added.')}
                </span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>
                  {localError(event.message, 'Sync failed - please retry.')}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
      {removeOpen && (
        <ConfirmActionDialog
          title={ui('Remove website source')}
          description={ui('Remove {url}? Pages already added to the library are kept.', {
            url: source.url,
          })}
          confirmLabel={ui('Remove')}
          cancelLabel={ui('Keep source')}
          busy={deleting}
          busyLabel={ui('Removing…')}
          error={removeError}
          onConfirm={() => void onDelete()}
          onCancel={() => setRemoveOpen(false)}
        />
      )}
    </li>
  )
}

/**
 * Living sources: website or sitemap URLs the librarian registers once, then
 * the portal re-checks daily and ingests newly published pages from. Distinct
 * from the one-off "Add content" ingestion methods, which never re-check.
 */
function SourcesPanelContent({ slug }: { slug: string }) {
  const { ui } = usePortalLocale()

  const { runExplicit, sessionAccess, sessionAllowed, pending } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<PortalSource[]>()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [maxPages, setMaxPages] = useState<number>(DEFAULT_CAP)
  const [auto, setAuto] = useState(true)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const heading = useRef<HTMLSpanElement>(null)

  const query = useQuery({
    queryKey: ['admin-sources', slug],
    queryFn: () => getSources(slug, sessionAccess),
    enabled: sessionAllowed,
    retry: false,
  })

  const { isLoading, isError } = query
  const data = sessionAllowed ? query.data : snapshot
  const refresh = async () => {
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Read website sources'),
        (access) => getSources(slug, access),
      )
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['admin-sources', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not load sources.', localError),
        ),
      )
    }
  }

  const onChanged = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-sources', slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] }),
    ])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setAdding(true)
    setMessage(null)
    try {
      // The server checks the site is genuinely readable before registering
      // it, and tells us what it found - report that rather than a bare
      // "added", so a site that cannot be crawled is obvious immediately.
      const added = await runExplicit(
        ui('Add website source'),
        (access) => addSource(slug, access, { url, auto, maxPages }),
      )
      assertCurrent()
      if (added === undefined) return
      if (!added.id || !Number.isFinite(added.discovered)) throw new AdminAccessError()
      if (!sessionAllowed) setSnapshot((previous) => [...(previous ?? []), added])
      setUrl('')
      setMessage(messageFor('ok', ({ ui }) =>
        ui(
          'Source added. Found {count} pages via {method}. Press Sync now to ingest the first {max}.',
          {
            count: added.discovered,
            method: ui(added.discoveredVia === 'sitemap' ? 'its sitemap' : 'page links'),
            max: maxPages,
          },
        ) + (auto ? ui(' Or leave it for the next daily sync.') : '')))
      assertCurrent()
      await onChanged()
    } catch (err) {
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not add that source.', localError),
        ),
      )
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-manage-section-head'
        title={
          <span ref={heading} className='rp-focus' tabIndex={-1}>{ui('Website sources')}</span>
        }
        description={ui(
          'Register a website or sitemap once. Daily syncs add new pages and refresh changed pages. Unchanged pages are left as they are.',
        )}
        actions={
          <Button
            variant='ghost'
            size='sm'
            leadingIcon={RotateCw}
            disabled={pending}
            onClick={() => void refresh()}
          >
            {ui('Refresh sources')}
          </Button>
        }
      />

      <form
        onSubmit={onSubmit}
        className='mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_auto_auto]'
      >
        <div className='min-w-0 sm:col-span-2 lg:col-span-1'>
          <div className='min-w-[min(16rem,100%)] flex-1'>
            <label
              htmlFor={`source-url-${slug}`}
              className='mb-1.5 block text-sm font-medium text-ink'
            >
              {ui('Site or sitemap URL')}
            </label>
            <input
              id={`source-url-${slug}`}
              type='url'
              className='rp-input'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={ui('https://example.com/sitemap.xml')}
              autoComplete='off'
              required
            />
          </div>
        </div>
        <div>
          <label
            htmlFor={`source-cap-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            {ui('Pages per run')}
          </label>
          <select
            id={`source-cap-${slug}`}
            className='rp-input rp-select'
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          >
            {PAGE_CAPS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <Button type='submit' disabled={adding} leadingIcon={Plus}>
          {adding ? ui('Checking site…') : ui('Add source')}
        </Button>
      </form>

      <label className='rp-check mt-2 text-sm text-ink-2'>
        <input
          type='checkbox'
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className='rp-focus'
        />
        {ui('Sync this source automatically each day')}
      </label>

      {message && <MessagePanel message={message} className='mt-3' />}

      <div className='mt-4 border-t border-line pt-3'>
        {!sessionAllowed && (
          <p className='mb-3 text-xs text-ink-3'>
            {ui('Sources are a snapshot. Refresh explicitly after changes.')}
          </p>
        )}
        {isLoading && (
          <div className='space-y-2'>
            <Skeleton className='h-12 w-full' />
            <Skeleton className='h-12 w-full' />
          </div>
        )}

        {isError && (
          <p className='text-sm text-ink-3'>
            {ui('Could not load sources.')}{' '}
            <Button
              type='button'
              onClick={() => void refresh()}
              variant='ghost'
              size='sm'
              leadingIcon={RotateCcw}
            >
              {ui('Try again')}
            </Button>
          </p>
        )}

        {data && data.length === 0 && (
          <p className='text-sm text-ink-3'>
            {ui(
              'No sources registered yet. Add a site above to keep the library current automatically.',
            )}
          </p>
        )}

        {data && data.length > 0 && (
          <ul className='divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {data.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                slug={slug}
                onChanged={onChanged}
                onRemoved={() => heading.current?.focus()}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Keep editors and protected snapshots within their authority generation. */
export function SourcesPanel(props: { slug: string }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <SourcesPanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
