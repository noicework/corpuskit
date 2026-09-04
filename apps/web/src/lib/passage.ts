/**
 * Whether a matched passage actually tells the reader anything.
 *
 * A place-name or single-term query often matches a bare heading or a list of
 * state names, so the passage comes back as the query echoed ("Western
 * Australia South Australia Victoria") or as punctuation noise. Quoting that
 * under a result is worse than quoting nothing.
 */
export function passageIsInformative(passage: string, query: string): boolean {
  const words = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)

  const passageWords = words(passage)
  if (passageWords.length === 0) return false

  const queryWords = new Set(words(query))
  const beyondQuery = passageWords.filter((word) => !queryWords.has(word))

  // Nothing but the query terms echoed back, however many times.
  if (beyondQuery.length === 0) return false
  // A couple of stray words either side of the query is still not a sentence.
  return beyondQuery.length >= 4
}
