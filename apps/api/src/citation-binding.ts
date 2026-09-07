/**
 * Sentence-level citation binding.
 *
 * The platform binds citations at paragraph granularity: its char offsets
 * land at the end of a block, so a paragraph of four claims arrives as
 * "...claim four.[1][2][3][4][5][6][7]" and nothing says which passage
 * supports which sentence. Reviewers checked and found markers on sentences
 * whose cited paper does not contain the claim. This pass re-derives the
 * binding claim by claim: each sentence keeps only the markers whose cited
 * text actually carries the sentence's content words, figures and named
 * entities, gains a marker to a cited text that clearly does when its own
 * markers resolve to nothing, and loses every marker otherwise. Headings
 * never carry markers. The surviving citations are renumbered in order of
 * first appearance, so "n cited" and the chips describe the bound set.
 *
 * Deterministic string matching only - no model in the loop - so the
 * binding is itself grounded.
 */
import type { Citation } from '@research-portal/core'
import {
  type ClaimFeatures,
  claimFeatures,
  extractNumbers,
  figureSupportedBy,
  normaliseFigures,
  type PreparedSource,
  prepareSource,
} from './answer-audit.ts'

const STOPWORDS = new Set([
  'about',
  'above',
  'after',
  'again',
  'against',
  'also',
  'although',
  'among',
  'another',
  'appear',
  'appears',
  'approximately',
  'around',
  'associated',
  'based',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'clinical',
  'compared',
  'could',
  'data',
  'does',
  'during',
  'each',
  'effect',
  'effects',
  'either',
  'evidence',
  'example',
  'finding',
  'findings',
  'found',
  'from',
  'further',
  'generally',
  'given',
  'have',
  'having',
  'here',
  'however',
  'including',
  'indicate',
  'indicated',
  'indicates',
  'into',
  'known',
  'less',
  'like',
  'likely',
  'made',
  'many',
  'more',
  'most',
  'much',
  'must',
  'need',
  'noted',
  'only',
  'other',
  'others',
  'over',
  'particularly',
  'patient',
  'patients',
  'people',
  'potential',
  'provide',
  'provided',
  'provides',
  'rather',
  'related',
  'report',
  'reported',
  'reports',
  'research',
  'result',
  'results',
  'same',
  'several',
  'shown',
  'shows',
  'showed',
  'significant',
  'significantly',
  'since',
  'some',
  'source',
  'sources',
  'specific',
  'specifically',
  'still',
  'studies',
  'study',
  'such',
  'suggest',
  'suggested',
  'suggests',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'therefore',
  'these',
  'they',
  'this',
  'those',
  'though',
  'through',
  'thus',
  'under',
  'used',
  'using',
  'various',
  'very',
  'well',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'with',
  'within',
  'without',
  'would',
  'year',
  'years',
  'yes',
])

/** Acronyms that look like gene symbols but are not named entities of a claim. */
const NOT_ENTITY =
  /^(PMC|DOI|EEG|MRI|PET|ASM|ASMS|RCT|ILAE|HR|CI|OR|RR|SD|IQR|AUC|FDA|TGA|USA|UK|AND|THE|FOR|NOT|WITH|QOL|TBI)\d*$/

/** Words that end a sentence but are not sentence boundaries when followed by a full stop. */
const ABBREVIATION =
  /(?:\b(?:e\.g|i\.e|et al|vs|fig|figs|dr|mr|mrs|ms|prof|approx|ca|cf|no|resp|ref|refs|vol|pp|p|st|sec|min|max|inc|ltd|al)|\b[A-Z])$/i

/** One suffix strip then a six-character cut: enough that "contraindicated" and "contraindication" meet. */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/'s$/, '')
  const stripped = w.replace(
    /(ations|ation|tions|tion|ities|ity|ness|ments|ment|ingly|ally|ing|ies|ied|ed|ers|er|es|s|ly|al|e)$/,
    '',
  )
  const base = stripped.length >= 3 ? stripped : w
  return base.length > 6 ? base.slice(0, 6) : base
}

