import { type Enrichment, EnrichmentSchema } from '@research-portal/core'
import { z } from 'zod'
import type { RequestContext } from './access-lifecycle.ts'
import {
  AdminAccessError,
  adminFetch,
  type AdminRequestAccess,
  assertResponseCurrent,
  finishResponse,
} from './break-glass.ts'

export const MAX_ENRICHMENT_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_AGENTS = 100
const MAX_RECORDS = 10_000
const encoder = new TextEncoder()
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

export type EnrichmentArchive = Record<string, Record<string, Enrichment>>
export interface EnrichmentArchiveReview {
  archive: EnrichmentArchive
  agentCount: number
  recordCount: number
  byteLength: number
}

export class EnrichmentImportError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'EnrichmentImportError'
  }
}

function invalid(message: string): never {
  throw new EnrichmentImportError(message)
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function safeKey(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !unsafeKeys.has(value)
}
function checkSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ENRICHMENT_ARCHIVE_BYTES) {
    invalid('Choose an enrichment archive no larger than 8 MiB.')
  }
}

/** Validate the complete archive before presenting counts or sending a request. */
export function preflightEnrichmentArchive(
  text: string,
  fileSize?: number,
): EnrichmentArchiveReview {
  if (fileSize !== undefined) checkSize(fileSize)
  if (typeof text !== 'string') invalid('Choose a valid JSON enrichment archive.')
  const byteLength = encoder.encode(text).byteLength
  checkSize(byteLength)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalid('Choose a valid JSON enrichment archive.')
  }
  if (!record(value)) invalid('The archive must contain records grouped by agent and resource.')
  const agents = Object.entries(value)
  if (agents.length > MAX_AGENTS) invalid('An archive can contain at most 100 agents.')
  const archive: EnrichmentArchive = Object.create(null)
  let recordCount = 0
  for (const [agentId, incoming] of agents) {
    if (!safeKey(agentId, 200)) invalid('The archive contains an invalid agent ID.')
    if (!record(incoming)) invalid('Each agent must contain records grouped by resource.')
    const bucket: Record<string, Enrichment> = Object.create(null)
    archive[agentId] = bucket
    for (const [resourceId, enrichment] of Object.entries(incoming)) {
      if (++recordCount > MAX_RECORDS) invalid('An archive can contain at most 10,000 records.')
      if (!safeKey(resourceId, 1000)) invalid('The archive contains an invalid resource ID.')
      const parsed = EnrichmentSchema.safeParse(enrichment)
      if (!parsed.success) invalid('The archive contains an invalid enrichment record.')
      if (parsed.data.schemaId !== agentId) {
        invalid('Each record schemaId must match its containing agent ID.')
      }
      let recordBytes: number
      try {
        recordBytes = encoder.encode(JSON.stringify(parsed.data)).byteLength
      } catch {
        invalid('The archive contains an invalid enrichment record.')
      }
      if (recordBytes > MAX_RECORD_BYTES) {
        invalid('An individual enrichment record cannot exceed 1 MiB.')
      }
      bucket[resourceId] = parsed.data
    }
  }
  if (recordCount === 0) invalid('Choose an archive containing at least one enrichment record.')
  return { archive, agentCount: agents.length, recordCount, byteLength }
}

/** Check the file size before reading, then independently bound its UTF-8 text. */
export async function readEnrichmentArchive(
  file: Pick<File, 'size' | 'text'>,
): Promise<EnrichmentArchiveReview> {
  checkSize(file.size)
  let text: string
  try {
    text = await file.text()
  } catch {
    invalid('The archive could not be read. Choose the file again.')
  }
  return preflightEnrichmentArchive(text, file.size)
}

const count = z.number().int().min(0).max(MAX_RECORDS)
const resultSchema = z.object({
  ok: z.literal(true),
  targetSlug: z.string(),
  collisionPolicy: z.literal('skip'),
  imported: count,
  skipped: count,
  overwritten: z.literal(0),
  reasons: z.object({ existing: count }).strict(),
}).strict()
export type EnrichmentImportResult = z.infer<typeof resultSchema>

function failure(status: number): EnrichmentImportError {
  const message = status === 401
    ? 'Sign in again before importing enrichments.'
    : status === 403
    ? 'You no longer have permission to import enrichments.'
    : status === 400
    ? 'The archive was rejected. Check the archive and try again.'
    : status === 413
    ? 'Choose an enrichment archive no larger than 8 MiB.'
    : status === 423
    ? 'This portal is paused or read only. Import is unavailable.'
    : status === 429
    ? 'Too many requests. Wait a moment, then try again.'
    : 'The import could not be confirmed. Refresh enrichments before trying again.'
  return new EnrichmentImportError(message, status)
}

/** Existing records are always kept. Normal administration access owns authentication. */
export async function importEnrichmentArchive(
  slug: string,
  archive: EnrichmentArchive,
  access: AdminRequestAccess,
  options: RequestContext = {},
): Promise<EnrichmentImportResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) invalid('Choose a valid portal before importing.')
  let review: EnrichmentArchiveReview
  try {
    review = preflightEnrichmentArchive(JSON.stringify(archive))
  } catch (error) {
    if (error instanceof EnrichmentImportError) throw error
    invalid('Choose a valid JSON enrichment archive.')
  }
  let response: Response | undefined
  try {
    response = await adminFetch(
      access,
      `/api/admin/t/${encodeURIComponent(slug)}/enrichments/import?collision=skip`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(review.archive),
        cache: 'no-store',
      },
      options,
    )
    if (!response.ok) throw failure(response.status)
    const value: unknown = await response.json()
    assertResponseCurrent(response)
    const parsed = resultSchema.safeParse(value)
    if (
      !parsed.success || parsed.data.targetSlug !== slug ||
      parsed.data.imported + parsed.data.skipped !== review.recordCount ||
      parsed.data.reasons.existing !== parsed.data.skipped
    ) throw failure(response.status)
    assertResponseCurrent(response)
    // Retain the transport's result lifecycle for later completion callbacks.
    return value as EnrichmentImportResult
  } catch (error) {
    if (error instanceof EnrichmentImportError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (error instanceof AdminAccessError) throw failure(error.status)
    throw failure(response?.status ?? 0)
  } finally {
    if (response) finishResponse(response)
  }
}
