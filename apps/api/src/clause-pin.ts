/**
 * Clause pinning (review loop 8 section 6).
 *
 * The retrieval pin of loop 7 works, and it works only where the question
 * names something the catalogue can resolve - about one clinician question
 * in six. In the other five the answer is still generated over a bag of ten
 * papers, and that bag is where a mixture-model subgroup's 22% picks up the
 * pooled analysis set's n, where a neonatal channelopathy cohort's sex split
 * is offered as the sub-scalp trial's, and where a perampanel extension's
 * retention rate is printed under a heading that says Brivaracetam.
 *
 * So the pin is applied one level down. A question is decomposed into
 * clauses BEFORE retrieval; each clause is resolved to its own resource set
 * and then to one paper; each clause is answered as a constrained one-paper
 * ask, the way document chat is constrained - which got right every figure
 * the multi-paper path got wrong; and the answers are composed with hard
 * attribution, so every composed sentence inherits exactly one resource id
 * from the clause that produced it. No sentence can draw on two papers,
 * because no generation ever saw two papers. A clause that resolves to
 * nothing is declined by name and the rest of the answer stands.
 *
 * Everything here is pure or takes its retrieval as an injected function, so
 * the whole module is tested without the platform.
 */
import type { Citation, ResourceSummary, ScoredResource } from '@research-portal/core'
import {
  comparisonEntities,
  entityQuery,
  isDemographicQuestion,
  questionClauses,
  rankClosest,
} from './ask-entities.ts'
import { isMedicationTerm, isTreatmentDecisionQuestion } from './ask-prequeries.ts'
import { DOCUMENT_CHAT_ADDENDUM } from './ask-grounding.ts'
import { isResultsQuestion } from './intent-router.ts'
import {
  conditionNames,
  isStrongName,
  medicationNames,
  type NamePin,
  questionNames,
  scopeResources,
} from './name-pin.ts'
import { isDeclineSentence } from './figure-rescue.ts'
import { isAttachmentTitle } from './study-guard.ts'
import { splitSentences } from './citation-binding.ts'

/**
 * What a clause is: the whole question when it has one part, one part of a
 * multi-part question, or one entity of a comparison.
 */
export type ClauseKind = 'whole' | 'part' | 'entity'

export interface QuestionClause {
  /** The standalone question this clause is answered as. */
  text: string
  kind: ClauseKind
  /** What the clause is called in a heading or a decline. */
  label: string
  /** The medication or study the clause is about, for an entity clause. */
  entity?: string
  /**
   * The question put to the clause's paper, when it differs from the
   * retrieval text. Retrieval wants the other entities stripped out so the
   * ranking is not dragged to the wrong drug's papers; the generator wants a
   * question that reads like one.
   */
  ask?: string
}

/** Clauses one question may be answered in: three one-paper asks is already slow. */
export const MAX_CLAUSES = 3

/**
 * The cue that makes a question a comparison rather than a description of a
 * treatment path. "Switched from levetiracetam to brivaracetam" names two
 * drugs and asks one question about one cohort; "compare brivaracetam and
 * perampanel" asks two questions whose answers live in two papers. Only the
 * second is decomposed per drug.
 */
export function comparesEntities(query: string): boolean {
  return /\b(?:compare[sd]?|comparison|versus|vs\.?|against|better|best|superior|worse|difference between|which of)\b/i
    .test(query)
}

/**
 * The medications a question compares. A question that also names a study,
 * antibody, consortium or quoted title is that study's question, not a drug
 * comparison: the loop 7 pin resolves it whole, and splitting it per drug
 * would ask the EXPERIENCE pooled analysis a levetiracetam question and a
 * brivaracetam question separately (PA1a).
 */
export function comparedMedications(
  query: string,
  lexicon: readonly string[],
  supplied: readonly string[] = [],
): string[] {
  if (questionNames(query, lexicon).some(isStrongName)) return []
  if (isOpenTreatmentQuestion(query, lexicon)) return []
  if (!comparesEntities(query) && !isSuperlativeComparison(query)) return []
  const named = comparisonEntities(query, lexicon).filter((e) => isMedicationTerm(e))
  return named.length >= 2 ? named : supplied.length >= 2 ? [...supplied] : []
}

/**
 * The clauses of a question, before any retrieval. A comparison is one
 * clause per named entity ("compare brivaracetam and perampanel" is two
 * questions, and the answer to each lives in a different paper). A two-part
 * question is one clause per part. Anything else is a single clause over the
 * whole question - which still gets a one-paper answer, and that is the
 * point: document chat reads one paper and gets the figure right.
 */