/** The words that carry a sentence's content: four letters or more, not a stopword, stemmed. */
export function contentWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z-]{3,}/g)) {
    const word = m[0].replace(/-/g, '')
    if (word.length < 4 || STOPWORDS.has(word)) continue
    out.push(stem(word))
  }
  return out
}

/** A cited text prepared once for many sentence checks: the audit's normalised source plus its vocabulary. */
export interface PreparedText extends PreparedSource {
  vocab: Set<string>
  bigrams: Set<string>
}

export function prepareText(text: string): PreparedText {
  const source = prepareSource(text)
  const words = contentWords(source.lower)
  const vocab = new Set(words)
  const bigrams = new Set<string>()
  for (let i = 1; i < words.length; i++) bigrams.add(`${words[i - 1]} ${words[i]}`)
  return { ...source, vocab, bigrams }
}

export interface SentenceFeatures {
  words: string[]
  bigrams: string[]
  numbers: string[]
  entities: string[]
  /** The study designs the sentence states ("nested case-control"): a text that never mentions one cannot carry the sentence. */
  designs: string[]
  /** What the audit's figure check needs: the claim's terms, outcome, timepoint and question-named entities. */
  claim: ClaimFeatures
}

/** Named entities a claim hangs on: lexicon terms, gene symbols and capitalised names mid-sentence. */
export function namedEntities(sentence: string, lexicon: readonly string[]): string[] {
  const found = new Set<string>()
  const lower = sentence.toLowerCase()
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (t.length >= 4 && lower.includes(t)) found.add(t)
  }
  for (const m of sentence.matchAll(/\b[A-Z][A-Z0-9]{2,7}\b/g)) {
    if (!NOT_ENTITY.test(m[0])) found.add(m[0].toLowerCase())
  }
  // A capitalised word that is not sentence-initial: a syndrome, a study
  // name, a species ("Sprague-Dawley"), a register ("EURAP").
  for (
    const m of sentence.matchAll(/(?<=[^.!?\n]\s|[(,;]\s?)([A-Z][a-z]{3,}(?:-[A-Z][a-z]+)?)\b/g)
  ) {
    const word = m[1]!
    if (!STOPWORDS.has(word.toLowerCase())) found.add(word.toLowerCase())
  }
  return [...found]
}

export function sentenceFeatures(
  sentence: string,
  lexicon: readonly string[],
  questionEntities: readonly string[] = [],
): SentenceFeatures {
  const plain = sentence.replace(/\[\d{1,3}\]/g, ' ')
  const words = contentWords(plain)
  const bigrams: string[] = []
  for (let i = 1; i < words.length; i++) bigrams.push(`${words[i - 1]} ${words[i]}`)
  return {
    words,
    bigrams,
    numbers: extractNumbers(normaliseFigures(plain)),
    entities: namedEntities(plain, lexicon),
    designs: designTerms(plain),
    claim: claimFeatures(plain, lexicon, questionEntities),
  }
}

/**
 * The study designs a sentence states, as the phrases a cited text must
 * carry: "nested case-control", "randomised", "cross-sectional",
 * "retrospective cohort". A design sentence bound to a paper that never
 * mentions the design was the LGS criteria paper cited for "a
 * retrospective, nested case-control design" (D4-07).
 */
const DESIGN_TERM =
  /\b(?:nested case[- ]control|case[- ]control|randomi[sz]ed|double[- ]blind|placebo[- ]controlled|open[- ]label|cross[- ]sectional|retrospective|prospective|observational|pooled analysis|meta[- ]analysis|case series|case report|non[- ]randomi[sz]ed|single[- ]arm|first[- ]in[- ]human|nationwide survey|qualitative study|modelling study|simulation)\b/gi

export function designTerms(sentence: string): string[] {
  const out = new Set<string>()
  for (const m of sentence.matchAll(DESIGN_TERM)) {
    out.add(m[0].toLowerCase().replace(/\s+/g, ' ').replace(/randomized/, 'randomised'))
  }
  return [...out]
}

