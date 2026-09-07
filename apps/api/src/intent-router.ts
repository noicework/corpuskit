/**
 * Stage 1 of intent routing: deterministic, explainable, free. Pure functions
 * over the tenant's intents so they never need the platform. Stage 2 (the
 * classifier) lives in the provider; the threshold logic that accepts or
 * rejects its answer is here so both stages share one decision shape.
 * See docs/INTENT-ROUTING.md.
 */
import type { Intent, RouteDecision } from '@research-portal/core'

export const CLASSIFIER_THRESHOLD = 0.6

export function configurationFor(intentId: string, defaultIntent: string): string {
  return intentId === defaultIntent ? 'portal-ask' : `portal-intent-${intentId}`
}

/**
 * Upper-case tokens that look like gene symbols but are not: study acronyms,
 * statistics, modalities, mouse strains. Kept short and explicit - the gene
 * shape below also demands a digit, which already rules out most acronyms.
 */
export const GENERIC_ACRONYMS = new Set([
  'PMC',
  'DOI',
  'PMID',
  'EEG',
  'MRI',
  'FMRI',
  'MEG',
  'PET',
  'SPECT',
  'CT',
  'ASM',
  'ASMS',
  'AED',
  'AEDS',
  'RCT',
  'RCTS',
  'ILAE',
  'HR',
  'CI',
  'OR',
  'RR',
  'SD',
  'SE',
  'AUC',
  'ROC',
  'URL',
  'DNA',
  'RNA',
  'MRNA',
  'CSF',
  'ICU',
  'SUDEP',
  'PNES',
  'FDA',
  'TGA',
  'PBS',
  'DBS',
  'VNS',
  'RNS',
  'LITT',
  'SEEG',
  'ECOG',
  'TLE',
  'MTLE',
  'JME',
  'GGE',
  'DEE',
  'DEES',
  'GTCS',
  'EMU',
  'QOL',
  'NMDA',
  'NMDAR',
  'GABA',
  'AMPA',
  'HIV',
  'COVID',
  'COVID19',
  'ROI',
  'CDE',
  'GWAS',
  'WES',
  'WGS',
  'CNV',
  'CNVS',
  'SNP',
  'SNPS',
  'SNV',
  'VUS',
  'ACMG',
  'HGNC',
  'OMIM',
  'PCR',
  'ELISA',
  'LGS',
  'ADHD',
  'ASD',
  'IQ',
  'PTE',
  'TBI',
  'LOF',
  'GOF',
  'USA',
  'UK',
  'MDT',
  'ENIGMA',
  'C57BL',
  'C57BL6',
  'C57BL6J',
  'DBA',
  'FVB',
  'BALB',
  'H1',
  'H2',
  'T1',
  'T2',
  'P1',
  'P2',
  'A1',
  'A2',
  'B1',
  'B2',
  'S1',
  'S2',
  'S3',
  'D1',
  'D2',
  'E1',
  'E2',
])

/**
 * Human gene symbols that carry no digit (the shape below wants one, because a
 * digit is what separates "SCN1A" from "AUC" without a lexicon). Epilepsy
 * genes only - extend as the corpus does.
 */
const DIGITLESS_GENES = new Set([
  'ARX',
  'PTEN',
  'MTOR',
  'WWOX',
  'PIGA',
  'PIGN',
  'PIGO',
  'PIGQ',
  'PIGT',
  'CASK',
  'ATRX',
  'AARS',
  'QARS',
  'ROGDI',
  'PURA',
  'NEXMIF',
  'TBCK',
  'DHDDS',
  'ITPA',
])

/**
 * Does this token read as a gene symbol? Human: upper case with a digit
 * (SCN1A, KCNQ2, DEPDC5, SLC2A1) or a digitless symbol we know; mouse or
 * rat: capitalised with a digit (Scn1a, Kcnq2). Never a listed acronym.
 */
