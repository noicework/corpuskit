import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { LiveStatus } from '../../components/ui.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { uploadAdminFile } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { readRecent } from './RecentList.tsx'
import { errorMessage, type Message } from './shared.ts'
import {
  announce,
  applyProcessing,
  followed,
  formatBytes,
  recentWindow,
  refuseFile,
  summarise,
  type UploadRow,
} from './upload-queue.ts'

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
  const context = authority.controller.context
  const queryClient = useQueryClient()
  const inputId = useId()
  const hintId = useId()
  const queueHeadingId = useId()
  const [rows, setRows] = useState<UploadRow[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [notice, setNotice] = useState<Message | null>(null)
  const pending = useRef<{ key: string; file: File }[]>([])
  // Each file is kept while its row is listed, so a failed upload can be tried again.
  const retained = useRef(new Map<string, File>())
  const running = useRef(false)
  const shownPercent = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const update = (key: string, patch: Partial<UploadRow>) =>
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row))

  const uploadOne = async ({ key, file }: { key: string; file: File }) => {
    update(key, { status: 'uploading', progress: 0, error: undefined })
    setAnnouncement(`Uploading ${file.name}.`)
    try {
      const result = await runExplicit(
        `Upload ${file.name}`,
        (access) =>
          uploadAdminFile(slug, access, file, {}, (loaded, total) => {
            const size = total ?? file.size
            if (!size) return
            const percent = Math.min(100, Math.floor((loaded / size) * 100))
            // One render per whole percent, not per progress event.
            if (shownPercent.current.get(key) === percent) return
            shownPercent.current.set(key, percent)
            update(key, { progress: percent / 100 })
          }),
      )
      authority.controller.assertCurrent(context)
      if (result === undefined) {
        update(key, {
          status: 'failed',
          progress: null,
          error: 'The upload was cancelled.',
          retryable: true,
        })
        return
      }
      if (!result || typeof result.id !== 'string' || !result.id) throw new AdminAccessError()
      update(key, {
        status: 'processing',
        progress: null,
        resourceId: result.id,
        uploadedAt: Date.now(),
      })
      void onAdded().catch(() => {})
    } catch (err) {
      // Access changed underneath the upload: the page is checked again and redrawn.
      if (context !== authority.controller.context || !mounted.current) return
      update(key, {
        status: 'failed',
        progress: null,
        error: errorMessage(err, 'The upload failed - please try again.'),
        retryable: true,
      })
    }
  }

  const pump = async () => {
    if (running.current) return
    running.current = true
    try {
      // One file at a time keeps each row's progress true and the knowledge box's queue calm.
      for (let next = pending.current.shift(); next; next = pending.current.shift()) {
        if (!mounted.current) return
        await uploadOne(next)
      }
    } finally {
      running.current = false
    }
  }

  const addFiles = (files: File[]) => {
    if (files.length === 0) return
    setNotice(null)
    if (files.length > 1 && !sessionAllowed) {
      setNotice({
        tone: 'error',
        text:
          'Choose one file for emergency access. Sign in with an administrator account to upload several files at once.',
      })
      return
    }
    const added = files.map((file): UploadRow & { file: File } => {
      const refusal = refuseFile(file)
      return {
        key: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size,
        status: refusal ? 'failed' : 'queued',
        progress: null,
        ...(refusal ? { error: refusal, retryable: false } : {}),
      }
    })
    setRows((current) => [...current, ...added.map(({ file: _file, ...row }) => row)])
    for (const row of added) {
      if (row.status !== 'queued') continue
      retained.current.set(row.key, row.file)
      pending.current.push({ key: row.key, file: row.file })
    }
    setAnnouncement(
      added.length === 1 ? announce(added[0]!) : `${added.length} files added to the uploads.`,
    )
    void pump()
  }

  const retry = (key: string) => {
    const file = retained.current.get(key)
    if (!file) return
    update(key, { status: 'queued', progress: null, error: undefined })
    pending.current.push({ key, file })
    void pump()
  }

  const onChoose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    addFiles(files)
  }

  const clearFinished = () => {
    setRows((current) => {
      const keep = current.filter((row) => row.status !== 'ready' && row.status !== 'failed')
      const kept = new Set(keep.map((row) => row.key))
      for (const key of retained.current.keys()) if (!kept.has(key)) retained.current.delete(key)
      return keep
    })
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
    if (!status.data) return
    const now = Date.now()
    setRows((current) => applyProcessing(current, status.data, now))
  }, [status.data, status.dataUpdatedAt])

  // Say what changed, and refresh the collection when an upload becomes ready.
  const previous = useRef(new Map<string, UploadRow['status'] | 'stalled'>())
  useEffect(() => {
    let finished = false
    for (const row of rows) {
      const state = row.stalled ? 'stalled' : row.status
      const before = previous.current.get(row.key)
      if (before !== undefined && before !== state && state !== 'uploading') {
        setAnnouncement(announce(row))
        if (state === 'ready') finished = true
      }
      previous.current.set(row.key, state)
    }
    if (finished) void onAdded().catch(() => {})
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
                    {row.retryable && retained.current.has(row.key) && (
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