/** Whether a text states a design term, either spelling of "randomised" and either dash. */
export function textStatesDesign(lower: string, term: string): boolean {
  const pattern = term
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[- ]/g, '[- ]')
    .replace(/randomised/, 'randomi[sz]ed')
  return new RegExp(`\\b${pattern}\\b`, 'i').test(lower)
}

/**
 * Whether a cited text supports a sentence: its named entities and figures
 * must be present, and enough of its content words (and word pairs) must
 * be found for the sentence to be a paraphrase of something the text says.
 * Returns the match strength so competing supporters can be ranked.
 */
export function supportScore(
  features: SentenceFeatures,
  text: PreparedText,
  /**
   * The sentence's words that few of the cited texts carry (see
   * `rareWords`). A text that has none of them is not the passage the
   * sentence paraphrases, however well it covers the ordinary words: a
   * levetiracetam paper covers "levetiracetam ... efficacy ... criteria"
   * and still says nothing about non-inferiority.
   */
  rare: readonly string[] = [],
  /**
   * The sentence's word pairs that few of the cited texts carry: a
   * figureless sentence needs one of them, not only a phrase every paper
   * in the field uses (D8-04).
   */
  rarePairs: readonly string[] = [],
): number {
  const { words, bigrams, numbers, entities } = features
  if (rare.length > 0 && !rare.some((w) => text.vocab.has(w))) return 0
  // The names a claim hangs on must be in the text: both of two, most of
  // many. A drug list cited to a paper that names one drug of four is the
  // misbinding reviewers caught most often.
  const entityHits = entities.filter((e) => text.lower.includes(e)).length
  if (entities.length > 0 && entityHits === 0) return 0
  if (entities.length <= 2 && entityHits < entities.length) return 0
  if (entities.length > 2 && entityHits / entities.length < 0.6) return 0
  // A name the question also uses - the cohort, drug or study the sentence
  // attributes its figures to - must be in the text whatever the others do:
  // a fenfluramine trial never mentions the Melbourne cohort.
  for (const name of features.claim.mandatory) {
    if (!text.lower.includes(name)) return 0
  }
  // The design a sentence states must be in the text: a paper that never
  // says "case-control" is not the source for "a nested case-control
  // design" whatever else it shares with the sentence (D4-07).
  for (const design of features.designs) {
    if (!textStatesDesign(text.lower, design)) return 0
  }
  // Every figure the sentence states must be in the text beside the claim's
  // own terms, not merely somewhere in it: "21% to 45%" bound to a paper
  // that carries only the 45% is the misattribution reviewers scored as a
  // P0, and a "79.8%" that a brivaracetam paper carries for brivaracetam
  // does not let it vouch for a perampanel sentence.
  const numberHits = numbers.filter((n) => figureSupportedBy(n, features.claim, text).supported)
    .length
  if (numbers.length > 0 && numberHits < numbers.length) return 0
  const wordHits = words.filter((w) => text.vocab.has(w)).length
  const wordRate = words.length > 0 ? wordHits / words.length : 0
  const bigramHits = bigrams.filter((b) => text.bigrams.has(b)).length
  const bigramRate = bigrams.length > 0 ? bigramHits / bigrams.length : 0
  const anchored = numberHits > 0 || entityHits > 0
  // A long paper's vocabulary covers most ordinary words, so an unanchored
  // sentence (no figure, no name) needs its word pairs found too - "visual
  // field loss" as a phrase, not "visual" and "loss" somewhere in 40 pages.
  let ok = false
  // A short item of a list ("Week 4", "Baseline", "Nijmegen scale at
  // week 12") states no figure and no name: it is carried when the text
  // has every one of its words (D4-20).
  if (words.length < 3) {
    ok = anchored || (numbers.length === 0 && words.length > 0 && wordRate === 1)
  } else if (anchored) ok = wordRate >= 0.45 || bigramRate >= 0.2
  else if (wordRate >= 0.5 && bigramRate >= 0.25) ok = true
  else if (wordRate >= 0.85 && words.length >= 5 && bigramRate >= 0.1) ok = true
  // A claim without a figure is placed by its key phrase: a text that has
  // none of the sentence's word pairs, only its words scattered across
  // forty pages, does not carry "a six-monthly dosing schedule" because it
  // mentions dosing and schedules (D3-09).
  if (ok && numbers.length === 0 && bigrams.length >= 2 && bigramHits === 0) return 0
  // And one of the pairs must be a distinctive one (D8-04).
  if (
    ok && numbers.length === 0 && rarePairs.length > 0 &&
    !rarePairs.some((b) => text.bigrams.has(b))
  ) return 0
  if (!ok) return 0
  return Math.min(
    1,
    0.55 * wordRate + 0.3 * bigramRate + (numberHits > 0 ? 0.1 : 0) + (entityHits > 0 ? 0.05 : 0),
  )
}

