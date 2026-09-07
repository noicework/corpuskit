/**
 * Portal wording for a failure the reader is shown.
 *
 * A platform failure is the portal's own problem to describe. The vendor's
 * name, its endpoint host, the knowledge-box id, an internal API path, a
 * tenant slug in an upstream body and a stack frame are all detail for the
 * server log, never for the page: loop 8 D8-07 caught a raw
 * `Agentic RAG API 422 for https://<zone>.rag.progress.cloud/api/v1/kb/<uuid>/ask: ...`
 * rendered verbatim into the answer card, which breaks the portal's
 * own-system framing in front of whoever is watching the screen.
 *
 * Everything a reader can see goes through `publicErrorMessage` (a thrown
 * error) or `publicSseEvent` (an error event on a stream), and
 * `leaksInternalDetail` is the invariant a test can assert.
 */

import { KnowledgeBoxNotConnectedError } from '@research-portal/retrieval'

/** The generic wording: something upstream failed and the reader can retry. */
export const ANSWER_SERVICE_PROBLEM = 'The answer service had a problem - please try again.'

/** The portal has no knowledge box behind it yet. */
export const NOT_CONNECTED_MESSAGE = 'This portal is not connected to its content yet.'

/** A document chat or reader link whose resource id the collection cannot resolve. */
export const BAD_DOCUMENT_LINK_MESSAGE = 'That document link is not valid.'

/** The platform is shedding load: transient, and worth saying so. */
export const SERVICE_BUSY_MESSAGE =
  'The answer service is busy right now - please try again in a moment.'

/**
 * What must never appear in a string sent to a reader. Each pattern is one
 * class of internal detail rather than one vendor spelling, so a reworded
 * upstream message is still caught.
 */
const INTERNAL_DETAIL: readonly RegExp[] = [
  // An endpoint URL or a bare internal host.
  /https?:\/\//i,
  /\b[a-z0-9-]+\.(?:rag|dp)\.progress\.cloud\b/i,
  /\bnuclia\.cloud\b/i,
  // A knowledge-box, resource or account UUID, hyphenated or bare.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[0-9a-f]{32}\b/i,
  // The vendor, however it is spelled.
  /\bnuclia\b/i,
  /\bagentic\s+rag\b/i,
  /\bprogress\s+agentic\b/i,
  // An internal API path or header name.
  /\/api\/v\d+\//i,
  /\bx-nuclia[a-z-]*\b/i,
  // An upstream validation body or a stack frame.
  /\bresource_filters\b/i,
  /"detail"\s*:\s*[[{]/i,
  /\bvalue_error\b/i,
  /(?:^|\n)\s+at\s+\S/,
]

/**
 * Whether a message carries internal detail. The invariant every
 * user-facing error payload holds to; empty is the only passing result for
 * the assertion in public-error.test.ts.
 */
export function leaksInternalDetail(text: string): boolean {
  return INTERNAL_DETAIL.some((pattern) => pattern.test(text))
}

/** Wording this module has already produced: passing it through again is a no-op. */
function isPortalMessage(text: string): boolean {
  return text === ANSWER_SERVICE_PROBLEM || text === NOT_CONNECTED_MESSAGE ||
    text === BAD_DOCUMENT_LINK_MESSAGE || text === SERVICE_BUSY_MESSAGE ||
    /^The answer service had a problem \(HTTP \d{3}\) - please try again\.$/.test(text)
}

/** The HTTP status an upstream failure reported, when it named one. */
function upstreamStatus(detail: string): string | null {
  return /Agentic RAG API (\d{3})/i.exec(detail)?.[1] ??
    /returned status (\d{3})/i.exec(detail)?.[1] ??
    null
}

/**
 * The portal's wording for a recognised platform failure, or null when the
 * failure is not one the portal has anything specific to say about.
 */
function mapPlatformDetail(detail: string): string | null {
  if (!detail) return null
  // A resource id the platform rejects is a stale or hand-typed document
  // link, not a service fault - say so rather than blaming the service.
  if (/should be a valid UUID|resource id filter/i.test(detail)) {
    return BAD_DOCUMENT_LINK_MESSAGE
  }
  const status = upstreamStatus(detail)
  if (status === '429' || /back-pressure/i.test(detail)) return SERVICE_BUSY_MESSAGE
  if (status) return `The answer service had a problem (HTTP ${status}) - please try again.`
  return null
}

/**
 * The message to show a reader for a thrown error. Nothing of the error
 * itself is passed through: the caller logs it, the reader gets the
 * portal's own words.
 */
export function publicErrorMessage(err: unknown): string {
  if (err instanceof KnowledgeBoxNotConnectedError) return NOT_CONNECTED_MESSAGE
  const detail = err instanceof Error ? err.message : ''
  return mapPlatformDetail(detail) ?? ANSWER_SERVICE_PROBLEM
}

/**
 * The message to show a reader for an error a provider reported as a
 * stream event rather than by throwing. Same rule, one string in.
 */
export function publicStreamErrorMessage(detail: string): string {
  if (isPortalMessage(detail)) return detail
  return mapPlatformDetail(detail) ?? ANSWER_SERVICE_PROBLEM
}

/**
 * An SSE event on its way to a reader, with any error message replaced by
 * the portal's wording and the original written to the server log. Every
 * other event passes through untouched.
 */
export function publicSseEvent(event: unknown, label: string): unknown {
  if (typeof event !== 'object' || event === null) return event
  const record = event as Record<string, unknown>
  if (record.type !== 'error') return event
  const detail = typeof record.message === 'string' ? record.message : ''
  if (detail && !isPortalMessage(detail)) console.error(`[${label}] upstream error: ${detail}`)
  return { ...record, message: publicStreamErrorMessage(detail) }
}
