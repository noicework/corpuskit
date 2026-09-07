/**
 * The paper a terse question is about, when the study guard pinned none
 * (D5-09). "ICV valproate seizure reduction - number?" retrieved the
 * first-in-man intracerebroventricular valproate paper fifth, behind a
 * rat study and a cannabidiol trial, and the generator declined; "LGI1 -
 * proportion relapsed and median time to relapse" was answered with the
 * anti-NMDAR paper's figures while the LGI1 immunotherapy paper sat in
 * the sources with "16 (30%) patients experienced at least 1 relapse".
 * Both had the paper on the shortlist and neither read it. The topic pin
 * is the retrieved paper whose own text carries every name the question
 * uses (an acronym, a lexicon term, a capitalised word) and the most of
 * its outcome words; the one retry then reads that paper alone, with its
 * own paragraphs beside retrieval, before anything is declined.
 * Deterministic, string matching over the texts fetched during the probe.
 */
import { wordCount } from './intent-router.ts'
import type { WarmText } from './ask-stream-verify.ts'

/** A question this short is a terse one: the study guard's own pins take precedence. */
export const TOPIC_PIN_MAX_WORDS = 10

/** Words that say what is measured, not which paper: never a name, counted as outcome words. */
const MEASURE_WORD =
  /^(?:number|numbers|proportion|percentage|percent|rate|rates|median|mean|average|time|times|how|many|much|often|long|what|which|with|and|the|for|from|its|their|per|ci|hr|or|rr|smr|iqr|auc|sd|n|vs|versus|risk|risks|value|values|figure|figures|count|counts|total|totals|size|sizes)$/i

/** Words no paper is about. */
const STOP = new Set([
  'in',
  'for',
  'of',
  'on',
  'is',
  'are',
  'was',
  'were',
  'what',
  'which',
  'how',
  'does',
  'did',
  'do',
  'can',
  'the',
  'a',
  'an',
  'about',
  'after',
  'before',
  'during',
  'study',
  'studies',
  'paper',
  'papers',
  'trial',
  'trials',
  'patients',
  'people',
  'adults',
  'children',
  'does',
  'did',
  'was',
  'were',
  'are',
  'any',
  'have',
  'has',
  'had',
  'this',
  'that',
  'there',
])

export interface TopicPinCandidate {
  id: string
  title: string
  relevance: number
  kind?: string
}

/**
 * The names a terse question hangs on: acronyms (ICV, LGI1), lexicon terms
 * and capitalised words that are not measure words, lower-cased with
 * hyphens removed. Empty when the question names nothing.
 */
export function questionNames(query: string, lexicon: readonly string[] = []): string[] {
  const out = new Set<string>()
  const lower = query.toLowerCase()
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (t.length >= 4 && new RegExp(`\\b${escape(t)}\\b`).test(lower)) out.add(t)
  }
  for (const m of query.matchAll(/\b[A-Z][A-Za-z0-9-]{1,}\b/g)) {
    const word = m[0]
    if (MEASURE_WORD.test(word) || STOP.has(word.toLowerCase())) continue
    // An acronym, or a capitalised word: in a terse question the first
    // word is as likely a drug or a study as an opener, and the openers
    // are stopped above.
    out.add(word.toLowerCase().replace(/-/g, ''))
  }
  return [...out]
}

/** The question's outcome words: content words that are not its names. */
export function outcomeWords(query: string, names: readonly string[]): string[] {
  const out: string[] = []
  for (const m of query.toLowerCase().matchAll(/[a-z][a-z-]{3,}/g)) {
    const word = m[0].replace(/-/g, '')
    if (word.length < 4 || STOP.has(word) || MEASURE_WORD.test(word)) continue
    if (names.some((n) => n === word || n.includes(word))) continue
    out.push(word.length > 6 ? word.slice(0, 6) : word)
  }
  return [...new Set(out)]
}

/**
 * Among the retrieved papers whose texts are known, the one a terse
 * question is about: its title or text carries every name the question
 * uses, and of those it carries the most mentions of the question's
 * outcome words (a stem each, ten mentions at most), the retrieval score
 * breaking ties. A preclinical paper never stands in for a question about
 * people, and a paper that carries none of the outcome words is not the
 * one. Null for a question longer than a terse one, or with no name.
 */
export function topicPin(
  query: string,
  candidates: readonly TopicPinCandidate[],
  texts: readonly WarmText[],
  lexicon: readonly string[] = [],
): TopicPinCandidate | null {
  if (wordCount(query) > TOPIC_PIN_MAX_WORDS) return null
  const names = questionNames(query, lexicon)
  if (names.length === 0) return null
  const outcomes = outcomeWords(query, names)
  const human = !/\b(?:rat|rats|mouse|mice|rodent|animal|model|models|in vitro|in vivo)\b/i.test(
    query,
  )
  let best: { candidate: TopicPinCandidate; score: number } | null = null
  for (const candidate of candidates) {
    if (human && /preclinical|animal/i.test(candidate.kind ?? '')) continue
    const warm = texts.find((t) => t.resourceId === candidate.id)
    if (!warm) continue
    // Hyphens both removed and spaced, so "anti-LGI1" carries LGI1 and
    // "intra-cerebroventricular" carries intracerebroventricular.
    const lower = `${candidate.title}\n${warm.text}`.toLowerCase()
    const haystack = `${lower.replace(/-/g, '')}\n${lower.replace(/-/g, ' ')}`
    if (!names.every((name) => new RegExp(`\\b${escape(name)}\\b`).test(haystack))) continue
    let score = 0
    for (const word of outcomes) {
      const hits = haystack.match(new RegExp(`\\b${escape(word)}`, 'g'))?.length ?? 0
      score += Math.min(hits, 40)
    }
    if (outcomes.length > 0 && score === 0) continue
    if (
      !best || score > best.score ||
      (score === best.score && candidate.relevance > best.candidate.relevance)
    ) {
      best = { candidate, score }
    }
  }
  return best?.candidate ?? null
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