export function decomposeQuestion(
  query: string,
  lexicon: readonly string[],
  /**
   * Entities retrieval supplied for a question that compares a category
   * without naming its members ("which anti-seizure medication has the best
   * real-world retention"). See `medicationsInResults`.
   */
  supplied: readonly string[] = [],
): QuestionClause[] {
  const entities = comparedMedications(query, lexicon, supplied)
  if (entities.length >= 2) {
    return entities.slice(0, MAX_CLAUSES).map((entity) => ({
      text: tidy(entityQuery(query, entity, entities)),
      kind: 'entity' as const,
      label: entity,
      entity,
      // The paper cannot say which treatment is best; it can say what it
      // reports for its own. A superlative left in the clause question is
      // answered "this document does not state which medication has the best
      // retention", which is true of the paper and useless to the reader
      // (D8-13).
      ask: `${query} Answer only for ${entity}: report what this paper states about ${entity} ` +
        'for the outcome the question asks about, without ranking or comparing treatments.',
    }))
  }
  const parts = questionClauses(query)
  if (parts.length >= 2) {
    return parts.slice(0, MAX_CLAUSES).map((part) => ({
      text: stripFraming(part),
      kind: 'part' as const,
      label: stripFraming(part),
    }))
  }
  return [{ text: stripFraming(query), kind: 'whole', label: stripFraming(query) }]
}

/**
 * The framing a clinician puts in front of a question - "For a registrar
 * teaching session:", "what does the collection say about" - is addressed to
 * the portal, not to the corpus, and it is what retrieval scores. With it in
 * place the misdiagnosis half of JOB2 scored 0.19 against the paper that
 * answers it and the clause was declined; without it, 0.43 (D8-06).
 */
export function stripFraming(text: string): string {
  let out = text.trim()
  // A short lead-in ending in a colon, with no digits or quotes in it.
  const lead = /^([^:?"'\d]{0,60}):\s*(?=.{15,})/.exec(out)
  if (lead) out = out.slice(lead[0].length)
  out = out.replace(
    /^(?:and\s+)?(?:what|how)\s+(?:does|do)\s+(?:the\s+)?(?:collection|corpus|portal|sources|papers|literature|evidence)\s+say\s+about\s+/i,
    '',
  )
  out = out.replace(
    /^(?:and\s+)?(?:what|how)\s+(?:does|do)\s+(?:the\s+)?(?:collection|corpus|portal|sources|papers)\s+(?:report|show|find)\s+about\s+/i,
    '',
  )
  return out.trim() || text.trim()
}

/**
 * The dangling conjunction and doubled space a removed entity leaves behind:
 * "the retention rates of and perampanel" reads as a typo to a reader and
 * retrieves as one too.
 */
function tidy(text: string): string {
  return text
    .replace(/\b(of|between|for|with|from|to|versus|vs\.?)\s+(?:and|or)\s+/gi, '$1 ')
    .replace(/\s+(?:and|or|versus|vs\.?)\s*([,.?!])/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.?!])/g, '$1')
    .trim()
}

/**
 * Whether clause pinning is the right shape for this question. It is, for a
 * comparison (each side belongs to its own paper), for a question that asks
 * for a quantity (one paper carries the figure, and reading ten papers is
 * how it acquires the wrong denominator), and for a treatment question that
 * names a drug and a condition (the condition is what keeps a CLN2
 * guideline out of a juvenile myoclonic epilepsy answer). It is NOT the
 * shape for "what is the evidence for X" or "does X work", which are
 * genuinely multi-paper syntheses and which this build already answers well.
 */
export function clausePinningApplies(
  query: string,
  lexicon: readonly string[],
): boolean {
  // An open "which medications" question has no clause structure at all, so
  // there is nothing to decompose and the only clauses available are the
  // drugs retrieval happened to return. See `isOpenTreatmentQuestion`.
  if (isOpenTreatmentQuestion(query, lexicon)) return false
  if (comparedMedications(query, lexicon).length >= 2) return true
  if (isSuperlativeComparison(query) && !questionNames(query, lexicon).some(isStrongName)) {
    return true
  }
  if (asksForQuantity(query)) return true
  return medicationNames(query, lexicon).length > 0 && conditionNames(query).length > 0 &&
    isTreatmentDecisionQuestion(query)
}

/**
 * A question that wants a number. `isResultsQuestion` is the router's rule
 * and is shared with retrieval, so the wordings it misses are added here
 * rather than widened there: "what share of patients", "how common is",
 * "how old were".
 */
export function asksForQuantity(query: string): boolean {
  return isResultsQuestion(query) || isDemographicQuestion(query) ||
    /\b(?:what share|what fraction|how common|how frequent|how likely|how old|what age)\b/i.test(
      query,
    )
}

/**
 * The words that ask the collection to put treatments in an order. Without
 * one of these a "which medication" question is not a ranking, and its
 * answer is a list, not a league table.
 */
const RANKING_CUE =
  /\b(?:best|highest|lowest|greatest|worst|most|least|longest|shortest|safest|strongest|better|superior|outperform\w*|rank(?:s|ed|ing)?)\b/i

/** The category a "which medication" question asks over, when it names no member. */
const TREATMENT_CATEGORY =
  /\b(?:which|what)\s+(?:asms?|drugs?|medicines?|medications?|agents?|treatments?|therapies|therapy|options?|anti-?seizure\s+\w+|anti-?epileptic\s+\w+|antiepileptic\s+\w+)\b/i

