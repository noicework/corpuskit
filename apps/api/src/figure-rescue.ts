/**
 * The gate's second look (review loop 3 D3-01,
 * D3-02, D3-07, D3-10). The audit only ever saw the paragraphs the
 * platform happened to cite, so a correct figure from a retrieved but
 * uncited paper was "unverifiable" and withheld, while a wrong-cohort
 * figure that sat in a cited paragraph passed with a clean badge. Three
 * deterministic passes fix both directions:
 *
 *  - the cohort guard: when the question names a cohort, study or drug
 *    that titles some of the retrieved papers, a figure sentence may cite
 *    only those papers unless it names another study itself;
 *  - the rescue: before a sentence is withheld, its figures are looked up
 *    in the full text of every retrieved resource, the papers cited in the
 *    session's earlier turns and the data-augmentation summary and key
 *    takeaways, and a resource that carries every figure beside the claim
 *    lends the sentence its marker;
 *  - the replacement: a removed sentence about a named paper is replaced
 *    by that paper's own figure sentence, quoted verbatim and cited.
 *
 * Everything here is string matching over the platform's extracted texts
 * and DA fields; no model is in the loop.
 */
import type { Citation, ScoredResource } from '@research-portal/core'
import {
  abbreviationPairs,
  bracketSpan,
  claimFeatures,
  claimWindow,
  extractNumbers,
  type FigureCheck,
  figurePattern,
  figureSupportedBy,
  isSampleSizeFigure,
  locateFigure,
  normaliseFigures,
  normaliseGlyphs,
  outcomeFamilies,
  type PreparedSource,
  prepareSource,
  termForms,
  timepointsInMonths,
} from './answer-audit.ts'
import type { BoundSentence } from './citation-binding.ts'
import {
  citesEarlierWork,
  hasBodyHeadings,
  inTableOrLegend,
  sectionAt,
  sectionSpans,
} from './secondhand.ts'
import { looksLikeReferencePassage } from './citation-binding.ts'
import { isMedicationTerm } from './ask-prequeries.ts'

// ---------------------------------------------------------------------------
// The cohort the question names
// ---------------------------------------------------------------------------

/** Words after which a name is a cohort, study or analysis designator. */
const DESIGNATOR =
  /(?:\b(?:[Ii]n|[Ff]rom|[Oo]f|[Ff]or|[Aa]cross|[Ww]ithin)\s+)?\b[Tt]he\s+((?:[A-Z][\w-]*|anti-[A-Z]\w*|[a-z]+-[A-Z][A-Z0-9]+[\w-]*)(?:\s+[\w-]+){0,3}?)\s+(?:cohort|trial|study|analysis|analyses|register|registry|consortium|series|subgroup|programme|program|survey)\b/g

/**
 * The names a question uses to designate a cohort or study: "the LGI1
 * encephalitis cohort", "the PERMIT pooled analysis", "the BREATHS trial",
 * "the video-EEG monitoring mortality cohort", plus the terms that pinned
 * a paper and every medication the question names from the lexicon (a
 * drug's figure may only come from a paper about that drug, and a
 * comparison of two drugs admits both drugs' papers). An acronym or a
 * gene-like symbol inside the designator is the key ("LGI1"); a token that
 * carries one keeps its whole form ("video-eeg"); otherwise the capitalised
 * word that opens it ("Melbourne"). Lower-cased, deduplicated.
 */
export function cohortTerms(
  query: string,
  pinnedTerms: readonly string[] = [],
  lexicon: readonly string[] = [],
): string[] {
  const out: string[] = []
  const add = (term: string) => {
    const t = term.toLowerCase().replace(/^anti-/, '')
    if (t.length < 3 || NOT_A_COHORT.has(t)) return
    if (!out.includes(t)) out.push(t)
  }
  const lower = query.toLowerCase()
  const drugs = lexicon.filter((t) =>
    isMedicationTerm(t.toLowerCase()) && t.length >= 5 &&
    new RegExp(`(?:^|[^a-z0-9])${escape(t.toLowerCase())}(?=$|[^a-z0-9])`).test(lower)
  )
  // A question that sets two studies side by side ("compare the SUDEP
  // case-control study with the psychiatric comorbidity and mortality
  // study") designates no single cohort: each sentence may cite either.
  const designators = query.match(
    /\b(?:the|a)\s+[\w-]+(?:\s+[\w-]+){0,4}?\s+(?:study|trial|cohort|analysis|analyses|register|registry)\b/gi,
  ) ?? []
  if (designators.length >= 2) {
    for (const term of [...pinnedTerms, ...drugs]) add(term)
    return out
  }
  for (const m of query.matchAll(DESIGNATOR)) {
    const phrase = m[1]!
    const token = phrase.match(/\b[a-z]+-[A-Z][A-Z0-9]+\b/)
    const symbol = phrase.match(/\b(?:anti-)?[A-Z][A-Z0-9-]{2,}\b/)
    if (token) add(token[0])
    else if (symbol) add(symbol[0])
    else add(phrase.split(/\s+/)[0]!)
  }
  for (const term of [...pinnedTerms, ...drugs]) add(term)
  return out
}

