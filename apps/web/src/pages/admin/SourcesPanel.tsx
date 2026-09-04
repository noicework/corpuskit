import { type FormEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PortalSource, SourceSyncEvent } from '../../api/client.ts'
import { addSource, deleteSource, getSources, syncSource, updateSource } from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/** Pages one sync run may ingest. Small by default so a first sync is quick. */
const PAGE_CAPS = [5, 10, 25, 50, 100] as const
const DEFAULT_CAP = 25

/** Same relative-time shape used across the admin panels, applied to ISO timestamps. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

const pageWord = (n: number) => (n === 1 ? 'page' : 'pages')

function SourceRow({
  source,
  slug,
  passcode,
  onChanged,
}: {
  source: PortalSource
  slug: string
  passcode: string
  onChanged: () => Promise<unknown>
}) {
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState<SourceSyncEvent[]>([])
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const patch = async (change: { auto?: boolean; maxPages?: number }) => {
    setSaving(true)
    setMessage(null)
    try {
      await updateSource(slug, passcode, source.id, change)
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save that change.') })
    } finally {
      setSaving(false)
    }
  }

  const onSync = async () => {
    setSyncing(true)
    setLog([])
    setMessage(null)
    try {
      await syncSource(slug, passcode, source.id, (event) => {
        setLog((prev) => [...prev, event])
        if (event.type === 'done') {
          const deferred = event.deferred ?? 0
          setMessage({
            // Deferring pages under back-pressure is graceful handling, not a
            // failure - the sync still made progress and will finish itself.
            tone: 'ok',
            text: deferred > 0
              ? `Synced - ${event.added} ${pageWord(event.added)} added. ` +
                `The knowledge box was busy, so ${deferred} ${
                  deferred === 1 ? 'page was' : 'pages were'
                } left for the next sync.`
              : `Synced - ${event.added} ${pageWord(event.added)} added.`,
          })
        }
        if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Sync failed - please retry.') })
    } finally {
      setSyncing(false)
    }
  }

  const onDelete = async () => {
    setDeleting(true)
    setMessage(null)
    try {
      await deleteSource(slug, passcode, source.id)
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not remove that source.') })
      setDeleting(false)
    }
  }

  const failed = source.lastStatus === 'error'
  const cap = source.maxPages ?? DEFAULT_CAP
  const capOptions = [...new Set<number>([...PAGE_CAPS, cap])].sort((a, b) => a - b)
  const capId = `source-cap-${source.id}`

  return (
    <li className='bg-surface px-4 py-3'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        {
          /* `grow basis-64`, not `flex-1`: a 16rem basis makes a narrow panel
            wrap the buttons onto their own line instead of squeezing the url
            column to a useless "https://www…". `flex-1` cannot express this -
            its `flex: 1 1 0%` shorthand resets the basis to zero. */
        }
        <div className='min-w-0 grow basis-64'>
          <div className='flex flex-wrap items-center gap-2'>
            <p className='min-w-0 truncate text-sm font-medium text-ink' title={source.url}>
              {source.url}
            </p>
            {failed
              ? <span className='rp-badge rp-badge-bad'>Last sync failed</span>
              : source.lastSync === null
              ? <span className='rp-badge rp-badge-quiet'>Not synced yet</span>
              : <span className='rp-badge rp-badge-ok'>Synced</span>}
            <span className='rp-badge rp-badge-quiet'>
              {source.auto ? 'Daily' : 'Manual only'}
            </span>
          </div>
          <p className='mt-1 text-xs text-ink-3'>
            {source.itemCount} {pageWord(source.itemCount)} in the library from this source
            {source.lastSync
              ? ` - last checked ${relativeTime(source.lastSync)}, ${source.lastAdded} added`
              : ' - never checked'}
          </p>
          {failed && source.lastError && (
            <p className='mt-1.5 text-xs' style={{ color: 'var(--rp-bad-ink)' }}>
              {source.lastError}
            </p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <button
            type='button'
            disabled={syncing}
            onClick={() => void onSync()}
            className='rp-btn rp-btn-outline'
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type='button'
            disabled={deleting || syncing}
            onClick={() => void onDelete()}
            className='rp-btn rp-btn-ghost'
            style={{ color: 'var(--rp-bad-ink)' }}
          >
            {deleting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>

      <div className='mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-2.5'>
        <label className='flex items-center gap-2 text-xs text-ink-2'>
          <input
            type='checkbox'
            checked={source.auto}
            disabled={saving || syncing}
            onChange={(e) => void patch({ auto: e.target.checked })}
            className='rp-focus h-4 w-4 rounded border-line'
          />
          Sync automatically each day
        </label>
        <div className='flex items-center gap-2'>
          <label htmlFor={capId} className='whitespace-nowrap text-xs text-ink-2'>
            New pages per run
          </label>
          <select
            id={capId}
            className='rp-input w-24'
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
                  Finished - {event.added} added.
                </span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>{event.message}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
    </li>
  )
}

/**
 * Living sources: website or sitemap URLs the librarian registers once, then
 * the portal re-checks daily and ingests newly published pages from. Distinct
 * from the one-off "Add content" ingestion methods, which never re-check.
 */
export function SourcesPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [maxPages, setMaxPages] = useState<number>(DEFAULT_CAP)
  const [auto, setAuto] = useState(true)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-sources', slug],
    queryFn: () => getSources(slug, passcode),
  })

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
      const added = await addSource(slug, passcode, { url, auto, maxPages })
      setUrl('')
      setMessage({
        tone: 'ok',
        text: `Source added. Found ${added.discovered} ${pageWord(added.discovered)} via ` +
          `${added.discoveredVia === 'sitemap' ? 'its sitemap' : 'page links'}. ` +
          `Press Sync now to ingest the first ${maxPages}` +
          (auto ? ', or leave it for the next daily sync.' : '.'),
      })
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not add that source.') })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div>
        <p className='text-sm font-semibold text-ink'>Website sources</p>
        <p className='mt-0.5 text-xs text-ink-3'>
          Register a website or sitemap once. Each source is re-checked daily, and pages published
          since the last check are ingested automatically. Pages already taken from a source are
          never ingested twice.
        </p>
      </div>

      <form onSubmit={onSubmit} className='mt-3 flex flex-wrap items-end gap-2'>
        <div className='min-w-[min(16rem,100%)] flex-1'>
          <label
            htmlFor={`source-url-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Site or sitemap URL
          </label>
          <input
            id={`source-url-${slug}`}
            type='url'
            className='rp-input'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://example.com/sitemap.xml'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label
            htmlFor={`source-cap-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Pages per run
          </label>
          <select
            id={`source-cap-${slug}`}
            className='rp-input'
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          >
            {PAGE_CAPS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type='submit' disabled={adding} className='rp-btn rp-btn-primary'>
          {adding ? 'Checking site…' : 'Add source'}
        </button>
      </form>

      <label className='mt-2 flex items-center gap-2 text-xs text-ink-2'>
        <input
          type='checkbox'
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className='rp-focus h-4 w-4 rounded border-line'
        />
        Sync this source automatically each day
      </label>

      {message && <MessagePanel message={message} className='mt-3' />}

      <div className='mt-4 border-t border-line pt-3'>
        {isLoading && (
          <div className='space-y-2'>
            <Skeleton className='h-12 w-full' />
            <Skeleton className='h-12 w-full' />
          </div>
        )}

        {isError && (
          <p className='text-sm text-ink-3'>
            Could not load sources.{' '}
            <button
              type='button'
              onClick={() => void refetch()}
              className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'
            >
              Try again
            </button>
          </p>
        )}

        {data && data.length === 0 && (
          <p className='text-sm text-ink-3'>
            No sources registered yet. Add a site above to keep the library current automatically.
          </p>
        )}

        {data && data.length > 0 && (
          <ul className='divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {data.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                slug={slug}
                passcode={passcode}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
