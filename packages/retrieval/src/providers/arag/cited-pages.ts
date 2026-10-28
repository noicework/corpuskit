// A citation names a resource; the paragraph it drew on is known only to the
// binding (a footnote block or a citations-map key), and that paragraph's page
// only to retrieval (`position.page_number`). The two are joined here so a
// citation opens the stored file at the page the answer actually cited.
import type { Citation } from '@research-portal/core'

/** One retrieved document paragraph, keyed elsewhere by its platform paragraph id. */
export interface CitedParagraph {
  text: string
  /** One-based, and only for a paragraph in a paged file field. */
  page?: number
}

/** The longest passage a citation carries: the reader matches on its opening words. */
const PASSAGE_LIMIT = 2000

/**
 * Whether a paragraph id (`<resource>/<type>/<field>/<start>-<end>`) belongs to a stored file.
 * Only a file has pages: a text or link field reports page 0 for every paragraph, which would
 * otherwise read as a confident "page 1".
 */
export function isFileParagraph(paragraphId: string): boolean {
  return /^[^/]+\/f\/[^/]+\//.test(paragraphId)
}

/**
 * Gives each resource-level citation the text and page of the first paragraph the answer cited
 * in that resource, in citing order, preferring the first one with a page so the citation can
 * open the file there. Text and page always come from the same paragraph. A citation whose cited
 * paragraphs retrieval never returned (a whole-field reference, supplied context, a generated
 * summary) is left as it was, and the reader falls back to the source's own matched passage.
 */
export function citeParagraphs(
  citations: readonly Citation[],
  citedIds: readonly string[],
  paragraphs: ReadonlyMap<string, CitedParagraph>,
): Citation[] {
  const first = new Map<string, CitedParagraph>()
  const paged = new Map<string, CitedParagraph>()
  for (const id of citedIds) {
    const paragraph = paragraphs.get(id)
    const resourceId = id.split('/')[0]
    if (!paragraph || !resourceId) continue
    if (!first.has(resourceId)) first.set(resourceId, paragraph)
    if (paragraph.page && !paged.has(resourceId)) paged.set(resourceId, paragraph)
  }
  return citations.map((citation) => {
    const paragraph = paged.get(citation.resourceId) ?? first.get(citation.resourceId)
    if (!paragraph) return citation
    return {
      ...citation,
      passage: paragraph.text.slice(0, PASSAGE_LIMIT),
      ...(paragraph.page ? { page: paragraph.page } : {}),
    }
  })
}
