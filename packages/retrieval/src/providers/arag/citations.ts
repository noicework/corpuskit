import type { Citation } from '@research-portal/core'

/**
 * Deterministic citation binding for streamed /ask answers.
 *
 * THE PROBLEM this module solves: the system prompt asks the model to write
 * its own `[n]` markers in the prose ("numbered matching the order sources
 * first appear in your answer"), while the platform independently returns a
 * `citations` map keyed `"<rid>/<field-type>/<field>/<range>"` -> `[[start,
 * end], ...]` char-offset pairs into that same answer text. Nothing forced
 * these two numbering schemes to agree, so a model-written `[3]` could bind
 * to the wrong resource whenever its own numbering diverged from the
 * platform's. The fix: treat the
 * model's own bracket markers as untrustworthy prose noise, strip them, and
 * splice OUR OWN markers into the answer text at the platform's own
 * char-offsets - numbered by the order resource ids first appear as keys in
 * the citations map (the platform serialises them in that order). The
 * evidence table and the click-through target are built from the exact same
 * `Citation[]` list, so the prose marker, the badge and the link always
 * agree by construction.
 */

/**
 * Marker syntax the model is asked to write - and that we strip as untrusted.
 * Models also emit grouped markers (`[2, 1, 19]`) despite the prompt asking
 * for single ones, so the pattern accepts a comma-separated run of 1-3 digit
 * numbers; 4-digit numbers (years such as `[2021]`) are left alone.
 */
const INLINE_MARKER = /\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g

/** Removes every `[n]` / `[n, m, ...]` marker the model wrote in its own prose. */
export function stripInlineMarkers(text: string): string {
  return text.replace(INLINE_MARKER, '')
}

/** One citation range: a resource cited at a given end-offset into the raw answer text. */
export interface CitationRange {
  resourceId: string
  end: number
}

/**
 * Extracts valid char-offset ranges from the platform's citations map.
 * Skips DA-generated fields (known bug: stored JSON blobs can surface as
 * citation hits) and any entry without a usable numeric end offset.
 */
export function parseCitationRanges(citationsMap: Record<string, unknown>): CitationRange[] {
  const ranges: CitationRange[] = []
  for (const [key, value] of Object.entries(citationsMap)) {
    if (key.includes('/da-')) continue
    const resourceId = key.split('/')[0]
    if (!resourceId || !Array.isArray(value)) continue
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      const end = pair[1]
      if (typeof end === 'number' && Number.isFinite(end) && end >= 0) {
        ranges.push({ resourceId, end })
      }
    }
  }
  return ranges
}

/**
 * Assigns the canonical 1-based citation index per resource id, in the order
 * each id first appears as a citations-map key - the platform's own
 * appearance order, independent of anything the model wrote. Every cited
 * resource gets an entry here even when it has no usable offset (it still
 * needs a stable number for the evidence table), but only resources with a
 * usable offset end up with an in-text marker (see spliceCitationMarkers).
 */
export function assignCitationIndices(
  citationsMap: Record<string, unknown>,
  resolveTitle: (resourceId: string) => string | undefined,
): Citation[] {
  const citations: Citation[] = []
  const seen = new Set<string>()
  let index = 0
  for (const key of Object.keys(citationsMap)) {
    if (key.includes('/da-')) continue
    const resourceId = key.split('/')[0]
    if (!resourceId || seen.has(resourceId)) continue
    seen.add(resourceId)
    index += 1
    citations.push({ index, resourceId, title: resolveTitle(resourceId) ?? resourceId })
  }
  return citations
}

/** Strips inline markers while tracking how raw-text offsets map onto the stripped text. */
function stripWithOffsetMap(
  text: string,
): { text: string; mapOffset: (rawOffset: number) => number } {
  const matches = [...text.matchAll(INLINE_MARKER)]
  if (matches.length === 0) return { text, mapOffset: (offset) => offset }
  let result = ''
  let cursor = 0
  let removedTotal = 0
  const removedBefore: { rawEnd: number; removedLen: number }[] = []
  for (const match of matches) {
    const start = match.index ?? 0
    const end = start + match[0].length
    result += text.slice(cursor, start)
    removedTotal += end - start
    removedBefore.push({ rawEnd: end, removedLen: removedTotal })
    cursor = end
  }
  result += text.slice(cursor)
  const mapOffset = (rawOffset: number): number => {
    let removed = 0
    for (const entry of removedBefore) {
      if (entry.rawEnd <= rawOffset) removed = entry.removedLen
      else break
    }
    return Math.max(0, rawOffset - removed)
  }
  return { text: result, mapOffset }
}

/**
 * The full deterministic binding pass: strips the model's own `[n]` markers
 * from the raw answer text, then splices authoritative markers back in at
 * the platform's own char-offsets (highest offset first, so earlier splices
 * never invalidate later ones). Returns the corrected text alongside the
 * canonical `Citation[]` list - the same numbering used for both.
 *
 * `rawAnswer` must be the complete, final answer text (offsets are only
 * meaningful once generation has finished and every citations-map entry has
 * arrived).
 */
export function spliceCitationMarkers(
  rawAnswer: string,
  citationsMap: Record<string, unknown>,
  resolveTitle: (resourceId: string) => string | undefined,
): { text: string; citations: Citation[] } {
  const citations = assignCitationIndices(citationsMap, resolveTitle)
  if (citations.length === 0) {
    return { text: stripInlineMarkers(rawAnswer), citations: [] }
  }
  const indexByResource = new Map(citations.map((c) => [c.resourceId, c.index]))
  const { text: stripped, mapOffset } = stripWithOffsetMap(rawAnswer)
  const inserts = parseCitationRanges(citationsMap)
    .filter((r) => indexByResource.has(r.resourceId))
    .map((r) => ({
      index: indexByResource.get(r.resourceId) as number,
      pos: mapOffset(Math.min(r.end, rawAnswer.length)),
    }))
  if (inserts.length === 0) return { text: stripped, citations }
  const seenInsert = new Set<string>()
  const deduped = inserts.filter((r) => {
    const key = `${r.pos}:${r.index}`
    if (seenInsert.has(key)) return false
    seenInsert.add(key)
    return true
  })
  // Highest offset first, so an earlier splice never invalidates a later one.
  // Within one offset, highest index first: each insert at the same position
  // pushes the previous one rightwards, so descending insertion order yields
  // ASCENDING reading order. A claim supported by seven sources renders
  // `[1][2][5][6][7][8][9]`, not the `[9][8][7][6][5][2][1]` it used to.
  deduped.sort((a, b) => b.pos - a.pos || b.index - a.index)
  let out = stripped
  for (const { pos, index } of deduped) {
    const clamped = Math.max(0, Math.min(pos, out.length))
    out = `${out.slice(0, clamped)}[${index}]${out.slice(clamped)}`
  }
  return { text: out, citations }
}