/**
 * A question that compares a category without naming its members: "which
 * anti-seizure medication has the best real-world 12-month retention". The
 * answer is a comparison, so the clauses are the category's members - and
 * asking it as one question is how the collection's cannabidiol extension
 * came back as "the highest retention rate mentioned in the provided
 * context", which is not an answer to "which is best" (D8-13).
 *
 * The ranking cue is what makes it one. A bare "which anti-seizure
 * medications ..." is not: see `isOpenTreatmentQuestion`.
 */
export function isSuperlativeComparison(query: string): boolean {
  return new RegExp(`\\bwhich\\b[^?]*${RANKING_CUE.source}`, 'i').test(query)
}

/**
 * An open "which medications" question: it asks the collection to name the
 * members of a category, names none of them itself, and asks for no ranking.
 * "Which anti-seizure medications are contraindicated in SCN1A Dravet
 * syndrome?" is the shape, and it has no clause structure at all - it is one
 * question, and one paper (the syndrome's consensus statement) answers it.
 *
 * Decomposing it by drug is a regression, not a refinement: the drugs can
 * only come from `medicationsInResults`, which reads them off whatever
 * retrieval returned rather than off the question. On this collection that
 * produced a "**phenytoin**" heading arguing phenytoin may be BENEFICIAL in
 * Dravet syndrome, followed by clause declines for cannabidiol and
 * fenfluramine, neither of which the reader had asked about - an inverted
 * answer to the single most-tested question in the portal. A question that
 * names no treatment is never decomposed by treatment.
 */
export function isOpenTreatmentQuestion(query: string, lexicon: readonly string[]): boolean {
  if (!TREATMENT_CATEGORY.test(query) || RANKING_CUE.test(query)) return false
  return medicationNames(query, lexicon).length === 0 &&
    comparisonEntities(query, lexicon).every((e) => !isMedicationTerm(e))
}

/**
 * A consensus statement, guideline or management recommendation. This is the
 * one paper in a research collection that answers "which medications are
 * contraindicated in X" outright; every other paper answers it for one drug
 * at a time, and a bag of those reads as a debate rather than an answer.
 */
const GUIDANCE_TITLE =
  /\b(?:consensus|guidelines?|guidance|recommendations?|position statement|practice parameter|management|algorithm)\b/i

/**
 * The conditions a question is about: the phrases `conditionNames` reads
 * ("SCN1A Dravet syndrome", "juvenile myoclonic epilepsy") and the tenant's
 * own non-medication entity terms ("Dravet", "Lennox-Gastaut"). The portal's
 * own suggested wording is "Which ASMs should be avoided in SCN1A Dravet?",
 * which carries no head noun at all and so names no condition by phrase.
 */
export function conditionSubjects(query: string, lexicon: readonly string[]): string[] {
  const out = [...conditionNames(query)]
  for (const term of lexicon) {
    const t = term.trim()
    if (!t || t.length < 4 || isMedicationTerm(t)) continue
    if (out.some((c) => c.includes(t.toLowerCase()))) continue
    if (wordIn(t, query.toLowerCase())) out.push(t.toLowerCase())
  }
  return out
}

/**
 * The syndrome's guidance papers for an open treatment question, or null.
 *
 * "Which anti-seizure medications are contraindicated in SCN1A Dravet
 * syndrome?" names no paper the loop 7 pin can resolve - a syndrome is a
 * topic, not a cohort - so unpinned retrieval hands the generator a bag in
 * which a single-centre phenytoin case series scores 1.00 and the
 * international consensus statement 0.97, and the answer leads on the case
 * series. The consensus statement is what the question asks for, so it is
 * pinned. The ask route still drops the pin when nothing inside it clears
 * the grounding floor, so a collection with no guidance for the syndrome
 * retrieves exactly as before.
 */
export function guidancePin(
  query: string,
  catalogue: readonly ResourceSummary[],
  lexicon: readonly string[],
  limit = 2,
): NamePin | null {
  if (!isOpenTreatmentQuestion(query, lexicon)) return null
  const papers: ResourceSummary[] = []
  const names: string[] = []
  for (const condition of conditionSubjects(query, lexicon)) {
    const terms = condition.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []
    const head = terms.at(-1)
    if (!head) continue
    // A phrase must carry its head noun and one of its own qualifiers -
    // "Dravet syndrome", never a bare "epilepsy". A lexicon term is already
    // the name of one condition, so the term itself is enough.
    const qualifiers = terms.slice(0, -1).filter((w) => w.length >= 4)
    if (terms.length > 1 && qualifiers.length === 0) continue
    for (const resource of catalogue) {
      if (papers.length >= limit) break
      if (isAttachmentTitle(resource.title) || papers.includes(resource)) continue
      const title = resource.title.toLowerCase()
      if (!GUIDANCE_TITLE.test(resource.title)) continue
      if (!wordIn(head, title)) continue
      if (qualifiers.length > 0 && !qualifiers.some((w) => wordIn(w, title))) continue
      papers.push(resource)
      if (!names.includes(condition)) names.push(condition)
    }
  }
  if (papers.length === 0) return null
  return {
    resourceIds: papers.map((r) => r.id),
    titles: papers.map((r) => r.title),
    names,
    resolved: [],
  }
}

