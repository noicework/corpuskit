/**
 * How the reader treats a PDF's extracted text.
 *
 * The document itself is the default view: arriving from a citation opens the
 * PDF at the cited page with the passage highlighted, and the machine reading
 * of that file stays folded away behind a switch until the reader asks for it.
 * The one exception is a PDF that cannot be displayed at all - then the
 * extracted text is the only reading there is, so it is shown outright rather
 * than hidden behind a control the reader has no reason to find.
 */
export type ExtractedTextMode =
  /** There is no extracted text (or generated summary) to show at all. */
  | 'hidden'
  /** The PDF is on screen, so the extracted text waits behind its switch. */
  | 'switch'
  /** The PDF could not be displayed - the extracted text is the only reading. */
  | 'always'

export function extractedTextMode(
  { hasExtractedText, pdfAvailable }: {
    /** Parsed document blocks or a generated summary exist for this resource. */
    hasExtractedText: boolean
    /** The PDF viewer has a file and opened it. */
    pdfAvailable: boolean
  },
): ExtractedTextMode {
  if (!hasExtractedText) return 'hidden'
  return pdfAvailable ? 'switch' : 'always'
}

/** The switch's label, which always states the action it performs. */
export function extractedTextToggleLabel(open: boolean): string {
  return open ? 'Hide extracted text' : 'Show extracted text'
}

/**
 * The line under the switch. It says what the extracted text is and, when a
 * search or a citation matched inside it, that there is something in there to
 * find - without opening a wall of machine text to say so.
 */
export function extractedTextHint(
  { open, hasMatch }: { open: boolean; hasMatch: boolean },
): string {
  if (open) {
    return 'A machine reading of the file. The PDF above is the document itself.'
  }
  return hasMatch
    ? 'A machine reading of the file, for searching and copying. Your match appears in it.'
    : 'A machine reading of the file, for searching and copying.'
}