/**
 * The sentence's content words that at most a third of the cited texts
 * carry (one of two, when only two were fetched). With one text nothing is
 * rare enough to judge by, and a word no text carries at all cannot pick a
 * supporter either.
 */
export function rareWords(words: readonly string[], texts: readonly PreparedText[]): string[] {
  if (texts.length < 2) return []
  const ceiling = Math.max(1, Math.floor(texts.length / 3))
  return [...new Set(words)].filter((w) => {
    const df = texts.filter((t) => t.vocab.has(w)).length
    return df >= 1 && df <= ceiling
  })
}

/**
 * The sentence's word pairs that at most a third of the cited texts carry
 * (review loop 8 D8-04). A sentence with no figure
 * of its own is placed by its phrases, and "antiseizure medications" is a
 * phrase every epilepsy paper carries: "This proportion has remained
 * stable despite the introduction of new antiseizure medications" took
 * markers to a rat sodium selenate study and a GWAS on that one pair. A
 * text that carries none of the distinctive pairs is not a source for it.
 */
export function rareBigrams(bigrams: readonly string[], texts: readonly PreparedText[]): string[] {
  if (texts.length < 2) return []
  const ceiling = Math.max(1, Math.floor(texts.length / 3))
  return [...new Set(bigrams)].filter((b) => {
    const df = texts.filter((t) => t.bigrams.has(b)).length
    return df >= 1 && df <= ceiling
  })
}

// ---------------------------------------------------------------------------
// Reference-list detection: a bibliography entry is never a passage that
// supports a claim, so it is cut out of a cited text before matching.
// ---------------------------------------------------------------------------

/** "12. Smith AB, Jones C. Title. J Neurol. 2019;45:1-9." and its relatives. */
export function looksLikeBibliographyEntry(paragraph: string): boolean {
  const p = paragraph.trim()
  if (p.length < 25 || p.length > 1500) return false
  const numbered = /^(?:\[\d{1,3}\]|\d{1,3}[.)]|\d{1,3}\s)/.test(p)
  const year = /\b(?:19|20)\d{2}\b/.test(p)
  const doi = /\b(?:doi|https?:\/\/doi\.org|10\.\d{4,})\b/i.test(p)
  const authors = (p.match(/\b[A-Z][a-z]+(?:-[A-Z][a-z]+)? [A-Z]{1,3}\b[,.]/g) ?? []).length
  const etAl = /\bet al\b/i.test(p)
  const journalish =
    /\b(?:\d{1,4}\s*[;:]\s*\d+|\d+\s*[(]\d+[)]\s*[:]\s*\d+|vol\.?\s*\d+|pp?\.\s*\d+|\d+-\d+\.?$)/i
      .test(p)
  if (numbered && year && (authors >= 2 || etAl || doi || journalish)) return true
  if (doi && year && (authors >= 1 || etAl)) return true
  return authors >= 3 && year && journalish
}

/**
 * Whether a retrieved passage is a slice of a reference list: one entry, or
 * a run of numbered author-initial entries and journal citations. Catches
 * the mid-list chunks ("2018;90(1):e67. 58. Devinsky O, Cross JH ...") the
 * provider's density check lets through.
 */
