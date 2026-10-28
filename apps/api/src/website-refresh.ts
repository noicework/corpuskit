import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'

export interface PageFingerprint {
  resourceId?: string
  etag?: string
  lastModified?: string
  hash: string
}
export interface SyncSummary {
  new: number
  changed: number
  unchanged: number
  failed: number
}

export async function pageFingerprint(
  headers: Headers,
  content: { title: string; body: string },
): Promise<PageFingerprint> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${content.title}\n${content.body}`),
  )
  return {
    ...(headers.get('etag') ? { etag: headers.get('etag')! } : {}),
    ...(headers.get('last-modified') ? { lastModified: headers.get('last-modified')! } : {}),
    hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  }
}

/** Content takes precedence over noisy validators such as a deployment-specific ETag. */
export function pageChanged(previous: PageFingerprint, next: PageFingerprint): boolean {
  return previous.hash !== next.hash
}

export function conditionalHeaders(previous?: PageFingerprint): Record<string, string> {
  if (previous?.etag) return { 'if-none-match': previous.etag }
  if (previous?.lastModified) return { 'if-modified-since': previous.lastModified }
  return {}
}

/** The same clean-text replacement as manual reingest: keep drafts, titles and labels. */
export async function replaceWebsitePage(
  management: AragProvider,
  config: TenantConfig,
  resourceId: string,
  cleaned: { title: string; body: string },
  signal?: AbortSignal,
): Promise<string> {
  const summary = await management.resource(config, resourceId, { hidden: true })
  const full = await management.resourceFull(config, resourceId)
  if (!summary || !full) throw new Error('The original resource could not be read.')
  signal?.throwIfAborted()
  const created = await management.createText(config, {
    title: summary.title,
    body: cleaned.body,
    format: 'MARKDOWN',
    originUrl: full.originUrl,
    ...(summary.hidden ? { hidden: true } : {}),
  })
  signal?.throwIfAborted()
  const labels = [
    ...summary.topicIds.map((topic) => ({ labelset: 'topic', label: topic })),
    ...(summary.kind ? [{ labelset: 'kind', label: summary.kind }] : []),
  ]
  // A failed label copy must leave the original intact.
  try {
    if (labels.length) await management.patchResourceClassifications(config, created.id, labels)
  } catch (error) {
    // Roll back a failed preparation while the original is still safely present.
    if (!signal?.aborted) await management.deleteResource(config, created.id).catch(() => {})
    throw error
  }
  signal?.throwIfAborted()
  await management.deleteResource(config, resourceId)
  return created.id
}
