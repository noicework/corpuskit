import { adminRequest } from './client.ts'
import { AdminAccessError, type AdminRequestAccess } from './break-glass.ts'
import type { ProgressRequestInit } from './upload-transport.ts'

/** Reuse the existing content replacement route, treating pasted text as text, never HTML. */
export async function updateDocumentText(
  slug: string,
  access: AdminRequestAccess,
  resourceId: string,
  text: string,
): Promise<{ ok: true; newId: string; words: number }> {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const html = `<main><p>${escaped}</p></main>`
  const init: ProgressRequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId, html }),
    holdThroughRecheck: true,
  }
  const result = await adminRequest<{ ok: boolean; newId: string; words: number }>(
    `/api/admin/t/${encodeURIComponent(slug)}/reingest`,
    access,
    init,
  )
  if (
    result?.ok !== true || typeof result.newId !== 'string' || !result.newId ||
    !Number.isFinite(result.words)
  ) {
    throw new AdminAccessError()
  }
  return { ...result, ok: true }
}
