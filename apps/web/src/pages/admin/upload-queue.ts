import type { RecentResource } from '@research-portal/core'

/** The largest file the portal accepts, checked before any bytes are sent. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** How long an upload is followed while it processes before it is left to Recent additions. */
export const FOLLOW_PROCESSING_MS = 15 * 60 * 1000

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed'

export interface UploadRow {
  key: string
  name: string
  size: number
  status: UploadStatus
  /** Share of the file sent, 0 to 1, while uploading; null when the transport cannot tell. */
  progress: number | null
  /** Why the upload failed, in words from the portal or this page. */
  error?: string
  /** Whether trying the same file again could succeed. */
  retryable?: boolean
  /** The knowledge-box resource the upload created. */
  resourceId?: string
  /** When the upload finished, for how long its processing is followed. */
  uploadedAt?: number
  /** Processing outlasted the follow window; Recent additions reports the rest. */
  stalled?: boolean
}

/** Why a file cannot be uploaded at all, before it is sent, or null when it can. */
export function refuseFile(file: Pick<File, 'size'>): string | null {
  if (file.size === 0) return 'That file is empty - choose another file.'
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is larger than the 100 MB limit.'
  return null
}

/** A file size for people: bytes, KB or MB with one decimal where it helps. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** How many of the newest additions to read so every followed upload can be found. */
export function recentWindow(followed: number): number {
  return Math.min(100, Math.max(12, followed + 12))
}

/**
 * Apply the knowledge box's view of its newest resources to the uploads being followed. A
 * processed resource is ready and one the platform could not process has failed; one that has
 * been processing past the follow window is left to Recent additions.
 */
export function applyProcessing(
  rows: UploadRow[],
  recent: RecentResource[],
  now: number,
): UploadRow[] {
  const byId = new Map(recent.map((resource) => [resource.id, resource]))
  let changed = false
  const next = rows.map((row) => {
    if (row.status !== 'processing' || row.stalled || !row.resourceId) return row
    const resource = byId.get(row.resourceId)
    if (resource?.status === 'processed') {
      changed = true
      return { ...row, status: 'ready' as const }
    }
    if (resource?.status === 'error') {
      changed = true
      return {
        ...row,
        status: 'failed' as const,
        error: 'The file was uploaded but could not be processed. Check that it opens, or try ' +
          'another format.',
        retryable: false,
      }
    }
    if (row.uploadedAt !== undefined && now - row.uploadedAt > FOLLOW_PROCESSING_MS) {
      changed = true
      return { ...row, stalled: true }
    }
    return row
  })
  return changed ? next : rows
}

/** Uploads whose processing is still being followed. */
export function followed(rows: UploadRow[]): UploadRow[] {
  return rows.filter((row) => row.status === 'processing' && !row.stalled && row.resourceId)
}

/** One line that sums up a batch, such as "3 files: 1 uploading, 1 processing, 1 ready". */
export function summarise(rows: UploadRow[]): string {
  const count = (status: UploadStatus) => rows.filter((row) => row.status === status).length
  const parts = [
    [count('queued'), 'waiting'],
    [count('uploading'), 'uploading'],
    [count('processing'), 'processing'],
    [count('ready'), 'ready'],
    [count('failed'), 'failed'],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`)
  const files = `${rows.length} ${rows.length === 1 ? 'file' : 'files'}`
  return parts.length ? `${files}: ${parts.join(', ')}` : files
}

/** What a screen reader hears when an upload changes state. */
export function announce(row: UploadRow): string {
  switch (row.status) {
    case 'queued':
      return `${row.name} is waiting to upload.`
    case 'uploading':
      return `Uploading ${row.name}.`
    case 'processing':
      return row.stalled ? `${row.name} is still processing.` : `${row.name} uploaded. Processing.`
    case 'ready':
      return `${row.name} is ready.`
    case 'failed':
      return `${row.name} failed. ${row.error ?? ''}`.trim()
  }
}
