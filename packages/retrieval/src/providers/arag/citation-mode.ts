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
  'For a short, coherent paragraph or bullet of 2–4 sentences all supported by the same ' +
  'passage or passages, place one citation group at the end rather than repeating it after ' +
  'every sentence. Sharing a document is not enough: the cited passages must support every ' +
  'sentence in that group. Cite direct quotations, statistics and specific findings immediately ' +
  'after the sentence containing them. Use a new citation group when the supporting evidence ' +
  'changes, and give each separate paragraph or bullet its own citations. ' +
  'Use short bullet lists for distinct findings or recommendations when helpful, without ' +
  'forcing every answer into a list. These citation placement instructions take precedence ' +
  'over conflicting instructions to cite every sentence or to write placeholder or arbitrary ' +
  'citation numbers.'