export function looksLikeReferencePassage(passage: string): boolean {
  const p = passage.trim()
  if (!p) return false
  if (looksLikeBibliographyEntry(p)) return true
  const numberedAuthors =
    (p.match(/(?:^|\s)\d{1,3}\.\s+[A-Z][A-Za-z'-]+\s+[A-Z]{1,3}[,.]/g) ?? []).length
  const journalRefs = (p.match(/\b(?:19|20)\d{2};\s?\d{1,4}(?:\(\d+\))?:\s?[e]?\d+/g) ?? []).length
  const authors = (p.match(/\b[A-Z][a-z]+(?:-[A-Z][a-z]+)? [A-Z]{1,3}\b[,.]/g) ?? []).length
  return numberedAuthors >= 2 || (journalRefs >= 2 && authors >= 2)
}

/**
 * The text with its reference list removed: everything after a References
 * heading that reads as a bibliography, plus any paragraph anywhere that
 * looks like a bibliography entry.
 */
export function stripReferenceSection(text: string): string {
  const lines = text.split('\n')
  let cutAt = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (
      !/^\s*(?:#+\s*)?(?:\d+\.?\s*)?(?:references|bibliography|literature cited|works cited|reference list)\s*:?\s*$/i
        .test(lines[i]!)
    ) continue
    // A PDF extraction wraps one entry over three or four lines ("7. Faught
    // RE, Weiner JR, ... / Impact of nonadherence ... / Epilepsia.
    // 2009;50(3):501-9."), so no single line reads as an entry and a
    // line-by-line test never cut the bibliography at all: the RANSOM
    // reference title was then read as a finding (loop 6 D6-02). The
    // following lines are joined into blank-line blocks first.
    const following = blocksAfter(lines, i, 40)
    const entries = following.filter(looksLikeBibliographyEntry).length
    if (entries >= 2 || (following.length > 0 && entries / following.length >= 0.3)) {
      cutAt = i
      break
    }
  }
  const kept = lines.slice(0, cutAt)
  // A bibliography entry anywhere else (a footnote block, an endnote the
  // extraction moved) goes too, whether it sits on one line or is wrapped
  // over several.
  const out: string[] = []
  let block: { text: string; from: number }[] = []
  const flush = () => {
    if (block.length === 0) return
    const joined = block.map((b) => b.text.trim()).join(' ').replace(/\s+/g, ' ')
    if (!looksLikeBibliographyEntry(joined)) {
      for (const b of block) if (!looksLikeBibliographyEntry(b.text)) out.push(b.text)
    }
    block = []
  }
  for (const line of kept) {
    if (line.trim().length === 0) {
      flush()
      out.push(line)
      continue
    }
    block.push({ text: line, from: out.length })
  }
  flush()
  return out.join('\n')
}

/** The blank-line-separated blocks after a line, joined onto one line each. */
function blocksAfter(lines: readonly string[], from: number, count: number): string[] {
  const out: string[] = []
  let current: string[] = []
  for (let i = from + 1; i < lines.length && out.length < count; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) {
      if (current.length > 0) out.push(current.join(' ').replace(/\s+/g, ' ').trim())
      current = []
      continue
    }
    current.push(line.trim())
  }
  if (current.length > 0 && out.length < count) {
    out.push(current.join(' ').replace(/\s+/g, ' ').trim())
  }
  return out.filter((b) => b.length > 0)
}

// ---------------------------------------------------------------------------
// Sentence splitting that keeps each sentence's markers with it
// ---------------------------------------------------------------------------

const MARKER = /\[(\d{1,3})\]/g

function markersIn(text: string): number[] {
  return [...text.matchAll(MARKER)].map((m) => Number(m[1]))
}

/** Splits one paragraph line into sentences, each keeping the markers that follow it. */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /[.!?]["'”)]*(?:\s*\[\d{1,3}\])*(?=\s+(?:[A-Z0-9("'“*]|\d))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    const before = text.slice(start, m.index)
    // "4 p.m." ends a sentence; the abbreviation rule would read its "m" as an initial.
    if (ABBREVIATION.test(before.trimEnd()) && !/\b[ap]\.m$/i.test(before.trimEnd())) continue
    out.push(text.slice(start, end).trim())
    start = end
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter((s) => s.length > 0)
}

/** The safety variant's mandated closing line: advice, never a cited claim. */
const BOILERPLATE = /verify against current prescribing information/i

function isHeading(line: string): boolean {
  return /^\s*#{1,6}\s/.test(line) ||
    /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*(?:\[\d{1,3}\]\s*)*$/.test(line)
}

const LIST_PREFIX = /^(\s*(?:[-*•]|\d{1,3}[.)])\s+)/

// ---------------------------------------------------------------------------
// The binding pass
// ---------------------------------------------------------------------------

export interface BoundSentence {
  /** The sentence without markers. */
  text: string
  /** Citation indices (after renumbering) the sentence is bound to. */
  bound: number[]
  /** Which line of the answer the sentence sits on (an index into `layout`). */
  line: number
  /** The markers the model or platform placed on the sentence itself (the provider's numbering), kept or not. */
  original?: number[]
  /** The markers sprayed at the end of the sentence's block, candidates for every sentence in it. */
  block?: number[]
}

/** One line of the bound answer: a run of sentences with its list prefix, or a line kept as is. */
export type BoundLine = { kind: 'raw'; text: string } | {
  kind: 'sentences'
  prefix: string
  /** Indices into `sentences`. */
  sentences: number[]
}

export interface BindInput {
  text: string
  citations: readonly Citation[]
  /** Extracted text per citation index (the provider's numbering), reference list already removed. */
  texts: ReadonlyMap<number, string>
  lexicon?: readonly string[]
  /** Citation indices that failed the display floor: their markers are dropped outright. */
  belowFloor?: ReadonlySet<number>
  /** Names the question uses (lower-cased): a sentence naming one binds only to a text that carries it. */
  questionEntities?: readonly string[]
  /**
   * A name every cited text must carry to be bound at all (the study the
   * question names, "SANAD"): a citation whose text and title both lack it
   * is dropped, so a tau-pathology paper never carries a SANAD sentence.
   */
  requiredName?: string | readonly string[]
  /**
   * Keep the provider's citation numbers rather than renumbering by first
   * appearance, for a caller that renumbers once more after its own pass
   * (the figure gate) and needs one numbering throughout.
   */
  keepNumbering?: boolean
}

export interface BindResult {
  text: string
  /** The citations that kept at least one marker, renumbered in order of first appearance. */
  citations: Citation[]
  sentences: BoundSentence[]
  /** The answer's lines, so a caller can drop or re-mark sentences and render the text again. */
  layout: BoundLine[]
  /** Citation indices (the provider's numbering) that passed the floor and the name check, bound or not. */
  usable: number[]
  /**
   * Citation indices that passed the name check whatever their score: a
   * text the platform cited that verifiably carries a sentence's figures
   * beside the claim may still lend it a marker.
   */
  named: number[]
  /** Markers removed because nothing supported them. */
  dropped: number
  /** Markers moved to a different citation than the model or platform placed. */
  rebound: number
}

export function bindSentences(input: BindInput): BindResult {
  const lexicon = input.lexicon ?? []
  const prepared = new Map<number, PreparedText>()
  for (const [index, text] of input.texts) prepared.set(index, prepareText(text))
  const allPrepared = [...prepared.values()]
  const known = new Set(input.citations.map((c) => c.index))
  // Any one of the names the question uses will do: a question across two
  // studies binds to a paper that carries either.
  const required =
    (typeof input.requiredName === 'string' ? [input.requiredName] : input.requiredName ?? []).map((
      n,
    ) => n.toLowerCase()).filter((n) => n.length > 0)
  const carriesName = (index: number): boolean => {
    if (required.length === 0) return true
    const text = prepared.get(index)
    const title = input.citations.find((c) => c.index === index)?.title ?? ''
    return required.some((name) => {
      const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      return (text !== undefined && word.test(text.lower)) || word.test(title)
    })
  }
  const usable = (index: number) =>
    known.has(index) && !(input.belowFloor?.has(index) ?? false) && carriesName(index)

  let dropped = 0
  let rebound = 0
  const sentencesOut: {
    text: string
    bound: number[]
    line: number
    original: number[]
    block: number[]
  }[] = []
  const lines = input.text.split('\n')
  const layout: BoundLine[] = []
  // The markers of the paragraph a list hangs from: a list item with no
  // marker of its own may inherit them when the cited text carries the
  // item (D4-20). A heading or a blank line ends the paragraph's reach
  // only when a new marked paragraph follows; the list's own lead line
  // ("The protocol specifies: [1]") is the usual source.
  let paragraphMarkers: number[] = []

  for (const line of lines) {
    if (!line.trim()) {
      layout.push({ kind: 'raw', text: line })
      continue
    }
    if (isHeading(line)) {
      const own = markersIn(line)
      dropped += own.length
      layout.push({ kind: 'raw', text: line.replace(/\s*\[\d{1,3}\]/g, '').trimEnd() })
      continue
    }
    const prefix = LIST_PREFIX.exec(line)?.[1] ?? ''
    const body = line.slice(prefix.length)
    const sentences = splitSentences(body)
    if (sentences.length === 0) {
      layout.push({ kind: 'raw', text: line })
      continue
    }
    // Markers at the end of the paragraph are the platform's block-level
    // spray: candidates for every sentence in the block, owned by none.
    const last = sentences[sentences.length - 1]!
    const tailMarkers = markersIn(/((?:\s*\[\d{1,3}\])+)\s*$/.exec(last)?.[1] ?? '')
    const lineMarkers = markersIn(body)
    const inherited = prefix && lineMarkers.length === 0 ? paragraphMarkers : []
    // The nearest marked line above, a list item included, is what an
    // unmarked item may inherit from; an unmarked paragraph ends the reach.
    if (lineMarkers.length > 0) paragraphMarkers = [...new Set(lineMarkers)]
    else if (!prefix) paragraphMarkers = []
    const outSentences: number[] = []
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i]!
      const isLast = i === sentences.length - 1
      const ownAll = markersIn(sentence)
      const own = isLast && sentences.length > 1
        ? ownAll.slice(0, ownAll.length - tailMarkers.length)
        : ownAll
      const plain = sentence.replace(/\s*\[\d{1,3}\]/g, '').trim()
      const features = sentenceFeatures(plain, lexicon, input.questionEntities ?? [])
      const rare = rareWords(features.words, allPrepared)
      const rarePairs = rareBigrams(features.bigrams, allPrepared)
      const candidates = BOILERPLATE.test(plain)
        ? []
        : [...new Set([...own, ...(sentences.length > 1 ? tailMarkers : []), ...inherited])]
          .filter(usable)
      const score = (index: number): number => {
        const text = prepared.get(index)
        // A citation whose text could not be fetched is unverifiable: it
        // keeps a marker the sentence already had, never gains one.
        if (!text) return own.includes(index) ? 0.5 : 0
        return supportScore(features, text, rare, rarePairs)
      }
      let supporters = candidates.map((index) => ({ index, score: score(index) }))
        .filter((s) => s.score > 0)
      // Only a sentence with a figure or a named entity can gain a marker it
      // did not have: boilerplate ("verify against prescribing information")
      // matches every drug paper's vocabulary and must never be cited.
      const verifiable = features.numbers.length > 0 || features.entities.length > 0
      if (supporters.length === 0 && verifiable) {
        // Nothing the block cited supports this sentence - look across every
        // citation the answer made, and bind only to a clear match.
        supporters = input.citations
          .filter((c) => usable(c.index) && !candidates.includes(c.index))
          .map((c) => ({ index: c.index, score: score(c.index) }))
          .filter((s) => s.score >= 0.6)
        if (supporters.length > 0) rebound += 1
      }
      supporters.sort((a, b) => b.score - a.score || a.index - b.index)
      const bound = supporters.slice(0, 3).map((s) => s.index).sort((a, b) => a - b)
      const lost = new Set(
        [...own, ...(isLast ? tailMarkers : [])].filter((n) => !bound.includes(n)),
      )
      dropped += lost.size
      outSentences.push(sentencesOut.length)
      sentencesOut.push({
        text: plain,
        bound,
        line: layout.length,
        original: [...new Set(own)],
        // The block's tail markers are candidates for every sentence in it.
        block: tailMarkers.filter((n) => !own.includes(n)),
      })
    }
    layout.push({ kind: 'sentences', prefix, sentences: outSentences })
  }

  // Renumber by first appearance in the bound text.
  const order: number[] = []
  for (const s of sentencesOut) for (const n of s.bound) if (!order.includes(n)) order.push(n)
  const renumber = new Map(
    order.map((old, i) => [old, input.keepNumbering ? old : i + 1]),
  )
  const citations = order.map((old) => {
    const source = input.citations.find((c) => c.index === old)!
    return { ...source, index: renumber.get(old)! }
  })
  const sentences = sentencesOut.map((s) => ({
    text: s.text,
    bound: s.bound.map((n) => renumber.get(n)!).filter((n) => n !== undefined).sort((a, b) =>
      a - b
    ),
    line: s.line,
    original: s.original,
    block: s.block,
  }))
  return {
    text: renderBound(layout, sentences),
    citations,
    sentences,
    layout,
    usable: input.citations.map((c) => c.index).filter(usable),
    named: input.citations.map((c) => c.index).filter((i) => known.has(i) && carriesName(i)),
    dropped,
    rebound,
  }
}

