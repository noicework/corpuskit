/**
 * The passage an evidence card shows for a cited source. The platform's
 * "matched passage" is its best-scoring retrieval paragraph, which is often
 * a discussion paragraph, a masthead or a funding statement rather than the
 * sentence the answer's figure came from. This picks, per cited resource,
 * the paragraph that carries the claims the answer bound to it - figures
 * first - from the paragraphs retrieval returned (which carry a page) and,
 * failing those, from the resource's extracted text (no page; the reader
 * finds the passage in the PDF by scanning). Deterministic, no model.
 */
import { extractNumbers, figurePresent } from './answer-audit.ts'
import {
  contentWords,
  looksLikeReferencePassage,
  prepareText,
  sentenceFeatures,
  supportScore,
} from './citation-binding.ts'

export interface CandidatePassage {
  text: string
  page?: number
}

export interface PassageChoice {
  passage: string
  page?: number
}

/** Paragraphs of an extracted text worth quoting: prose of a sensible length, not a bibliography line. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:#|\d+\.\s|[-*•]\s))/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 60 && p.length <= 2500 && !looksLikeReferencePassage(p))
}

/**
 * A retrieved chunk that opens with the page's running head ("| 343 NIGHTSCALES
 * et al. 3.2 | Implications This study...") starts at the heading instead.
 */
export function stripRunningHead(passage: string): string {
  return passage.replace(/^\|?\s*(?:\d{1,4}\s*)?[^|]{0,80}\|\s*(?=\S)/, '').trim()
}

/** The sentences of a passage, in order. */
function sentencesOf(passage: string): string[] {
  return passage.split(/(?<=[.!?])\s+(?=[A-Z0-9("])/).map((s) => s.trim()).filter(Boolean)
}

/**
 * A long paragraph trimmed to the sentences that carry the claim: the one
 * with the most specific figure (a percentage or a decimal before a bare
 * count or a duration), or, without figures, the one sharing most of the
 * claim's content words, with its neighbours up to about 600 characters.
 * A retrieved chunk often opens with a masthead or a heading; the trim
 * makes sure the card quotes the finding, not the journal's running head.
 */
export function focus(
  passage: string,
  figures: readonly string[],
  claimWords: readonly string[],
): string {
  if (passage.length <= 600) return passage
  const sentences = sentencesOf(passage)
  if (sentences.length <= 1) return passage.slice(0, 600).trim()
  const ranked = [...figures].sort((a, b) => specificity(b) - specificity(a))
  const wordSet = new Set(claimWords)
  let bestIndex = 0
  let bestScore = -1
  sentences.forEach((sentence, i) => {
    const lower = sentence.toLowerCase()
    let score = 0
    ranked.forEach((figure, rank) => {
      if (figurePresent(figure, lower)) score += 100 - rank
    })
    score += contentWords(lower).filter((w) => wordSet.has(w)).length
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  })
  let out = sentences[bestIndex]!
  let before = bestIndex - 1
  let after = bestIndex + 1
  while (out.length < 600 && (before >= 0 || after < sentences.length)) {
    if (after < sentences.length && out.length + sentences[after]!.length < 600) {
      out = `${out} ${sentences[after]}`
      after++
    } else if (before >= 0 && out.length + sentences[before]!.length < 600) {
      out = `${sentences[before]} ${out}`
      before--
    } else break
  }
  return out.trim()
}

/** Percentages and decimals before bare counts, durations last. */
function specificity(figure: string): number {
  if (figure.endsWith('%')) return 3
  if (/(?:month|week|year|day|hour)s$/.test(figure)) return 0
  if (figure.includes('.')) return 2
  return 1
}

/**
 * The passage that best supports the sentences bound to one citation. Every
 * figure those sentences state must be in it when any candidate has them;
 * among such candidates the highest sentence support wins, retrieved
 * paragraphs (paged) ahead of extracted-text paragraphs at equal support.
 * Null when nothing is a better fit than what the platform matched.
 */
export function choosePassage(
  sentences: readonly string[],
  retrieved: readonly CandidatePassage[],
  extracted: readonly string[],
  lexicon: readonly string[] = [],
): PassageChoice | null {
  if (sentences.length === 0) return null
  const figures = [...new Set(sentences.flatMap((s) => extractNumbers(s)))]
  const features = sentences.map((s) => sentenceFeatures(s, lexicon))
  const candidates: (CandidatePassage & { paged: boolean })[] = [
    ...retrieved.filter((p) => p.text.trim().length >= 40 && !looksLikeReferencePassage(p.text))
      .map((p) => ({ ...p, paged: p.page !== undefined })),
    ...extracted.map((text) => ({ text, paged: false })),
  ]
  if (candidates.length === 0) return null
  let best:
    | { score: number; figureHits: number; candidate: CandidatePassage & { paged: boolean } }
    | null = null
  for (const candidate of candidates) {
    const prepared = prepareText(candidate.text)
    const figureHits = figures.filter((f) => figurePresent(f, prepared.lower)).length
    let score = 0
    for (const f of features) score = Math.max(score, supportScore(f, prepared))
    // A passage with the figures but no sentence support is still the
    // figure's home; one with neither is not evidence for these sentences.
    if (figureHits === 0 && score === 0) continue
    const better = !best || figureHits > best.figureHits ||
      (figureHits === best.figureHits &&
        (score > best.score + 0.05 ||
          (Math.abs(score - best.score) <= 0.05 && candidate.paged && !best.candidate.paged)))
    if (better) best = { score, figureHits, candidate }
  }
  if (!best) return null
  const passage = focus(
    stripRunningHead(best.candidate.text.replace(/\s+/g, ' ').trim()),
    figures,
    features.flatMap((f) => f.words),
  )
  return { passage, ...(best.candidate.page !== undefined ? { page: best.candidate.page } : {}) }
}
