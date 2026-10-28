/** The host composition floor, applied to the score returned by each peer. */
export const PEER_MIN_SCORE = 0.3

export function peerScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= PEER_MIN_SCORE
    ? value
    : undefined
}

const filename = /\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|html?|xml|json)(?:[?#].*)?$/i
const useful = (value: string) =>
  /\p{L}{3}/u.test(value) && !filename.test(value) && !/^https?:\/\//i.test(value) &&
  !/^untitled(?: document| passage)?$/i.test(value)

const withoutSuffix = (value: string) => {
  const last = [...value.matchAll(/\s+(?:\||-)\s+/g)].at(-1)
  return last ? value.slice(0, last.index) : value
}

/**
 * Prefer a descriptive title to a filename, then metadata, then a meaningful passage line.
 * With origin links off, remove the last spaced pipe/dash segment as a site-name suffix.
 * This is deliberately generic: a title's final subtitle can also be removed.
 */
export function peerTitle(
  title: string,
  resourceTitle: string,
  body: string,
  linkOrigins = false,
): string {
  const candidates = [
    title,
    resourceTitle,
    ...body.split(/\r?\n/).map((line) => line.trim().replace(/^\s*(?:#+|[-*])\s+/, '')),
  ].map((candidate) => candidate.trim())
  const chosen =
    candidates.find((candidate) =>
      useful(withoutSuffix(candidate)) && !/^\[\d+\]:|^Document IDs:/i.test(candidate)
    ) ?? 'Untitled document'
  return (linkOrigins ? chosen : withoutSuffix(chosen)).slice(0, 160)
}
