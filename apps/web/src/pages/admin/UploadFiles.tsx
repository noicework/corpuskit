import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { LiveStatus } from '../../components/ui.tsx'
import type { AdminRequestAccess } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { readRecent } from './RecentList.tsx'
import type { Message } from './shared.ts'
import {
  announce,
  followed,
  formatBytes,
  recentWindow,
  summarise,
  type UploadRow,
} from './upload-queue.ts'
import { UploadQueue, uploadQueueFor, type UploadRunner } from './upload-store.ts'

/** Stand-ins while no identity holds authority, stable so nothing resubscribes. */
const NO_ROWS: UploadRow[] = []
const noRows = () => NO_ROWS
const noSubscription = () => () => {}

/** How often followed uploads are checked, and how often the collection counts are re-read. */
const STATUS_POLL_MS = 3000
const COUNTS_POLL_MS = 9000

function UploadIcon() {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      className='h-8 w-8 text-ink-3'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M12 16V4' />
      <path d='m7 9 5-5 5 5' />
      <path d='M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' />
    </svg>
  )
}

function UploadBadge({ row }: { row: UploadRow }) {
  switch (row.status) {
    case 'queued':
      return <span className='rp-badge rp-badge-quiet'>Waiting</span>
    case 'uploading':
      return (
        <span className='rp-badge rp-badge-quiet tabular-nums'>
          {row.progress === null ? 'Uploading' : `Uploading ${Math.round(row.progress * 100)}%`}
        </span>
      )
    case 'processing':
      return (
        <span className='rp-badge rp-badge-warn'>
          <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--rp-warn-ink)]' />
          Processing
        </span>
      )
    case 'ready':
      return <span className='rp-badge rp-badge-ok'>Ready</span>
    case 'failed':
      return <span className='rp-badge rp-badge-bad'>Failed</span>
  }
}

function UploadProgressBar({ row }: { row: UploadRow }) {
  const percent = row.progress === null ? null : Math.round(row.progress * 100)
  return (
    <div
      className='mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3'
      role='progressbar'
      aria-label={`Uploading ${row.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-200 ${
          percent === null ? 'w-1/3 animate-pulse' : ''
        }`}
        style={{
          background: 'var(--rp-primary)',
          ...(percent === null ? {} : { width: `${Math.max(percent, 2)}%` }),
        }}
      />
    </div>
  )
}

/**
 * Upload files by choosing them or dropping them on the zone. Each file gets a row that goes
 * waiting, uploading (with progress), processing, then ready, or failed with the reason the
 * portal gave. Processing is followed until the knowledge box has indexed the file, and the
 * collection counts are re-read meanwhile, so nothing needs a manual refresh.
 */