export function looksLikeGeneSymbol(token: string): boolean {
  const t = token.trim()
  if (!t || GENERIC_ACRONYMS.has(t.toUpperCase()) || /^(PMC|PMID)\d+$/i.test(t)) return false
  if (/^[A-Z][A-Z0-9]{1,7}$/.test(t)) return /\d/.test(t) || DIGITLESS_GENES.has(t)
  if (/^[A-Z][a-z]{1,6}\d[a-z0-9]{0,3}$/.test(t)) return true
  return false
}

/** Terms from the tenant's lexicon (medications, syndromes) that the question names. */
export function lexiconEntities(query: string, lexicon: readonly string[] = []): string[] {
  const lower = query.toLowerCase()
  const found: string[] = []
  const seen = new Set<string>()
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (t.length < 4 || seen.has(t)) continue
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      seen.add(t)
      found.push(term)
    }
  }
  return found
}

/** Gene symbols (SCN1A, KCNQ2, DEPDC5, Scn1a) and any term in the tenant's lexicon. */
export function extractEntities(query: string, lexicon: readonly string[] = []): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (term: string) => {
    const key = term.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(term)
    }
  }
  for (const m of query.match(/[A-Za-z][A-Za-z0-9]{1,7}/g) ?? []) {
    if (looksLikeGeneSymbol(m)) add(m)
  }
  for (const term of lexiconEntities(query, lexicon)) add(term)
  return found
}

export type IdentifierKind = 'doi' | 'pmcid' | 'pmid'

/**
 * A results question: it asks for a figure a paper itself reports (a rate,
 * a count, an outcome, a sample size). Such questions read the papers on the
 * default configuration by rule, so the classifier never sends them to the
 * supplements alone, and the router answers in microseconds rather than
 * after a generation. Shared with the tenant's rule list so the two never
 * drift apart.
 */
export const RESULTS_QUESTION_RULE =
  '\\b(how many|how long|how often|how much|what (?:proportion|percentage|fraction)|' +
  'proportion of|percentage|per ?cent|rates?|ratios?|hazard ratio|odds ratio|relative risk|' +
  'incidence|prevalence|mortality|retention|seizure[- ]free\\w*|responders?|remission|' +
  'adverse events?|side effects?|primary (?:outcome|endpoint)|secondary (?:outcomes?|endpoints?)|' +
  'sample size|participants|median|mean|number of|risk of|efficacy|effectiveness|tolerability|' +
  'control (?:arm|group)|follow[- ]up)\\b'

export function isResultsQuestion(query: string): boolean {
  return new RegExp(RESULTS_QUESTION_RULE, 'i').test(query)
}

/**
 * A bare identifier: a DOI (with or without a doi: or doi.org prefix), a
 * PubMed Central id, or a PubMed id ("PMID: 12345678" or seven to eight bare
 * digits). Resolved against catalogue metadata before any retrieval - an
 * identifier either names one resource or nothing, never a list of papers
 * whose reference lists share a DOI prefix.
 */
export function parseIdentifier(query: string): { kind: IdentifierKind; value: string } | null {
  const q = query.trim()
  const doi = /^(?:doi:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s]+?)[.,;)]?$/i.exec(q)
  if (doi?.[1]) return { kind: 'doi', value: doi[1] }
  const pmc = /^(?:pmcid:?\s*)?(PMC\d{4,9})$/i.exec(q)
  if (pmc?.[1]) return { kind: 'pmcid', value: pmc[1].toUpperCase() }
  const pmid = /^(?:pmid:?\s*(\d{1,9})|(\d{7,8}))$/i.exec(q)
  const digits = pmid?.[1] ?? pmid?.[2]
  if (digits) return { kind: 'pmid', value: digits }
  return null
}

/**
 * "Seery 2025 rituximab", "Vajda 2004": a surname and a year is a citation the
 * reader is chasing, not a request for what is newest. The year must not be
 * read as recency by the classifier either, so the router settles it.
 */
