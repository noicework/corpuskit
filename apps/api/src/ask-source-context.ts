import type { SourceContext } from '@research-portal/retrieval'
import { type ContextTurn, MAX_PRIOR_IDS, MAX_PRIOR_PASSAGES } from './ask-session.ts'

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The browser's previous excerpts are hints, never proof of provenance.
 * Re-read the named originals and retain only excerpts actually present there.
 * Do not guess a document from a title, use positional alignment between the
 * client's arrays, or treat its generated answer as original source material.
 */
export async function verifiedPriorSourceContext(
  turns: readonly ContextTurn[],
  extraction: (resourceId: string) => Promise<string>,
  allowedResourceIds: ReadonlySet<string>,
): Promise<SourceContext[]> {
  const loaded = new Map<string, Promise<string>>()
  const out: SourceContext[] = []
  const seen = new Set<string>()
  for (const turn of [...turns].reverse()) {
    if (turn.author !== 'AGENT') continue
    const passages = (turn.passages ?? []).slice(0, MAX_PRIOR_PASSAGES)
      .map((p) => normalise(p).slice(0, 700)).filter((p) => p.length >= 40)
    if (passages.length === 0) continue
    for (const id of turn.resourceIds ?? []) {
      if (!allowedResourceIds.has(id)) continue
      if (!loaded.has(id)) {
        if (loaded.size >= MAX_PRIOR_IDS) continue
        loaded.set(id, extraction(id).then(normalise, () => ''))
      }
      const original = await loaded.get(id)!
      if (!original) continue
      for (const text of passages) {
        const key = `${id}\n${text}`
        if (seen.has(key) || !original.includes(text)) continue
        seen.add(key)
        out.push({ resourceId: id, text })
        if (out.length >= MAX_PRIOR_PASSAGES) return out
      }
    }
  }
  return out
}