/**
 * A question that asks what to assume, plan for or expect: "what 12-month
 * retention rate should I assume", "what placebo responder rate should I
 * plan for". Its lead figure must be a paper's own result, never a ceiling
 * the paper quotes from other studies (D4-12).
 */
export function isPlanningQuestion(query: string): boolean {
  return /\b(?:should (?:i|we)\s+(?:\w+\s+){0,6}?(?:assume|plan|expect|use|budget)|plan for|to assume|to expect|sample size)\b/i
    .test(query)
}

/**
 * The generator's own scaffolding, removed before a sentence is judged
 * (D4-14): a trailing "Cited sources from the provided context." line and
 * the "; no denominator stated" clause the denominator instruction
 * provoked inside a bracket. The "(inference)" mark stays: the surface
 * renders it as a flag.
 */
export function stripTemplateLeaks(text: string): string {
  return text
    .replace(/\s*\bCited sources(?: from| in) the provided context\.?(?=\s|$)/gi, '')
    .replace(/\s*[;,]\s*no denominator (?:is |was )?(?:stated|given|reported|provided)(?=\))/gi, '')
    .replace(/\s*\((?:no denominator (?:is |was )?(?:stated|given|reported|provided))\)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Designators that describe every paper rather than one, and acronyms that are methods, not cohorts. */
const NOT_A_COHORT = new Set([
  // Topics that name a field, not a cohort: "the SUDEP case-control study".
  'sudep',
  'pnes',
  'ige',
  'jme',
  'gge',
  'dee',
  'tle',
  'mtle',
  'gtcs',
  'qol',
  'covid',
  'covid-19',
  'eeg',
  'mri',
  'pet',
  'seeg',
  'asm',
  'asms',
  'rct',
  'ilae',
  'who',
  'ich',
  'whole',
  'entire',
  'same',
  'this',
  'that',
  'each',
  'real-world',
  'australian',
  'international',
  'pooled',
  'overall',
  'full',
  'total',
])

/** Whether a title, or a paper's DA summary, carries a cohort term as a whole word. */
export function carriesCohortTerm(text: string, term: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escape(term)}(?=$|[^a-z0-9])`, 'i').test(text)
}

/**
 * How an answer names a paper in its prose when it has to say which paper
 * a figure comes from (review loop 5 D5-12): the
 * study acronym its title carries ("PERMIT", "EXPERIENCE", "UMPIRE"), or
 * the title itself.
 */
export function studyLabel(title: string): string {
  for (const m of title.matchAll(/\b[A-Z][A-Z0-9-]{3,}\b/g)) {
    const token = m[0]
    if (
      !/^(?:EEG|MRI|SEEG|SUDEP|PNES|ASM|ASMS|AED|AEDS|RCT|ILAE|LGI1|NMDAR|CASPR2|GABA|MOG|AQP4|GTCS|FBTCS|COVID|COVID-19|DNA|RNA|PCR|CSF|STXBP1|SCN1A|SCN8A|KCNQ2|IGE|JME|GGE|DRE|TLE|MTLE|FLE|LGS|CBD|THC|VNS|DBS|RNS|LITT|RFTC|RFTHC|QOL|PRO|PROS|HIV|USA|UK|AUS|ECG|PET|CT|SPECT|II|III|IV)$/
        .test(token)
    ) return token
  }
  return title
}

/**
 * Whether a sentence names a study or cohort of its own - "in the
 * anti-NMDAR study", "in the BRIVAFIRST cohort" - so a figure it gives
 * that study is not a figure about the question's cohort.
 */
export function namesOtherStudy(sentence: string, terms: readonly string[]): boolean {
  for (const m of sentence.matchAll(DESIGNATOR)) {
    const phrase = m[1]!.toLowerCase().replace(/^anti-/, '')
    if (!terms.some((t) => phrase.includes(t))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The pool of texts a figure may be found in
// ---------------------------------------------------------------------------

export interface PoolText {
  resourceId: string
  title: string
  text: string
  /** True for the data-augmentation summary and key takeaways rather than the paper. */
  generated: boolean
}

/** The DA summary and key takeaways of a resource as one text, or undefined when it has neither. */
export function generatedText(
  resource: Pick<ScoredResource, 'summary' | 'keyTakeaways'>,
): string | undefined {
  const parts = [...(resource.keyTakeaways ?? []), resource.summary ?? ''].filter((p) =>
    p.trim().length > 0
  )
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

// ---------------------------------------------------------------------------
// Rescue
// ---------------------------------------------------------------------------

export interface RescueInput {
  sentence: BoundSentence
  /** The provider's numbering: an index every text in `pool` may be bound as. */
  pool: readonly { index: number; text: PreparedSource; resourceId: string }[]
  lexicon: readonly string[]
  questionEntities: readonly string[]
}

/**
 * The first pool text that carries every figure of the sentence beside
 * its claim, with the checks that prove it. Undefined when none does.
 */
export function rescueSentence(
  input: RescueInput,
): { index: number; resourceId: string; checks: FigureCheck[] } | undefined {
  const figures = extractNumbers(input.sentence.text)
  if (figures.length === 0) return undefined
  const claim = claimFeatures(input.sentence.text, input.lexicon, input.questionEntities)
  for (const candidate of input.pool) {
    const checks: FigureCheck[] = []
    let ok = true
    for (const figure of figures) {
      const verdict = figureSupportedBy(figure, claim, candidate.text)
      if (!verdict.supported) {
        ok = false
        break
      }
      checks.push({
        figure,
        sentence: input.sentence.text,
        supported: true,
        supportedBy: [0],
        ...(verdict.passage !== undefined ? { passage: verdict.passage } : {}),
      })
    }
    if (ok) return { index: candidate.index, resourceId: candidate.resourceId, checks }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The paper's own figure sentence
// ---------------------------------------------------------------------------

/** Prefixes a PDF line break splits off a word ("in- creased", "pre- treatment"): joined without a hyphen. */
const JOIN_PREFIX = new Set([
  'anti',
  'auto',
  'con',
  'contra',
  'de',
  'dis',
  'hyper',
  'hypo',
  'inter',
  'intra',
  'mis',
  'multi',
  'non',
  'over',
  'post',
  'pre',
  'pro',
  'sub',
  'super',
  'trans',
  'under',
])

/** Sections whose sentences are a paper's own findings. */
const OWN_FINDINGS = new Set(['abstract', 'results', 'conclusion', 'other'])

const QUOTE_MAX = 320

export interface OwnFigure {
  sentence: string
  score: number
}

/**
 * The sentence of a paper's own findings that answers what a removed
 * sentence tried to: it carries a specific figure, at least one of the
 * claim's names (a drug, a scale, an acronym the question or sentence
 * used) and the claim's outcome when it had one, and it sits in the
 * Abstract, Results or Conclusion (or a table), never the Introduction or
 * Discussion. The best-scoring such sentence, or undefined.
 */
export function ownFigureSentence(
  text: string,
  cue: {
    anchors: readonly string[]
    /** Outcome families the sentence must name, when the removed sentence named one. */
    outcomes: readonly string[]
    /** Outcome families the question named: preferred, not required. */
    preferred?: readonly string[]
    words?: readonly string[]
    /** The sentence must state a sample or group size. */
    wantCount?: boolean
    /** What the removed sentence stated: a share, a count, a ratio, a decimal - the candidate should match in kind. */
    kinds?: { share: boolean; count: boolean; ratio: boolean; decimal?: boolean }
    /** Figures the answer already states: a sentence that adds none of its own is not a replacement. */
    exclude?: readonly string[]
    /** The words that sat beside the removed sentence's figures: the figure's own subject. */
    near?: readonly string[]
    /** The medications the removed sentence named: the quote must name one. */
    drugs?: readonly string[]
    /** For a paper the question did not name: the quote must share two of the claim's words, its outcome or its drug. */
    strict?: boolean
  },
): OwnFigure | undefined {
  const spans = sectionSpans(text)
  const sectioned = hasBodyHeadings(spans)
  const anchors = cue.anchors.map((a) => a.toLowerCase()).filter((a) => a.length >= 3)
  const words = (cue.words ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 5)
  if (anchors.length === 0 && words.length < 2) return undefined
  let best: OwnFigure | undefined
  let offset = 0
  // A word broken across a PDF line ("in- creased") is joined when the
  // paper writes it whole elsewhere; a real compound keeps its hyphen.
  const lowerText = text.toLowerCase()
  const pairs = abbreviationPairs(text.replace(/\s+/g, ' '))
  // Blank-line paragraphs, table rows included (a row is shorter than the
  // evidence passages' floor), bibliography entries left out.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) =>
    p.length >= 12 && p.length <= 2500 && !looksLikeReferencePassage(p)
  )
  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p]!
    const at = text.indexOf(paragraph.slice(0, 40), offset)
    if (at >= 0) offset = at
    // The Introduction and Discussion are never quoted, even in a text
    // whose other headings the extraction lost.
    const section = at >= 0 ? sectionAt(spans, at) : 'other'
    // A pipe table, or an extracted table row ("Switched from LEV 709
    // (43.8)l"): a count with its share, footnote letter and all.
    const row = isTableRow(paragraph)
    const table = /^\s*\|/.test(paragraph) || row
    if (!table && (section === 'introduction' || section === 'discussion')) continue
    if (sectioned && !OWN_FINDINGS.has(section) && !table) continue

    // Sibling rows of the same table ("Switched from LEV ... / Switched
    // from other ASMs ...") read as one finding.
    const rowText = row
      ? [paragraph, ...siblingRows(paragraphs, p)].map(tableRowText).join('; ')
      : ''
    const sentences = row ? [rowText] : table ? [paragraph] : splitOwnSentences(paragraph)
    for (const raw of sentences) {
      // A word broken across a PDF line is one word; a fragment that opens
      // mid-sentence, a figure legend or a subgroup analysis is not quoted.
      const sentence = raw.replace(
        /([a-z]{2,})-\s+([a-z]{2,})/g,
        (_m, a: string, b: string) =>
          lowerText.includes(`${a}${b}`) || a.length <= 3 || JOIN_PREFIX.has(a)
            ? `${a}${b}`
            : `${a}-${b}`,
      ).replace(/\s+/g, ' ').trim()
      if (sentence.length < 20 || sentence.length > QUOTE_MAX) continue
      // A sentence that cites other work is not the paper's own finding.
      if (
        !table &&
        /\b(?:previous|prior|earlier) (?:studies|study|reports?|work)\b|\bet al\.?\b|\breported (?:that|by)\b/i
          .test(sentence)
      ) continue
      if (!table && !/^[A-Z≥]/.test(sentence)) continue
      if (!table && !/[.!?]["')]?$/.test(sentence)) continue
      if (/\b(?:mfas|subgroup|see esm|supplementar|fig\.? s\d|table s\d)\b/i.test(sentence)) {
        continue
      }
      const figures = extractNumbers(sentence).filter((f) =>
        !/(?:month|week|year|day|hour)s$/.test(f)
      )
      if (figures.length === 0) continue
      if (cue.exclude && figures.every((f) => cue.exclude!.includes(f))) continue
      const lower = sentence.toLowerCase()
      // A name by the abbreviation the paper defines for it ("PER"), a
      // word by its stem ("discontinuation" beside "discontinued").
      const carries = (term: string) =>
        lower.includes(term) ||
        termForms(term, pairs).some((re) => re.test(lower) || re.test(sentence)) ||
        (term.length >= 7 && lower.includes(term.slice(0, 6)))
      const anchorHits = anchors.filter(carries).length
      const hitWords = words.filter(carries)
      const wordHits = hitWords.length
      // One long, distinctive word ("rituximab", "retention") places a
      // sentence as two ordinary ones do; a table row needs one of the
      // claim's own words, its label being all it has.
      if (anchorHits === 0 && wordHits < 2 && !hitWords.some((w) => w.length >= 7)) continue
      if (table && wordHits === 0) continue
      // A sentence the extraction glued a heading onto is placed by that
      // heading: a Methods sentence is not a finding, a Results one is.
      const glued = /^(?:Methods?|Introduction|Background|Discussion)\s+(?=[A-Z])/.exec(sentence)
      if (glued) continue
      // A claim about a named drug is answered by a sentence about that
      // drug, by its name or the abbreviation the paper defines for it
      // ("brivaracetam (BRV)"): a perampanel retention never stands in for
      // brivaracetam's.
      if (
        cue.drugs && cue.drugs.length > 0 &&
        !cue.drugs.some((d) =>
          termForms(d, pairs).some((re) => re.test(lower) || re.test(sentence))
        )
      ) continue
      const outcomes = outcomeFamilies(sentence)
      if (cue.outcomes.length > 0 && !outcomes.some((o) => cue.outcomes.includes(o))) continue
      const sameOutcome = [...cue.outcomes, ...(cue.preferred ?? [])].some((o) =>
        outcomes.includes(o)
      )
      const sameDrug = (cue.drugs ?? []).some((d) =>
        termForms(d, pairs).some((re) => re.test(lower) || re.test(sentence))
      )
      if (cue.strict && wordHits < 2 && !sameOutcome && !sameDrug) continue
      // A demographic line ("mean age 54.47 years, 49% female") describes
      // the sample, not a finding.
      const demographic = /\bmean age\b|\bmedian age\b|\b(?:fe)?male\b|\bSD\s*=/i.test(sentence)
        ? 3
        : 0
      const normalised = normaliseFigures(sentence).toLowerCase()
      const counts = figures.filter((f) => isSampleSizeFigure(f, normalised)).length
      if (
        cue.wantCount &&
        (counts === 0 || (wordHits < 2 && !(anchorHits >= 1 && wordHits >= 1)) ||
          /\bmg\b|\bdose/i.test(sentence))
      ) {
        continue
      }
      // A count with its share ("709 (43.8%)") is the count the sentence
      // is about; a rate with an "(n = 525)" beside it is about the rate.
      const countWithShare = cue.wantCount && /\d[\d,]*\s\(\d{1,3}(?:\.\d+)?\s?%\)/.test(sentence)
        ? 3
        : 0
      const specific = figures.filter((f) => /%|\./.test(f) || /^\d{2,}$/.test(f)).length
      // The question's outcome is preferred for a rate or a ratio; a count
      // ("how many received rituximab") is about the count.
      const countOnly = cue.kinds ? cue.kinds.count && !cue.kinds.share && !cue.kinds.ratio : false
      const preferred = !countOnly && (cue.preferred ?? []).some((o) => outcomes.includes(o))
        ? 2
        : 0
      const shares = figures.some((f) => f.endsWith('%'))
      const ratios = /\b(?:a?HR|a?OR|RR|IRR|hazard ratio|odds ratio|risk ratio)\b/.test(sentence)
      let kind = 0
      // A decimal rate ("5.9 per 1000") is answered by a rate or a share,
      // never by a bare count of samples.
      if (
        cue.kinds?.decimal && !shares && !figures.some((f) => /\d\.\d/.test(f)) && !ratios
      ) continue
      if (cue.kinds) {
        if (cue.kinds.share && shares) kind += 3
        if (cue.kinds.count && counts > 0) kind += 2
        if (cue.kinds.ratio && ratios) kind += 3
        if (!cue.kinds.ratio && ratios) kind -= 3
      }
      // A count that leads its sentence ("Overall, 709 (43.8%) switched
      // from LEV") is the count the sentence is about.
      const leads = cue.wantCount &&
          /^(?:overall,?\s+|in total,?\s+|a total of\s+|of (?:these|the \d+ [a-z]+),?\s+)?\d/i.test(
            sentence,
          )
        ? 2
        : 0
      // The shortest sentence that says it: a long sentence with the same
      // hits carries other things beside the answer.
      const length = Math.floor(Math.max(0, sentence.length - 120) / 60)
      // A sentence listing many figures is a table in prose, rarely the
      // one fact asked for.
      const crowd = Math.max(0, figures.length - 4)
      // The figure beside the removed sentence's own subject ("Rituximab
      // was administered in 26") outranks the same words elsewhere.
      const subject = (cue.near ?? []).length > 0 && figureNear(lower, cue.near!) ? 3 : 0
      // A sentence about outcomes the claim never named (a death, a
      // relapse beside the functional outcome asked for) is about
      // something else.
      const extra = outcomes.filter((o) =>
        !cue.outcomes.includes(o) && !(cue.preferred ?? []).includes(o)
      ).length
      // Two names place a sentence; a consortium's four-word name in a
      // paper's boilerplate should not outrank the finding asked for.
      const score = Math.min(anchorHits, 2) * 3 + wordHits + Math.min(specific, 4) + preferred +
        kind + leads +
        countWithShare + subject + (section === 'results' ? 2 : section === 'abstract' ? 1 : 0) -
        length - crowd - 2 * extra - demographic
      if (!best || score > best.score) best = { sentence, score }
    }
  }
  return best
}

/** The content words within four tokens of any figure in a sentence, stemmed as `claimTerms` stems them. */
export function wordsNearFigures(sentence: string): string[] {
  const tokens = sentence.toLowerCase().split(/\s+/)
  const out = new Set<string>()
  tokens.forEach((token, i) => {
    if (!/\d/.test(token)) return
    for (let j = Math.max(0, i - 4); j <= Math.min(tokens.length - 1, i + 4); j++) {
      const word = tokens[j]!.replace(/[^a-z-]/g, '')
      if (word.length >= 5 && !NEAR_STOP.has(word)) out.add(word.replace(/s$/, ''))
    }
  })
  return [...out]
}

const NEAR_STOP = new Set([
  'patients',
  'participants',
  'people',
  'subjects',
  'adults',
  'children',
  'months',
  'weeks',
  'years',
  'their',
  'these',
  'those',
  'which',
  'there',
  'total',
  'cohort',
  'study',
  'analysis',
  'received',
  'achieved',
  'reported',
  'observed',
  'approximately',
])

/** Whether one of the words sits within six tokens of a figure in the (lower-cased) sentence. */
export function figureNear(lower: string, words: readonly string[]): boolean {
  const tokens = lower.split(/\s+/)
  return tokens.some((token, i) => {
    if (!/\d/.test(token)) return false
    for (let j = Math.max(0, i - 6); j <= Math.min(tokens.length - 1, i + 6); j++) {
      const word = tokens[j]!.replace(/[^a-z-]/g, '')
      if (words.some((w) => word.startsWith(w))) return true
    }
    return false
  })
}

/** An extracted table row: a label, a count and its share in brackets, an optional footnote letter. */
const TABLE_ROW = /^[A-Z][^.!?|\n]{2,80}?\s\d[\d,]*\s\(\d{1,3}(?:\.\d+)?\)[a-z]?\s*$/

export function isTableRow(paragraph: string): boolean {
  return TABLE_ROW.test(paragraph.trim())
}

/** The row as prose: "Switched from LEV 709 (43.8%)". */
export function tableRowText(row: string): string {
  return row.trim().replace(/\((\d{1,3}(?:\.\d+)?)\)[a-z]?\s*$/, '($1%)')
}

/** The following rows of the same table that open with the row's first two words, at most two. */
function siblingRows(paragraphs: readonly string[], at: number): string[] {
  const lead = paragraphs[at]!.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase()
  const out: string[] = []
  for (let i = at + 1; i < paragraphs.length && out.length < 2; i++) {
    const next = paragraphs[i]!.trim()
    if (!isTableRow(next) || !next.toLowerCase().startsWith(lead)) break
    out.push(next)
  }
  return out
}

/** "Fig.", "et al.", "vs." and their kin end no sentence. */
const OWN_ABBREVIATION =
  /\b(?:fig|figs|et al|vs|e\.g|i\.e|no|approx|ca|cf|ref|refs|vol|dr|prof|st)\.$/i

/** A paragraph's sentences, without breaking at an abbreviation's full stop. */
export function splitOwnSentences(paragraph: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /[.!?]["')]*(?=\s+[A-Z0-9("])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(paragraph)) !== null) {
    const end = m.index + m[0].length
    if (OWN_ABBREVIATION.test(paragraph.slice(start, end).trimEnd())) continue
    out.push(paragraph.slice(start, end))
    start = end
  }
  const rest = paragraph.slice(start)
  if (rest.trim()) out.push(rest)
  return out
}

/** The removed sentence's cue for `ownFigureSentence`: its names, its outcomes and its specific words. */
export function replacementCue(
  sentence: string,
  lexicon: readonly string[],
  questionEntities: readonly string[],
  questionOutcomes: readonly string[],
  /** The cohort terms that chose the paper: every sentence of that paper may carry them, so they place nothing within it. */
  cohortTerms: readonly string[] = [],
): {
  anchors: string[]
  outcomes: string[]
  preferred: string[]
  words: string[]
  kinds: { share: boolean; count: boolean; ratio: boolean }
  near: string[]
  drugs: string[]
} {
  const claim = claimFeatures(sentence, lexicon, questionEntities)
  const lowerSentence = sentence.toLowerCase()
  const drugs = lexicon.map((t) => t.toLowerCase()).filter((t) =>
    isMedicationTerm(t) && lowerSentence.includes(t)
  )
  const anchors = [...new Set([...claim.anchors, ...questionEntities.map((e) => e.toLowerCase())])]
    .filter((a) => !/^(?:fas|mfas|itt|pp)$/.test(a) && !cohortTerms.includes(a))
  const figures = extractNumbers(sentence)
  const kinds = {
    share: figures.some((f) => f.endsWith('%')),
    count: figures.some((f) => isSampleSizeFigure(f, claim.normalised)),
    ratio: /\b(?:a?HR|a?OR|RR|IRR|hazard ratio|odds ratio|risk ratio)\b/.test(sentence),
  }
  return {
    anchors,
    outcomes: claim.outcomes,
    preferred: [...questionOutcomes],
    words: claim.words,
    kinds,
    near: wordsNearFigures(sentence).filter((w) => !cohortTerms.includes(w)),
    drugs,
  }
}

/** The replacement sentence as it reads in the answer: the paper's words, less a heading the extraction glued on. */
/**
 * Whether a candidate quote answers what a removed sentence tried to, on
 * the removed sentence's own terms (review loop 4
 * D4-03): every result figure the sentence stated (a share, a decimal, a
 * ratio, a count of three digits or more) must sit in the quote beside the
 * claim under the same check the sentence itself would have needed, and a
 * follow-up the sentence named must be one the quote names too. A quote
 * that carries a different figure, or the same outcome at a different
 * time point, is not a substitute.
 */
export function quoteCarriesClaim(
  quote: string,
  sentence: string,
  lexicon: readonly string[],
  questionEntities: readonly string[],
  /** The abbreviations the quote's paper defines ("perampanel (PER)"), from its full text. */
  pairs: readonly { phrase: string; abbr: string }[] = [],
): boolean {
  // The bracket the removed sentence paired with its share is the pairing
  // the quote replaces: the figure, its outcome and its time point are what
  // must match (D4-05, loop 5 D5-03).
  const unpaired = sentence.replace(
    /\s*\((?:n\s*=\s*)?\d[\d,]*(?:\s*\/\s*\d[\d,]*)?(?:\s*[,;]\s*[^)]{0,40})?\)/g,
    '',
  )
  const claim = claimFeatures(unpaired, lexicon, questionEntities)
  const own = prepareSource(quote)
  const prepared = { ...own, pairs: [...own.pairs, ...pairs] }
  const results = extractNumbers(unpaired).filter((f) =>
    !/(?:month|week|year|day|hour)s$/.test(f) && !isSampleSizeFigure(f, claim.normalised) &&
    (/%|\./.test(f) || /^\d{3,}$/.test(f))
  )
  if (results.length === 0) return false
  for (const figure of results) {
    if (!figureSupportedBy(figure, claim, prepared).supported) return false
  }
  if (claim.timepoints.length > 0) {
    const found = timepointsInMonths(normaliseFigures(quote))
    if (found.length === 0) return false
    if (!claim.timepoints.some((s) => found.some((w) => Math.abs(s - w) <= 0.5 + 0.08 * s))) {
      return false
    }
  }
  return true
}

/**
 * The sentence of a paper that carries one of the figures a gate removed,
 * for an answer that would otherwise be declined (
 * review loop 8 D8-11). The check has already decided the answer did not
 * state the figure as the paper carries it; before refusing, the portal
 * reads the paper the removal names and quotes the sentence that does
 * carry it - the paper's own results, not its introduction or discussion,
 * not a table row or legend, not a sentence reporting earlier work, and
 * about the outcome the question asked for.
 */
export function rescueQuote(
  text: PreparedSource,
  figures: readonly string[],
  questionOutcomes: readonly string[],
): string | undefined {
  const spans = sectionSpans(text.original)
  const sectioned = hasBodyHeadings(spans)
  for (const figure of figures) {
    for (const occ of locateFigure(figure, text)) {
      if (occ.row) continue
      const section = sectionAt(spans, occ.at)
      if (section === 'introduction' || section === 'discussion') continue
      if (sectioned && !OWN_FINDINGS.has(section)) continue
      if (inTableOrLegend(text.original, occ.at)) continue
      if (citesEarlierWork(text.original, occ.at)) continue
      // The figure must be the sentence's result, not a bound of somebody
      // else's interval: "(95%CI 61-73%)" carries 73% and reports 68%.
      const span = bracketSpan(text.lower, occ.at)
      if (span) {
        const inside = text.lower.slice(span.open, span.close)
        if (/\bcis?\b|confidence interval|\d\s*(?:-|\u2013|to)\s*\d/.test(inside)) continue
      }
      const sentence = occ.sentenceOriginal.replace(/\s+/g, ' ').trim()
      if (sentence.length < 25 || sentence.length > QUOTE_MAX) continue
      // A quote may open on a figure ("5 years after initiation of ASM
      // withdrawal, 73% ... had experienced seizure relapses"), which is
      // where the extraction's sentence bounds often fall; it may not open
      // mid-clause on a lower-case word.
      if (!/^[A-Z\u2265(\d]/.test(sentence)) continue
      if (
        questionOutcomes.length > 0 &&
        !outcomeFamilies(sentence).some((o) => questionOutcomes.includes(o))
      ) continue
      return sentence
    }
  }
  return undefined
}

export function quoteSentence(quote: string): string {
  const trimmed = normaliseGlyphs(quote).replace(/\s+/g, ' ').trim()
    .replace(
      /^(?:Results|Conclusions?|Methods|Background|Objectives?|Interpretation|Findings)\s+(?=[A-Z])/,
      '',
    )
    // A figure or table reference is the paper's cross-reference, not its finding.
    .replace(/\s*\((?:see\s+)?(?:Fig\.?|Figure|Figs\.?|Table|Tables|Supplementary|ESM)[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;,]$/, '')
  return `The paper itself reports: "${trimmed}."`
}

// ---------------------------------------------------------------------------
// The population the passage states
// ---------------------------------------------------------------------------

/** Words of a qualifier that carry it: "psychiatric", "comorbidity"; not "with". */
function qualifierWords(qualifier: string): string[] {
  return (qualifier.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) =>
    !/^(?:with|without|those|their|other|previous|prior|baseline)$/.test(w)
  ).map((w) => w.slice(0, 6))
}

/**
 * Whether a sentence (or the question) already carries the population the
 * passage states its figure for: one of the qualifier's content words, by
 * stem, is enough ("psychiatric" for "with psychiatric comorbidity").
 */
export function carriesQualifier(text: string, qualifier: string): boolean {
  const words = qualifierWords(qualifier)
  if (words.length === 0) return true
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w))
}

/**
 * The sentence with the passage's population carried into it: "Among
 * patients with psychiatric comorbidity, the 12-month seizure freedom rate
 * ... was 13.9%". The original keeps its capitalisation when it opens with
 * an acronym or a name.
 */
export function withQualifier(sentence: string, qualifier: string): string {
  const first = sentence.match(/^\s*([A-Za-z][\w'-]*)/)?.[1] ?? ''
  const keepCase = /^[A-Z]{2,}|^[a-z]+[A-Z]|^[A-Z][a-z]+[A-Z]/.test(first)
  const body = keepCase ? sentence : sentence.charAt(0).toLowerCase() + sentence.slice(1)
  return `Among patients ${qualifier}, ${body}`
}

// ---------------------------------------------------------------------------
// Decline sentences
// ---------------------------------------------------------------------------

/**
 * A sentence in which the answer declines rather than states: "The cited
 * sources do not provide ...", "is not specified in the cited sources".
 * Such a sentence is the portal's decline, never a claim, so it carries
 * no marker (D3-15).
 */
export function isDeclineSentence(sentence: string): boolean {
  return /\b(?:the\s+)?(?:cited\s+)?(?:sources?|passages?|documents?|papers?|context)\s+(?:do|does|did)\s+not\s+(?:\w+\s+){0,2}(?:provide|state|report|specify|give|mention|detail|include|contain|address|indicate|say|offer)\b|\b(?:is|are|was|were)\s+not\s+(?:\w+\s+)?(?:specified|provided|stated|reported|given|detailed|mentioned|available|indicated)\s+(?:in|by)\s+(?:the\s+)?(?:cited\s+)?(?:sources?|passages?|documents?|papers?|context)\b|\b(?:no|none of the)\s+(?:cited\s+)?(?:sources?|passages?)\s+(?:provides?|states?|reports?|gives?|mentions?|specif)/i
    .test(sentence)
}

/**
 * Whether a removed sentence's figures can be found anywhere in the
 * texts, however loosely: the decline can then say "found in X but could
 * not be tied to the claim" instead of "not used" (D3-15).
 */
export function figuresFoundIn(
  figures: readonly string[],
  pool: readonly { title: string; text: PreparedSource }[],
  /** The removed sentences' words: a paper is named only where one of them sits beside the figure (D4-19). */
  words: readonly string[] = [],
): string[] {
  const out: string[] = []
  const terms = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 5)
  for (const { title, text } of pool) {
    const carries = figures.some((f) => {
      const re = figurePattern(f, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text.lower)) !== null) {
        if (terms.length === 0) return true
        const window = claimWindow(text.lower, m.index)
        if (terms.some((t) => window.includes(t))) return true
      }
      return false
    })
    if (carries && !out.includes(title)) out.push(title)
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers shared with the gate
// ---------------------------------------------------------------------------

/** Whether the sentence states any figure that is not a sample size or a timepoint. */
export function statesResultFigure(sentence: string): boolean {
  const normalised = normaliseFigures(sentence).toLowerCase()
  return extractNumbers(sentence).some((f) =>
    !/(?:month|week|year|day|hour)s$/.test(f) && !isSampleSizeFigure(f, normalised)
  )
}

export function prepareIfNeeded(text: string, cache: Map<string, PreparedSource>): PreparedSource {
  let v = cache.get(text)
  if (v === undefined) {
    v = prepareSource(text)
    cache.set(text, v)
  }
  return v
}

/** A synthetic citation for a resource the platform retrieved but did not cite. */
export function syntheticCitation(
  index: number,
  resource: { id: string; title: string },
): Citation {
  return { index, resourceId: resource.id, title: resource.title }
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// The exposure and outcome a question pairs
// ---------------------------------------------------------------------------

export interface ExposureOutcomePair {
  exposure: string
  outcome: string
  /** Stems the papers are searched for, one per side. */
  exposureKeys: string[]
  outcomeKeys: string[]
}

const PAIR_STOP = new Set([
  'the',
  'and',
  'with',
  'their',
  'between',
  'among',
  'people',
  'patients',
  'adults',
  'children',
  'epilepsy',
  'antiseizure',
  'medication',
  'medications',
  'drug',
  'drugs',
  'treatment',
])

function pairKeys(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [])
    .filter((w) => !PAIR_STOP.has(w))
    .map((w) => w.replace(/(?:ies|ied|ing|ers?|es|s|ly|al|ity)$/, '').slice(0, 6))
}

/**
 * The exposure and outcome a question pairs explicitly: "the relationship
 * between X and Y", "the association of X with Y", "the effect of X on Y".
 * Undefined for any other form - the check is for the questions whose
 * stitched answer reads as a finding the collection never made (D3-12).
 */
export function exposureOutcomePair(query: string): ExposureOutcomePair | undefined {
  const m =
    /\b(?:relationship|association|link|correlation)\s+(?:between|of)\s+([^,?.]{3,60}?)\s+(?:and|with)\s+([^,?.;]{3,50}?)(?=[,?.;]|\s+(?:with|in|among|for|over|across)\b|$)/i
      .exec(query) ??
      /\b(?:effect|impact|influence)\s+of\s+([^,?.]{3,60}?)\s+on\s+([^,?.;]{3,50}?)(?=[,?.;]|\s+(?:with|in|among|for|over|across)\b|$)/i
        .exec(query)
  if (!m) return undefined
  const exposure = m[1]!.trim()
  const outcome = m[2]!.trim()
  const exposureKeys = pairKeys(exposure)
  const outcomeKeys = pairKeys(outcome)
  if (exposureKeys.length === 0 || outcomeKeys.length === 0) return undefined
  return { exposure, outcome, exposureKeys, outcomeKeys }
}

const OUTCOME_SYNONYMS: Record<string, RegExp> = {
  death: /\b(?:death|deaths|died|mortality|sudep|fatal)/,
  mortal: /\b(?:death|deaths|died|mortality|sudep|fatal)/,
  sudep: /\b(?:sudep|death|deaths|mortality)/,
}

/**
 * Whether a resource's record pairs the exposure and the outcome in one
 * field - the title, one key takeaway, or one sentence of the summary.
 * A paper that mentions adherence in its title and deaths in an unrelated
 * takeaway does not study the two together.
 */
export function pairCarried(
  resource: { title: string; summary?: string; keyTakeaways?: string[] },
  pair: ExposureOutcomePair,
): boolean {
  const fields = [
    resource.title,
    ...(resource.keyTakeaways ?? []),
    ...(resource.summary ?? '').split(/(?<=[.!?])\s+/),
  ]
  const hasExposure = (f: string) => pair.exposureKeys.some((k) => f.includes(k))
  const hasOutcome = (f: string) =>
    pair.outcomeKeys.some((k) => f.includes(k) || OUTCOME_SYNONYMS[k]?.test(f))
  return fields.some((field) => {
    const f = field.toLowerCase()
    return hasExposure(f) && hasOutcome(f)
  })
}

/** Whether every sentence of an answer (its notes aside) is a decline. */
export function isWholeDecline(text: string): boolean {
  const sentences = text.split('\n').filter((l) => l.trim() && !/^\s*\*/.test(l))
    .map((l) => l.replace(/\s*\[\d{1,3}\]/g, ''))
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return sentences.length > 0 && sentences.every(isDeclineSentence)
}
