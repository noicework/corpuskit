/**
 * Snippet selection for search results. Retrieval scores a reference-list
 * line ("33. Steinhoff BJ, Christensen J ... 2018;138:186-94.") as highly as
 * a sentence of findings, because the query terms sit in the cited title.
 * The passage shown under a result, and the resource's rank, should come
 * from the body of the paper whenever the body matched at all. Pure
 * functions, unit-tested; `search()` is the only caller.
 */

export interface ScoredParagraph {
  score: number
  text: string
  page?: number
  /** Field the paragraph came from (a generated summary field is not body text). */
  fieldKey?: string
}

/**
 * A bibliography entry or a run of them: a numbered author list, the
 * "journal. year;volume:pages." tail of a citation, or a passage that is
 * mostly DOIs. Complements the broader `looksLikeReferenceChunk` (which
 * needs several author-year pairs before it fires) with the shapes a single
 * indexed paragraph of a reference list actually takes.
 */
export function looksLikeBibliographicSnippet(text: string): boolean {
  const sample = text.trim().slice(0, 600)
  if (!sample) return false
  // "12. Surname AB, Other CD, ..." - a numbered entry opening with an author
  // list in the "Surname INITIALS," form, anywhere in the first line or two.
  const numberedAuthors =
    /(?:^|\s)\d{1,3}\.\s+[A-Z][A-Za-z'’-]+\s+[A-Z]{1,3}(?:,|\s+[A-Z][A-Za-z'’-]+\s+[A-Z]{1,3})/
  // "Epilepsia. 2018;59(2):186-94." - the volume/pages tail of a citation.
  const journalTail = /\b(19|20)\d{2}\s*;\s*\d{1,4}\s*(\(\d+\))?\s*:\s*\d+/
  const doiMentions = (sample.match(/doi\.org\/|\b10\.\d{4,9}\/[^\s]+/gi) ?? []).length
  const words = sample.split(/\s+/).length || 1
  const authorRuns = (sample.match(/[A-Z][a-z]+\s[A-Z]{1,3},/g) ?? []).length
  if (numberedAuthors.test(sample)) return true
  if (journalTail.test(sample) && authorRuns >= 2) return true
  // A passage that is mostly DOIs (a references-only column, or a DOI footer).
  if (doiMentions >= 2 && words / doiMentions < 12) return true
  return false
}

/**
 * The title/author/affiliation block of a first page: journal masthead
 * words, an "Open Access" badge, "Correspondence" or "Received/Accepted"
 * lines, or a run of "Name,1,2" affiliation superscripts.
 */
export function looksLikeFrontMatter(text: string): boolean {
  const sample = text.trim().slice(0, 600)
  if (!sample) return false
  const masthead =
    /\b(RESEARCH ARTICLE|ORIGINAL (ARTICLE|RESEARCH)|OPEN ACCESS|REVIEW ARTICLE|CASE REPORT|BRIEF COMMUNICATION|Received:?\s+\d|Accepted:?\s+\d|Correspondence(\s+to)?:)/
  const affiliationRuns = (sample.match(/[A-Z][a-z]+,\s?\d{1,2}(?:,\s?\d{1,2})*\b/g) ?? []).length
  return masthead.test(sample) || affiliationRuns >= 3
}

/**
 * A DOI fragment, an isolated URL, an identifier line or a shredded table
 * ("Pa tie nt s (%) d n") - not prose.
 */
export function looksLikeIdentifierFragment(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const letters = (t.match(/[A-Za-z]/g) ?? []).length
  const doiOrUrl = (t.match(/https?:\/\/\S+|\b10\.\d{4,9}\/\S+/gi) ?? []).join('').length
  if (doiOrUrl / Math.max(1, t.length) > 0.4 || letters < 12) return true
  // Column-extracted tables come back as a spray of one- and two-letter
  // tokens; real sentences are mostly longer words.
  const tokens = t.split(/\s+/)
  const isShort = (w: string) => w.replace(/[^A-Za-z0-9]/g, '').length <= 2
  const short = tokens.filter(isShort).length
  if (tokens.length >= 8 && short / tokens.length > 0.5) return true
  // Or a passage that OPENS with a spray of them before the prose resumes
  // ("Pa tie nt s (%) d n Patients with post-stroke epilepsy ...").
  const opening = tokens.slice(0, 12)
  return opening.length >= 8 && opening.filter(isShort).length >= 6
}

/** True when a passage should never be the snippet for a body-text match. */
export function isCitationNoise(text: string): boolean {
  return looksLikeBibliographicSnippet(text) || looksLikeFrontMatter(text) ||
    looksLikeIdentifierFragment(text)
}

export interface SnippetChoice {
  /** The paragraph to show, or undefined when nothing was retrieved. */
  passage?: ScoredParagraph
  /** Score to rank by: the best body paragraph, or the best noise paragraph discounted. */
  score: number
  /** The only matches were reference-list, front-matter or identifier noise. */
  reference: boolean
}

/** How much a resource whose only matches are citation noise is discounted in ranking. */
export const REFERENCE_DISCOUNT = 0.4

/**
 * Pick the paragraph to quote and the score to rank by. A body paragraph
 * that cleared the relevance floor always wins over a higher-scoring
 * reference-list line; a resource whose only matches are noise keeps its
 * best paragraph (so the card can say "reference list") but ranks at a
 * fraction of its score. `isNoise` is injectable so the caller can combine
 * this module's detectors with its own.
 */
export function chooseSnippet(
  paragraphs: ScoredParagraph[],
  minScore: number,
  isNoise: (text: string) => boolean = isCitationNoise,
): SnippetChoice {
  let bestBody: ScoredParagraph | undefined
  let bestAny: ScoredParagraph | undefined
  for (const paragraph of paragraphs) {
    if (!bestAny || paragraph.score >= bestAny.score) bestAny = paragraph
    if (paragraph.score < minScore) continue
    if (isNoise(paragraph.text)) continue
    if (!bestBody || paragraph.score >= bestBody.score) bestBody = paragraph
  }
  if (bestBody) return { passage: bestBody, score: bestBody.score, reference: false }
  if (!bestAny) return { score: 0, reference: false }
  return { passage: bestAny, score: bestAny.score * REFERENCE_DISCOUNT, reference: true }
}

/** A query that is a DOI, with or without a resolver prefix. */
export function extractDoi(query: string): string | undefined {
  const match = query.trim().match(
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i,
  )
  return match ? match[1]!.replace(/[.,;)]+$/, '').toLowerCase() : undefined
}

/**
 * Whether a resource is the document a DOI query names: its own recorded DOI
 * matches, or the exact identifier appears in its matched text (a reference
 * to a different DOI in the same journal is not a match).
 */
export function matchesDoi(
  doi: string,
  resource: { doi?: string; texts: string[] },
): boolean {
  const wanted = doi.toLowerCase()
  if (resource.doi && resource.doi.trim().toLowerCase().replace(/[.,;)]+$/, '') === wanted) {
    return true
  }
  return resource.texts.some((t) => t.toLowerCase().replace(/\s+/g, '').includes(wanted))
}

/**
 * An exact lookup (a bare identifier or term the router sent to the keyword
 * configuration) promises the documents that contain it. Fuzzy retrieval
 * still returns near misses - "Okafor recurrence" matched eighteen papers
 * about recurrence - so every term of at least three characters must occur
 * in the title or matched passage for the result to count.
 */
export function isExactTermMatch(
  query: string,
  resource: { title?: string; texts: string[] },
): boolean {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 3)
  if (terms.length === 0) return true
  const haystack = [resource.title ?? '', ...resource.texts].join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
