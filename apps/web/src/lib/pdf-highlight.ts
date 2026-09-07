/**
 * Locating a cited passage inside a PDF's text layer so the viewer can paint
 * a highlight over it. pdfjs hands back a page as a list of text items, each
 * a run of characters with its own position; the passage the retrieval
 * matched is a normalised extract of the same text, so the job is to find
 * where that extract sits in the run list and hand back the item range.
 */

/** Lowercase, collapse whitespace, so matching survives layout and punctuation drift. */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Candidate needles from a passage, longest first. A long needle is the most
 * specific; the shorter ones are fallbacks for a passage whose start was cut
 * mid-word or straddles a hyphenated line break in the PDF.
 */
export function passageNeedles(passage: string): string[] {
  const normalised = normaliseText(passage)
  if (normalised.length === 0) return []
  const lengths = [80, 50, 30]
  const needles = lengths.map((n) => normalised.slice(0, n).trim()).filter((n) => n.length >= 12)
  return [...new Set(needles)]
}

export interface TextRun {
  str: string
}

/** The inclusive range of text items that carry the passage, or null when absent. */
export function findPassageRange(
  items: readonly TextRun[],
  passage: string,
): { start: number; end: number } | null {
  const needles = passageNeedles(passage)
  if (needles.length === 0 || items.length === 0) return null
  // Build one normalised string for the page and remember which item each
  // character came from, so a hit maps straight back to item indices.
  const owner: number[] = []
  let text = ''
  items.forEach((item, index) => {
    const piece = normaliseText(item.str)
    if (piece.length === 0) return
    if (text.length > 0) {
      text += ' '
      owner.push(index)
    }
    text += piece
    for (let i = 0; i < piece.length; i++) owner.push(index)
  })
  for (const needle of needles) {
    const at = text.indexOf(needle)
    if (at === -1) continue
    const start = owner[at]
    const end = owner[Math.min(at + needle.length - 1, owner.length - 1)]
    if (start === undefined || end === undefined) continue
    return { start, end }
  }
  return null
}