export function parseAuthorYear(query: string): { surname: string; year: string } | null {
  const m = /^([A-Z][A-Za-z'’-]{2,})\s+((?:19|20)\d\d)\b/.exec(query.trim())
  if (!m?.[1] || !m[2]) return null
  if (looksLikeGeneSymbol(m[1])) return null
  return { surname: m[1], year: m[2] }
}

/** Replace `{entities}` and `{query}` in an intent's prequery templates. */
export function fillPrequeries(
  templates: readonly string[],
  query: string,
  entities: readonly string[],
): string[] {
  const subject = entities.length > 0 ? entities.join(', ') : query
  return templates
    .map((t) => t.replaceAll('{entities}', subject).replaceAll('{query}', query).trim())
    .filter((t) => t.length > 3)
}

export interface RouteContext {
  intents: readonly Intent[]
  defaultIntent: string
  lexicon?: readonly string[]
  /** The surface asking: an intent that cannot serve it (search-only on Ask) is never chosen. */
  surface?: 'ask' | 'search'
}

/** Intents that can serve the context's surface. */
export function eligibleIntents(ctx: RouteContext): Intent[] {
  const surface = ctx.surface
  return ctx.intents.filter((i) =>
    !surface || i.answer.surfaces.includes(surface) || i.id === ctx.defaultIntent
  )
}

/**
 * Intents the classifier may choose: eligible for the surface, not
 * rules-only, and, when the intent carries a classifier gate, only for a
 * question that matches it.
 */
export function classifierIntents(ctx: RouteContext, query = ''): Intent[] {
  return eligibleIntents(ctx).filter((i) => !i.rulesOnly && passesGate(i, query))
}

function passesGate(intent: Intent, query: string): boolean {
  if (intent.classifierGate.length === 0) return true
  return intent.classifierGate.some((gate) => {
    try {
      return new RegExp(gate, 'i').test(query)
    } catch {
      return false
    }
  })
}

/** The listing intent an identifier resolves to: no generation, results only. */
function listingIntent(ctx: RouteContext): Intent | undefined {
  return eligibleIntents(ctx).find((i) => i.answer.strategy === 'none')
}

/** A named person's papers: the possessive, "papers by", or "et al." after a capitalised name. */
/**
 * A terse clinic question, typed the way a phone question is typed: seven
 * words or fewer, a lexicon entity (a drug, a syndrome, an antigen) and an
 * outcome word ("lamotrigine SUDEP risk - adjusted HR?"). It is a results
 * question in shorthand: routed to the default configuration by rule, and
 * never sent to the classifier (five seconds) or decomposed into
 * sub-questions (a five-word question searched five ways took 24 seconds
 * on the phone, D4-08).
 */
export const TERSE_MAX_WORDS = 7

const OUTCOME_WORD =
  /\b(?:a?hr|or|rr|smr|ci|risk|rates?|retention|relapses?|freedom|responders?|discontinu\w*|side effects?|adverse|dos(?:e|es|ing)|schedule|incidence|prevalence|mortality|number|outcomes?|efficacy|effectiveness|tolerability|how (?:many|much|often|long)|death|deaths|sudep)\b/i

/** The words of a query, punctuation and dashes aside. */
export function wordCount(query: string): number {
  return (query.match(/[A-Za-z0-9][\w'’.%-]*/g) ?? []).length
}

export function isTerseResultsQuestion(query: string, lexicon: readonly string[] = []): boolean {
  if (wordCount(query) > TERSE_MAX_WORDS) return false
  // A lexicon term (a drug, a syndrome, an antigen), not a bare gene
  // symbol: a preclinical dosing question is not a clinic question.
  if (lexiconEntities(query, lexicon).length === 0) return false
  return OUTCOME_WORD.test(query)
}

/**
 * Whether a question is long enough, and shaped enough like a question, to
 * be decomposed into sub-questions or given an intent's probe prequeries:
 * eight words or more, and a question word somewhere in it. A terse clinic
 * question is searched as typed (D4-08).
 */
export function decomposable(query: string): boolean {
  return wordCount(query) > TERSE_MAX_WORDS &&
    /\b(?:what|which|how|why|when|where|who|does|do|did|is|are|was|were|can|could|should|compare|comparison|versus|vs)\b/i
      .test(query)
}

const AUTHOR_PAPERS =
  /\b[A-Z][\w'’-]+['’]s\s+(?:papers?|publications?|articles?|studies|work)\b|\b(?:papers?|publications?|articles?|studies|work)\s+(?:by|from)\s+[A-Z][\w'’-]+\b|\b[A-Z][\w'’-]+\s+et\s+al\b/

/** First intent whose rule matches; null when no rule fires. */
export function routeByRules(query: string, ctx: RouteContext): RouteDecision | null {
  const q = query.trim()
  if (!q) return null
  const lexicon = ctx.lexicon ?? []
  const entities = extractEntities(q, lexicon)
  // An identifier is the strongest signal there is: it names one document.
  const identifier = parseIdentifier(q)
  const listing = identifier ? listingIntent(ctx) : undefined
  if (identifier && listing) {
    return {
      intent: listing.id,
      confidence: 1,
      stage: 'rule',
      rationale: `${listing.label}: ${identifier.kind.toUpperCase()} ${identifier.value}`,
      configuration: configurationFor(listing.id, ctx.defaultIntent),
      entities: [identifier.value],
      rule: `identifier:${identifier.kind}`,
    }
  }
  // An author-year citation names a paper: on a listing surface it is a
  // lookup, and on the ask surface it runs on the default configuration
  // rather than letting the year read as "recent".
  const citation = parseAuthorYear(q)
  if (citation) {
    const target = listingIntent(ctx) ??
      eligibleIntents(ctx).find((i) => i.id === ctx.defaultIntent)
    if (target) {
      return {
        intent: target.id,
        confidence: 1,
        stage: 'rule',
        rationale: `${target.label}: ${citation.surname} ${citation.year} reads as a citation`,
        configuration: configurationFor(target.id, ctx.defaultIntent),
        entities,
        rule: 'author-year',
      }
    }
  }
  // "X's papers", "papers by X", "X et al.": a question about a named
  // person's work is a review of it, settled here rather than by the
  // classifier (five seconds, and it chose the wrong scope) (D3-11).
  if (AUTHOR_PAPERS.test(q)) {
    const eligible = eligibleIntents(ctx)
    const target = eligible.find((i) => i.answer.promptVariant === 'synthesis') ??
      eligible.find((i) => /review/i.test(i.id)) ??
      eligible.find((i) => i.id === ctx.defaultIntent)
    if (target) {
      return {
        intent: target.id,
        confidence: 1,
        stage: 'rule',
        rationale: `${target.label}: papers by a named author`,
        configuration: configurationFor(target.id, ctx.defaultIntent),
        entities,
        rule: 'author-papers',
      }
    }
  }
  for (const intent of eligibleIntents(ctx)) {
    for (const rule of intent.rules) {
      let re: RegExp
      try {
        re = new RegExp(rule, 'i')
      } catch {
        continue
      }
      if (!re.test(q)) continue
      if (intent.requireEntity && entities.length === 0) continue
      if (intent.requireLexiconEntity && lexiconEntities(q, lexicon).length === 0) continue
      // A listing (exact lookup) only when the entity is the whole query:
      // "lamotrigine SUDEP" is a two-entity question for retrieval, not a
      // lookup of lamotrigine (D5-17).
      if (intent.answer.strategy === 'none' && !singleEntityQuery(q, entities)) continue
      return {
        intent: intent.id,
        confidence: 1,
        stage: 'rule',
        rationale: describeRule(intent, entities),
        configuration: configurationFor(intent.id, ctx.defaultIntent),
        entities,
        rule,
      }
    }
  }
  // No intent rule fired. A terse clinic question ("lamotrigine SUDEP
  // risk - adjusted HR?") is a results question in shorthand: the default
  // configuration, by rule, so the classifier never takes five seconds
  // over five words (D4-08). An intent's own rule (a dosing question to
  // the clinical configuration) has already had its turn.
  if (isTerseResultsQuestion(q, lexicon)) {
    const target = eligibleIntents(ctx).find((i) => i.id === ctx.defaultIntent)
    if (target) {
      return {
        intent: target.id,
        confidence: 1,
        stage: 'rule',
        rationale: `${target.label}: a short results question, answered from the papers themselves${
          entities.length > 0 ? ` (${entities.join(', ')})` : ''
        }`,
        configuration: configurationFor(target.id, ctx.defaultIntent),
        entities,
        rule: 'terse-results',
      }
    }
  }
  return null
}

/** Words that complete an entity's name rather than add a second one: "Dravet syndrome", "SCN8A epilepsy". */
const ENTITY_SUFFIX =
  /\b(?:syndrome|epilepsy|epilepsies|encephalitis|disease|disorder|deficiency|mutation|mutations|variant|variants|gene|seizures?)\b/gi

/**
 * Whether the recognised entities account for the whole query: a lookup
 * lists one thing, so what remains after the entities and their completing
 * words are removed must be nothing but punctuation.
 */
export function singleEntityQuery(query: string, entities: readonly string[]): boolean {
  // Entities nested in one another ("Dravet", "Dravet syndrome") are one.
  const distinct = entities.filter((e) =>
    !entities.some((other) => other !== e && other.toLowerCase().includes(e.toLowerCase()))
  )
  return distinct.length === 1 && entityCoversQuery(query, entities)
}

export function entityCoversQuery(query: string, entities: readonly string[]): boolean {
  let rest = query
  for (const entity of entities) {
    rest = rest.replace(
      new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      ' ',
    )
  }
  rest = rest.replace(ENTITY_SUFFIX, ' ')
  return !/[A-Za-z0-9]/.test(rest)
}

function describeRule(intent: Intent, entities: string[]): string {
  const who = entities.length > 0 ? ` (${entities.slice(0, 3).join(', ')})` : ''
  return `${intent.label}: ${intent.ruleRationale ?? 'matched a routing rule'}${who}`
}

/** The default decision when nothing fires or the classifier is unsure. */
export function defaultDecision(
  ctx: RouteContext,
  rationale: string,
  entities: string[] = [],
): RouteDecision {
  return {
    intent: ctx.defaultIntent,
    confidence: 0,
    stage: 'default',
    rationale,
    configuration: configurationFor(ctx.defaultIntent, ctx.defaultIntent),
    entities,
  }
}

/** Accept the classifier's answer only when it names a known intent with enough confidence. */
export function decideFromClassifier(
  raw: { intent?: unknown; confidence?: unknown; rationale?: unknown },
  ctx: RouteContext,
  entities: string[] = [],
  threshold = CLASSIFIER_THRESHOLD,
  query = '',
): RouteDecision {
  const intent = typeof raw.intent === 'string' ? raw.intent.trim() : ''
  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0
  const known = classifierIntents(ctx, query).find((i) => i.id === intent)
  if (!known || confidence < threshold) {
    return defaultDecision(ctx, 'No confident match, using the default configuration', entities)
  }
  return {
    intent: known.id,
    confidence,
    stage: 'classifier',
    rationale: typeof raw.rationale === 'string' && raw.rationale.trim()
      ? raw.rationale.trim().slice(0, 200)
      : `${known.label}: classified from the question`,
    configuration: configurationFor(known.id, ctx.defaultIntent),
    entities,
  }
}

/** A manual override from the route chip. */
export function overrideDecision(
  intentId: string,
  ctx: RouteContext,
  entities: string[] = [],
): RouteDecision | null {
  const known = ctx.intents.find((i) => i.id === intentId)
  if (!known) return null
  return {
    intent: known.id,
    confidence: 1,
    stage: 'override',
    rationale: `${known.label}: chosen by the reader`,
    configuration: configurationFor(known.id, ctx.defaultIntent),
    entities,
  }
}
