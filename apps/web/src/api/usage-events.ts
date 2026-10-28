/** Anonymous best-effort beacon. No browser id, question, address or reader identity in its body. */
export function recordOpen(
  slug: string,
  source: { answerId?: string; searchId?: string },
  resourceId: string,
  rank: number,
): void {
  if (!source.answerId && !source.searchId) return
  void fetch(`/api/t/${encodeURIComponent(slug)}/events/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...source, resourceId, rank }),
    keepalive: true,
  }).catch(() => {})
}