/**
 * The prequery a guidance-pinned question is asked alongside itself: the
 * question written out in the words guidance uses.
 *
 * Retrieval on the question as asked lands on a consensus statement's
 * abstract, where the answer is "the paper does not list them"; the same
 * question written out lands on its treatment recommendations, where the
 * answer is lamotrigine. It is a prequery and not a second chance for the
 * pin to hold: a pin whose papers the question itself cannot find is still
 * dropped, because a pin nothing answers is worse than no pin.
 */
export function guidanceProbe(pin: NamePin): string {
  const subject = pin.names[0] ?? ''
  return `${subject}: which medications are contraindicated, which should be avoided, ` +
    'and which are recommended'
}

/**
 * What a guidance-pinned answer is told beyond the ordinary pin prompt: name
 * the medications, in the paper's own words, and expand the reader's
 * abbreviations rather than declining on them.
 *
 * "Which ASMs should be avoided in SCN1A Dravet?" was answered "the cited
 * sources do not specify which antiseizure medications should be avoided ...
 * they mention consensus on contraindicated medications but do not list them
 * explicitly", over passages that name lamotrigine twice. The reader's
 * abbreviation is not a different question from the paper's prose.
 */
export const GUIDANCE_ADDENDUM =
  'These papers are the guidance for the condition the question asks about. Name the ' +
  'medications they name, in their own words, and where they describe a class ("sodium ' +
  'channel blockers"), give the class and the medications they list under it. Read the ' +
  "question's abbreviations as the words the papers use (ASM and anti-seizure medication " +
  'are the same thing), and do not decline because the paper words the question differently.'

/**
 * The medications the collection's own best-matching papers are about, in
 * retrieval order: the portal's medication entities, read off the titles
 * retrieval returned rather than off the noisy extracted graph. These are
 * the members a category comparison is decomposed into.
 */
export function medicationsInResults(
  results: readonly ScoredResource[],
  lexicon: readonly string[],
  limit = MAX_CLAUSES,
): string[] {
  const drugs = lexicon.filter((t) => isMedicationTerm(t))
  const out: string[] = []
  for (const resource of results) {
    if (isAttachmentTitle(resource.title) || resource.referenceChunk) continue
    const title = resource.title.toLowerCase()
    for (const drug of drugs) {
      if (out.length >= limit) return out
      if (out.includes(drug)) continue
      if (wordIn(drug, title)) out.push(drug)
    }
  }
  return out
}

/**
 * The collection's medication papers: every article whose TITLE names one of
 * the portal's medication entities. A category comparison is retrieved
 * inside this set, so "which anti-seizure medication has the best real-world
 * retention" reaches the effectiveness studies rather than the genetics
 * papers a bare semantic match returns (D8-13).
 */
export function medicationPapers(
  catalogue: readonly ResourceSummary[],
  lexicon: readonly string[],
  limit = 80,
): string[] {
  const drugs = lexicon.filter((t) => isMedicationTerm(t))
  const out: string[] = []
  for (const resource of catalogue) {
    if (isAttachmentTitle(resource.title)) continue
    const title = resource.title.toLowerCase()
    if (drugs.some((drug) => wordIn(drug, title))) out.push(resource.id)
    if (out.length >= limit) break
  }
  return out
}

