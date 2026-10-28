import {
  type DuplicateDecision,
  DuplicateReportSchema,
  DuplicateReviewResultSchema,
  OverlapReportSchema,
} from '@research-portal/core'
import { adminRequest } from './client.ts'
import { adminFetch, type AdminRequestAccess, assertResponseCurrent } from './break-glass.ts'
import type { Locale } from '../lib/portal-locale.tsx'

/** Source metadata remains authored text; the matcher's evidence labels are interface copy. */
export function duplicateReason(reason: string, ui: Locale['ui']): string {
  const similarity = /^Similar title and summary shingles \((\d+)%\)$/.exec(reason)
  return similarity
    ? ui('Similar title and summary shingles ({score}%)', { score: similarity[1]! })
    : ui(reason)
}

const portalPath = (slug: string) => `/api/admin/t/${encodeURIComponent(slug)}/duplicates`
export function getDuplicates(
  slug: string,
  access: AdminRequestAccess,
  signal?: AbortSignal,
  page = 1,
  reviewed = true,
) {
  return adminRequest<unknown>(
    `${portalPath(slug)}?page=${page}&reviewed=${reviewed}`,
    access,
    { signal },
  ).then((value) => DuplicateReportSchema.parse(value))
}
export function refreshDuplicates(
  slug: string,
  access: AdminRequestAccess,
  page = 1,
  reviewed = true,
) {
  return adminRequest<unknown>(
    `${portalPath(slug)}/refresh?page=${page}&reviewed=${reviewed}`,
    access,
    { method: 'POST' },
  ).then((value) => DuplicateReportSchema.parse(value))
}
export function reviewDuplicate(
  slug: string,
  access: AdminRequestAccess,
  pair: string,
  decision: DuplicateDecision,
) {
  return adminRequest<unknown>(`${portalPath(slug)}/review`, access, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair, decision }),
  }).then((value) => DuplicateReviewResultSchema.parse(value))
}
export function getOverlap(access: AdminRequestAccess, signal?: AbortSignal, page = 1) {
  return adminRequest<unknown>(`/api/admin/overlap?page=${page}`, access, { signal }).then((
    value,
  ) => OverlapReportSchema.parse(value))
}
export function refreshOverlap(access: AdminRequestAccess, page = 1) {
  return adminRequest<unknown>(`/api/admin/overlap/refresh?page=${page}`, access, {
    method: 'POST',
  }).then((value) => OverlapReportSchema.parse(value))
}
export async function downloadOverlap(access: AdminRequestAccess, page = 1): Promise<Blob> {
  const response = await adminFetch(access, `/api/admin/overlap/export?page=${page}`)
  const blob = await response.blob()
  assertResponseCurrent(response)
  if (!response.ok) throw new Error('Could not download the overlap report.')
  return blob
}