/**
 * A table row's markers sit inside its last cell, never after the closing
 * pipe where they render as a column of their own; a header row (no
 * figure, no claim) carries none (D4-06).
 */
export function tableRowMarkers(line: string): string {
  const m = /^(\s*\|.*\|)((?:\s*\[\d{1,3}\])+)\s*$/.exec(line)
  if (!m) return line
  const row = m[1]!
  const markers = m[2]!.replace(/\s+/g, '')
  if (/^\s*\|[\s|:-]*\|\s*$/.test(row) || !/\d/.test(row)) return row
  return row.replace(/\s*\|\s*$/, ` ${markers} |`)
}

/**
 * The answer text from its layout: each sentence followed by its markers in
 * ascending order, a line whose every sentence was removed dropped with it.
 */
/** A Markdown heading, or a bold label on a line of its own, that introduces what follows. */
export function isLabelLine(text: string): boolean {
  const trimmed = text.trim()
  return /^#{1,6}\s/.test(trimmed) || /^\*\*[^*]+\*\*:?$/.test(trimmed)
}

export function renderBound(
  layout: readonly BoundLine[],
  sentences: readonly BoundSentence[],
  removed: ReadonlySet<number> = new Set(),
): string {
  const lines: string[] = []
  // A heading or a bold label whose every sentence was removed is a
  // promise the answer no longer keeps: "**Perampanel:**" over nothing at
  // all (review loop 8, the retention comparison
  // after the gate took the perampanel rows). It goes with them.
  const empty = new Set<number>()
  for (let i = 0; i < layout.length; i++) {
    const line = layout[i]!
    if (line.kind !== 'raw' || !isLabelLine(line.text)) continue
    let anything = false
    for (let j = i + 1; j < layout.length; j++) {
      const next = layout[j]!
      if (next.kind === 'raw') {
        if (isLabelLine(next.text)) break
        continue
      }
      if (next.sentences.some((n) => !removed.has(n))) {
        anything = true
        break
      }
    }
    if (!anything) empty.add(i)
  }
  for (let index = 0; index < layout.length; index++) {
    const line = layout[index]!
    if (line.kind === 'raw') {
      if (!empty.has(index)) lines.push(line.text)
      continue
    }
    const kept = line.sentences.filter((i) => !removed.has(i))
    if (kept.length === 0) continue
    const rendered = line.prefix +
      kept.map((i) => {
        const s = sentences[i]!
        return s.bound.length > 0 ? `${s.text}${s.bound.map((n) => `[${n}]`).join('')}` : s.text
      }).join(' ')
    lines.push(tableRowMarkers(rendered))
  }
  // A removed list item or paragraph never leaves a double blank line behind.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
}
