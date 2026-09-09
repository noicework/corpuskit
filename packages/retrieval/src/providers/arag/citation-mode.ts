/** One server-side switch for every prose answer surface. No client override. */
export type CitationMode = 'llm_footnotes' | 'standard'
export const CITATION_MODE: CitationMode = 'llm_footnotes'

export function citationRequest(mode: CitationMode) {
  return mode === 'llm_footnotes' ? 'llm_footnotes' : true
}

export const FOOTNOTE_PROMPT =
  'Cite factual claims and direct quotations using the supplied footnote protocol. ' +
  'Every footnote must link to the exact supporting context block; never invent a block or ' +
  'citation number. Put citations after sentence punctuation, not on headings. ' +
  'Use short bullet lists for distinct findings or recommendations when helpful, without ' +
  'forcing every answer into a list. These citation instructions take precedence over any ' +
  'instruction to write placeholder or arbitrary citation numbers.'
