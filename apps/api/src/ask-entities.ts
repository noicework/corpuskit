/**
 * What a question names, and how it comes apart
 * (review loop 2 D2-03, D2-05, D2-08).
 *
 * The clauses of a multi-part question, the drugs and studies a comparison
 * names, the retrieval text for one of them, and the ranking that chooses
 * which papers a decline names. Clause pinning (clause-pin.ts) builds on
 * all of it: a comparison is now answered one paper at a time rather than
 * being grounded on several papers at once and checked afterwards.
 *
 * Everything here is deterministic and pure, so the module is tested
 * without the platform.
 */
import type { ScoredResource } from '@research-portal/core'
import { isMedicationTerm } from './ask-prequeries.ts'
import { isResultsQuestion, lexiconEntities } from './intent-router.ts'
import { isAttachmentTitle, studyAcronyms } from './study-guard.ts'

/**
 * The clauses of a multi-part question, each a standalone retrieval query:
 * "What are the criteria for X, and what proportion met them?" splits at
 * the ", and what". A question with one clause yields nothing (the main
 * query already covers it); at most three clauses of four or more words.
 */
export function questionClauses(query: string): string[] {
  const parts = query
    .split(
      /\s*(?:[;?]|,?\s+and\s+(?=(?:what|how|which|whether|when|where|why|did|does|do|is|was|were|are|can|could|should|who)\b))\s*/i,
    )
    .map((p) => p.trim().replace(/[?.]+$/, '').trim())
    .filter((p) => p.split(/\s+/).length >= 4)
  return parts.length >= 2 ? parts.slice(0, 3) : []
}

/**
 * The drugs and studies a question names, in order: medication terms from
 * the lexicon and study acronyms. Two or more make the question a
 * comparison that grounds per entity.
 */
export function comparisonEntities(query: string, lexicon: readonly string[]): string[] {
  const out: string[] = []
  const add = (e: string) => {
    if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e)
  }
  for (const term of lexiconEntities(query, lexicon)) if (isMedicationTerm(term)) add(term)
  for (const acronym of studyAcronyms(query)) add(acronym)
  return out
}

/**
 * The retrieval text for one entity: the question with the other entities
 * removed and the entity itself repeated at the front, so the stored
 * configuration ranks that entity's own papers first.
 */
