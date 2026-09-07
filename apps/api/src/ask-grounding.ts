/**
 * The ask handler's grounding helpers: the cited texts it binds and audits
 * against, the context it adds beside retrieval, and the one pass that
 * turns the provider's paragraph-bound answer into a sentence-bound,
 * audited one (docs/TRUST-LAYER.md).
 */
import type { Citation, ResourceSummary, ScoredResource, TenantConfig } from '@research-portal/core'
import {
  auditAddendum,
  denominatorsMissing,
  drugsFlaggedInSources,
  drugsMissingFromAnswer,
  extractNumbers,
  figurePattern,
  isSampleSizeFigure,
  normaliseFigures,
  outcomeFamilies,
  populationQualifier,
  type PreparedSource,
  qualifierForFigure,
  stripUnsupportedSafetyClaims,
  studyDesignOf,
  timepointsInMonths,
  verifyFigures,
  yearsUnsupported,
} from './answer-audit.ts'
import {
  carriesQualifier,
  cohortTerms,
  figuresFoundIn,
  generatedText,
  isDeclineSentence,
  isPlanningQuestion,
  namesOtherStudy,
  ownFigureSentence,
  type PoolText,
  prepareIfNeeded,
  quoteCarriesClaim,
  quoteSentence,
  replacementCue,
  rescueQuote,
  rescueSentence,
  statesResultFigure,
  stripTemplateLeaks,
  studyLabel,
  syntheticCitation,
  withQualifier,
} from './figure-rescue.ts'
import {
  attributedElsewhere,
  attributedNote,
  figureOffsets,
  markedSentences,
  secondhandFigures,
  secondhandNote,
} from './secondhand.ts'
import {
  bindSentences,
  looksLikeReferencePassage,
  namedEntities,
  splitSentences,
  stripReferenceSection,
} from './citation-binding.ts'
import {
  assertsFinding,
  CONCLUSION,
  CONNECTIVE,
  designLead,
  effectSizeNote,
  effectSizesFor,
  gateFigures,
  markUnverifiableCells,
  reconcileRemovals,
  removalNote,
  rowKey,
  stripConnective,
  tableCellHeadings,
  uncitedNote,
} from './answer-gate.ts'
import { correctAttributions, type NamedAuthor } from './ask-author.ts'
import { choosePassage, paragraphsOf } from './evidence-passages.ts'
import {
  isMedicationTerm,
  isTreatmentDecisionQuestion,
  isTreatmentSelectionQuestion,
} from './ask-prequeries.ts'

/** What the handler needs from the management surface: a resource's extracted text. */
export interface ExtractionSource {
  resourceExtraction(tenant: TenantConfig, id: string): Promise<{ text: string }>
}

/** The `audit` ask event (packages/core AskEventSchema). */
export interface AuditEvent {
  type: 'audit'
  figuresChecked: number
  figuresUnsupported: string[]
  yearsUnsupported: string[]
  contraindicationsUnsupported: string[]
  sentencesChecked: number
  sentencesCited: number
  denominatorsMissing: string[]
  attributionsCorrected: string[]
  /** Sentences the figure gate removed, and the figures they stated. */
  sentencesRemoved: number
  figuresRemoved: string[]
  /** Figures found in a retrieved, prior-turn or DA text after the cited passages failed them. */
  figuresRescued?: string[]
  /** Sentences replaced by the named paper's own figure sentence. */
  sentencesReplaced?: number
  /** Titles of resources that carry a removed figure somewhere, though not beside its claim. */
  foundIn?: string[]
  /** Figures removed because the cited paper carries them only where it cites other studies. */
  figuresSecondhandRemoved?: string[]
}

// ---------------------------------------------------------------------------
// Cited texts, fetched once per resource
// ---------------------------------------------------------------------------

const CACHE_CAP = 80
const extractionCache = new Map<string, Promise<string>>()

/**
 * A resource's extracted text with its reference list removed, cached per
 * process so the same paper is not re-fetched for every answer that cites
 * it. A failed fetch is not cached.
 */
export function extractionText(
  management: ExtractionSource,
  config: TenantConfig,
  id: string,
): Promise<string> {
  const key = `${config.slug}:${id}`
  const hit = extractionCache.get(key)
  if (hit) return hit
  const pending = management.resourceExtraction(config, id).then(
    (r) => stripReferenceSection(r.text),
    (err) => {
      extractionCache.delete(key)
      throw err
    },
  )
  extractionCache.set(key, pending)
  if (extractionCache.size > CACHE_CAP) {
    const oldest = extractionCache.keys().next().value
    if (oldest) extractionCache.delete(oldest)
  }
  return pending
}

// ---------------------------------------------------------------------------
// Sources as shown: never a bibliography paragraph as the passage
// ---------------------------------------------------------------------------

/**
 * Reference-list hits keep their flag but lose the bibliography paragraph
 * and its page. A passage the provider did not flag is checked here too:
 * mid-list chunks slip past its density heuristic.
 */
export function withoutReferencePassages(resources: ScoredResource[]): ScoredResource[] {
  return resources.map((r) => {
    const reference = r.referenceChunk ||
      (r.matchedPassage !== undefined && looksLikeReferencePassage(r.matchedPassage))
    if (!reference) return r
    const { matchedPassage: _passage, matchedPage: _page, matchedField: _field, ...rest } = r
    return { ...rest, referenceChunk: true }
  })
}

// ---------------------------------------------------------------------------
// Context the application adds beside retrieval
// ---------------------------------------------------------------------------

export const DOCUMENT_CHAT_ADDENDUM =
  "You are answering about one document only. Preserve each statistic's name exactly as " +
  'the document gives it - a mean is not a median, a hazard ratio is not a relative risk - ' +
  'and correct the question when it names the wrong one. When the question asks "which", ' +
  'enumerate every item the document names, not only the first. Tables and key-resources ' +
  'blocks supplied with the sources are part of the document. If the document does not ' +
  'address the question, say "This document does not state" that plainly, and never write ' +
  '"the context" or "Not enough data".'

/**
 * The parts of a document that retrieval by paragraph tends to miss: its
 * pipe tables and the key-resources or STAR-methods block. Returned as
 * blocks of at most 1,500 characters, at most 6,000 in total.
 */
export function documentContextBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let table: string[] = []
  const flushTable = () => {
    if (table.length >= 2) blocks.push(table.join('\n'))
    table = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push(line.trim())
      continue
    }
    flushTable()
    if (
      /\b(key resources? table|star methods|experimental models?|organisms?\/strains?|resource availability|reagent or resource)\b/i
        .test(line)
    ) {
      const block = lines.slice(i, i + 25).join('\n').trim()
      if (block) blocks.push(block)
    }
  }
  flushTable()
  const out: string[] = []
  let total = 0
  const seen = new Set<string>()
  for (const block of blocks) {
    const clipped = block.slice(0, 1500)
    if (seen.has(clipped)) continue
    seen.add(clipped)
    if (total + clipped.length > 6000) break
    out.push(clipped)
    total += clipped.length
  }
  return out
}

/** "Publication years of the matching resources" for the recency prompt. */
export function publicationYearsContext(resources: readonly ScoredResource[]): string {
  const lines = resources
    .map((r) => {
      const year = r.year ?? r.published?.slice(0, 4)
      return year ? `- ${r.title} (${year})` : null
    })
    .filter((l): l is string => l !== null)
    .slice(0, 12)
  return lines.length > 0
    ? 'Publication years of the portal resources that match this question, from their ' +
      `records - state a study's year only from this list or the source text:\n${lines.join('\n')}`
    : ''
}

// ---------------------------------------------------------------------------
// Bind and audit
// ---------------------------------------------------------------------------

export interface BindAndAuditInput {
  management: ExtractionSource
  config: TenantConfig
  query: string
  text: string
  citations: readonly Citation[]
  sources: readonly ScoredResource[]
  lexicon: readonly string[]
  variant: string | undefined
  floor: number
  /** The catalogue, for author lists and titles the sources may lack. */
  catalogue?: readonly ResourceSummary[]
  /** Authors the question named that the catalogue recognises (retrieval was scoped to them). */
  authors?: readonly NamedAuthor[]
  /** Papers the study guard pinned, and the terms that pinned them. */
  pinnedResourceIds?: readonly string[]
  pinnedTerms?: readonly string[]
  /** Resources the session's earlier turns cited: a figure carried forward is checked against them. */
  priorResourceIds?: readonly string[]
  /**
   * The resources retrieval was pinned to (name-pin.ts): the papers the
   * question's own names resolved to. Every retrieved passage came from
   * them, so a rescue may rebind a figure inside the pin but can never
   * import one from a neighbouring cohort (D7-01, D7-02).
   */
  pinScopeIds?: readonly string[]
}

export interface BindAndAuditResult {
  text: string
  citations: Citation[]
  audit: AuditEvent
  /** The sources with each cited resource's card passage re-chosen for the claims bound to it. */
  sources: ScoredResource[]
  /** The figure gate removed every sentence: nothing verifiable is left to show. */
  emptied: boolean
}

// ---------------------------------------------------------------------------
// The corpus boundary for a named study
// ---------------------------------------------------------------------------

/** Acronyms a question uses that are never study names. */
const NOT_A_STUDY =
  /^(?:EEG|ECG|EMG|MRI|PET|CT|SPECT|ASM|ASMS|AED|AEDS|SUDEP|PNES|IGE|JME|CAE|JAE|GGE|DRE|TLE|FLE|MTLE|QOL|QALY|PRO|PROS|RCT|RCTS|CI|HR|OR|RR|SD|IQR|AUC|FDA|TGA|PBS|NHS|WHO|ILAE|SEEG|RFTC|LITT|VNS|DBS|RNS|LGS|CBD|THC|GWAS|DNA|RNA|PCR|CSF|NMDAR|LGI1|CASPR2|GABA|MOG|AQP4|GTCS|FBTCS|FS|HS|TBI|ICU|ED|GP|MDT|AI|ML|API|PDF|USA|UK|EU|II|III|IV)$/