/** Whether a term appears in a text as a whole word. */
function wordIn(term: string, text: string): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`,
  ).test(text)
}

/** How a clause found its paper. */
export type ClauseVia = 'name' | 'scope' | 'topic' | 'inherited' | 'none'

export interface ClauseResolution {
  clause: QuestionClause
  via: ClauseVia
  resourceId?: string
  title?: string
  relevance: number
}

export interface ClauseDeps {
  catalogue: readonly ResourceSummary[]
  lexicon: readonly string[]
  /** A find over the collection, or inside a resource set. */
  find(text: string, resourceIds?: readonly string[]): Promise<readonly ScoredResource[]>
  /** The name pin for one clause's own text, when its names resolve. */
  pin(text: string): NamePin | null
  /** Below this a match is noise. */
  floor: number
  /**
   * How much better a paper of its own a continuation clause needs before it
   * leaves the paper the clause before it resolved to. "... and how many
   * were female" has no subject of its own; answering it from whichever
   * cohort paper ranks next is exactly D8-03.
   */
  margin: number
}

/**
 * How far below the best match a paper may still be the clause's paper. The
 * semantic scores at the top of a find are within a point or two of each
 * other and their order is not stable: "what placebo responder rate should I
 * assume" put a paediatric lacosamide trial at 0.94 and the pooled placebo
 * analysis the question is actually about at 0.93.
 */
export const CLAUSE_RELEVANCE_BAND = 0.15

/**
 * The best article a find returned: never an attachment, never a reference
 * list. Among the matches within a band of the top score, the one that
 * shares most of the clause's own words and outcome wins - the same ranking
 * a decline uses to choose which papers to name (rankClosest), and the
 * difference between answering a trial-powering question from the pooled
 * placebo analysis and answering it from a paediatric add-on trial.
 */
export function bestArticle(
  results: readonly ScoredResource[],
  floor: number,
  query?: string,
): ScoredResource | undefined {
  const articles = results
    .filter((r) => !isAttachmentTitle(r.title) && !r.referenceChunk && r.relevance >= floor)
    .sort((a, b) => b.relevance - a.relevance)
  if (articles.length === 0 || !query) return articles[0]
  const top = articles[0]!.relevance
  const band = articles.filter((r) => r.relevance >= top - CLAUSE_RELEVANCE_BAND)
  if (band.length === 1) return band[0]
  // A shared phrase is worth more than a shared word: "placebo responder
  // rate" and "placebo response rate" are the same subject, while "efficacy"
  // and "patients" are shared by every trial in the collection.
  const ranked = rankClosest(band, query)
  const withPhrase = ranked.length > 0 ? ranked : band
  const score = (r: ScoredResource) =>
    phraseOverlap(query, r.title) + phraseOverlap(query, r.summary ?? '') / 2
  return [...withPhrase].sort((a, b) => score(b) - score(a))[0]
}

/** Words that carry no subject: they pair with everything. */
const PHRASE_STOP = new Set([
  'about',
  'after',
  'assume',
  'be',
  'been',
  'being',
  'does',
  'from',
  'have',
  'many',
  'much',
  'should',
  'study',
  'studies',
  'that',
  'their',
  'there',
  'these',
  'this',
  'those',
  'were',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
])

/** The content words of a text, hyphens closed up and stemmed to five letters. */
function contentStems(text: string): string[] {
  return (text.toLowerCase().replace(/[-–—]/g, '').match(/[a-z][a-z]{3,}/g) ?? [])
    .filter((w) => !PHRASE_STOP.has(w))
    .map((w) => w.slice(0, 5))
}

/**
 * How many adjacent content-word pairs a title shares with the question. Two
 * words in sequence is a subject; one word on its own is a topic.
 */
export function phraseOverlap(query: string, title: string): number {
  const pairs = (stems: string[]) =>
    new Set(stems.slice(0, -1).map((w, i) => `${w} ${stems[i + 1]}`))
  const wanted = pairs(contentStems(query))
  if (wanted.size === 0) return 0
  let shared = 0
  for (const pair of pairs(contentStems(title))) if (wanted.has(pair)) shared++
  return shared
}

/**
 * Whether a clause introduces a subject of its own: a name the catalogue can
 * resolve, a medication, or a condition. "... and how many participants were
 * enrolled" introduces none - its subject is the clause before it - and a
 * clause like that must never go looking for a paper of its own. Loop 7 and
 * loop 8 both answered it from an unrelated study's enrolment (D7-06, D8-03).
 */
export function introducesSubject(
  clause: QuestionClause,
  lexicon: readonly string[],
  pin: (text: string) => NamePin | null,
): boolean {
  if (clause.entity) return true
  if (clauseTerms(clause, lexicon).length > 0) return true
  return pin(clause.text) !== null
}

/** The medications and conditions a clause names, which together scope it. */
export function clauseTerms(clause: QuestionClause, lexicon: readonly string[]): string[] {
  const terms = [
    ...medicationNames(clause.text, lexicon),
    ...conditionNames(clause.text),
  ]
  if (clause.entity && isMedicationTerm(clause.entity) && !terms.includes(clause.entity)) {
    terms.unshift(clause.entity)
  }
  return terms
}

/**
 * Each clause resolved to one paper, in order. A clause is resolved by the
 * names it uses first (the loop 7 pin, run per clause), then by the
 * medications and conditions that scope it, then by what retrieval finds for
 * it over the collection - and a clause that introduces nothing of its own
 * stays with the paper the clause before it resolved to unless the
 * collection has a decisively better one.
 */
export async function resolveClauses(
  clauses: readonly QuestionClause[],
  deps: ClauseDeps,
): Promise<ClauseResolution[]> {
  const out: ClauseResolution[] = []
  for (const clause of clauses) {
    const previous = out.filter((r) => r.resourceId).at(-1)
    const pin = deps.pin(clause.text)
    if (pin && pin.resourceIds.length > 0) {
      const inside = await deps.find(clause.text, pin.resourceIds)
      const best = bestArticle(inside, deps.floor, clause.text) ??
        (pin.resourceIds[0]
          ? { id: pin.resourceIds[0], title: pin.titles[0] ?? '', relevance: 0 } as ScoredResource
          : undefined)
      if (best) {
        out.push({
          clause,
          via: 'name',
          resourceId: best.id,
          title: best.title,
          relevance: best.relevance,
        })
        continue
      }
    }
    const scope = scopeResources(clauseTerms(clause, deps.lexicon), deps.catalogue)
    if (scope.length > 0) {
      const inside = await deps.find(clause.text, scope)
      const best = bestArticle(inside, deps.floor, clause.text)
      if (best) {
        out.push({
          clause,
          via: 'scope',
          resourceId: best.id,
          title: best.title,
          relevance: best.relevance,
        })
        continue
      }
    }
    // A clause that introduces nothing of its own belongs to the clause
    // before it, and no score may take it somewhere else: "and how many
    // participants were enrolled" is about the study the first clause named,
    // and answering it from whichever paper ranks next is D8-03 exactly.
    if (previous?.resourceId && !introducesSubject(clause, deps.lexicon, deps.pin)) {
      const kept = await deps.find(clause.text, [previous.resourceId])
      out.push({
        clause,
        via: 'inherited',
        resourceId: previous.resourceId,
        title: previous.title,
        relevance: bestArticle(kept, 0)?.relevance ?? previous.relevance,
      })
      continue
    }
    const [wide, kept] = await Promise.all([
      deps.find(clause.text),
      previous?.resourceId
        ? deps.find(clause.text, [previous.resourceId])
        : Promise.resolve([] as ScoredResource[]),
    ])
    const candidate = bestArticle(wide, deps.floor, clause.text)
    const inherited = bestArticle(kept, deps.floor)
    if (
      previous?.resourceId && inherited &&
      (!candidate || candidate.id === previous.resourceId ||
        candidate.relevance - inherited.relevance < deps.margin)
    ) {
      out.push({
        clause,
        via: candidate?.id === previous.resourceId ? 'topic' : 'inherited',
        resourceId: previous.resourceId,
        title: previous.title,
        relevance: inherited.relevance,
      })
      continue
    }
    if (candidate) {
      out.push({
        clause,
        via: 'topic',
        resourceId: candidate.id,
        title: candidate.title,
        relevance: candidate.relevance,
      })
      continue
    }
    out.push({ clause, via: 'none', relevance: 0 })
  }
  return out
}

export interface ClauseGroup {
  resourceId: string
  title: string
  /** The clauses this paper answers, in the order the question asked them. */
  clauses: QuestionClause[]
  /** The question put to the paper: the whole question when it answers all of it. */
  query: string
  /** The heading this group is written under, when the answer has more than one. */
  heading?: string
}

/**
 * The one-paper asks a resolution list becomes. Clauses that resolved to the
 * same paper are asked together - two halves of one question about one study
 * is one document chat, not two - and a comparison keeps one group per drug
 * so each drug's figures come from that drug's paper.
 */
export function groupClauses(
  resolutions: readonly ClauseResolution[],
  /** The question as it was asked, framing already stripped. */
  query?: string,
): { groups: ClauseGroup[]; declined: QuestionClause[] } {
  const groups: ClauseGroup[] = []
  const declined: QuestionClause[] = []
  for (const resolution of resolutions) {
    if (!resolution.resourceId) {
      declined.push(resolution.clause)
      continue
    }
    const existing = groups.find((g) => g.resourceId === resolution.resourceId)
    if (existing) existing.clauses.push(resolution.clause)
    else {
      groups.push({
        resourceId: resolution.resourceId,
        title: resolution.title ?? '',
        clauses: [resolution.clause],
        query: '',
      })
    }
  }
  for (const group of groups) {
    // One paper answering every clause is asked the question as it was
    // written (minus the framing): the clauses are retrieval texts, and
    // splitting "how often do patients relapse, and how soon after" into two
    // of them costs the generator the sentence that carries both figures.
    // A paper answering part of the question is asked only its own clauses,
    // so a comparison's other drug is not in front of it.
    group.query = query !== undefined && groups.length === 1 && declined.length === 0
      ? query
      : group.clauses.map((c) => c.ask ?? c.text).join('; ')
    if (groups.length > 1 && group.clauses.every((c) => c.kind === 'entity')) {
      group.heading = group.clauses.map((c) => c.label).join(' and ')
    }
  }
  return { groups, declined }
}

/**
 * The prompt for a clause's one-paper ask: exactly the constraint document
 * chat runs under, plus the instruction that keeps the composition honest -
 * report this paper's own figures with the sample size the paper puts beside
 * them, and say plainly when the paper does not answer.
 */
export function clauseAddendum(group: ClauseGroup): string {
  const entities = [...new Set(group.clauses.map((c) => c.entity).filter(Boolean))]
  return `${DOCUMENT_CHAT_ADDENDUM}\n\nEvery supplied passage comes from one paper: ` +
    `"${group.title}". ` +
    (entities.length > 0
      ? `Report only what it states about ${entities.join(' and ')}; if it reports another ` +
        'treatment as well, leave that out, and do not remark on the treatments it does not ' +
        'cover - another paper answers for those. Where the question asks which treatment is ' +
        "best, do not rank: give this paper's own figure for its own treatment. "
      : '') +
    'Answer only from that paper and report only what its own text states, with the sample or ' +
    'subgroup size the paper puts beside each proportion, in the same sentence the paper puts ' +
    'it in. Never pair a figure with a denominator from a different sentence, a different ' +
    'subgroup or a different analysis. When the paper does not answer part of this, say so in ' +
    "one plain sentence rather than answering it from anything else. Do not write the paper's " +
    'title into the prose, and do not write a heading: the citation marker identifies the paper.'
}

/** A heading line, a horizontal rule or a blank line: never a claim needing a marker. */
function isStructuralLine(line: string): boolean {
  const t = line.trim()
  return t === '' || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t) || /^\|/.test(t) ||
    /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$/.test(t)
}

/** The portal's own italic notes carry no claim of their own, so they carry no marker. */
function isPortalNote(line: string): boolean {
  return /^\s*\*[^*].*\*\s*$/.test(line.trim())
}

const LIST_PREFIX = /^(\s*(?:[-*•]|\d{1,3}[.)])\s+)/

/**
 * One clause answer, rewritten so that every sentence in it carries exactly
 * one citation marker: the paper the clause was answered from. Whatever the
 * generator wrote as a marker goes - it was numbering a single-source
 * context and means nothing here.
 */
export function attributeToResource(text: string, index: number): string {
  const marker = `[${index}]`
  return text.split('\n').map((line) => {
    const stripped = line.replace(/\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '')
    if (isStructuralLine(stripped) || isPortalNote(stripped)) return stripped
    const prefix = LIST_PREFIX.exec(stripped)?.[1] ?? ''
    const body = stripped.slice(prefix.length)
    if (!body.trim()) return stripped
    const sentences = splitSentences(body).map((sentence) => {
      const trimmed = sentence.trim()
      if (!trimmed) return sentence
      // A sentence of pure punctuation or a bare label gets no marker.
      if (!/[a-z0-9]/i.test(trimmed)) return sentence
      return `${trimmed}${marker}`
    })
    return `${prefix}${sentences.join(' ')}`
  }).join('\n')
}

/** What the reader is told about a clause the collection does not answer. */
export function clauseDecline(clause: QuestionClause): string {
  const subject = clause.kind === 'entity' && clause.entity
    ? clause.entity
    : clause.label.replace(/\s+/g, ' ').trim().replace(/^[,;]\s*/, '')
  return clause.kind === 'entity'
    ? `*This collection holds no paper answering this question for ${subject}.*`
    : `*This collection holds no paper answering "${subject}".*`
}

/**
 * A one-paper block never remarks on the drug another block answers for.
 * Asked only about brivaracetam, the paper's answer closes "the paper does
 * not provide data on perampanel, so no comparison can be made" - which is
 * true of that paper and false of the answer, because the block above it is
 * the perampanel answer.
 */
export function withoutForeignEntities(text: string, foreign: readonly string[]): string {
  if (foreign.length === 0) return text
  const names = foreign.map((e) => e.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const mentions = new RegExp(
    `(?:^|[^a-z0-9])(?:${names.join('|')})(?=$|[^a-z0-9])|` +
      // The category the comparison is over, and the comparison itself.
      `\\b(?:other (?:anti-?seizure )?(?:medications?|drugs?|treatments?|asms?)|` +
      `anti-?seizure medications?|which (?:medication|drug|asm)|comparison|compare[sd]?)\\b`,
    'i',
  )
  const absence =
    /\b(?:does not|do not|doesn't|don't|only provides?|no)\s+(?:provide|report|contain|cover|include|mention|discuss|compare|state|data|comparison|information)|no comparison can be made|not (?:reported|provided|covered|discussed|available|stated)\b/i
  return text.split('\n').map((line) =>
    splitSentences(line).filter((sentence) => !(mentions.test(sentence) && absence.test(sentence)))
      .join(' ')
  ).join('\n')
}

/**
 * A clause answer that is only a decline. The one-paper generation says "this
 * document does not state ..." in its own words; the portal's own decline
 * names the clause, so the block is replaced by that rather than printed as
 * an answer with a citation marker on a non-claim.
 */
export function isOnlyDecline(text: string): boolean {
  const sentences = text.split('\n').flatMap((line) => splitSentences(line))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[a-z]/i.test(sentence))
  if (sentences.length === 0) return true
  return sentences.every((sentence) =>
    isDeclineSentence(sentence) ||
    /\b(?:this|the)\s+(?:document|paper|study|source)\s+(?:does|did)\s+not\s+/i.test(sentence) ||
    /^\s*\*/.test(sentence)
  )
}

export interface ComposedAnswer {
  text: string
  citations: Citation[]
}

/**
 * The composed answer: each group's one-paper answer under its own heading,
 * every sentence carrying that group's marker and no other, then a plain
 * note for each clause the collection could not answer. There is no shared
 * pool of passages behind this text, so there is no sentence that can draw
 * on two papers and no removed figure that can reappear from a neighbour.
 */
export function composeClauseAnswers(
  answered: readonly { group: ClauseGroup; text: string }[],
  declined: readonly QuestionClause[],
): ComposedAnswer {
  const blocks: string[] = []
  const citations: Citation[] = []
  for (const { group, text } of answered) {
    const body = text.trim()
    if (!body) continue
    const existing = citations.find((c) => c.resourceId === group.resourceId)
    const index = existing?.index ?? citations.length + 1
    if (!existing) {
      citations.push({ index, resourceId: group.resourceId, title: group.title })
    }
    const attributed = attributeToResource(body, index)
    blocks.push(group.heading ? `**${group.heading}**\n\n${attributed}` : attributed)
  }
  for (const clause of declined) blocks.push(clauseDecline(clause))
  return { text: blocks.join('\n\n').trim(), citations }
}

/** Every sentence of a composed answer carries one marker at most - the invariant, for tests. */
export function markersPerSentence(text: string): number[] {
  return text.split('\n').filter((line) => !isStructuralLine(line)).flatMap((line) =>
    splitSentences(line.replace(LIST_PREFIX, '')).map((s) =>
      [...s.matchAll(/\[(\d{1,3})\]/g)].length
    )
  )
}

// ---------------------------------------------------------------------------
// The whole move, in one call
// ---------------------------------------------------------------------------

export interface ClausePlanDeps extends ClauseDeps {
  /** One paper, asked its own clauses under `resource_filters` and read whole. */
  askOne(group: ClauseGroup): Promise<{ text: string; sources: readonly ScoredResource[] }>
  /** Each composed block, as it is ready, in clause order. */
  onBlock?(text: string): Promise<void>
  /** The members of a category a comparison does not name (see medicationsInResults). */
  categoryMembers?(): Promise<string[]>
  /** The plan, once every clause has resolved and before any paper is asked. */
  onPlan?(plan: {
    resolutions: readonly ClauseResolution[]
    groups: readonly ClauseGroup[]
    declined: readonly QuestionClause[]
  }): Promise<void>
}

export interface ClauseAnswer extends ComposedAnswer {
  sources: ScoredResource[]
  resolutions: ClauseResolution[]
  groups: ClauseGroup[]
  declined: QuestionClause[]
}

/**
 * Decompose, resolve, ask each clause's paper on its own and compose. Returns
 * null when nothing resolved or when no one-paper ask produced an answer, in
 * which case the caller's ordinary retrieval runs unchanged - clause pinning
 * never turns a question the collection can answer into a refusal.
 */
export async function answerByClause(
  query: string,
  deps: ClausePlanDeps,
): Promise<ClauseAnswer | null> {
  const supplied = deps.categoryMembers && isSuperlativeComparison(query) &&
      comparisonEntities(query, deps.lexicon).length < 2
    ? await deps.categoryMembers().catch(() => [] as string[])
    : []
  const clauses = decomposeQuestion(query, deps.lexicon, supplied)
  const resolutions = await resolveClauses(clauses, deps)
  if (!resolutions.some((r) => r.resourceId)) return null
  const { groups, declined } = groupClauses(resolutions, stripFraming(query))
  await deps.onPlan?.({ resolutions, groups, declined })
  const pending = groups.map((group) =>
    deps.askOne(group).catch(() => ({ text: '', sources: [] as readonly ScoredResource[] }))
  )
  const answered: { group: ClauseGroup; text: string }[] = []
  const sources: ScoredResource[] = []
  const entitiesOf = (g: ClauseGroup) =>
    g.clauses.map((c) => c.entity).filter((e): e is string => Boolean(e))
  const everyEntity = new Set([
    ...groups.flatMap(entitiesOf),
    ...declined.map((c) => c.entity).filter((e): e is string => Boolean(e)),
  ])
  let emitted = ''
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!
    const raw = await pending[i]!
    // A one-paper block says what its own paper reports and nothing about
    // the drug the block beside it answers for: "this document does not
    // state which medication has the best retention" is true of the paper
    // and useless to the reader, who is looking at the other papers' rows.
    const mine = new Set(entitiesOf(group))
    const result = {
      ...raw,
      text: everyEntity.size > 0
        ? withoutForeignEntities(raw.text, [...everyEntity].filter((e) => !mine.has(e)))
        : raw.text,
    }
    for (const s of result.sources) if (!sources.some((x) => x.id === s.id)) sources.push(s)
    // A paper that answers nothing is not a silent gap: its clauses are
    // declined by name, exactly as an unresolved clause is.
    if (!result.text.trim() || isOnlyDecline(result.text)) {
      for (const clause of group.clauses) if (!declined.includes(clause)) declined.push(clause)
      continue
    }
    answered.push({ group, text: result.text })
    const composed = composeClauseAnswers(answered, [])
    if (deps.onBlock && composed.text.length > emitted.length) {
      await deps.onBlock(composed.text.slice(emitted.length))
    }
    emitted = composed.text
  }
  if (answered.length === 0) return null
  const final = composeClauseAnswers(answered, declined)
  if (deps.onBlock && final.text.length > emitted.length) {
    await deps.onBlock(final.text.slice(emitted.length))
  }
  return { ...final, sources, resolutions, groups, declined }
}
