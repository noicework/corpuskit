import { expect } from '@std/expect'
import {
  announce,
  applyProcessing,
  FOLLOW_PROCESSING_MS,
  followed,
  formatBytes,
  MAX_UPLOAD_BYTES,
  recentWindow,
  refuseFile,
  summarise,
  type UploadRow,
} from './upload-queue.ts'

const row = (patch: Partial<UploadRow> = {}): UploadRow => ({
  key: 'k',
  name: 'report.pdf',
  size: 2048,
  status: 'processing',
  progress: null,
  resourceId: 'res-1',
  uploadedAt: 1_000,
  ...patch,
})

Deno.test('files the portal would refuse are refused before any bytes are sent', () => {
  expect(refuseFile({ size: 0 })).toContain('empty')
  expect(refuseFile({ size: MAX_UPLOAD_BYTES + 1 })).toContain('100 MB')
  expect(refuseFile({ size: 1 })).toBe(null)
  expect(refuseFile({ size: MAX_UPLOAD_BYTES })).toBe(null)
})

Deno.test('sizes and batch summaries read naturally', () => {
  expect(formatBytes(900)).toBe('900 B')
  expect(formatBytes(180_000)).toBe('176 KB')
  expect(formatBytes(2_400_000)).toBe('2.3 MB')
  expect(formatBytes(52_428_800)).toBe('50 MB')
  expect(summarise([row({ status: 'ready' })])).toBe('1 file: 1 ready')
  expect(
    summarise([
      row({ key: 'a', status: 'queued' }),
      row({ key: 'b', status: 'uploading' }),
      row({ key: 'c', status: 'failed' }),
    ]),
  ).toBe('3 files: 1 waiting, 1 uploading, 1 failed')
})

Deno.test('processing follows the knowledge box until each upload is indexed or fails', () => {
  const rows = [
    row({ key: 'a', resourceId: 'r-a' }),
    row({ key: 'b', resourceId: 'r-b' }),
    row({ key: 'c', resourceId: 'r-c' }),
    row({ key: 'd', status: 'failed', resourceId: undefined }),
  ]
  const recent = [
    { id: 'r-a', title: 'a', status: 'processed' as const },
    { id: 'r-b', title: 'b', status: 'error' as const },
    { id: 'r-c', title: 'c', status: 'pending' as const },
  ]
  const next = applyProcessing(rows, recent, 2_000)
  expect(next.map((r) => r.status)).toEqual(['ready', 'failed', 'processing', 'failed'])
  expect(next[1]!.error).toContain('could not be processed')
  expect(next[1]!.retryable).toBe(false)
  expect(followed(next).map((r) => r.key)).toEqual(['c'])
  // Nothing new: the same rows, so no re-render.
  expect(applyProcessing(next, recent, 2_000)).toBe(next)
  // Past the follow window a still-pending upload is left to Recent additions.
  const late = applyProcessing(next, recent, 1_000 + FOLLOW_PROCESSING_MS + 1)
  expect(late[2]!.stalled).toBe(true)
  expect(followed(late)).toEqual([])
  expect(announce(late[2]!)).toContain('still processing')
})

Deno.test('the status read covers every followed upload, within the route bound', () => {
  expect(recentWindow(0)).toBe(12)
  expect(recentWindow(30)).toBe(42)
  expect(recentWindow(500)).toBe(100)
})

Deno.test('each state change has words for a screen reader', () => {
  expect(announce(row({ status: 'uploading' }))).toBe('Uploading report.pdf.')
  expect(announce(row({ status: 'processing' }))).toBe('report.pdf uploaded. Processing.')
  expect(announce(row({ status: 'ready' }))).toBe('report.pdf is ready.')
  expect(announce(row({ status: 'failed', error: 'That file is too large to upload.' }))).toBe(
    'report.pdf failed. That file is too large to upload.',
  )
})