export function UploadFiles({ slug, onAdded }: {
  slug: string
  onAdded: () => Promise<unknown>
}) {
  const { runExplicit, sessionAllowed, sessionAccess } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const queryClient = useQueryClient()
  const inputId = useId()
  const hintId = useId()
  const queueHeadingId = useId()
  const [dragActive, setDragActive] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [notice, setNotice] = useState<Message | null>(null)
  // A signed-in queue outlives this panel: a re-check that confirms the same person redraws the
  // page, and the uploads it was running are still here, finished or going, when it returns.
  // Emergency uploads are one confirmed request each and belong to this panel alone.
  const [emergencyQueue] = useState(() =>
    new UploadQueue(
      authority.controller.context.identityKey ?? 'emergency',
      slug,
      authority.controller,
      undefined,
      true,
    )
  )
  const queue = sessionAllowed ? uploadQueueFor(authority.controller, slug) : emergencyQueue
  // The queue sends through this panel's access, re-checked on every request, while it is shown.
  const accessRef = useRef(sessionAccess)
  accessRef.current = sessionAccess
  useEffect(() => {
    if (!sessionAllowed || !queue) return
    return queue.attach({ request: (input, init) => accessRef.current.request(input, init) })
  }, [queue, sessionAllowed])
  const rows = useSyncExternalStore(queue?.subscribe ?? noSubscription, queue?.snapshot ?? noRows)
  // Emergency access sends one confirmed request per file, from this panel.
  const runner: UploadRunner | undefined = sessionAllowed
    ? undefined
    : <T,>(label: string, action: (access: AdminRequestAccess) => Promise<T>) =>
      runExplicit(label, action)

  const addFiles = (files: File[]) => {
    if (files.length === 0 || !queue) return
    setNotice(null)
    if (files.length > 1 && !sessionAllowed) {
      setNotice({
        tone: 'error',
        text:
          'Choose one file for emergency access. Sign in with an administrator account to upload several files at once.',
      })
      return
    }
    const added = queue.add(files, runner)
    setAnnouncement(
      added.length === 1 ? announce(added[0]!) : `${added.length} files added to the uploads.`,
    )
  }

  const onChoose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    addFiles(files)
  }

  const retry = (key: string) => queue?.retry(key, runner)
  const clearFinished = () => {
    queue?.clearFinished()
    setNotice(null)
  }

  // Follow processing until the knowledge box reports each upload indexed or failed.
  const followedRows = followed(rows)
  const recentLimit = recentWindow(followedRows.length)
  const status = useQuery({
    queryKey: ['admin-upload-status', slug, recentLimit],
    queryFn: () => readRecent(slug, sessionAccess, recentLimit),
    enabled: sessionAllowed && followedRows.length > 0,
    refetchInterval: STATUS_POLL_MS,
    retry: false,
  })
  useEffect(() => {
    if (status.data) queue?.applyProcessing(status.data, Date.now())
  }, [queue, status.data, status.dataUpdatedAt])

  // Say what changed, and refresh the collection when an upload lands or becomes ready.
  const previous = useRef(new Map<string, UploadRow['status'] | 'stalled'>())
  useEffect(() => {
    let changed = false
    for (const row of rows) {
      const state = row.stalled ? 'stalled' : row.status
      const before = previous.current.get(row.key)
      if (before !== undefined && before !== state && state !== 'uploading') {
        setAnnouncement(announce(row))
        if (state === 'processing' || state === 'ready') changed = true
      }
      previous.current.set(row.key, state)
    }
    if (changed) void onAdded().catch(() => {})
  }, [rows])

  // While anything processes, re-read the collection counts now and then.
  const processing = followedRows.length > 0
  useEffect(() => {
    if (!processing || !sessionAllowed) return
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['admin-counters', slug] })
      void queryClient.invalidateQueries({ queryKey: ['manage-content', slug] })
    }, COUNTS_POLL_MS)
    return () => clearInterval(timer)
  }, [processing, sessionAllowed, queryClient, slug])

  // A file dropped beside the zone must not replace the page with the file itself.
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    globalThis.addEventListener('dragover', guard)
    globalThis.addEventListener('drop', guard)
    return () => {
      globalThis.removeEventListener('dragover', guard)
      globalThis.removeEventListener('drop', guard)
    }
  }, [])

  const onDragOver = (event: ReactDragEvent<HTMLLabelElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }
  const onDragLeave = (event: ReactDragEvent<HTMLLabelElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDragActive(false)
  }
  const onDrop = (event: ReactDragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragActive(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const finishedCount = rows.filter((row) => row.status === 'ready' || row.status === 'failed')
    .length

  return (
    <div className='space-y-4' data-upload-files>
      <label
        htmlFor={inputId}
        data-drop-zone
        data-drop-active={dragActive ? 'true' : undefined}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[calc(var(--rp-radius)+4px)] border-2 border-dashed px-4 py-10 text-center transition-colors duration-150 focus-within:shadow-[var(--rp-ring)] ${
          dragActive ? 'bg-surface-3' : 'bg-surface hover:bg-[var(--rp-surface-2)]'
        }`}
        style={{ borderColor: dragActive ? 'var(--rp-primary)' : 'var(--rp-line)' }}
      >
        <UploadIcon />
        <span className='text-base font-semibold text-ink'>
          {dragActive
            ? 'Drop to upload'
            : sessionAllowed
            ? 'Drag files here to upload'
            : 'Drag a file here to upload'}
        </span>
        <span className='text-sm text-ink-2'>or</span>
        <span className='rp-btn rp-btn-primary' aria-hidden='true'>
          {sessionAllowed ? 'Choose files' : 'Choose a file'}
        </span>
        <span id={hintId} className='max-w-md text-xs text-ink-3'>
          {sessionAllowed
            ? 'Add several files at once. Up to 100 MB per file.'
            : 'Emergency access uploads one file per confirmation. Up to 100 MB.'}
        </span>
        <input
          id={inputId}
          type='file'
          multiple={sessionAllowed}
          className='sr-only'
          aria-label={sessionAllowed ? 'Choose files to upload' : 'Choose a file to upload'}
          aria-describedby={hintId}
          onChange={onChoose}
        />
      </label>

      {notice && <MessagePanel message={notice} />}

      {rows.length > 0 && (
        <section aria-labelledby={queueHeadingId} data-upload-queue>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h4 id={queueHeadingId} className='text-sm font-medium text-ink'>
              {summarise(rows)}
            </h4>
            {finishedCount > 0 && (
              <button type='button' className='rp-btn rp-btn-ghost' onClick={clearFinished}>
                Clear finished
              </button>
            )}
          </div>
          <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {rows.map((row) => (
              <li
                key={row.key}
                className='bg-surface px-4 py-3'
                data-upload-row
                data-upload-status={row.status}
              >
                <div className='flex flex-wrap items-center justify-between gap-x-3 gap-y-1'>
                  <span className='min-w-0 flex-1 truncate text-sm text-ink' title={row.name}>
                    {row.name}
                  </span>
                  <span className='flex shrink-0 items-center gap-3'>
                    <span className='text-xs tabular-nums text-ink-3'>
                      {formatBytes(row.size)}
                    </span>
                    <UploadBadge row={row} />
                  </span>
                </div>
                {row.status === 'uploading' && <UploadProgressBar row={row} />}
                {row.status === 'failed' && (
                  <div className='mt-1.5 flex flex-wrap items-start justify-between gap-2'>
                    <p
                      className='min-w-0 flex-1 text-sm text-[var(--rp-bad-ink)]'
                      data-upload-error
                    >
                      {row.error}
                    </p>
                    {row.retryable && queue?.canRetry(row.key) && (
                      <button
                        type='button'
                        className='rp-btn rp-btn-outline'
                        onClick={() => retry(row.key)}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                )}
                {row.status === 'processing' && !sessionAllowed && (
                  <p className='mt-1 text-xs text-ink-3'>
                    Processing continues on the platform. Refresh Recent additions to check it.
                  </p>
                )}
                {row.status === 'processing' && row.stalled && (
                  <p className='mt-1 text-xs text-ink-3'>
                    Still processing. It appears in Recent additions once it is ready.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <LiveStatus message={announcement} />
    </div>
  )
}