export function entityQuery(query: string, entity: string, others: readonly string[]): string {
  let text = query
  for (const other of others) {
    if (other.toLowerCase() === entity.toLowerCase()) continue
    text = text.replace(
      new RegExp(
        `\\b(?:adjunctive\\s+|versus\\s+|vs\\.?\\s+|or\\s+|and\\s+)?${escape(other)}\\b`,
        'gi',
      ),
      ' ',
    )
  }
  return `${entity}: ${text.replace(/\s+/g, ' ').trim()}`
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether a resource's title or matched passage names the entity. */
export function mentionsEntity(
  resource: Pick<ScoredResource, 'title' | 'matchedPassage'>,
  entity: string,
): boolean {
  const word = new RegExp(`(?:^|[^a-z0-9])${escape(entity.toLowerCase())}(?=$|[^a-z0-9])`)
  return word.test(resource.title.toLowerCase()) ||
    word.test((resource.matchedPassage ?? '').toLowerCase())
}

/**
 * The paper to ground an entity on: the first retrieved article (never an
 * attachment) whose title or passage names the entity. The title is
 * preferred over the passage so "PERMIT study: ... perampanel" beats a
 * brivaracetam paper whose passage mentions perampanel in passing.
 */
export function pickEntityPaper(
  results: readonly ScoredResource[],
  entity: string,
): ScoredResource | undefined {
  const articles = results.filter((r) => !isAttachmentTitle(r.title) && !r.referenceChunk)
  const word = new RegExp(`(?:^|[^a-z0-9])${escape(entity.toLowerCase())}(?=$|[^a-z0-9])`)
  return articles.find((r) => word.test(r.title.toLowerCase())) ??
    articles.find((r) => mentionsEntity(r, entity))
}

/**
 * A conference abstract collection or meeting proceedings: never a "closest
 * match" worth naming in a decline (D2-10). Matched on the title, as the
 * kind rules have no such kind.
 */
export function isConferenceTitle(title: string): boolean {
  return /\b(?:\d+(?:st|nd|rd|th)\s+(?:[\w-]+\s+){0,5}(?:meeting|congress|conference|symposium)|annual meeting|meeting:\s*part|proceedings of|abstracts? (?:of|from) the|congress of|conference on)\b/i
    .test(title)
}

/** Words that make a question about animal or model work, where a preclinical paper fits. */
const ANIMAL = /\b(?:rat|rats|mouse|mice|rodent|animal|model|models|in vitro|in vivo|zebrafish)\b/i

/**
 * The closest matches to name in a decline: ranked first by how much of
 * the question they share, and only then by the semantic score, so a
 * paper about incidence in Australia outranks a better-scoring review that
 * shares one word with the question (D3-19). The question's outcome noun
 * counts double, and so does any word of its family (incidence, prevalence,
 * epidemiology and burden are one subject); a capitalised name - a place,
 * a people, a register - counts half, so a nationwide survey that merely
 * shares "Australia" does not lead an incidence question; and a narrative
 * review or an editorial, which reports no figure of its own, ranks at
 * half strength under a results question (D4-23). Each word found in the
 * title counts in full, in the summary by half. A preclinical paper is
 * never a close match for a question about people.
 */
export function rankClosest<
  T extends { title: string; summary?: string; kind?: string; relevance: number },
>(
  resources: readonly T[],
  query: string,
): T[] {
  const weights = new Map<string, number>()
  const families = new Set<string>()
  for (const m of query.matchAll(/(^|\s)([A-Za-z][A-Za-z-]{4,})/g)) {
    const word = m[2]!
    const stem = word.toLowerCase().slice(0, 6)
    if (CLOSEST_STOP.has(stem)) continue
    const family = outcomeFamilyOf(word)
    if (family) {
      // Counted once, through its family, below.
      families.add(family)
      continue
    }
    const capitalised = m.index !== 0 && /^[A-Z]/.test(word)
    weights.set(stem, Math.max(weights.get(stem) ?? 0, capitalised ? 0.5 : 1))
  }
  const human = !ANIMAL.test(query)
  const asksResult = families.size > 0 || isResultsQuestion(query)
  const wordsOf = (text: string) => text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []
  const stems = (text: string) => new Set(wordsOf(text).map((w) => w.slice(0, 6)))
  const familiesIn = (text: string) =>
    new Set(wordsOf(text).map(outcomeFamilyOf).filter((f): f is string => f !== null))
  return resources
    .filter((r) => !(human && r.kind === 'preclinical'))
    .map((r) => {
      const title = stems(r.title)
      const summary = stems(r.summary ?? '')
      let overlap = 0
      for (const [w, weight] of weights) {
        if (title.has(w)) overlap += weight
        else if (summary.has(w)) overlap += weight / 2
      }
      // The question's subject under another name: "burden" for an
      // incidence question.
      const titleFamilies = familiesIn(r.title)
      const summaryFamilies = familiesIn(r.summary ?? '')
      for (const f of families) {
        if (titleFamilies.has(f)) overlap += 2
        else if (summaryFamilies.has(f)) overlap += 1
      }
      if (asksResult && r.kind !== undefined && SECOND_HAND_KIND.has(r.kind)) overlap /= 2
      return { r, overlap }
    })
    .sort((a, b) => b.overlap - a.overlap || b.r.relevance - a.r.relevance)
    .map((x) => x.r)
}

/** Kinds that report no figure of their own. */
const SECOND_HAND_KIND = new Set(['narrative-review', 'editorial', 'commentary', 'letter'])

/** The outcome families a question or a title may name: one subject under several words. */
const OUTCOME_FAMILIES: Record<string, readonly string[]> = {
  epidemiology: [
    'incidence',
    'incident',
    'prevalence',
    'prevalent',
    'epidemiology',
    'epidemiological',
    'burden',
    'projection',
    'projected',
  ],
  mortality: ['mortality', 'death', 'deaths', 'died', 'survival', 'sudep', 'fatal'],
  retention: ['retention', 'discontinuation', 'discontinued', 'adherence', 'persistence'],
  response: [
    'relapse',
    'relapses',
    'remission',
    'freedom',
    'responder',
    'responders',
    'response',
    'efficacy',
    'effectiveness',
  ],
  safety: ['safety', 'tolerability', 'adverse', 'contraindication', 'contraindications'],
}
const FAMILY_OF = new Map<string, string>()
for (const [family, words] of Object.entries(OUTCOME_FAMILIES)) {
  for (const w of words) FAMILY_OF.set(w, family)
}

function outcomeFamilyOf(word: string): string | null {
  return FAMILY_OF.get(word.toLowerCase()) ?? null
}

const CLOSEST_STOP = new Set(['which', 'there', 'their', 'about', 'these', 'those', 'where'])

/**
 * A question about who was in a study rather than what it found: its
 * participants' age or sex, how many were enrolled, implanted or
 * followed, its baseline characteristics (D4-09). Answered from the named
 * paper alone when one is pinned.
 */
export function isDemographicQuestion(query: string): boolean {
  return /\b(?:median|mean|average)\s+age\b|\bhow many\s+(?:\w+\s+){0,3}?(?:women|men|female|male|females|males|participants|patients|subjects|adults|children|were\s+(?:enrolled|implanted|recruited|included|randomi[sz]ed))\b|\b(?:proportion|percentage|number)\s+of\s+(?:women|men|females|males)\b|\b(?:sex|gender)\s+(?:distribution|ratio|breakdown)\b|\bbaseline characteristics\b|\b(?:were|was)\s+enrolled\b/i
    .test(query)
}

/**
 * The prompt addendum for an ask with pinned papers: answer from them,
 * name a figure or table when the text holds the sample but not the
 * outcome, and never declare absent what the supplied passages contain.
 */
export function pinnedAddendum(titles: readonly string[]): string {
  const named = titles.slice(0, 3).map((t) => `"${t}"`).join(', ')
  return `The sources include the paper${
    titles.length === 1 ? '' : 's'
  } the question names: ${named}. ` +
    'Answer from that paper first and report what its text states, with the sample or subgroup ' +
    'size beside each proportion. When the paper gives the sample or subgroup sizes in its text ' +
    'but reports the outcome only in a figure or table, say exactly that and name the figure or ' +
    'table; answer the part the text does answer rather than declining. Never say the sources ' +
    'do not detail something that the supplied passages of that paper contain, and never ' +
    'attribute a figure from a different paper to the named study.'
}