/**
 * The answer with every sentence naming one of the given studies replaced
 * by a note saying the collection holds no such study and no cited source
 * states the claim. Used only for a study the answer introduced that no
 * cited text mentions: with reference lists cut, such a sentence has
 * nothing behind it at all (loop 6 D6-02).
 */
export function stripUnheldStudyClaims(
  answer: string,
  studies: readonly string[],
): { text: string; removed: string[] } {
  if (studies.length === 0) return { text: answer, removed: [] }
  const removed: string[] = []
  const notes: string[] = []
  let text = answer
  for (const study of studies) {
    const head = study.split(' ')[0]!
    for (const line of text.split('\n')) {
      if (/^\s*[*|]/.test(line)) continue
      for (const sentence of splitSentences(line)) {
        const plain = sentence.replace(/\s*\[\d{1,3}\]/g, '').trim()
        if (!new RegExp(`\\b${head}\\b`).test(plain)) continue
        if (!text.includes(sentence)) continue
        removed.push(plain)
        const note = `*A sentence naming ${study} was removed: this collection holds no paper ` +
          'reporting that study, and no cited source states the finding.*'
        notes.push(note)
        text = text.replace(sentence, note)
      }
    }
  }
  // A removal takes its dependants with it (
  // review loop 7 D7-07): the figure gate already drops a conclusion that
  // rested on a removed sentence, and a sentence removed here - a finding
  // this collection holds no paper for - must take the same dependants.
  const dependants = removeDependants(text, removed, notes)
  return { text: dependants.text, removed: [...removed, ...dependants.removed] }
}

/** Words a sentence is about: long enough to carry meaning, lower case. */
function contentTerms(sentence: string): Set<string> {
  const stop = new Set([
    'about',
    'above',
    'after',
    'among',
    'associated',
    'because',
    'been',
    'being',
    'between',
    'could',
    'cited',
    'found',
    'from',
    'given',
    'other',
    'people',
    'reported',
    'sources',
    'study',
    'studies',
    'their',
    'there',
    'these',
    'this',
    'those',
    'which',
    'while',
    'with',
    'within',
    'would',
  ])
  return new Set(
    (sentence.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [])
      .map((w) => w.replace(/(?:s|es|ed|ing)$/, ''))
      .filter((w) => w.length >= 4 && !stop.has(w)),
  )
}

/** How many content terms two sentences share. */
function sharedTerms(a: Set<string>, b: Set<string>): number {
  let hits = 0
  for (const term of a) if (b.has(term)) hits++
  return hits
}

/**
 * The sentences that depended on a removed one, removed with it (D7-07):
 * the conclusion that rested on it ("This suggests ..."), the connective
 * that tied the next sentence to it, and the answer's opening assertion
 * when the removed sentence was the only thing standing behind it. Loop 7
 * J9 removed the fabricated RANSOM finding and kept both "Yes, medication
 * adherence is associated with mortality" and "This suggests that
 * adherence ... is crucial", neither of which any source stated.
 */
export function removeDependants(
  answer: string,
  removed: readonly string[],
  notes: readonly string[],
): { text: string; removed: string[] } {
  if (removed.length === 0) return { text: answer, removed: [] }
  const isNote = (sentence: string) =>
    notes.some((n) => sentence.includes(n)) || /^\s*\*/.test(sentence)
  // A note ends "...finding.*", which the sentence splitter does not read
  // as a sentence end, so the notes are cut out of the line first and the
  // prose either side split normally.
  const splitWithNotes = (line: string): string[] => {
    let parts = [line]
    for (const note of notes) {
      const next: string[] = []
      for (const part of parts) {
        if (part === note || !part.includes(note)) {
          next.push(part)
          continue
        }
        const pieces = part.split(note)
        pieces.forEach((piece, i) => {
          if (piece.trim()) next.push(piece.trim())
          if (i < pieces.length - 1) next.push(note)
        })
      }
      parts = next
    }
    return parts.flatMap((part) => notes.includes(part) ? [part] : splitSentences(part))
  }
  const alsoRemoved: string[] = []
  const lines = answer.split('\n')
  // A conclusion anywhere after a removal rested on it, the way the figure
  // gate already reads one; a connective only ties a sentence to the one
  // immediately before it.
  let anyRemoved = false
  const out = lines.map((line) => {
    if (/^\s*[|#>]/.test(line)) return line
    let justRemoved = false
    const kept: string[] = []
    for (const sentence of splitWithNotes(line)) {
      const plain = sentence.replace(/\s*\[\d{1,3}\]/g, '').trim()
      if (isNote(sentence)) {
        justRemoved = true
        anyRemoved = true
        kept.push(sentence)
        continue
      }
      if (anyRemoved && CONCLUSION.test(plain) && !/\d/.test(plain)) {
        alsoRemoved.push(plain)
        continue
      }
      if (justRemoved && CONNECTIVE.test(sentence)) {
        kept.push(stripConnective(sentence))
        justRemoved = false
        continue
      }
      justRemoved = false
      kept.push(sentence)
    }
    return kept.join(' ')
  })
  let text = out.join('\n')
  // The opening assertion goes when the removal left nothing behind it: no
  // sentence still in the answer speaks to the same claim. Loop 8 U9 kept
  // "non-adherence to antiepileptic drugs is linked to increased mortality"
  // after every sentence carrying evidence for it had gone, cited to a
  // paper whose only use of the word is about drug response in adherent
  // patients (D8-09). The lead is a dependant like any other, and whether
  // the removed sentence happened to share its wording is not the test -
  // what stands behind it now is. A lead that states a figure of its own
  // stands on that figure, and one that asserts no finding - a framing
  // line, a list lead-in, the portal's own note about what the sources do
  // not say - is not a claim that needs support at all.
  const lead = leadSentence(text)
  if (lead && !/\d/.test(lead) && assertsFinding(lead)) {
    const leadTerms = contentTerms(lead)
    // Split with the notes cut out: a note ends "...finding.*", which the
    // sentence splitter does not read as a sentence end, so a plain split
    // glues the note to the sentence after it and the support that
    // sentence carries is lost with it.
    const others = text
      .split('\n')
      .filter((l) => !/^\s*[|#>*]/.test(l))
      .flatMap((l) => splitWithNotes(l))
      .map((sentence) => sentence.replace(/\s*\[\d{1,3}\]/g, '').trim())
      .filter((sentence) => sentence.length > 0 && sentence !== lead && !isNote(sentence))
    const stillSupported = others.some((o) => sharedTerms(leadTerms, contentTerms(o)) >= 2)
    if (!stillSupported) {
      alsoRemoved.push(lead)
      text = text
        .split('\n')
        .map((l) =>
          /^\s*[|#>]/.test(l) ? l : splitWithNotes(l)
            .filter((sentence) => sentence.replace(/\s*\[\d{1,3}\]/g, '').trim() !== lead)
            .join(' ')
        )
        .join('\n')
    }
  }
  return { text, removed: alsoRemoved }
}

/** The first sentence of an answer's body: the first line that is not a heading or an italic note. */
export function leadSentence(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || /^[*#|>-]/.test(trimmed)) continue
    const stop = /[.!?]["'\u201d)]*(?:\s*\[\d{1,3}\])*(?=\s|$)/.exec(trimmed)
    return (stop ? trimmed.slice(0, stop.index + stop[0].length) : trimmed)
      .replace(/\s*\[\d{1,3}\]/g, '').trim()
  }
  return ''
}

/**
 * Whether a token can be a study name at all (
 * review loop 7 D7-12). The extraction glues a reference marker to the
 * word before it, so "SUDEP1" and "JME1 2" reach the answer looking like
 * acronyms; the portal then told the reader it held no such study while
 * citing the very paper the sentence above came from. A study name is at
 * least four characters, and a condition abbreviation with a citation
 * marker stuck to it ("SUDEP" + "1") is not one.
 */
export function isStudyAcronym(token: string, next = ''): boolean {
  if (token.length < 4) return false
  const base = token.replace(/[0-9]+$/, '')
  if (base.length >= 2 && base !== token && NOT_A_STUDY.test(base)) return false
  // A trailing digit followed by a bare numeral is a run of reference
  // markers ("JME1 2"), never a study and its edition.
  if (/[0-9]$/.test(token) && /^\d{1,3}$/.test(next)) return false
  return true
}

/**
 * A study, trial or register the question names by acronym ("SANAD II",
 * "the BREATHS trial", "PERMIT pooled analysis"): an all-caps token of
 * three letters or more that either carries a numeral or sits beside a
 * study word. Null when the question names none.
 */
export function namedStudy(query: string): string | null {
  const words = query.split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!.replace(/[^A-Za-z0-9-]/g, '')
    if (!/^[A-Z][A-Z0-9-]{2,}$/.test(raw) || NOT_A_STUDY.test(raw)) continue
    const next = (words[i + 1] ?? '').replace(/[^A-Za-z0-9]/g, '')
    if (!isStudyAcronym(raw, next)) continue
    const numeral = /^(?:II|III|IV|V|2|3|4)$/.test(next)
    const near = words.slice(Math.max(0, i - 2), i + 4).join(' ').toLowerCase()
    const studyWord =
      /\b(?:trial|study|protocol|analysis|analyses|cohort|register|registry|programme|program|consortium)\b/
        .test(near)
    if (numeral) return `${raw} ${next}`
    if (studyWord) return raw
  }
  return null
}

/**
 * The boundary sentence for a named study: none when a cited or catalogued
 * title carries its name; otherwise whether the collection holds it at all,
 * so the reader can tell coverage from evidence.
 */
/**
 * Every study, trial or register a text names by acronym, in order and
 * without repeats. `namedStudy` returns the first; a generated answer may
 * introduce one the question never mentioned.
 */
export function namedStudies(text: string): string[] {
  const out: string[] = []
  const words = text.split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!.replace(/[^A-Za-z0-9-]/g, '')
    if (!/^[A-Z][A-Z0-9-]{2,}$/.test(raw) || NOT_A_STUDY.test(raw)) continue
    const next = (words[i + 1] ?? '').replace(/[^A-Za-z0-9]/g, '')
    if (!isStudyAcronym(raw, next)) continue
    const numeral = /^(?:II|III|IV|V|2|3|4)$/.test(next)
    const near = words.slice(Math.max(0, i - 2), i + 4).join(' ').toLowerCase()
    const studyWord =
      /\b(?:trial|study|studies|protocol|analysis|analyses|cohort|register|registry|programme|program|consortium)\b/
        .test(near)
    const name = numeral ? `${raw} ${next}` : studyWord ? raw : undefined
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export function unheldStudyNote(
  query: string,
  citedTitles: readonly string[],
  catalogueTitles: readonly string[],
  /** The gated answer: a study the answer itself introduces is bounded too (loop 6 D6-02). */
  answer?: string,
  /** Whether any cited text actually refers to the study (D7-08). */
  citedTextsMention = true,
): string | undefined {
  const named = namedStudy(query)
  const introduced = answer ? namedStudies(answer) : []
  const study = named ?? introduced.find((s) => {
    const head = s.split(' ')[0]!
    const carries = (title: string) => new RegExp(`\\b${head}\\b`, 'i').test(title)
    return !citedTitles.some(carries) && !catalogueTitles.some(carries)
  })
  if (!study) return undefined
  const head = study.split(' ')[0]!
  const carries = (title: string) => new RegExp(`\\b${head}\\b`, 'i').test(title)
  if (citedTitles.some(carries)) return undefined
  if (catalogueTitles.some(carries)) {
    return `*This collection holds ${study} itself, but the answer above did not cite it: the ` +
      'statements come from sources that refer to it. Search the Library for the study to read it directly.*'
  }
  // "The statements above come from sources that cite it second-hand" is
  // only true when there are such sources: loop 7 Z2 printed it over an
  // answer with no citation and no source at all (D7-08).
  if (citedTitles.length === 0 || !citedTextsMention) {
    return `*This collection does not hold ${study}, and no source cited above refers to it. ` +
      'Nothing here reports what that study found.*'
  }
  return `*This collection does not hold ${study} itself. The statements above come from ` +
    'sources that cite it second-hand; verify against the original before relying on them.*'
}

/** Words that name a study design, for the clinical variant's first-citation check. */
const DESIGN_WORD =
  /\b(?:randomi[sz]ed|trial|cohort|case-control|case series|case report|cross-sectional|survey|model(?:ling)?|simulation|simulated|review|meta-analysis|pooled analysis|protocol|first-in-human|observational|retrospective|prospective)\b/i

/**
 * The addendum line for table cells marked "not verified" rather than the
 * row dropped (D5-05): those whose figure the check could not tie to the
 * row's source, and those that stated an analysis set or "not reported"
 * where the column asked for a figure (loop 6 D6-16a). One line covers
 * both, so a table never carries two notes about its own cells.
 */
export function blankedNote(
  blanked: readonly { figures: string[] }[],
  unreadable = 0,
): string | undefined {
  const figures = [...new Set(blanked.flatMap((b) => b.figures))]
  const failed = blanked.reduce((n, b) => n + b.figures.length, 0)
  const cells = failed + unreadable
  if (cells === 0) return undefined
  const reasons: string[] = []
  if (failed > 0) {
    reasons.push(
      `${failed === 1 ? 'one' : failed} whose ${figures.length === 1 ? 'figure' : 'figures'} (${
        figures.join(', ')
      }) could not be tied to the cited passage for that row`,
    )
  }
  if (unreadable > 0) {
    reasons.push(
      `${
        unreadable === 1 ? 'one' : unreadable
      } that stated an analysis set or "not reported" where the column asked for a figure`,
    )
  }
  return `*${
    cells === 1 ? 'One table cell was' : `${cells} table cells were`
  } marked "not verified": ${reasons.join(', and ')}.*`
}

/** How many figures an answer states: the "Checking N figures" count the surface shows while the audit runs. */
export function figureCount(text: string): number {
  return extractNumbers(text.replace(/\s*\[\d{1,3}\]/g, '')).length
}

/** Words of a claim that say nothing about which paper it is about. */
const GENERIC_SENTENCE_WORDS = new Set([
  'patients',
  'study',
  'studies',
  'analysis',
  'cohort',
  'epilepsy',
  'months',
  'years',
  'their',
  'these',
  'those',
  'which',
  'there',
  'about',
  'other',
  'papers',
  'across',
  'among',
  'within',
  'after',
  'before',
  'between',
  'included',
  'reported',
  'achieved',
  'proportion',
  'rate',
  'rates',
  'outcome',
  'outcomes',
  'score',
  'scores',
  'specific',
  'another',
  'during',
  'median',
  'range',
  'follow-up',
  'number',
  'total',
  'overall',
  'compared',
  'significantly',
  'approximately',
])

/** How many cited resources' texts are fetched for binding and audit. */
const MAX_CITED_TEXTS = 8
/** How many further resources' texts the rescue may fetch. */
const MAX_POOL_TEXTS = 8

/**
 * The texts a withheld figure is looked up in. Under a pin they are the
 * pinned papers and nothing else, so a rescue can rebind a figure inside
 * the pin but never import one from a neighbouring cohort. Without a pin,
 * best first: the pinned papers, the papers earlier turns cited, then the
 * retrieved resources by relevance. Each is the paper's extracted text
 * (fetched now, cached per process) plus its DA summary and key takeaways
 * as a text of its own. Cited texts already fetched are not repeated.
 */
async function poolTexts(
  input: BindAndAuditInput,
  fetched: ReadonlyMap<number, string>,
  cohort: ReadonlySet<string>,
  _terms: readonly string[],
): Promise<PoolText[]> {
  const fetchedIds = new Set(
    input.citations.filter((c) => fetched.has(c.index)).map((c) => c.resourceId),
  )
  const titleOf = new Map<string, string>()
  for (const s of input.sources) titleOf.set(s.id, s.title)
  for (const c of input.citations) {
    if (!titleOf.has(c.resourceId)) titleOf.set(c.resourceId, c.title)
  }
  for (const r of input.catalogue ?? []) if (!titleOf.has(r.id)) titleOf.set(r.id, r.title)
  const order: string[] = []
  const add = (id: string) => {
    if (!order.includes(id)) order.push(id)
  }
  for (const id of cohort) add(id)
  // The rescue read stays inside the pin: it may rebind a figure to a paper
  // the question named, and can never import one from a neighbouring cohort
  // (D7-01). Without a pin the pool is the retrieved set, as before.
  if (cohort.size === 0) {
    for (const id of input.pinnedResourceIds ?? []) add(id)
    for (const id of input.priorResourceIds ?? []) add(id)
    for (const s of [...input.sources].sort((a, b) => b.relevance - a.relevance)) {
      if (!s.referenceChunk) add(s.id)
    }
  }
  const wanted = order.filter((id) => !fetchedIds.has(id)).slice(0, MAX_POOL_TEXTS)
  const out: PoolText[] = []
  const texts = await Promise.all(wanted.map(async (id) => {
    try {
      return { id, text: await extractionText(input.management, input.config, id) }
    } catch {
      return { id, text: undefined }
    }
  }))
  for (const { id, text } of texts) {
    if (text) out.push({ resourceId: id, title: titleOf.get(id) ?? '', text, generated: false })
  }
  // The DA fields of every known resource, cited or not, after the texts.
  for (const id of order) {
    const source = input.sources.find((s) => s.id === id)
    const generated = source ? generatedText(source) : undefined
    if (generated) {
      out.push({ resourceId: id, title: titleOf.get(id) ?? '', text: generated, generated: true })
    }
  }
  return out
}

/**
 * Sentence-level binding followed by the audit, over the extracted texts of
 * the cited resources. The bound text carries the renumbered markers; the
 * audit addendum is appended to it; the `audit` event summarises what was
 * checked so the surface can badge the answer and mark figures inline.
 */
export async function bindAndAudit(raw: BindAndAuditInput): Promise<BindAndAuditResult> {
  // The pin, enforced on the way back. The platform honours
  // `resource_filters` weakly on `/ask` (docs/ARAG-DEV.md), so a citation to
  // a paper outside the pin is dropped before anything is checked: its
  // sentence then has no marker and is judged, and removed, like any other
  // unsupported sentence. This is what the question-level cohort guard used
  // to approximate by matching strings.
  const scope = new Set(raw.pinScopeIds ?? [])
  const input: BindAndAuditInput = scope.size > 0
    ? { ...raw, citations: raw.citations.filter((c) => scope.has(c.resourceId)) }
    : raw
  const { config, query, lexicon, variant } = input
  const texts = new Map<number, string>()
  await Promise.all(
    input.citations.slice(0, MAX_CITED_TEXTS).map(async (citation) => {
      try {
        texts.set(
          citation.index,
          await extractionText(input.management, config, citation.resourceId),
        )
      } catch {
        // An unfetchable text leaves its citation unverifiable, not dropped.
      }
    }),
  )
  const byId = new Map(input.sources.map((s) => [s.id, s]))
  const catalogueById = new Map((input.catalogue ?? []).map((r) => [r.id, r]))
  // A paper the question names is pinned whatever its retrieval score:
  // the display floor never strips its markers (TD2 in the loop 4 replay,
  // the BREATHS protocol at 10%).
  const pinnedSet = new Set([
    ...(input.pinnedResourceIds ?? []),
    ...(input.pinScopeIds ?? []),
  ])
  // The pin: when retrieval was constrained to the papers the question
  // names, every cited paper is by construction one of them, so the checks
  // that existed to tell the question's cohort from a neighbour's - the
  // cohort guard, the name test on a cited text, the restricted rescue
  // pool - have nothing left to decide and are gone (docs/TRUST-LAYER.md).
  const pinScope = scope
  const belowFloor = new Set(
    input.citations
      .filter((c) =>
        !pinnedSet.has(c.resourceId) && (byId.get(c.resourceId)?.relevance ?? 1) < input.floor
      )
      .map((c) => c.index),
  )
  // The names the question uses (a cohort, a drug, a study) bind a sentence
  // only to a text that carries them; a study the question names by
  // acronym must be in every cited text (or its title) for it to be bound.
  const questionEntities = namedEntities(query, lexicon)
  const study = namedStudy(query)
  // The names a cited text must carry: the study the question names by
  // acronym, or any of the cohorts it designates (a question across two
  // studies binds to a paper that carries either).
  // The cohort the question designates (an acronym, a described cohort, a
  // pinned paper's own term) outranks the drugs it names: under "the LGI1
  // encephalitis cohort ... rituximab", the rituximab papers are not the
  // cohort (D3-01). Drugs define the cohort only when nothing else does.
  const designatedTerms = cohortTerms(
    query,
    (input.pinnedTerms ?? []).filter((t) => !isMedicationTerm(t.toLowerCase())),
  )
  const designated = designatedTerms.length > 0 || pinScope.size > 0
  const terms = designated ? designatedTerms : cohortTerms(query, input.pinnedTerms ?? [], lexicon)
  // Under a pin the name test is a tautology - the cited paper is a paper
  // the question named - and applying it would strip a marker from a pinned
  // paper whose text spells the cohort differently from the question.
  const requiredNames = pinScope.size > 0
    ? []
    : [...new Set([...(study ? [study.split(' ')[0]!] : []), ...terms])]
  // The generator's scaffolding goes before any sentence is judged (D4-14).
  const bound = bindSentences({
    text: stripTemplateLeaks(input.text),
    citations: input.citations,
    texts,
    lexicon,
    belowFloor,
    questionEntities,
    ...(requiredNames.length > 0 ? { requiredName: requiredNames } : {}),
    // The gate renumbers once it has decided what stays.
    keepNumbering: true,
  })
  // Every cited text that carries the study the question names, in the
  // provider's numbering: what the gate checks an unbound sentence against,
  // and what it may lend a marker from. The display floor does not apply
  // here: a paper the platform cited that verifiably carries every figure
  // of a sentence beside its claim is that sentence's source whatever its
  // search score.
  const usableTexts = new Map<number, string>()
  for (const index of bound.named) {
    const t = texts.get(index)
    if (t !== undefined) usableTexts.set(index, t)
  }
  const oldIndexByResource = new Map(input.citations.map((c) => [c.resourceId, c.index]))
  const allTexts = [...usableTexts.values()]
  // Figures beside their own terms, in the texts each sentence is bound to,
  // then the gate: a sentence whose figures fail is removed, a figure
  // sentence with no marker inherits the one text that carries all of them
  // or is removed too. What remains has passed.
  const markerOfText = [...usableTexts.keys()]
  const textsByNew = new Map<number, string>()
  // A table cell is checked under the column heading above it (D6-03).
  const headings = tableCellHeadings(stripTemplateLeaks(input.text))
  let checks = verifyFigures(
    bound.sentences.map((s) => ({
      text: s.text,
      texts: s.bound.map((n) => usableTexts.get(n)).filter((t): t is string => t !== undefined),
      ...(headings.has(rowKey(s.text)) ? { headings: headings.get(rowKey(s.text))! } : {}),
    })),
    allTexts,
    lexicon,
    questionEntities,
  )
  // A decline ("the cited sources do not provide ...") is the portal's
  // own state, not a claim: it carries no marker and is not gated (D3-15).
  const declines = new Set<string>()
  for (const sentence of bound.sentences) {
    if (!isDeclineSentence(sentence.text)) continue
    declines.add(sentence.text)
    sentence.bound = []
  }
  checks = checks.filter((c) => !declines.has(c.sentence))
  const resourceOfIndex = new Map(input.citations.map((c) => [c.index, c.resourceId]))
  const candidates: Citation[] = [...input.citations]
  // The cohort the answer may draw on IS the pin: retrieval never saw
  // another cohort's paper, so there is no post-hoc guard to run. The
  // question-level cohort guard that used to force every result sentence to
  // cite a paper "about that cohort" (D3-01, D3-07, D4-01, D4-02) is gone
  // with it, and so are the catalogue-matching helpers it needed.
  const cohort = pinScope
  const namedCohort = cohort.size > 0
  const planning = isPlanningQuestion(query)
  // The rescue (D3-02): a sentence the gate would remove is looked up in
  // the full text of every retrieved resource, the papers the session's
  // earlier turns cited and the DA summary and key takeaways, before it
  // is withheld. The texts are fetched only when something needs them.
  const failing = new Set(checks.filter((c) => !c.supported).map((c) => c.sentence))
  // An unbound sentence passes only when one text carries every figure
  // (the gate's inheritance rule); otherwise it needs the rescue too.
  for (const sentence of bound.sentences) {
    if (sentence.bound.length > 0) continue
    const own = checks.filter((c) => c.sentence === sentence.text)
    if (own.length === 0) continue
    const common = own.map((c) => new Set(c.supportedBy)).reduce<Set<number> | null>(
      (acc, set) => acc === null ? set : new Set([...acc].filter((n) => set.has(n))),
      null,
    )
    if (!common || common.size === 0) failing.add(sentence.text)
  }
  // Figures a bound sentence attributes to a paper that carries them only
  // where it cites other studies (its introduction, its discussion): a
  // second-hand figure is looked for first-hand in another paper before
  // it is judged (D4-15), and on a question that names a cohort, or asks
  // what to assume, a sentence left with a second-hand figure is removed
  // rather than annotated (D4-02, D4-12).
  const secondhandBySentence = new Map<string, string[]>()
  // The passage the audit located each figure in, by the marker of the
  // text it sits in: the second-hand judgement reads that passage, not
  // every occurrence of the number in the paper (loop 5 TFD: the paper's
  // own 22% in its results is not the introduction's "over 22% after
  // 2020" the answer repeated).
  const locatedFor = (sentenceText: string, renumber?: ReadonlyMap<number, number>) => {
    const own = bound.sentences.find((s) => s.text === sentenceText)
    const indices = own?.bound ?? []
    return checks
      .filter((c) => c.sentence === sentenceText && c.supported && c.passage !== undefined)
      .flatMap((c) =>
        c.supportedBy.map((position) => {
          const old = indices[position]
          const index = old === undefined ? undefined : renumber ? renumber.get(old) : old
          return index === undefined ? [] : [{ figure: c.figure, index, passage: c.passage! }]
        }).flat()
      )
  }
  for (const sentence of bound.sentences) {
    if (
      sentence.bound.length === 0 || failing.has(sentence.text) || declines.has(sentence.text) ||
      !statesResultFigure(sentence.text)
    ) continue
    const flagged = secondhandFigures(
      [{ text: sentence.text, bound: sentence.bound, located: locatedFor(sentence.text) }],
      texts,
    )
    if (flagged.length === 0) continue
    // A figure is second-hand for the sentence when every bound text that
    // carries it carries it second-hand.
    const figures = [...new Set(flagged.map((f) => f.figure))].filter((figure) => {
      const carrying = sentence.bound.filter((n) => {
        const t = texts.get(n)
        return t !== undefined && figureOffsets(figure, t).length > 0
      })
      return carrying.length > 0 &&
        carrying.every((n) => flagged.some((f) => f.figure === figure && f.index === n))
    })
    if (figures.length > 0) secondhandBySentence.set(sentence.text, figures)
  }
  const rescued: { figures: string[]; resourceId: string }[] = []
  const prepared = new Map<string, PreparedSource>()
  const poolEntries: { index: number; text: PreparedSource; resourceId: string; title: string }[] =
    []
  // The cited texts as pool entries of their own: a sentence the cohort
  // guard failed is looked up in the cohort paper the answer cited for
  // something else (loop 5 T2: "101 SUDEP cases and 199 controls" bound
  // to the wrong SUDEP paper, carried by the case-control paper).
  const citedEntries = [...usableTexts.entries()].map(([index, t]) => ({
    index,
    text: prepareIfNeeded(t, prepared),
    resourceId: resourceOfIndex.get(index) ?? '',
    title: candidates.find((c) => c.index === index)?.title ?? '',
  }))
  const prior = new Set(input.priorResourceIds ?? [])
  const named = (entry: { text: PreparedSource; title: string }) =>
    requiredNames.length === 0 ||
    requiredNames.some((name) =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
        `${entry.text.lower}\n${entry.title}`,
      )
    )
  if (failing.size > 0 || secondhandBySentence.size > 0) {
    const pool = await poolTexts(input, texts, cohort, terms)
    let nextIndex = Math.max(0, ...input.citations.map((c) => c.index)) + 1
    for (const entry of pool) {
      const existing = candidates.find((c) => c.resourceId === entry.resourceId)
      const index = existing ? existing.index : nextIndex++
      if (!existing) {
        candidates.push(syntheticCitation(index, { id: entry.resourceId, title: entry.title }))
      }
      resourceOfIndex.set(index, entry.resourceId)
      poolEntries.push({
        index,
        text: prepareIfNeeded(entry.text, prepared),
        resourceId: entry.resourceId,
        title: entry.title,
      })
      if (!entry.generated && !texts.has(index)) texts.set(index, entry.text)
    }
    // A resource the study guard would reject cannot lend a marker either
    // - unless an earlier turn cited it, or the sentence names that other
    // study itself ("in the EXPERIENCE pooled analysis" under a PERMIT
    // question): a figure carried from the last answer is checked against
    // the paper it came from (D3-06).
    for (const sentence of bound.sentences) {
      if (!failing.has(sentence.text)) continue
      const other = namesOtherStudy(sentence.text, terms)
      // Under a pin the pool is already the pinned papers, so the rescue
      // reads more of them and can never reach a neighbouring cohort's
      // paper; without one it is the retrieved set, name-tested as before.
      const poolFor = [
        ...citedEntries.filter((e) => !sentence.bound.includes(e.index)),
        ...poolEntries,
      ].filter((e) => other || prior.has(e.resourceId) || named(e))
      const found = rescueSentence({ sentence, pool: poolFor, lexicon, questionEntities })
      if (!found) continue
      sentence.bound = [found.index]
      checks = [...checks.filter((c) => c.sentence !== sentence.text), ...found.checks]
      rescued.push({ figures: found.checks.map((c) => c.figure), resourceId: found.resourceId })
      failing.delete(sentence.text)
    }
  }
  // A sentence the rescue bound to a retrieved paper is judged for
  // second-hand figures in that paper the same way (N06 in loop 4 replay:
  // a consortium figure found in another paper's introduction).
  for (const sentence of bound.sentences) {
    if (
      sentence.bound.length === 0 || failing.has(sentence.text) || declines.has(sentence.text) ||
      secondhandBySentence.has(sentence.text) || !statesResultFigure(sentence.text) ||
      !rescued.some((r) => resourceOfIndex.get(sentence.bound[0]!) === r.resourceId)
    ) continue
    const flagged = secondhandFigures([{ text: sentence.text, bound: sentence.bound }], texts)
    const figures = [...new Set(flagged.map((f) => f.figure))]
    if (figures.length > 0) secondhandBySentence.set(sentence.text, figures)
  }
  // The first-hand rescue for second-hand figures (D4-15): the cited
  // texts the sentence is not bound to, then the retrieved papers, in the
  // cohort first; a paper that carries every figure of the sentence
  // beside its claim among its own findings takes the marker.
  const secondhandRemoved: string[] = []
  if (secondhandBySentence.size > 0) {
    for (const sentence of bound.sentences) {
      const figures = secondhandBySentence.get(sentence.text)
      if (!figures) continue
      const other = namesOtherStudy(sentence.text, terms)
      const pool = [...citedEntries, ...poolEntries]
        .filter((e) => !sentence.bound.includes(e.index) && texts.has(e.index))
        .filter((e) => other || prior.has(e.resourceId) || named(e))
      let found: ReturnType<typeof rescueSentence> | undefined
      for (const entry of pool) {
        const attempt = rescueSentence({ sentence, pool: [entry], lexicon, questionEntities })
        if (!attempt) continue
        const still = secondhandFigures([{ text: sentence.text, bound: [entry.index] }], texts)
        if (still.some((f) => figures.includes(f.figure))) continue
        found = attempt
        break
      }
      if (found) {
        sentence.bound = [found.index]
        checks = [...checks.filter((c) => c.sentence !== sentence.text), ...found.checks]
        rescued.push({ figures: found.checks.map((c) => c.figure), resourceId: found.resourceId })
        secondhandBySentence.delete(sentence.text)
        continue
      }
      if (!namedCohort && !planning) continue
      checks = checks.map((c) =>
        c.sentence === sentence.text && figures.includes(c.figure)
          ? { ...c, supported: false, supportedBy: [], reason: 'secondhand' as const }
          : c
      )
      failing.add(sentence.text)
      secondhandRemoved.push(...figures)
      secondhandBySentence.delete(sentence.text)
    }
  }
  // The replacement (D3-10, D4-03, D4-04): a sentence still failing about
  // the question's cohort or a pinned paper is replaced by that paper's
  // own sentence only when the quote carries the sentence's own figure at
  // the sentence's own time point, beside the claim, under the check the
  // sentence itself would have needed - a figure the model got right and
  // cited to the wrong paper. A decline is never replaced, a second-hand
  // figure is never rescued by quotation, and at most one quote stands
  // in for a sentence.
  const replaced: { from: string; resourceId: string }[] = []
  const replacementPapers = [...cohort]
  for (const id of input.pinnedResourceIds ?? []) {
    // Under a designated cohort only its papers may stand in.
    if (designated && !cohort.has(id)) continue
    if (!replacementPapers.includes(id)) replacementPapers.push(id)
  }
  const questionOutcomes = outcomeFamilies(query)
  const quoted = new Set<string>()
  const MAX_REPLACEMENTS = 3
  const secondhandFailed = new Set(
    checks.filter((c) => !c.supported && c.reason === 'secondhand').map((c) => c.sentence),
  )
  if (failing.size > 0) {
    // What the answer already states: a quote that repeats it adds nothing.
    const stated = [
      ...new Set(
        bound.sentences.filter((s) => !failing.has(s.text)).flatMap((s) => extractNumbers(s.text)),
      ),
    ]
    for (const sentence of bound.sentences) {
      if (
        !failing.has(sentence.text) || declines.has(sentence.text) ||
        secondhandFailed.has(sentence.text)
      ) continue
      if (replaced.length >= MAX_REPLACEMENTS) break
      // The named papers first; the paper the sentence itself cited only
      // when no named paper answers.
      const papersOf = (indices: readonly number[]) =>
        indices.map((n) => resourceOfIndex.get(n))
          .filter((id): id is string => id !== undefined && !replacementPapers.includes(id))
      const own = papersOf([...sentence.bound, ...(sentence.original ?? [])])
      const block = papersOf(sentence.block ?? []).filter((id) => !own.includes(id))
      const cue = {
        ...replacementCue(sentence.text, lexicon, questionEntities, questionOutcomes, terms),
        exclude: stated,
      }
      let best: { quote: string; score: number; index: number; resourceId: string } | undefined
      const namedPapers = namesOtherStudy(sentence.text, terms) ? [] : replacementPapers
      const figuresOfSentence = extractNumbers(sentence.text).filter((f) =>
        /%|\./.test(f) || /^\d{3,}$/.test(f)
      )
      const sentenceWords = new Set(
        (sentence.text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) =>
          !GENERIC_SENTENCE_WORDS.has(w)
        ),
      )
      const aboutSentence = (id: string) => {
        const source = input.sources.find((s) => s.id === id)
        const record = `${source?.title ?? ''} ${source?.summary ?? ''}`.toLowerCase()
        const have = new Set(record.match(/[a-z][a-z-]{4,}/g) ?? [])
        let hits = 0
        for (const w of sentenceWords) if (have.has(w)) hits++
        return hits >= 2
      }
      const carrying = poolEntries
        .filter((e) =>
          !namedPapers.includes(e.resourceId) && !own.includes(e.resourceId) &&
          !block.includes(e.resourceId) && aboutSentence(e.resourceId) &&
          figuresOfSentence.some((f) => figurePattern(f).test(e.text.lower))
        )
        .map((e) => e.resourceId)
      for (const papers of [namedPapers, [...own, ...block, ...carrying]]) {
        const bar = papers === namedPapers ? 0 : 8
        const strict = papers !== namedPapers
        for (const id of papers) {
          const index = candidates.find((c) => c.resourceId === id)?.index
          const raw = index === undefined ? undefined : texts.get(index)
          if (index === undefined || !raw) continue
          const found = ownFigureSentence(raw, { ...cue, exclude: [...stated, ...quoted], strict })
          if (!found || found.score < bar || quoted.has(found.sentence)) continue
          // The same figure, at the same time point, beside the claim.
          if (
            !quoteCarriesClaim(
              found.sentence,
              sentence.text,
              lexicon,
              questionEntities,
              prepareIfNeeded(raw, prepared).pairs,
            )
          ) continue
          if (!best || found.score > best.score) {
            best = { quote: found.sentence, score: found.score, index, resourceId: id }
          }
        }
        if (best) break
      }
      if (!best) continue
      quoted.add(best.quote)
      replaced.push({ from: sentence.text, resourceId: best.resourceId })
      sentence.text = quoteSentence(best.quote)
      sentence.bound = [best.index]
      checks = [
        ...checks.filter((c) => c.sentence !== sentence.text),
        ...extractNumbers(sentence.text).map((figure) => ({
          figure,
          sentence: sentence.text,
          supported: true,
          supportedBy: [0],
        })),
      ]
      failing.delete(sentence.text)
    }
  }
  // The population the passage states (D3-07): a kept figure sentence
  // whose supporting passage gives the figure for "patients with
  // psychiatric comorbidity" carries that qualifier when neither the
  // sentence nor the question does.
  const qualified: string[] = []
  for (const sentence of bound.sentences) {
    if (failing.has(sentence.text) || sentence.bound.length === 0) continue
    // A sentence that states its own population ("the whole cohort") is
    // not requalified, and a sample size's passage frames the count, not
    // the claim.
    if (
      /\b(?:whole|entire|overall|total|full|all)\s+(?:cohort|population|patients|participants|analysis set|sample)\b/i
        .test(sentence.text)
    ) continue
    const normalised = normaliseFigures(sentence.text).toLowerCase()
    const own = checks.filter((c) =>
      c.sentence === sentence.text && c.supported && c.passage &&
      !isSampleSizeFigure(c.figure, normalised) && !/(?:month|week|year|day|hour)s$/.test(c.figure)
    )
    for (const check of own) {
      // The passage that carried the figure beside the claim frames it
      // (D3-07: "In patients with psychiatric comorbidity who switched
      // ... seizure freedom was 13.9%"); failing that, every occurrence
      // of the figure in the bound texts must open with the same frame.
      const boundTexts = sentence.bound.map((n) => texts.get(n)).filter((t): t is string =>
        t !== undefined
      )
      const qualifiers = boundTexts.map((t) =>
        qualifierForFigure(check.figure, prepareIfNeeded(t, prepared))
      )
      const qualifier = populationQualifier(check.passage!) ??
        (qualifiers.length > 0 && qualifiers.every((q) => q === qualifiers[0])
          ? qualifiers[0]
          : undefined)
      if (!qualifier) continue
      if (carriesQualifier(sentence.text, qualifier) || carriesQualifier(query, qualifier)) continue
      const before = sentence.text
      sentence.text = withQualifier(sentence.text, qualifier)
      checks = checks.map((c) => c.sentence === before ? { ...c, sentence: sentence.text } : c)
      qualified.push(qualifier)
      break
    }
  }
  // The gate runs whenever a cited text was read: a paper that never names
  // the question's cohort is judged like any other, never left to a
  // footnote (the loop 4 C4 replay: every cited text failed the name check).
  // A MARKER MAY ONLY NAME A PAPER THAT CARRIES THE FIGURE. A sentence with
  // one marker already gets this from the check itself, which reads only the
  // text of the paper that marker names; "28% of patients experienced a
  // relapsing course.[1]" survived because the anti-NMDAR paper was in the
  // grounding set and lent its marker, which the pin now prevents (D7-01).
  // What is left to decide is a sentence bound to several papers: the
  // per-sentence check knows which of them each figure's passage was located
  // in, and every other marker is dropped, so a sentence bound to three
  // papers where one carries the figure no longer reads as three sources for
  // it (loop 6 D6-12). A marker whose text could not be read stays:
  // unverifiable is not unsupported.
  for (const sentence of bound.sentences) {
    if (sentence.bound.length < 2) continue
    const own = checks.filter((c) => c.sentence === sentence.text)
    if (own.length === 0 || own.some((c) => !c.supported)) continue
    // `supportedBy` indexes the texts the check was given, which is
    // `sentence.bound` with the unfetchable ones dropped.
    const withText = sentence.bound.filter((n) => usableTexts.has(n))
    if (withText.length < 2) continue
    const carrying = withText.filter((_, i) => own.every((c) => c.supportedBy.includes(i)))
    if (carrying.length === 0 || carrying.length === sentence.bound.length) continue
    sentence.bound = sentence.bound.filter((n) => !usableTexts.has(n) || carrying.includes(n))
  }
  const gateRan = texts.size > 0 || rescued.length > 0
  const gated = gateRan ? gateFigures(bound, checks, markerOfText, candidates) : {
    text: bound.text,
    sentences: bound.sentences,
    citations: bound.citations,
    renumber: new Map<number, number>(),
    removed: [],
    inherited: 0,
    blanked: [],
  }
  const figuresUnsupported = gateRan
    ? []
    : [...new Set(checks.filter((c) => !c.supported).map((c) => c.figure))]
  const figuresRemoved = [...new Set(gated.removed.flatMap((r) => r.figures))]
  // A paper is named as carrying a removed figure only where one of the
  // removed sentence's own words sits beside it (D4-19).
  const removedWords = gated.removed.flatMap((r) =>
    r.text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []
  ).filter((w) => !GENERIC_SENTENCE_WORDS.has(w))
  const foundIn = figuresRemoved.length > 0
    ? figuresFoundIn(
      figuresRemoved,
      [
        ...[...texts.entries()].map(([index, t]) => ({
          title: candidates.find((c) => c.index === index)?.title ?? '',
          text: prepareIfNeeded(t, prepared),
        })),
        ...poolEntries.map((e) => ({ title: e.title, text: e.text })),
      ],
      removedWords,
    ).filter((t) => t.length > 0)
    : []
  // The gate renumbered what it kept: the texts follow the new numbering.
  let citations = gated.citations
  for (const citation of citations) {
    const old = oldIndexByResource.get(citation.resourceId) ??
      candidates.find((c) => c.resourceId === citation.resourceId)?.index
    const t = old === undefined ? undefined : texts.get(old)
    if (t !== undefined) textsByNew.set(citation.index, t)
  }
  let text = gated.text
  // A sentence of the gated text, rewritten in place; the checks follow it.
  const rewrite = (sentence: typeof gated.sentences[number], next: string) => {
    const before = sentence.text
    const pattern = new RegExp(before.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!pattern.test(text)) return
    text = text.replace(pattern, next)
    sentence.text = next
    checks = checks.map((c) => c.sentence === before ? { ...c, sentence: next } : c)
  }
  // Two populations stitched into one answer are named for what they are
  // (review loop 5 D5-12, TDE): under a designated
  // cohort, a planning question or a pin holding several of one cohort's
  // papers, each result sentence that names no study of its own is opened
  // with the paper it comes from - "In *Infradian
  // rhythms ... in healthy adults*, 70% (369/525) had ..." beside "In
  // *Multiday cycles of heart rate ...*, participants with epilepsy
  // documented 3,619 seizures".
  if (designated || planning) {
    const resultSentences = gated.sentences.filter((s) =>
      s.bound.length > 0 && statesResultFigure(s.text) && !/^\s*The paper/.test(s.text) &&
      !isDeclineSentence(s.text)
    )
    const papers = new Set(
      resultSentences.map((s) => citations.find((c) => c.index === s.bound[0])?.resourceId)
        .filter((id): id is string => id !== undefined),
    )
    // A pin of several papers is several studies under one name: the
    // Australian consortium has four papers and the answer must say which
    // one a figure comes from, even when it draws on only one of them, so
    // a sub-study's 84% is never read as the cohort's headline (D7-02).
    if (papers.size >= 2 || (pinScope.size >= 2 && papers.size >= 1)) {
      for (const sentence of resultSentences) {
        const citation = citations.find((c) => c.index === sentence.bound[0])
        if (!citation || namesOtherStudy(sentence.text, terms)) continue
        const label = studyLabel(citation.title)
        if (sentence.text.toLowerCase().includes(label.toLowerCase())) continue
        if (/^\s*In \*/.test(sentence.text)) continue
        // The question's own designator opening the sentence ("In the
        // multiday heart-rate cycle cohort, ...") is what the label
        // corrects: it goes.
        const body = sentence.text.replace(
          /^\s*(?:In|Within|Across|From)\s+the\s+(?:[\w-]+\s+){0,6}?(?:cohort|study|trial|analysis|analyses|register|registry|paper)\s*,\s*/i,
          '',
        )
        const first = body.match(/^\s*([A-Za-z][\w'-]*)/)?.[1] ?? ''
        const keepCase = /^[A-Z]{2,}|^[a-z]+[A-Z]|^[A-Z][a-z]+[A-Z]/.test(first)
        const opened = keepCase ? body : body.charAt(0).toLowerCase() + body.slice(1)
        rewrite(sentence, `In *${label}*, ${opened}`)
      }
    }
  }
  // The paper's own figure for the question's outcome, offered after a
  // removal when the model's figure differs from it (
  // review loop 5 D5-14): the consortium paper's "154 (67%)" after an
  // "80% (n = 231)" no paper carries. Named for what it is, cited, at most
  // one per removed sentence and two per answer; never a substitute for
  // the removed sentence, which stays removed.
  const offered: string[] = []
  if (gated.removed.length > 0 && questionOutcomes.length > 0) {
    const stated = new Set(extractNumbers(text.replace(/\s*\[\d{1,3}\]/g, '')))
    for (const removed of gated.removed) {
      if (offered.length >= 2) break
      if (
        removed.reason === 'conclusion' || removed.reason === 'secondhand' ||
        removed.reason === 'pvalue'
      ) continue
      const cue = {
        ...replacementCue(removed.text, lexicon, questionEntities, questionOutcomes, terms),
        exclude: [...stated, ...removed.figures],
        strict: true,
      }
      const timepoints = timepointsInMonths(normaliseFigures(removed.text))
      const carrying = poolEntries
        .filter((e) =>
          !replacementPapers.includes(e.resourceId) &&
          removed.figures.some((f) => figurePattern(f).test(e.text.lower))
        )
        .map((e) => e.resourceId)
      for (const id of [...replacementPapers, ...carrying]) {
        const index = candidates.find((c) => c.resourceId === id)?.index
        const raw = index === undefined ? undefined : texts.get(index)
        if (!raw) continue
        const found = ownFigureSentence(raw, cue)
        if (!found || found.score < 4) continue
        // A result the gate removed is never printed back verbatim two
        // lines under its own removal notice (
        // review loop 7 D7-10: "the figures 3.6, 2.9, 4.4 could not be
        // verified", then the same three quoted from the same paper). A
        // sample size is not that: "Data from 1,674 participants ... of
        // which 395 (23.6%) were 50% responders" is the answer to the
        // question the removed 22% got wrong, and the notice no longer
        // names a figure the body carries, so quoting it contradicts
        // nothing (loop 8 D8-01, D8-02).
        if (
          removed.figures.filter((f) => /%|\./.test(f)).some((f) =>
            figurePattern(f).test(found.sentence)
          )
        ) continue
        // The offered sentence must be about what the question asked, not
        // only about the same outcome noun: a lacosamide retention rate is
        // not an answer under a question about implanted devices (D7-10).
        if (
          terms.length > 0 &&
          !terms.some((t) => {
            const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
            return re.test(found.sentence) || re.test(raw.slice(0, 4000))
          })
        ) continue
        if (!outcomeFamilies(found.sentence).some((o) => questionOutcomes.includes(o))) continue
        if (timepoints.length > 0) {
          const have = timepointsInMonths(normaliseFigures(found.sentence))
          if (
            have.length === 0 ||
            !timepoints.some((s) => have.some((w) => Math.abs(s - w) <= 0.5 + 0.08 * s))
          ) continue
        }
        let marker = citations.find((c) => c.resourceId === id)?.index
        if (marker === undefined) {
          marker = citations.length + 1
          citations.push({
            index: marker,
            resourceId: id,
            title: candidates.find((c) => c.resourceId === id)?.title ?? '',
          })
          textsByNew.set(marker, raw)
        }
        const quote = quoteSentence(found.sentence).replace(/^The paper itself reports: /, '')
        offered.push(`*For the outcome asked about, [${marker}] itself reports: ${quote}*`)
        for (const f of extractNumbers(found.sentence)) stated.add(f)
        break
      }
    }
  }
  // Before declining, read the paper the decline would name (docs/persona-
  // reports/review loop 8 D8-11, and the D3-02 regression it reopened).
  // The gate has emptied the answer, and the figures it removed sit in a
  // retrieved paper: JOB5's "The SMR was 3.6 (95% CI 2.9-4.4) in those
  // with a psychiatric disorder" is one sentence of the paper its own
  // decline named, and E1's relapse rate the same. Quoted and cited, that
  // sentence is the paper's own wording rather than the model's claim, so
  // it stands where a refusal stood - under the same rules the offer after
  // a removal follows, plus the requirement that it carry what the answer
  // tried to state.
  let rescuedAnswer = false
  if (gated.sentences.length === 0 && gated.removed.length > 0 && !leadSentence(text)) {
    const entries = [...citedEntries, ...poolEntries].filter((e) => named(e))
    for (const removed of gated.removed) {
      if (rescuedAnswer) break
      if (removed.reason === 'secondhand' || removed.reason === 'conclusion') continue
      // Only a figure distinctive enough to identify the finding: a
      // confidence level is in every paper, and matching one would quote
      // whatever sentence happened to carry an interval.
      const distinctive = removed.figures.filter((f) =>
        (/%|\./.test(f) || /^\d{3,}$/.test(f)) && !/^(?:90|95|99)%$/.test(f)
      )
      if (distinctive.length === 0) continue
      for (const entry of entries) {
        const raw = texts.get(entry.index)
        if (!raw) continue
        const found = rescueQuote(entry.text, distinctive, questionOutcomes)
        if (!found) continue
        let marker = citations.find((c) => c.resourceId === entry.resourceId)?.index
        if (marker === undefined) {
          marker = citations.length + 1
          citations.push({ index: marker, resourceId: entry.resourceId, title: entry.title })
          textsByNew.set(marker, raw)
        }
        const quote = quoteSentence(found).replace(/^The paper itself reports: /, '')
        text = '*No cited passage carries the answer as it was generated, so the sentence the ' +
          `paper reports it in is quoted instead.*\n\n${quote}[${marker}]`
        rescuedAnswer = true
        break
      }
    }
  }
  // A protocol's recruitment target is not an enrolment (docs/persona-
  // reports/review loop 5 D5-11): a kept sentence that states a planned
  // sample from a protocol paper is said to be that, and the results paper
  // the answer also cites gives its enrolment in its own words.
  let protocolNote: string | undefined
  const PLANNED =
    /\b(?:aim(?:s|ed)? to (?:recruit|enrol|enroll|include)|plan(?:s|ned)? to|target(?:ed|s)?\b|will be (?:enrolled|recruited|included)|estimated (?:that|to|follow)|anticipated|expected to|sample size (?:of|was|is|calculation))/i
  // A sentence that states a cohort in the past tense ("the study enrolled
  // approximately 450 participants") over a citation to a protocol is the
  // same defect without the giveaway wording, so the enrolment shape is
  // read as well as the planning one (loop 6 D6-10). Whether the cited
  // paper is a protocol is settled below, from the paper itself.
  const ENROLMENT =
    /\b(?:enrol(?:l)?ed|recruited|randomi[sz]ed|included|participants|patients|subjects)\b/i
  for (const sentence of gated.sentences) {
    if (!PLANNED.test(sentence.text) && !ENROLMENT.test(sentence.text)) continue
    if (!extractNumbers(sentence.text).some((f) => /^\d{2,}$/.test(f))) continue
    const marker = sentence.bound[0]
    if (marker === undefined) continue
    const source = textsByNew.get(marker)
    const title = citations.find((c) => c.index === marker)?.title ?? ''
    if (!source) continue
    // A protocol says so in its masthead or title, or writes its methods in
    // the future tense ("450 eligible patients will be enrolled").
    const isProtocol = (t: string, name: string) =>
      studyDesignOf(t) === 'a trial protocol' || /\bprotocol\b/i.test(name) ||
      (t.slice(0, 8000).match(
          /\bwill be (?:enrolled|recruited|included|conducted|collected)\b/gi,
        ) ??
          []).length >= 2
    if (!isProtocol(source, title)) continue
    let results: { index: number; sentence: string } | undefined
    for (const c of citations) {
      if (c.index === marker) continue
      const t = textsByNew.get(c.index)
      if (!t || isProtocol(t, c.title)) continue
      const found = ownFigureSentence(t, {
        anchors: [],
        outcomes: [],
        words: ['enrolled', 'recruited', 'eligible', 'included', 'participants'],
        wantCount: true,
        kinds: { share: false, count: true, ratio: false },
      })
      if (found) {
        results = { index: c.index, sentence: found.sentence }
        break
      }
    }
    const lead = `*[${marker}] is the study protocol: the numbers it gives are the planned ` +
      'recruitment, not the enrolment.'
    protocolNote = results
      ? `${lead} The results paper [${results.index}] reports: ${
        quoteSentence(results.sentence).replace(/^The paper itself reports: /, '')
      }*`
      : `${lead}*`
    break
  }
  // A wrong denominator is never rewritten in the body: the check treats
  // the n a sentence pairs with a share as part of the figure, so a
  // sentence whose pairing the paper contradicts is removed and said so,
  // and the helper below only adds an n the located passage gives in the
  // figure's own bracket or cell (loop 5 D5-03).
  // A figure the cited paper carries only in its introduction or
  // discussion is that paper citing other studies: said so in one line,
  // and never asked for a denominator (D3-08, D3-13).
  const secondhand = secondhandFigures(
    markedSentences(text).map((m) => ({
      ...m,
      located: gated.sentences.some((s) => s.text === m.text)
        ? checks
          .filter((c) => c.sentence === m.text && c.supported && c.passage !== undefined)
          .flatMap((c) =>
            m.bound.map((index) => ({ figure: c.figure, index, passage: c.passage! }))
          )
        : [],
    })),
    textsByNew,
  )
  const secondhandFigureSet = new Set(secondhand.map((f) => f.figure))
  // The cited paper's own finding follows a second-hand figure when it has
  // one for the same claim: "relapses occur in 14%-35%" from the
  // introduction, then the cohort's own "16 (30%) patients experienced at
  // least one relapse", quoted and cited (D3-10, D2-04).
  const ownFindings: string[] = []
  if (secondhand.length > 0) {
    const stated = new Set(extractNumbers(text.replace(/\s*\[\d{1,3}\]/g, '')))
    for (const marked of markedSentences(text)) {
      const own = secondhand.filter((f) =>
        marked.bound.includes(f.index) && extractNumbers(marked.text).includes(f.figure)
      )
      if (own.length === 0) continue
      const index = own[0]!.index
      const source = textsByNew.get(index)
      if (!source) continue
      const flagged = own.map((f) => f.figure)
      const cue = {
        ...replacementCue(marked.text, lexicon, questionEntities, outcomeFamilies(query)),
        exclude: [...stated],
        // The paper's own finding must be of the same kind as the figure
        // it replaces: a rate for a rate, never a sample count.
        kinds: {
          share: flagged.some((f) => f.endsWith('%')),
          count: false,
          ratio: false,
          decimal: flagged.some((f) => /\d\.\d/.test(f)),
        },
      }
      if (cue.outcomes.length === 0) continue
      // The finding must be about what the question asked (D4-14): the
      // question's outcome when it named one, and not an outcome the
      // answer already states first-hand from the same paper.
      if (questionOutcomes.length > 0 && !cue.outcomes.some((o) => questionOutcomes.includes(o))) {
        continue
      }
      const alreadyStated = markedSentences(text).some((s) =>
        s.text !== marked.text && s.bound.includes(index) &&
        extractNumbers(s.text).length > 0 &&
        outcomeFamilies(s.text).some((o) => cue.outcomes.includes(o)) &&
        !secondhand.some((f) => f.index === index && extractNumbers(s.text).includes(f.figure))
      )
      if (alreadyStated) continue
      const found = ownFigureSentence(source, cue)
      if (!found) continue
      const quote = quoteSentence(found.sentence).replace(
        /^The paper itself reports:/,
        "The paper's own finding:",
      )
      const pattern = new RegExp(
        `${marked.text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:\\s*\\[\\d{1,3}\\])*)`,
      )
      if (!pattern.test(text)) continue
      // A sentence the answer itself flags as second-hand never leads the
      // answer: the paper's own finding takes its place at the front and
      // the flagged sentence follows it (loop 6 D6-07).
      const leads = leadSentence(text) === marked.text.trim()
      text = leads
        ? text.replace(pattern, (m) => `${quote}[${index}] ${m}`)
        : text.replace(pattern, (m) => `${m} ${quote}[${index}]`)
      ownFindings.push(found.sentence)
      for (const f of extractNumbers(found.sentence)) stated.add(f)
    }
  }
  // The drug checks read the medication entries of the lexicon only: a
  // syndrome name in the same list is never "contraindicated".
  const medications = lexicon.filter(isMedicationTerm)

  // Contraindications the sources never state are removed (safety variant,
  // or any treatment-decision question).
  let contraindicationsUnsupported: string[] = []
  if (variant === 'safety' || isTreatmentDecisionQuestion(query)) {
    // The cited papers whole, in the answer's own numbering: a safety verb
    // binds to the medication nearest it in the passage, so the check
    // reads the resource rather than grepping for the word, and the note
    // can cite the passage that speaks of the drug more weakly (D7-03).
    const stripped = stripUnsupportedSafetyClaims(
      text,
      [...textsByNew.entries()].map(([index, t]) => ({ index, text: t })),
      medications,
    )
    text = stripped.text
    contraindicationsUnsupported = stripped.unsupported
  }

  // "X and colleagues" over a paper X did not write is rewritten to the
  // paper's own first author.
  const authorsOf = (id: string) => byId.get(id)?.authors ?? catalogueById.get(id)?.authors
  const attributed = correctAttributions(text, input.authors ?? [], citations, authorsOf)
  text = attributed.text
  const attributionsCorrected = [...new Set(attributed.fixes.map((f) => f.surname))]

  // Proportions stated without their n, and the n the located passage
  // gives in the figure's own bracket or cell.
  const denominators = denominatorsMissing(
    gated.sentences.map((s) => ({
      text: s.text,
      located: checks
        .filter((c) => c.sentence === s.text && c.supported && c.passage !== undefined)
        .map((c) => ({ figure: c.figure, index: s.bound[0] ?? 0, passage: c.passage! })),
    })),
  ).filter((d) => !secondhandFigureSet.has(d.figure))

  // The effect size the passage carries when the answer paraphrased it away.
  const effectSizes = effectSizesFor(
    query,
    text,
    [...textsByNew.entries()]
      .filter(([index]) => {
        const id = citations.find((c) => c.index === index)?.resourceId
        return cohort.size === 0 || (id !== undefined && cohort.has(id))
      })
      .map(([index, t]) => ({ index, text: t })),
    lexicon,
  )

  // Years from resource metadata, then the texts. Every retrieved source
  // counts, not only the cited ones: a recency answer names the newest
  // paper retrieval found even when the platform bound no marker to it.
  const metadataYears = input.sources
    .flatMap((s) => [s.year, s.published?.slice(0, 4)])
    .filter((y): y is string => typeof y === 'string' && y.length >= 4)
  const missingYears = allTexts.length > 0 ? yearsUnsupported(text, metadataYears, allTexts) : []

  // Drugs the sources flag that a which-drug answer left out.
  const missingDrugs = variant === 'safety' && isTreatmentSelectionQuestion(query)
    ? drugsMissingFromAnswer(
      text,
      drugsFlaggedInSources(
        [...textsByNew.entries()].map(([index, t]) => ({ index, text: t })),
        medications,
      ),
    )
    : []

  // Study designs for the clinical variant: each source's own description,
  // named where the first sentence citing it did not.
  const designs: { index: number; design: string }[] = []
  if (variant === 'safety') {
    for (const citation of citations) {
      const source = textsByNew.get(citation.index)
      if (!source) continue
      const first = gated.sentences.find((s) => s.bound.includes(citation.index))
      if (!first || DESIGN_WORD.test(first.text)) continue
      const design = studyDesignOf(source)
      if (design) designs.push({ index: citation.index, design })
    }
  }
  // Study design first, on every intent: a modelling, simulation or
  // preclinical paper is named as such before its findings are read.
  const kindOf = (id: string) => byId.get(id)?.kind ?? catalogueById.get(id)?.kind
  const lead = designLead(
    citations.map((c) => ({
      index: c.index,
      title: c.title,
      ...(kindOf(c.resourceId) ? { kind: kindOf(c.resourceId) } : {}),
      ...(textsByNew.has(c.index) ? { text: textsByNew.get(c.index) } : {}),
    })),
    gated.sentences,
  )
  if (lead && text.trim()) text = `${lead}\n\n${text}`

  // The corpus boundary for a study the question names.
  const citedTitles = citations.map((c) => c.title)
  // A study the ANSWER introduced that neither the collection holds nor
  // any cited text mentions has nothing behind it: with the bibliographies
  // cut, a reference title can no longer ground it, and the sentence goes
  // rather than standing uncited (loop 6 D6-02, the RANSOM Study).
  const questionStudy = namedStudy(query)
  const unheldIntroduced = namedStudies(text).filter((study) => {
    if (study === questionStudy) return false
    const head = study.split(' ')[0]!
    const re = new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return !citedTitles.some((t) => re.test(t)) &&
      !(input.catalogue ?? []).some((r) => re.test(r.title)) &&
      ![...textsByNew.values()].some((t) => re.test(t))
  })
  const strippedStudies = stripUnheldStudyClaims(text, unheldIntroduced)
  text = strippedStudies.text
  // A citation whose only sentence went with the removal leaves the answer
  // with it: the chips and the "n cited" count describe the text the reader
  // is shown (D7-07).
  if (strippedStudies.removed.length > 0) {
    const used = new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))
    citations = citations.filter((c) => used.has(c.index))
  }
  const boundary = strippedStudies.removed.length > 0 ? undefined : unheldStudyNote(
    query,
    citedTitles,
    (input.catalogue ?? []).map((r) => r.title),
    text,
    (() => {
      const study = questionStudy ?? namedStudies(text)[0]
      if (!study) return true
      const head = study.split(' ')[0]!
      const re = new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      return [...textsByNew.values()].some((t) => re.test(t))
    })(),
  )

  const scoped = input.authors && input.authors.length > 0
    ? `*Retrieval was limited to the ${
      input.authors.map((a) =>
        `${a.resourceIds.length} ${
          a.resourceIds.length === 1 ? 'resource' : 'resources'
        } authored by ${a.surname}`
      ).join(
        ' and ',
      )
    } in this collection.*`
    : undefined

  // A table cell that states an analysis set or "not reported" where the
  // column asked for a figure is marked "not verified" like any other cell
  // the check could not verify, so the table reads the way How this works
  // describes it (review loop 6 D6-16a).
  const unreadableCells = markUnverifiableCells(text)
  text = unreadableCells.text

  // A study-claim removal that leaves nothing but its own notes is not an
  // answer (review loop 7 D7-07, D7-08): the honest
  // decline, with the closest matches, stands in its place rather than a
  // page of removal notices. A table still counts as a body, so a reformat
  // answer is not declined; a check's own note about what the sources do
  // not say is an answer in itself and is left alone.
  const bodyRemains = leadSentence(text) !== '' || /^\s*\|/m.test(text)
  const emptiedByRemoval = strippedStudies.removed.length > 0 && !bodyRemains

  // Removal is real (review loop 8 D8-02). The gate
  // has already swept every unverified repeat out of the text; what is
  // still printed here is a figure that passed its own check in the
  // sentence that carries it, so the notice stops naming it and the audit
  // reports only what actually left the answer. The body is read before
  // the addendum is appended, because the notice itself names them.
  // A rescued answer says in its own lead that the generated sentence was
  // not carried and the paper's sentence stands in its place, so a removal
  // note that adds no figure to that adds nothing (D8-11).
  const removedForNote = reconcileRemovals(gated.removed, text)
    .filter((r) => !rescuedAnswer || r.figures.length > 0)
  const figuresRemovedFromText = [...new Set(removedForNote.flatMap((r) => r.figures))]

  if (text.trim()) {
    text += auditAddendum({
      missingDrugs,
      missingNumbers: figuresUnsupported,
      missingYears,
      denominators,
      designs,
      attributions: attributed.fixes,
      notes: [
        removalNote(removedForNote, {
          foundIn,
          replaced: replaced.length,
        }),
        blankedNote(gated.blanked, unreadableCells.marked),
        uncitedNote(gated.sentences) || undefined,
        ...offered,
        protocolNote,
        effectSizeNote(effectSizes),
        boundary,
        scoped,
        secondhandNote(secondhand),
        attributedNote(
          attributedElsewhere(
            markedSentences(text),
            (index) => {
              const id = citations.find((c) => c.index === index)?.resourceId
              return id === undefined ? undefined : authorsOf(id)
            },
          ),
        ),
      ].filter((n): n is string => n !== undefined),
    })
  }

  // Each cited resource's card passage: the paragraph that carries the
  // claims bound to it, from retrieval's paragraphs (paged) or the text.
  const sources = input.sources.map((source) => {
    const citation = citations.find((c) => c.resourceId === source.id)
    if (!citation) return source
    const sentences = gated.sentences.filter((s) => s.bound.includes(citation.index)).map((s) =>
      s.text
    )
    const extracted = textsByNew.get(citation.index)
    const choice = choosePassage(
      sentences,
      source.passages ?? [],
      extracted ? paragraphsOf(extracted).slice(0, 400) : [],
      lexicon,
    )
    if (!choice) return source
    const { matchedPage: _page, referenceChunk: _reference, ...rest } = source
    return {
      ...rest,
      matchedPassage: choice.passage,
      ...(choice.page !== undefined ? { matchedPage: choice.page } : {}),
      matchedField: 'body' as const,
    }
  })

  return {
    text,
    citations,
    sources,
    emptied: !rescuedAnswer &&
      ((gated.removed.length > 0 && gated.sentences.length === 0) || emptiedByRemoval),
    audit: {
      type: 'audit',
      figuresChecked: checks.length,
      figuresUnsupported,
      yearsUnsupported: missingYears,
      contraindicationsUnsupported,
      sentencesChecked: bound.sentences.length,
      sentencesCited: Math.min(
        bound.sentences.length,
        gated.sentences.filter((s) => s.bound.length > 0).length + (rescuedAnswer ? 1 : 0),
      ),
      denominatorsMissing: denominators.map((d) => d.figure),
      attributionsCorrected,
      sentencesRemoved: gated.removed.length + strippedStudies.removed.length,
      figuresRemoved: figuresRemovedFromText,
      figuresRescued: [...new Set(rescued.flatMap((r) => r.figures))],
      sentencesReplaced: replaced.length,
      foundIn,
      figuresSecondhandRemoved: [...new Set(secondhandRemoved)],
    },
  }
}
