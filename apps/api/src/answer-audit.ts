/**
 * Post-answer grounding audit: figures in the answer must appear in the
 * cited material beside the claim's own terms, years must come from the
 * cited resources, drugs the answer calls contraindicated must be called
 * that by a cited passage, and drugs the cited sources flag must not be
 * silently dropped. Deterministic string checks over the extracted text of
 * the cited resources - no model in the loop - so the audit is itself
 * grounded. Numbers are only ever checked and marked, never rewritten.
 */

/**
 * One spelling for the ranges and decimals both sides write differently:
 * "21–45%", "21 to 45%" and "21-45%" become "21-45%"; ".5 mg" becomes
 * "0.5 mg". Applied to the answer and to the cited texts before any check.
 */
export function normaliseFigures(text: string): string {
  return normaliseGlyphs(text)
    .replace(/([\d%])\s*[‐‑‒–—−]\s*(\d)/g, '$1-$2')
    .replace(/(\d(?:\.\d+)?%?)\s+(?:to|through)\s+(\d)/g, '$1-$2')
    .replace(/(?<![\d.])\.(\d+)/g, '0.$1')
}

/**
 * The glyphs a PDF extraction writes where the paper has a decimal point,
 * a plus-minus sign or a thin space (review loop 4
 * D4-10): "1¢66 § 0¢52 h" is "1.66 ± 0.52 h", "1·66" (a Lancet-style
 * middle dot) is "1.66", "0⋅70" (the dot operator a Lancet PDF extracts,
 * loop 5 GB) is "0.70", and a thin, narrow, figure or non-breaking space
 * between digits or before a unit is an ordinary space. Applied to the
 * answer and to every source before any figure is read or quoted.
 */
export function normaliseGlyphs(text: string): string {
  return text
    .replace(/[    ]/g, ' ')
    .replace(/(\d)[¢·•⋅∙‧](\d)/g, '$1.$2')
    .replace(/§/g, '±')
}

const UNITS_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
}
const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
}
const NUMBER_WORD = new RegExp(
  `\\b(${Object.keys(TENS_WORDS).join('|')})(?:[\\s-]{1,3}(${
    Object.keys(UNITS_WORDS).join('|')
  }))?\\b|\\b(${Object.keys(UNITS_WORDS).join('|')})\\b`,
  'gi',
)

/**
 * Number words as digits: "Thirteen participants" reads "13 participants",
 * "thirty-one subjects" reads "31 subjects". A paper opens a sentence with
 * the word where the answer states the digits; without this the audit
 * flags a figure the paper carries.
 */
export function numberWordsToDigits(text: string): string {
  return text.replace(NUMBER_WORD, (_m, tens?: string, unit?: string, lone?: string) => {
    if (lone) return String(UNITS_WORDS[lone.toLowerCase()])
    const value = TENS_WORDS[tens!.toLowerCase()]! + (unit ? UNITS_WORDS[unit.toLowerCase()]! : 0)
    return String(value)
  })
}

/** Paragraph boundary marker kept through whitespace collapsing, so a claim window never crosses one. */
export const PARAGRAPH_MARK = '¶'

/**
 * A cited text prepared for figure matching: figures and ranges in one
 * spelling, number words as digits, thousands separators removed, the
 * "38 (79)" and "937 (52)" of a table cell read as "38 (79%)", and blank
 * lines kept as a paragraph mark so a window stops at the paragraph.
 * Whitespace is otherwise collapsed. Applied to every source before any
 * check; the answer only gets `normaliseFigures`.
 */
export function normaliseSource(text: string): string {
  return numberWordsToDigits(normaliseFigures(text))
    // A blank line the extraction put mid-sentence ("just \n\n over a
    // third") is not a paragraph break: the next line opens in lower case.
    .replace(/\n\s*\n(?=[ \t]*[a-z])/g, ' ')
    .replace(/\n\s*\n/g, ` ${PARAGRAPH_MARK} `)
    .replace(/\s+/g, ' ')
    // A word broken across a PDF line ("pri- mary", "com- mercial") is one
    // word; a compound written "two- arm" is matched hyphen-insensitively.
    .replace(/([a-z]{2,})- (?=[a-z]{2,})/g, '$1')
    .replace(/,(?=\d{3}\b)/g, '')
    // A thousands group set off by a space or a thin space ("82 723", "1 644")
    // is one number: the extraction writes "82 723" where the answer writes
    // "82,723", and the audit must find it (D3-02).
    .replace(/(?<![\d.,])(\d{1,3})[ \u00a0\u2009\u202f](\d{3})(?![\d])/g, '$1$2')
    // A count with its share in brackets is a table cell or a results
    // sentence: "29 (48)" and "154 (67)" state 48% and 67%. A share over
    // 100 or a decimal count is neither.
    .replace(/(?<![\d.])(\d{1,5}) \((\d{1,2}(?:\.\d+)?)\)(?!%)/g, '$1 ($2%)')
}

/** Numbers worth checking: percentages, decimals, doses; not citation markers, list numbers, years, labels or clock times. */
export function extractNumbers(answer: string): string[] {
  const cleaned = normaliseFigures(numberWordsToDigits(answer))
    // Both ends of a range carry the range's unit: "21-45%" states 21% and 45%.
    .replace(
      /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(\s?(?:%|mg(?:\/kg)?(?:\/day)?))/g,
      '$1$3 and $2$3',
    )
    // An age in years is a bare figure: a paper's table writes "45 (23–71)"
    // under a "years" column heading.
    .replace(/\b(aged?|years old)\b([^.]{0,40}?)(\d+(?:\.\d+)?)\s?years\b/gi, '$1$2$3')
    // A range of ages or durations ("range 23-71 years") is two bare
    // figures: a paper's table writes "45 (23–71)" without the unit.
    .replace(
      /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s?(?:years?|months?|weeks?|days?|hours?)\b/g,
      '$1 and $2',
    )
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ') // citation markers
    .replace(/^\s*\d+\.\s+/gm, ' ') // ordered-list numbers
    // Labels, not measurements: "Table 2", "Figure 3", "Patient 10", "reference 41",
    // "Week 52", "grade 3", "phase 2".
    .replace(
      /\b(?:table|figure|fig\.?|patient|participant|reference|ref\.?|section|chapter|item|case|week|day|visit|grade|stage|phase|type|cluster|class|arm|supplementary (?:table|figure|file|material))s?\s+S?\d+(?:\s*,\s*\d+)*(?:,?\s*(?:and|or)\s+\d+)?/gi,
      ' ',
    )
    // Clock times are checked as their own tokens below, never as bare numbers.
    .replace(/\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi, ' ')
    .replace(/\b\d{1,2}\s?(?:noon|midnight)\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
  const found = new Set<string>(clockTimes(answer))
  for (
    const m of cleaned.matchAll(
      /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?%|\s?mg(?:\/kg)?(?:\/day)?|[\s-]?(?:months?|weeks?|years?|days?|hours?|hrs?|h)\b)?/g,
    )
  ) {
    const raw = m[1] ?? ''
    const unit = (m[2] ?? '').replace(/[\s-]/g, '')
    const value = raw.replace(/,/g, '')
    if (/^(19|20)\d{2}$/.test(value) && !unit) continue // a year
    if (!unit && !value.includes('.') && Number(value) < 10) continue // small counts
    // A duration is a timepoint, not a result: "12 months" is checked as the
    // unit-bearing token "12months" (never the bare 12 of a table cell), and
    // counts under ten are as small as bare counts.
    found.add(value + normaliseUnit(unit))
  }
  return [...found]
}

/**
 * Clock times in a text as tokens: "11 p.m." and "11pm" read "11pm", "12
 * noon" reads "12noon", "08:30" reads "08:30". A sentence that places a
 * peak "between 11 p.m. and 7 a.m." states figures the reader will repeat,
 * so they count for the marker rule (D3-20) - and the matcher checks them
 * as times, never as the bare 11 of a table cell.
 */
export function clockTimes(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a|p)\.?m\.?(?![a-z])/gi)) {
    out.add(`${Number(m[1])}${m[2] ? `:${m[2]}` : ''}${m[3]!.toLowerCase()}m`)
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s?(noon|midnight)\b/gi)) {
    out.add(`${Number(m[1])}${m[2]!.toLowerCase()}`)
  }
  return [...out]
}

/** Whether a figure token is a clock time from `clockTimes`. */
export function isClockToken(token: string): boolean {
  return /^\d{1,2}(?::\d{2})?(?:[ap]m|noon|midnight)$/.test(token)
}

/** Plural, singular and abbreviated time units are one token: "12months" for "12 months" and "12-month", "5hours" for "5 h". */
function normaliseUnit(unit: string): string {
  const time = /^(month|week|year|day|hour)s?$/.exec(unit)
  if (time) return `${time[1]}s`
  if (/^hrs?$|^h$/.test(unit)) return 'hours'
  return unit
}

function normaliseText(text: string): string {
  return normaliseSource(text)
}

/**
 * The pattern a figure token ("6.42%", "1400mg", "0.54") must match in a
 * text: the whole number, and its unit when it has one - "21%" is not the
 * "21" of "21 patients". The number may also lead a range whose unit
 * follows the second number ("21-45%").
 */
export function figurePattern(token: string, flags = ''): RegExp {
  if (isClockToken(token)) {
    const m = /^(\d{1,2})(?::(\d{2}))?([ap]m|noon|midnight)$/.exec(token)!
    const hour = `(?<![\\d.])0?${m[1]}${m[2] ? `:${m[2]}` : '(?::00)?'}`
    const meridiem = m[3] === 'noon' || m[3] === 'midnight'
      ? `\\s?${m[3]}`
      : `\\s?${m[3]![0]}\\.?m\\.?(?![a-z])`
    return new RegExp(`${hour}${meridiem}`, flags + 'i')
  }
  const value = token.replace(/%|mg.*$|(?:month|week|year|day|hour)s$/, '')
  const unit = token.slice(value.length)
  // A count of four digits or more may carry a thousands separator in a
  // text that was not normalised ("2,709", "2 709"): the separator is
  // optional before every group of three (D4-01).
  const digits = value.includes('.') ? value.replace('.', '\\.') : value.replace(
    /(\d)(?=(?:\d{3})+$)/g,
    '$1[, ]?',
  )
  const number = `(?<![\\d.])${digits}(?![\\d])`
  if (!unit) return new RegExp(number, flags)
  const time = /^(month|week|year|day|hour)s$/.exec(unit)
  const unitPattern = unit === '%'
    ? '\\s?(?:%|percent|per cent)'
    : time
    ? `[\\s-]?(?:${time[1]}s?|${TIME_ABBREVIATIONS[time[1]!]})\\b`
    : `\\s?${unit.replace('/', '\\/')}`
  // A share the answer states as a percentage is stated by the paper as a
  // proportion: "F2 is 0.37" carries "37%" (D4-19). The proportion form is
  // an alternative for a percentage under 100, never a decimal unit of
  // its own.
  const proportion = unit === '%' ? proportionForm(value) : undefined
  // A time unit may follow its spread or interval: "1.66 ± 0.52 h", "414
  // (IQR 256, 967) days" (D4-10). The interval's label is matched in either
  // case: the check runs over a lower-cased text (loop 5 K5).
  const spread = time
    ? '(?:\\s?\\(?±\\s?\\d+(?:\\.\\d+)?\\)?|\\s?\\((?:iqr|IQR|range|sd|SD|95\\s?% ci|95\\s?% CI)[^)]{0,30}\\))?'
    : ''
  return new RegExp(
    `(?:${number}${spread}(?:${unitPattern}|-\\d+(?:\\.\\d+)?${unitPattern})${
      proportion ? `|${proportion}` : ''
    })`,
    flags,
  )
}

/** "37" as the proportion "0.37" (or ".37", "0.370"), "37.5" as "0.375"; undefined at or over 100. */
function proportionForm(percent: string): string | undefined {
  const n = Number(percent)
  if (!Number.isFinite(n) || n >= 100 || n <= 0) return undefined
  const fraction = (n / 100).toFixed(4).replace(/^0\./, '').replace(/0+$/, '')
  if (!fraction) return undefined
  // The decimal stands for a share only beside a fraction cue: "F2 is
  // 0.37", "the proportion was 0.37", "0.37 of discharges"; a kappa of
  // 0.80 or a hazard ratio of 0.37 is not 80% or 37% of anything.
  const tail =
    `0?\\.${fraction}0*(?![\\d%])(?!\\s?(?:mg|mmol|ml|mm|ms|h\\b|hours?|hrs?|years?|months?|weeks?|days?))`
  return `(?:(?<=\\b(?:proportion|fraction|share|f\\d)\\b[^.¶]{0,40})(?<![\\d.])${tail}|(?<![\\d.])${tail}(?=[^.¶]{0,60}\\bof\\b))`
}

/** The short forms a paper writes a time unit in: "48 h", "6 mo", "2 yr", "4 wk", "30 d". */
const TIME_ABBREVIATIONS: Record<string, string> = {
  hour: 'hrs?|h',
  day: 'd',
  week: 'wks?',
  month: 'mos?',
  year: 'yrs?|y',
}

/** Whether a figure token occurs, with its unit, in the text. */
export function figurePresent(token: string, haystack: string): boolean {
  return figurePattern(token).test(haystack)
}

// ---------------------------------------------------------------------------
// Figures checked beside their claim's own terms
// ---------------------------------------------------------------------------

/** Words too generic to anchor a figure to its claim. */
const GENERIC = new Set([
  'about',
  'above',
  'achieved',
  'after',
  'among',
  'analysis',
  'approximately',
  'around',
  'associated',
  'average',
  'baseline',
  'between',
  'cases',
  'cohort',
  'compared',
  'control',
  'controls',
  'data',
  'during',
  'estimated',
  'evidence',
  'findings',
  'first',
  'follow',
  'found',
  'frequency',
  'group',
  'groups',
  'higher',
  'incidence',
  'included',
  'increase',
  'increased',
  'interval',
  'lower',
  'majority',
  'mean',
  'median',
  'months',
  'number',
  'observed',
  'occurred',
  'outcome',
  'outcomes',
  'overall',
  'participants',
  'patients',
  'percent',
  'period',
  'population',
  'prevalence',
  'proportion',
  'range',
  'rate',
  'rates',
  'ratio',
  'reduction',
  'remained',
  'reported',
  'respectively',
  'response',
  'result',
  'results',
  'risk',
  'sample',
  'showed',
  'significant',
  'studies',
  'study',
  'subjects',
  'their',
  'there',
  'these',
  'those',
  'total',
  'trial',
  'trials',
  'versus',
  'weeks',
  'which',
  'while',
  'within',
  'years',
])

/**
 * The terms a figure hangs on. Anchors are the specific names in the same
 * sentence - lexicon hits (drugs, genes), symbols and capitalised names
 * (an intervention such as LITT, a species, a register, a scale such as
 * mRS) - and when a sentence has any, the figure must sit beside one of
 * them. Words are the fallback for a sentence with no names: any specific
 * word of five letters or more. Content words are every word of four
 * letters or more that is not a stopword, for a sentence whose words are
 * all generic ("the sample size is 220 participants, 110 per group").
 * All lower-cased.
 */
export function claimTerms(
  sentence: string,
  lexicon: readonly string[],
): { anchors: string[]; words: string[]; content: string[] } {
  const lower = sentence.toLowerCase()
  const anchors = new Set<string>()
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (t.length >= 4 && lower.includes(t)) anchors.add(t)
  }
  for (const m of sentence.matchAll(/\b[A-Z][A-Z0-9]{1,7}\b/g)) {
    if (
      !/^(PMC|DOI|EEG|MRI|PET|ASM|ASMS|RCT|ILAE|HR|CI|OR|RR|SD|IQR|AUC|FDA|USA|UK|HS|N|P)\d*$/.test(
        m[0],
      )
    ) {
      anchors.add(m[0].toLowerCase())
    }
  }
  // A mixed-case symbol: a scale (mRS), an adjusted ratio (aHR), a method (tDCS).
  for (const m of sentence.matchAll(/\b[a-z][A-Z]{2,}\d?\b/g)) {
    if (!/^a(?:HR|OR|RR)$/.test(m[0])) anchors.add(m[0].toLowerCase())
  }
  for (
    const m of sentence.matchAll(/(?<=[^.!?\n]\s|[(,;]\s?)([A-Z][a-z]{3,}(?:-[A-Z][a-z]+)?)\b/g)
  ) {
    const word = m[1]!.toLowerCase()
    if (!GENERIC.has(word)) anchors.add(word)
  }
  const words = new Set<string>()
  const content = new Set<string>()
  for (const m of lower.matchAll(/\b[a-z][a-z-]{3,}\b/g)) {
    const word = m[0]
    if (STOP.has(word)) continue
    content.add(word.replace(/s$/, ''))
    if (word.length >= 5 && !GENERIC.has(word)) words.add(word.replace(/s$/, ''))
  }
  return { anchors: [...anchors], words: [...words], content: [...content] }
}

/** Function words that never carry a claim, for the content-word fallback. */
const STOP = new Set([
  'that',
  'this',
  'with',
  'from',
  'were',
  'have',
  'been',
  'they',
  'their',
  'which',
  'when',
  'than',
  'then',
  'each',
  'into',
  'also',
  'only',
  'more',
  'most',
  'such',
  'some',
  'over',
  'both',
  'these',
  'those',
  'there',
  'where',
  'while',
  'after',
  'before',
  'about',
  'among',
  'between',
  'within',
  'during',
  'other',
  'being',
  'however',
  'therefore',
  'respectively',
  'approximately',
  'cited',
  'sources',
  'source',
  'indicate',
  'indicates',
  'reported',
  'report',
  'reports',
  'found',
  'showed',
  'shown',
  'suggest',
  'suggests',
  'study',
  'studies',
])

export interface FigureCheck {
  figure: string
  sentence: string
  supported: boolean
  /** Positions, in the texts the sentence was checked against, of the texts that carry the figure beside its claim. */
  supportedBy: number[]
  /** The sentence of the first supporting text that carries the figure, for the population check. */
  passage?: string
  /**
   * Why the figure failed, when it did: the number is absent from every
   * text, or present only beside none of the claim's terms, or beside a
   * different outcome or timepoint, or the sentence names a cohort, drug or
   * study the text never mentions.
   */
  reason?:
    | 'absent'
    | 'terms'
    | 'outcome'
    | 'timepoint'
    | 'entity'
    | 'pvalue'
    | 'population'
    | 'secondhand'
}

// ---------------------------------------------------------------------------
// Abbreviations a paper defines for the names a claim hangs on
// ---------------------------------------------------------------------------

/**
 * The "perampanel (PER)" and "antiseizure medication (ASM)" definitions in a
 * text, as pairs of the defined phrase (lower-cased) and its abbreviation
 * (as written, upper-case). A paper states its abbreviation once and uses
 * it everywhere after, so the figure's own sentence reads "retention on PER
 * treatment" while the claim names perampanel; without the pair the figure
 * looks unsupported. Only a real acronym qualifies: its first letter opens
 * the phrase and its letters occur in the phrase in order.
 */
export function abbreviationPairs(text: string): { phrase: string; abbr: string }[] {
  const out: { phrase: string; abbr: string }[] = []
  const seen = new Set<string>()
  for (
    const m of text.matchAll(
      /((?:[A-Za-z][a-z-]{2,}\s){0,3}[A-Za-z][a-z-]{2,})\s\(([A-Z][A-Z0-9]{1,5})s?\)/g,
    )
  ) {
    const words = m[1]!.toLowerCase().split(/\s+/)
    const abbr = m[2]!
    if (seen.has(abbr)) continue
    const letters = abbr.toLowerCase().replace(/[0-9]/g, '')
    // The shortest word suffix the abbreviation is an acronym of.
    for (let k = 1; k <= words.length; k++) {
      const phrase = words.slice(words.length - k).join(' ')
      if (phrase[0] !== letters[0]) continue
      if (!isSubsequence(letters, phrase.replace(/[\s-]/g, ''))) continue
      out.push({ phrase, abbr })
      seen.add(abbr)
      break
    }
  }
  return out
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return i === needle.length
}

/**
 * The forms a claim term may take in a text: the term itself and the phrase
 * an abbreviation stands for (lower-case, matched in the lower-cased
 * window) and the abbreviation the text defines for the term (upper-case,
 * matched case-sensitively in the original window - "PER" is never the
 * "per" of "per cent").
 */
export function termForms(
  term: string,
  pairs: readonly { phrase: string; abbr: string }[],
): RegExp[] {
  const forms: RegExp[] = [new RegExp(spellings(escapeRegExp(term)).replace(/-/g, '-?\\s?'))]
  // A paper's table writes "Female" where the answer says "women".
  if (term === 'women' || term === 'woman') forms.push(/\bfemales?\b/)
  // The abbreviation every paper uses without defining it.
  if (term === 'interquartile') forms.push(/\biqrs?\b/i)
  if (term === 'confidence') forms.push(/\bci\b/i)
  // "147 died" is the paper's "147 deceased" or "147 deaths".
  if (term === 'died' || term === 'death' || term === 'deaths') {
    forms.push(/\bdeceased\b|\bdeaths?\b|\bdie\b/)
  }
  if (term === 'men' || term === 'man') forms.push(/(?<!fe)\bmales?\b/)
  for (const { phrase, abbr } of pairs) {
    if (phrase === term || phrase.endsWith(` ${term}`) || phrase.split(' ')[0] === term) {
      forms.push(new RegExp(`\\b${escapeRegExp(abbr)}s?\\b`))
    }
    if (abbr.toLowerCase() === term) {
      for (const word of phrase.split(' ')) {
        if (word.length >= 4 && !GENERIC.has(word)) forms.push(new RegExp(escapeRegExp(word)))
      }
    }
  }
  return forms
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * British and American spellings as one pattern: "enrolment" finds
 * "enrollment", "generalised" finds "generalized", "favourable" finds
 * "favorable" (loop 5 HC, XB). Applied to an escaped term.
 */
export function spellings(escaped: string): string {
  return escaped
    .replace(/^enrol(?!l)/, 'enroll?')
    .replace(/(?<=[a-z])i[sz](?=e|ed|es|ing|ation)/g, 'i[sz]')
    .replace(/(?<=[a-z])our(?=[a-z])/g, 'ou?r')
    .replace(/(?<=[a-z])ae(?=[a-z])/g, 'a?e')
}

// ---------------------------------------------------------------------------
// Outcomes and timepoints: a figure beside a different outcome or a
// different follow-up is a figure about something else
// ---------------------------------------------------------------------------

/** Outcome families, each matched in the lower-cased sentence or window. */
const OUTCOME_FAMILIES: [string, RegExp][] = [
  ['relapse', /\brelaps/],
  ['retention', /\bretention\b|\bretained\b/],
  ['seizure freedom', /\bseizure[- ]free|\bremission\b/],
  ['mortality', /\bmortality\b|\bdeaths?\b|\bdied\b|\bdeceased\b|\bsudep\b|\bfatal/],
  ['discontinuation', /\bdiscontinu|\bwithdraw/],
  [
    'response',
    /\brespon(?:se|der)|50\s?%\s*(?:\([^)]{0,30}\)\s*)?(?:seizure\s+)?reduction|reduction (?:of|in) seizure frequency|reduction from baseline in [a-z ]{0,20}seizure/,
  ],
  [
    'adverse events',
    /\badverse[- ](?:event|effect|reaction)|\btolerab|\bside[- ]effect|\bteaes?\b|\baes?\b/,
  ],
  ['functional outcome', /\bmrs\b|\bmodified rankin|\bfunctional outcome|\bdisabilit/],
  ['drug resistance', /\bdrug[- ]resist|\bdre\b|\brefractor|\bpharmacoresist/],
  ['recurrence', /\brecurren/],
  ['incidence', /\bincidence\b/],
  ['prevalence', /\bprevalence\b/],
  ['survival', /\bsurviv/],
  ['quality of life', /\bquality of life\b|\bqol/],
]

/** The outcome families a sentence or window names. */
export function outcomeFamilies(text: string): string[] {
  const lower = text.toLowerCase()
  return OUTCOME_FAMILIES.filter(([, re]) => re.test(lower)).map(([name]) => name)
}

const TIMEPOINT =
  /(?<![\d.])(\d+(?:\.\d+)?)[\s-]?(months?|mos?|weeks?|wks?|years?|yrs?|y|days?|d)\b(?!\s*(?:of age|old))/g

/** Follow-up timepoints in a text, in months: "12 months", "1-year", "52 weeks", "700 days" (23). */
export function timepointsInMonths(text: string): number[] {
  const out: number[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(TIMEPOINT)) {
    // A median or mean duration ("a median of 414 days", "mean retention
    // time 18.7 months", "a median time to first relapse of 414 days") is
    // a result, not the follow-up it was measured at.
    const before = lower.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0)
    if (
      /\b(?:median|mean|average)\b(?:\s+(?!at\b|follow)[a-z-]+){0,6}\s*(?:[\d.,]+\s*(?:\([^)]{0,30}\))?\s*)?$/
        .test(before)
    ) {
      continue
    }
    const value = Number(m[1])
    const unit = m[2]!
    const months = /^mo/.test(unit)
      ? value
      : /^w/.test(unit)
      ? value * 7 / 30.44
      : /^y/.test(unit)
      ? value * 12
      : value / 30.44
    // Hours-scale and decade-scale durations are not follow-up timepoints.
    if (months >= 0.9 && months <= 240) out.push(months)
  }
  return out
}

function sameTimepoint(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.5 + 0.08 * Math.max(a, b)
}

/**
 * Whether a window's timepoints contradict a sentence's: both name one and
 * none agree. A window naming none, or a sentence naming none, says
 * nothing either way.
 */
export function timepointConflict(sentence: readonly number[], window: string): boolean {
  if (sentence.length === 0) return false
  const found = timepointsInMonths(window)
  if (found.length === 0) return false
  return !sentence.some((s) => found.some((w) => sameTimepoint(s, w)))
}

/**
 * Whether a window's outcome families contradict a sentence's: the window
 * names outcomes and none of them is one the sentence names. "DRE occurred
 * in 31%" is not a relapse rate.
 */
export function outcomeConflict(sentence: readonly string[], window: string): boolean {
  if (sentence.length === 0) return false
  const found = outcomeFamilies(window)
  if (found.length === 0) return false
  return !sentence.some((s) => found.includes(s))
}

/** Whether a figure token is a follow-up timepoint rather than a result. */
function isTimepointFigure(figure: string): boolean {
  return /(?:month|week|year|day)s$/.test(figure)
}

/**
 * Whether the sentence states the figure as a sample or subgroup size -
 * "n = 605", "605 patients", "(2698/4201)" - rather than as a result. A
 * count is placed by its noun, not by an outcome: the paper's "included
 * 605 patients with psychiatric comorbidity" sits in a methods paragraph
 * that names no retention, and that is no contradiction (D3-02).
 */
export function isSampleSizeFigure(figure: string, normalisedSentence: string): boolean {
  if (/%|\.|mg|[a-z]/.test(figure)) return false
  const n = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\bn\\s*=\\s*${n}(?![\\d])|(?<![\\d.])${n}\\s+(?:[a-z-]+\\s+)?(?:patients|participants|subjects|adults|children|individuals|people|persons|cases|controls|women|men|pwe|episodes|records|respondents|eyes|samples)|(?<![\\d.])${n}\\s*[)/]|/\\s*${n}(?![\\d])|(?<![\\d.])${n}\\s*\\(\\d{1,3}(?:\\.\\d+)?\\s?%\\)|\\bout of\\s+${n}(?![\\d])`,
  ).test(normalisedSentence)
}

/** Whether a text's sentence writes the figure as a count of people: "n = 1644", "1644 adults". */
export function isCountOfPeople(figure: string, normalisedSentence: string): boolean {
  if (/%|\.|mg|[a-z]/.test(figure)) return false
  const n = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\bn\\s*=\\s*${n}(?![\\d])|(?<![\\d.])${n}\\s+(?:[a-z-]+\\s+)?(?:patients|participants|subjects|adults|children|individuals|people|persons|cases|controls|women|men|pwe|episodes|records|respondents|eyes|samples)`,
  ).test(normalisedSentence)
}

/**
 * The population a passage states its figure for, when it does: "in
 * patients with psychiatric comorbidity", "among children without a
 * structural cause". Lower-cased, without the preposition. Undefined when
 * the passage names no population.
 */
export function populationQualifier(passage: string): string | undefined {
  // The frame that opens the passage's sentence, after an optional
  // timepoint: "In patients with psychiatric comorbidity who ...", "At 12
  // months, among children without ...". A population named mid-sentence
  // qualifies a clause, not the figure.
  const m =
    /^\s*(?:(?:at|after|by|over)\s+[^,]{2,30},\s+)?(?:in|among|for)\s+(?:the\s+)?(?:patients|people|participants|adults|children|subjects|individuals|pwe|those)\s+((?:with|without)\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})(?=\s+(?:who|and|at|or|were|was|had|the|after|treated|receiving|on)\b|[,;:.(]|$)/i
      .exec(passage.replace(/\s+/g, ' '))
  if (!m) return undefined
  const qualifier = m[1]!.toLowerCase().trim()
  // A comparison of two populations ("with and without") names neither.
  if (/\bwith and without\b|\bwithout and with\b/.test(qualifier)) return undefined
  return qualifier
}

/**
 * The population a text states a figure for, when every occurrence of the
 * figure in the text opens with the same frame: a "71.1%" the paper gives
 * once for the whole cohort and once for a subgroup qualifies nothing,
 * while a "13.9%" it gives only "in patients with psychiatric
 * comorbidity" is that subgroup's figure (D3-07).
 */
export function qualifierForFigure(figure: string, text: PreparedSource): string | undefined {
  const re = figurePattern(figure, 'g')
  let qualifier: string | undefined
  let m: RegExpExecArray | null
  while ((m = re.exec(text.lower)) !== null) {
    const whole = ownSentenceBounds(text.original, m.index, false)
    const found = populationQualifier(text.original.slice(whole.start, whole.end))
    if (!found) return undefined
    if (qualifier !== undefined && found !== qualifier) return undefined
    qualifier = found
  }
  return qualifier
}

// ---------------------------------------------------------------------------
// The population clause (loop 6 D6-01): a located figure is bound to the
// group the sentence it lives in reports it for, not only to its outcome
// noun. "In patients with psychiatric comorbidity, seizure freedom was
// 16.0%" does not carry "in patients with psychiatric comorbidity who
// switched from levetiracetam to brivaracetam" - the paper gives that
// subgroup 13.9%, in the very next paragraph.
// ---------------------------------------------------------------------------

/**
 * The verb a trial allocates an arm with, and the arm it names: "patients
 * who received placebo", "randomised to perampanel", "treated with
 * brivaracetam". Used to tell one arm's figure from another's inside a
 * single sentence that reports both (review loop 8
 * D8-02: "39.7% and 22.1% of patients who received perampanel ... and
 * 35.7% and 17.1% of patients who received placebo", served as the
 * placebo arm's 22.1%).
 */
const ALLOCATION =
  /\b(?:received|receiving|randomi[sz]ed to|randomi[sz]ed into|allocated to|assigned to|treated with|switched to|converted to)\s+(?:the\s+)?([a-z][a-z-]{3,})/gi

/** The arm nearest a position in a sentence: the first after it, else the last before it. */
export function allocationArm(sentence: string, at = 0): string | undefined {
  const re = new RegExp(ALLOCATION.source, 'gi')
  let before: string | undefined
  let m: RegExpExecArray | null
  while ((m = re.exec(sentence)) !== null) {
    const arm = m[1]!.toLowerCase()
    if (ARM_STOP.has(arm)) continue
    if (m.index >= at) return arm
    before = arm
  }
  return before
}

/** Words an allocation verb is followed by that name no arm. */
const ARM_STOP = new Set([
  'their',
  'this',
  'that',
  'these',
  'those',
  'them',
  'both',
  'either',
  'other',
  'another',
  'first',
  'second',
  'third',
  'more',
  'less',
  'least',
  'from',
  'with',
  'only',
  'least',
  'treatment',
  'therapy',
  'medication',
  'drug',
  'study',
  'trial',
  'patients',
  'participants',
  'people',
  'adults',
  'children',
  'average',
])

/** The nouns a population frame names a group of people by. */
const POPULATION_NOUN =
  '(?:patients?|people|participants?|adults?|children|subjects?|individuals?|persons?|pwe|women|men|cases|controls|infants?|neonates?|those)'

/** The words that open a qualifier narrowing a population. */
const POPULATION_QUALIFIER_INTRO =
  '(?:with|without|who|whose|aged|receiving|taking|treated|switching|switched|on|under|having)'

/** "these patients", "this group", "of them": a population named by the sentence before it. */
const ANAPHORIC_POPULATION =
  /\b(?:these|those|this|the same|such)\s+(?:patients?|participants?|people|subjects?|individuals?|persons?|women|men|group|groups|cohort|subgroup)\b|\bof (?:these|them)\b|\bin (?:this|that) (?:group|subgroup|cohort)\b/

/** Words a population qualifier never narrows on. */
const POPULATION_STOP = new Set([
  'and',
  'the',
  'a',
  'an',
  'of',
  'from',
  'to',
  'in',
  'at',
  'for',
  'or',
  'who',
  'whose',
  'with',
  'without',
  'were',
  'was',
  'had',
  'has',
  'have',
  'their',
  'other',
  'both',
  'all',
  'any',
  'least',
  'more',
  'than',
  'over',
  'under',
  'after',
  'before',
  'during',
  'months',
  'month',
  'years',
  'year',
  'weeks',
  'week',
  'days',
  'day',
  'patients',
  'patient',
  'people',
  'participants',
  'adults',
  'children',
  'subjects',
  'individuals',
  'persons',
  'women',
  'men',
  'cases',
  'controls',
  'pwe',
  'respectively',
])

export interface ClaimPopulation {
  /** The qualifier as written, lower-cased ("with psychiatric comorbidity who switched from lev to brv"). */
  qualifier: string
  /** Its distinctive words, stemmed as claim terms are. */
  words: string[]
  /** The claim points back at a group the sentence before it named ("of these patients"). */
  anaphoric: boolean
}

/** The distinctive words of a population qualifier, stemmed as claim terms are. */
export function populationWords(qualifier: string): string[] {
  const out: string[] = []
  for (const w of qualifier.toLowerCase().match(/[a-z][a-z-]{1,}/g) ?? []) {
    const parts = w.includes('-') ? [w, ...w.split('-')] : [w]
    for (const part of parts) {
      if (part.length < 3 || POPULATION_STOP.has(part) || STOP.has(part)) continue
      const stem = part.replace(/s$/, '')
      if (!out.includes(stem)) out.push(stem)
    }
  }
  return out
}

/**
 * The population a claim states its figure for: the frame that opens the
 * clause ("In patients with psychiatric comorbidity who switched from LEV
 * to BRV, ...") or the one that follows the figure ("16.0% of patients
 * with psychiatric comorbidity who switched from LEV to BRV"). A
 * comparison of two groups ("with and without psychiatric comorbidity")
 * names neither and qualifies nothing. Undefined when the clause names no
 * population.
 */
export function claimPopulation(clause: string): ClaimPopulation | undefined {
  const text = clause.replace(/\s+/g, ' ').toLowerCase()
  if (ANAPHORIC_POPULATION.test(text)) {
    return { qualifier: '', words: [], anaphoric: true }
  }
  const re = new RegExp(
    `\\b(?:in|among|of|for)\\s+(?:the\\s+)?(?:\\d[\\d.,]*\\s*%?\\s+(?:of\\s+)?)?${POPULATION_NOUN}\\s+(${POPULATION_QUALIFIER_INTRO}\\b[^.;,()]*)`,
  )
  const m = re.exec(text)
  if (!m) return undefined
  // The qualifier ends where the predicate resumes: at the first comma or
  // bracket, never running on into what the sentence says about the group.
  let qualifier = m[1]!.trim()
  // "with and without X" is a contrast of two populations, not one.
  if (/\bwith and without\b|\bwithout and with\b/.test(qualifier)) return undefined
  qualifier = qualifier.replace(/\s+$/, '')
  const words = populationWords(qualifier)
  if (words.length === 0) return undefined
  return { qualifier, words, anaphoric: false }
}

/**
 * Whether a passage frames its figures with a population of its own ("in
 * patients with psychiatric comorbidity ...", "of patients who switched
 * from LEV to BRV ..."). Only such a passage can contradict a claim's
 * population; a passage that names no group says nothing about which
 * group its figure is for. A contrast of two groups ("with and without
 * psychiatric comorbidity") does frame a population, unlike a claim.
 */
export function statesPopulation(passage: string): boolean {
  const re = new RegExp(
    `\\b(?:in|among|of|for)\\s+(?:the\\s+)?(?:\\d[\\d.,]*\\s*%?\\s+(?:of\\s+)?)?${POPULATION_NOUN}\\s+${POPULATION_QUALIFIER_INTRO}\\b`,
  )
  return re.test(passage.replace(/\s+/g, ' ').toLowerCase())
}

// ---------------------------------------------------------------------------
// Exact outcomes (loop 6 D6-03): "continuous seizure freedom" is not
// "seizure freedom". A modifier the paper itself uses to tell two figures
// apart tells the claim apart from the figure too.
// ---------------------------------------------------------------------------

/** Modifiers that make an outcome a different outcome from the same family. */
const OUTCOME_MODIFIERS: [string, RegExp][] = [
  ['continuous', /\bcontinuous(?:ly)?\b/],
  ['sustained', /\bsustained\b/],
  ['complete', /\bcomplete(?:ly)?\b/],
  ['all-cause', /\ball[-\s]cause\b/],
  ['drug-related', /\b(?:drug|treatment)[-\s]related\b/],
  ['serious', /\bserious\b/],
  ['definite', /\bdefinite\b/],
  ['probable', /\bprobable\b/],
]

/** The outcome modifiers a phrase names. */
export function outcomeModifiers(text: string): string[] {
  const lower = text.toLowerCase()
  return OUTCOME_MODIFIERS.filter(([, re]) => re.test(lower)).map(([name]) => name)
}

/**
 * The clause of a located sentence that carries a position: its segments
 * split on semicolons and " and " outside brackets, so "seizure freedom
 * rates were ... 14.9% (n = 1111); and continuous seizure freedom rates
 * were ... 11.7% (n = 1111)" gives each figure its own outcome.
 */
export function clauseAround(sentence: string, at: number): string {
  const bounds: number[] = [0]
  let depth = 0
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i]!
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === ';') bounds.push(i + 1)
  }
  bounds.push(sentence.length)
  for (let i = 0; i < bounds.length - 1; i++) {
    if (at >= bounds[i]! && at < bounds[i + 1]!) {
      return sentence.slice(bounds[i]!, bounds[i + 1]!)
    }
  }
  return sentence
}

/**
 * Whether a located occurrence measures a different outcome from the claim
 * because one of them carries a modifier the other does not, in a passage
 * where the paper itself uses that modifier to tell two figures apart.
 * A paper that only ever writes "all-cause mortality" contradicts nothing
 * when the answer says "mortality"; a paper that reports seizure freedom
 * and continuous seizure freedom in one sentence does.
 */
export function outcomeModifierConflict(
  claimModifiers: readonly string[],
  occurrenceClause: string,
  distinguishes: (modifier: string) => boolean,
): boolean {
  const found = outcomeModifiers(occurrenceClause)
  const extra = found.filter((m) => !claimModifiers.includes(m))
  const missing = claimModifiers.filter((m) => !found.includes(m))
  if (extra.length === 0 && missing.length === 0) return false
  return [...extra, ...missing].some(distinguishes)
}

/**
 * Whether a paper itself uses a modifier to tell two figures of the same
 * outcome family apart: it states that family with a figure both with the
 * modifier and without it. A paper that only ever writes "all-cause
 * mortality" tells nothing apart, so an answer that says "mortality" is
 * not contradicted; a paper that reports seizure freedom and continuous
 * seizure freedom side by side does (loop 6 D6-03).
 */
export function distinguishesModifier(
  text: string,
  families: readonly string[],
  modifier: string,
): boolean {
  if (families.length === 0) return false
  const re = OUTCOME_MODIFIERS.find(([name]) => name === modifier)?.[1]
  if (!re) return false
  let withIt = false
  let withoutIt = false
  for (const clause of text.split(/;|(?<=[.!?])\s+|\n/)) {
    if (!/\d/.test(clause)) continue
    const lower = clause.toLowerCase()
    if (!families.every((f) => outcomeFamilies(lower).includes(f))) continue
    if (re.test(lower)) withIt = true
    else withoutIt = true
    if (withIt && withoutIt) return true
  }
  return false
}

/**
 * The bracket a position sits inside, when it does: the unmatched "(" or
 * "[" within 300 characters before it and its closer after it. A semicolon
 * or a line break inside a statistics bracket ("[χ2 = 6.94; odds ratio =
 * 10.00, 95% CI (1.68, 59.31)]") does not end the sentence the bracket
 * belongs to, and the window of a figure inside it is the sentence's
 * (loop 5 RB).
 */
export function bracketSpan(text: string, at: number): { open: number; close: number } | null {
  // The outermost unmatched opener: "(1.68, 59.31)" inside "[odds ratio =
  // 10.00, 95% CI (1.68, 59.31)]" belongs to the square bracket's sentence.
  let depth = 0
  const floor = Math.max(0, at - 300)
  let open = -1
  let unmatched = 0
  for (let i = at - 1; i >= floor; i--) {
    const ch = text[i]
    if (ch === ')' || ch === ']') depth++
    else if (ch === '(' || ch === '[') {
      if (depth === 0) {
        open = i
        unmatched++
      } else depth--
    }
  }
  if (open === -1) return null
  depth = 0
  const ceiling = Math.min(text.length, at + 300)
  for (let i = at; i < ceiling; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      if (depth === 0) {
        unmatched--
        if (unmatched === 0) return { open, close: i }
      } else depth--
    }
  }
  return null
}

/** The sentence a position falls in, within its paragraph, in the normalised text. */
export function ownSentenceBounds(
  text: string,
  at: number,
  /** Whether a semicolon before a word ends the clause, as in `claimWindowBounds`. */
  clauses = true,
): { start: number; end: number } {
  const span = bracketSpan(text, at)
  const from = span ? span.open : at
  const floor = Math.max(0, from - 500)
  const before = text.slice(floor, from)
  const clause = clauses ? ';\\s+(?=[a-z(])|' : ''
  // On a lower-cased text every sentence opens in lower case; on the
  // original a sentence opens with a capital, and an abbreviation's stop
  // ("Fig. S1a", "et al. 2020") is not a boundary.
  const opener = clauses
    ? '[.!?][\\d,-]{0,12}\\s+(?=[a-z0-9("])'
    : '(?<!\\b(?:Fig|Figs|et al|vs|e\\.g|i\\.e|No|approx|ca|cf|Dr|Prof|St|Suppl))[.!?][\\d,-]{0,12}\\s+(?=[A-Za-z0-9("])'
  const boundaries = [
    ...before.matchAll(new RegExp(`${opener}|${clause}${PARAGRAPH_MARK}\\s*`, 'g')),
  ].map((m) => m.index + m[0].length)
  const start = boundaries.length > 0 ? boundaries[boundaries.length - 1]! : 0
  const tail = span ? span.close + 1 : at
  return { start: floor + start, end: sentenceEnd(text, tail, 400, clauses) }
}

/**
 * Where the sentence (or clause) that continues at `from` ends: the first
 * stop, clause semicolon or paragraph mark outside any bracket, within
 * `max` characters; "(FAS; n = 1111)" is part of its sentence.
 */
function sentenceEnd(text: string, from: number, max: number, clauses: boolean): number {
  const ceiling = Math.min(text.length, from + max)
  let depth = 0
  for (let i = from; i < ceiling; i++) {
    const ch = text[i]!
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (depth > 0) continue
    if (ch === '.' || ch === '!' || ch === '?') {
      if (i + 1 >= text.length || /\s/.test(text[i + 1]!)) return i + 1
    } else if (clauses && ch === ';') {
      if (i + 1 >= text.length || /\s[a-z(]/.test(text.slice(i + 1, i + 3))) return i + 1
    } else if (ch === PARAGRAPH_MARK && i > from && /\s/.test(text[i - 1]!)) return i
  }
  return ceiling
}

/** A cited text prepared once for many figure checks. */
export interface PreparedSource {
  /** The normalised text, lower-cased; every index matches `original`. */
  lower: string
  /** The normalised text as written. */
  original: string
  pairs: { phrase: string; abbr: string }[]
}

export function prepareSource(text: string): PreparedSource {
  const original = normaliseText(text)
  return { lower: original.toLowerCase(), original, pairs: abbreviationPairs(original) }
}

// ---------------------------------------------------------------------------
// Locate first (review loop 5 D5-01 to D5-04): the
// figure is found in the cited paper's text and the sentence or table row
// that carries it is what the claim is judged against - never a window of
// nearby words alone.
// ---------------------------------------------------------------------------

/** One occurrence of a figure in a prepared text, with the sentence or table row that carries it. */
export interface LocatedFigure {
  /** Position of the figure in `text.lower`. */
  at: number
  /** The sentence that carries the figure (lower-cased), or the table row with its label and column headings. */
  sentence: string
  /** The figure's offset within `sentence`. */
  sentenceAt: number
  /** The same span of the original-case text. */
  sentenceOriginal: string
  /** The sentence and up to three before it within the paragraph (a table row's block is its own window), lower-cased. */
  window: string
  windowOriginal: string
  /** Whether the figure sits in a table row rather than prose. */
  row: boolean
  /** A table row's label: the words before its first number, and the label line the extraction put before it. */
  label: string
  /** Whether the row's label says its numbers are counts ("N (%)", "Number deceased"). */
  countRow: boolean
  /** The window's own paragraph up to the figure (a row's block): where an n paired with the figure may sit. */
  paragraph: string
  /** The whole paragraph the figure sits in (a row's whole block): where the frame naming its population sits. */
  paragraphFull: string
}

/** A paragraph of the normalised text: its bounds and its trimmed content. */
interface Paragraph {
  start: number
  end: number
}

function paragraphAt(text: string, at: number): Paragraph {
  const mark = text.lastIndexOf(PARAGRAPH_MARK, at)
  const start = mark === -1 ? 0 : mark + 1
  const next = text.indexOf(PARAGRAPH_MARK, at)
  const end = next === -1 ? text.length : next
  return { start, end }
}

function paragraphBefore(text: string, paragraph: Paragraph): Paragraph | null {
  if (paragraph.start <= 1) return null
  const end = paragraph.start - 1
  const mark = text.lastIndexOf(PARAGRAPH_MARK, end - 1)
  return { start: mark === -1 ? 0 : mark + 1, end }
}

/**
 * Whether a paragraph of the normalised text is an extracted table row:
 * two or more numbers, at most a short label of words, no sentence inside
 * it and no closing stop - "N (%) 868 (48%) 937 (52%)", "Number deceased
 * 60 87 63", "9 (4-14) 9 (5-13)", "Female, n (%) 13 (50%)".
 */
export function isRowParagraph(paragraph: string): boolean {
  const p = paragraph.trim()
  if (p.length === 0 || p.length > 400) return false
  const numbers = p.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?%?/g) ?? []
  if (numbers.length < 2) return false
  if (/[.!?]\s+[A-Za-z]/.test(p) || /[.!?]$/.test(p)) return false
  const letters = p.replace(/[\d.,%()[\]±<>=≤≥/–—-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return letters.length <= 70 && letters.split(' ').filter(Boolean).length <= 8
}

/** Whether a short paragraph is a table cell or caption rather than prose. */
function isCellParagraph(paragraph: string): boolean {
  const p = paragraph.trim()
  if (p.length === 0) return false
  if (/^(?:t\s?a\s?b\s?l\s?e|table)\s+s?\d+/i.test(p)) return p.length <= 220
  if (p.length > 90) return false
  return !/[.!?]\s+[A-Za-z]/.test(p) && !/[.!?]$/.test(p)
}

const CAPTION = /^(?:t\s?a\s?b\s?l\s?e|table)\s+s?\d+/i

/** "N (%)", "n", "No.", "Number deceased", "Deaths": a label under which bare numbers are counts. */
const COUNT_LABEL =
  /(?:^|[\s,(])(?:n|no\.?|number|count|counts|total|deaths?|deceased|died|patients|participants|subjects)(?:$|[\s,()%])/i

/**
 * The block a table row belongs to: the caption and column headings the
 * extraction placed before it (short cell paragraphs, skipping sibling
 * rows, at most fourteen paragraphs back and stopping at prose), the
 * label line put just before it, and the row itself. A figure in a table
 * cell is judged against its row label and its column headings, which is
 * where the paper says what the cell counts (loop 5 N12, E4, XA, DCB).
 */
function rowBlock(text: PreparedSource, paragraph: Paragraph): {
  spans: Paragraph[]
  label: string
} {
  const spans: Paragraph[] = [paragraph]
  const rowText = text.lower.slice(paragraph.start, paragraph.end).trim()
  const labelParts = [rowText.replace(/\d.*$/s, '').trim()]
  let previous = paragraphBefore(text.lower, paragraph)
  let steps = 0
  let adjacent = true
  while (previous && steps < 14) {
    const content = text.lower.slice(previous.start, previous.end).trim()
    steps++
    if (content.length === 0) {
      previous = paragraphBefore(text.lower, previous)
      continue
    }
    if (isRowParagraph(content)) {
      adjacent = false
      previous = paragraphBefore(text.lower, previous)
      continue
    }
    if (!isCellParagraph(content)) break
    spans.unshift(previous)
    if (adjacent && labelParts.length < 3) labelParts.push(content)
    if (CAPTION.test(content)) break
    previous = paragraphBefore(text.lower, previous)
  }
  return { spans, label: labelParts.filter((p) => p.length > 0).join(' ') }
}

/** The short forms a table's label writes a time unit in. */
const UNIT_IN_LABEL: Record<string, RegExp> = {
  years: /(?:^|[\s,(])(?:y|yr|yrs|years?)(?:$|[\s,)])/,
  months: /(?:^|[\s,(])(?:mo|mos|months?)(?:$|[\s,)])/,
  weeks: /(?:^|[\s,(])(?:wk|wks|weeks?)(?:$|[\s,)])/,
  days: /(?:^|[\s,(])(?:d|days?)(?:$|[\s,)])/,
  hours: /(?:^|[\s,(])(?:h|hr|hrs|hours?)(?:$|[\s,)])/,
}

/**
 * Every place a figure occurs in a prepared text, each with the sentence
 * or table row that carries it. A figure with a time unit is also found as
 * the bare number of a table row whose label names the unit ("Follow-up
 * duration, y, median (IQR)" over "9 (4-14) 9 (5-13)", loop 5 XA).
 */
export function locateFigure(figure: string, text: PreparedSource): LocatedFigure[] {
  const out: LocatedFigure[] = []
  const seen = new Set<number>()
  const place = (at: number, unitRow?: string) => {
    if (seen.has(at)) return
    const paragraph = paragraphAt(text.lower, at)
    const content = text.lower.slice(paragraph.start, paragraph.end)
    const row = isRowParagraph(content)
    if (unitRow && !row) return
    if (row) {
      const block = rowBlock(text, paragraph)
      if (unitRow && !UNIT_IN_LABEL[unitRow]!.test(block.label)) return
      const lower = block.spans.map((s) => text.lower.slice(s.start, s.end).trim()).join(
        ` ${PARAGRAPH_MARK} `,
      )
      const original = block.spans.map((s) => text.original.slice(s.start, s.end).trim()).join(
        ` ${PARAGRAPH_MARK} `,
      )
      seen.add(at)
      const rowRaw = text.lower.slice(paragraph.start, paragraph.end)
      const rowTrimmed = rowRaw.trim()
      const rowStart = lower.lastIndexOf(rowTrimmed)
      const inRow = at - paragraph.start - (rowRaw.length - rowRaw.trimStart().length)
      out.push({
        at,
        sentence: lower,
        sentenceAt: rowStart >= 0 ? rowStart + Math.max(0, inRow) : 0,
        sentenceOriginal: original,
        window: lower,
        windowOriginal: original,
        row: true,
        label: block.label,
        countRow: COUNT_LABEL.test(block.label),
        paragraph: lower,
        paragraphFull: lower,
      })
      return
    }
    const own = ownSentenceBounds(text.lower, at)
    const window = claimWindowBounds(text.lower, at)
    // The window may reach back over a paragraph mark (a table cell reaches
    // its heading); an n paired with the figure never comes from before one.
    const before = text.lower.slice(window.start, at)
    const paragraphStart = window.start + Math.max(0, before.lastIndexOf(PARAGRAPH_MARK) + 1)
    seen.add(at)
    out.push({
      at,
      sentence: text.lower.slice(own.start, own.end),
      sentenceAt: at - own.start,
      sentenceOriginal: text.original.slice(own.start, own.end),
      window: text.lower.slice(window.start, window.end),
      windowOriginal: text.original.slice(window.start, window.end),
      row: false,
      label: '',
      countRow: false,
      paragraph: text.lower.slice(paragraphStart, window.end),
      paragraphFull: text.lower.slice(paragraph.start, paragraph.end),
    })
  }
  const re = figurePattern(figure, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text.lower)) !== null) place(m.index)
  const time = /^(\d+(?:\.\d+)?)((?:month|week|year|day|hour)s)$/.exec(figure)
  if (time) {
    const bare = new RegExp(`(?<![\\d.])${time[1]!.replace('.', '\\.')}(?![\\d])`, 'g')
    while ((m = bare.exec(text.lower)) !== null) place(m.index, time[2])
  }
  return out
}

/** Words of a quantity phrase that name nothing about which quantity it is. */
const PHRASE_STOP = new Set([
  'rate',
  'rates',
  'ratio',
  'ratios',
  'level',
  'levels',
  'value',
  'values',
  'score',
  'scores',
  'group',
  'groups',
  'cohort',
  'cohorts',
  'patients',
  'participants',
  'subjects',
  'people',
  'persons',
  'individuals',
  'adults',
  'children',
  'women',
  'men',
  'cases',
  'controls',
  'study',
  'studies',
  'analysis',
  'trial',
  'month',
  'months',
  'week',
  'weeks',
  'year',
  'years',
  'day',
  'days',
  'hour',
  'hours',
  'time',
  'timepoint',
  'mark',
  'point',
  'least',
  'most',
  'more',
  'less',
  'than',
  'only',
  'about',
  'approximately',
  'around',
  'roughly',
  'nearly',
  'almost',
  'over',
  'under',
  'just',
  'total',
  'overall',
  'specifically',
  'respectively',
  'which',
  'that',
  'these',
  'those',
  'this',
  'with',
  'without',
  'from',
  'were',
  'was',
  'had',
  'has',
  'have',
  'been',
  'being',
  'each',
  'both',
  'all',
  'any',
  'per',
  'the',
  'and',
  'for',
  'stated',
  'reported',
  'not',
])

/** A verb or link that closes the phrase before a figure: "the rate was 33.6%", "included 1,216 patients". */
const PHRASE_LINK =
  /\b(?:was|were|is|are|of|at|reached|reaching|included|includes|comprised|comprising|involved|involving|totalled|totaled|had|has|showed|showing|reported|found|achieved|occurred in|experienced|documented|recorded|identified|enrolled|recruited|implanted|by|to|from|in|among|for|=|:)\s*(?:only|approximately|about|around|roughly|over|under|just|nearly|almost|up to|a|an|the|as|being)?\s*(?:approximately|about|around|roughly|nearly|almost|over)?\s*$/

/** Clause boundaries inside a claim sentence: each figure is judged with the clause it sits in. */
const CLAUSE_BREAK =
  /;|,\s*(?:while|whereas|and|but|compared|versus|vs\.?)\s|\s(?:while|whereas)\s/g

/** The designators and quoted titles of a clause: they name a study, not the quantity. */
const DESIGNATOR_PHRASE =
  /\b(?:the|this|that|a|an)\s+(?:[\w"'-]+\s+){0,6}?(?:cohort|study|trial|analysis|analyses|register|registry|paper|consortium|programme|program)\b|"[^"]{12,}"/g

export interface QuantityPhrase {
  /** The clause of the claim the figure sits in, lower-cased, as written. */
  rawClause: string
  /** The same clause with designators and quoted titles removed. */
  clause: string
  /** The distinctive words of the noun phrase the figure measures, lower-cased and stemmed as claim terms are. */
  words: string[]
  /** The claim's names that sit in that phrase: the intervention the figure is given to ("LITT achieved 76%"). */
  anchors: string[]
  /** The outcome families the phrase (or, failing that, the clause, or the sentence) names. */
  families: string[]
  /** Whether a percentage is a responder threshold in the claim ("50% responder rate"). */
  threshold: boolean
  /** The n the claim pairs with the figure in its own bracket ("14.9% (n = 1111)", "64.2% (2698/4201)"). */
  pairedNs: string[]
  /** The analysis set the claim names beside the figure ("FAS", "mFAS", "safety population"), lower-cased. */
  analysisSet?: string
  /** The population the claim states the figure for, when its clause names one (D6-01). */
  population?: ClaimPopulation
  /** The outcome modifiers the claim's clause names ("continuous", "all-cause") (D6-03). */
  modifiers: string[]
}

/**
 * The quantity a figure measures in the claim: the noun phrase before its
 * verb ("the adverse-event discontinuation rate was 33.6%"), the words
 * after it when the phrase is empty ("80% of EDs occur during sleep"), or
 * the label of the bracket it sits in ("(n = 4201, retention population)").
 * The located sentence in the paper must share one of its words, and every
 * outcome it names (all-cause is not adverse-event, loop 5 TFA); a
 * responder threshold in one must be a threshold in the other (loop 5
 * DCC); an n paired in the claim's bracket must be the paper's pairing
 * (loop 5 TFA, D4-05).
 */
export function quantityPhrase(
  claim: ClaimFeatures,
  figure: string,
  entities: ReadonlySet<string> = new Set(),
): QuantityPhrase {
  const sentence = claim.normalised
  const m = figurePattern(figure).exec(sentence)
  const empty: QuantityPhrase = {
    rawClause: sentence,
    clause: sentence,
    words: [],
    anchors: [],
    families: [],
    threshold: false,
    pairedNs: [],
    modifiers: outcomeModifiers(sentence),
  }
  if (!m) return empty
  const at = m.index
  const after = at + m[0].length
  // A range's or a confidence interval's upper bound says what it measures
  // before its lower bound, never between the two: "(95% CI: 1.07-4.68)",
  // "a range of 23 to 71 years" (loop 6 D6-05, D6-06). The phrase is read
  // from the lower bound, so both endpoints carry the same quantity.
  const phraseAt = rangeLowerBound(sentence, at) ?? at
  let clauseStart = 0
  let clauseEnd = sentence.length
  for (const b of sentence.matchAll(CLAUSE_BREAK)) {
    const i = b.index ?? 0
    if (i < at) clauseStart = i + b[0].length
    else if (i >= after && clauseEnd === sentence.length) clauseEnd = i
  }
  const rawClause = sentence.slice(clauseStart, clauseEnd)
  const clause = rawClause.replace(DESIGNATOR_PHRASE, ' ').replace(/\s+/g, ' ').trim()
  const stripped = sentence.replace(DESIGNATOR_PHRASE, ' ')
  const distinctive = (phrase: string): string[] => {
    const out: string[] = []
    for (const w of phrase.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
      const parts = w.includes('-') ? [w, ...w.split('-')] : [w]
      for (const part of parts) {
        if (part.length < 3 || STOP.has(part) || GENERIC.has(part) || PHRASE_STOP.has(part)) {
          continue
        }
        if (entities.has(part) || claim.anchors.includes(part)) continue
        if (/^(?:month|week|year|day|hour)s?$|^(?:mg|kg|ml)$/.test(part)) continue
        const stem = part.replace(/s$/, '')
        if (!out.includes(stem)) out.push(stem)
      }
    }
    return out
  }
  // The bracket the figure sits in, when it does: an n's label is the
  // analysis set after it; a statistic's label is the name before it.
  let phrase = ''
  const span = bracketSpan(sentence, phraseAt)
  if (span && span.open >= clauseStart) {
    const inside = sentence.slice(span.open + 1, phraseAt)
    if (/^\s*n\s*=\s*$/.test(inside)) {
      phrase = sentence.slice(after, span.close).replace(/^[\s,;]+/, '')
    } else if (/[a-z]{3,}/.test(inside)) {
      phrase = inside.replace(/[\d.,;:=%()-]+/g, ' ')
    }
  }
  // The words after the figure: "80% of EDs in this group occur", "24
  // completed the study", "937 patients had a psychiatric diagnosis".
  const following = (): string => {
    const rest = sentence.slice(after, clauseEnd).replace(
      /^\s*(?:of|out of|the|in|among|per)\s+/,
      '',
    )
    const cut = /[,;:.]|\s(?:which|that|with|compared|versus|vs\.?|at\s+\d)\b/.exec(rest)
    return (cut ? rest.slice(0, cut.index) : rest).split(/\s+/).slice(0, 8).join(' ')
  }
  // The subject before the figure's verb: "the adverse-event
  // discontinuation rate was 33.6%", "the safety population included 1216".
  const subject = (): string => {
    const before = sentence.slice(clauseStart, phraseAt)
    const link = PHRASE_LINK.exec(before)
    if (!link) return ''
    const words = before.slice(0, link.index).replace(DESIGNATOR_PHRASE, ' ').trim().split(/\s+/)
      .filter(Boolean)
    return words.slice(-8).join(' ')
  }
  if (!phrase.trim()) {
    const ofNoun = /^\s*(?:of|out of)\s+/.test(sentence.slice(after, clauseEnd))
    const candidates = ofNoun ? [following(), subject()] : [subject(), following()]
    phrase = candidates.find((c) => distinctive(c).length > 0) ?? ''
    if (!phrase) {
      const tail = sentence.slice(clauseStart, phraseAt).replace(DESIGNATOR_PHRASE, ' ').trim()
        .split(
          /\s+/,
        ).slice(-4).join(' ')
      if (distinctive(tail).length > 0) phrase = tail
    }
  }
  const words = distinctive(phrase)
  // The name the figure is given to sits in its subject ("LITT achieved
  // 76%") or in the phrase itself.
  const named = `${subject()} ${phrase}`
  const anchorsInPhrase = claim.anchors.filter((a) => named.includes(a))
  const phraseFamilies = outcomeFamilies(phrase.replace(DESIGNATOR_PHRASE, ' '))
  const families = phraseFamilies.length > 0
    ? phraseFamilies
    : outcomeFamilies(clause).length > 0
    ? outcomeFamilies(clause)
    : outcomeFamilies(stripped)
  const own = claimPopulation(rawClause) ?? claimPopulation(sentence)
  const population = own === undefined || own.anaphoric ? (claim.inheritedPopulation ?? own) : own
  return {
    rawClause,
    clause,
    words,
    anchors: anchorsInPhrase,
    families,
    threshold: figure.endsWith('%') && isThresholdAt(sentence, at, after),
    pairedNs: figure.endsWith('%') ? pairedNsAfter(sentence.slice(after)) : [],
    ...(analysisSetIn(sentence.slice(after, after + 60)) !== undefined
      ? { analysisSet: analysisSetIn(sentence.slice(after, after + 60))! }
      : {}),
    ...(population ? { population } : {}),
    modifiers: outcomeModifiers(rawClause),
  }
}

/**
 * The position of the lower bound of the range or interval a figure closes,
 * when it closes one: the number immediately before it across a dash or
 * "to" ("1.07- 4.68", "23 to 71"). Undefined otherwise.
 */
export function rangeLowerBound(sentence: string, at: number): number | undefined {
  const from = Math.max(0, at - 24)
  const before = sentence.slice(from, at)
  const m = /(?<![\d.,])(\d[\d.,]*%?)\s*(?:[-\u2010-\u2015]|\bto)\s*$/.exec(before)
  return m ? from + m.index : undefined
}

/**
 * The other endpoint of the range a figure closes or opens in a claim
 * ("a range of 23 to 71 years" pairs 23 with 71), or undefined when the
 * claim states no range around it.
 */
export function rangePartnerOf(sentence: string, figure: string): string | undefined {
  const m = figurePattern(figure).exec(sentence)
  if (!m) return undefined
  const at = m.index
  const after = at + m[0].length
  const lowerAt = rangeLowerBound(sentence, at)
  if (lowerAt !== undefined) {
    const lower = /^(\d[\d.,]*%?)/.exec(sentence.slice(lowerAt))
    if (lower) return lower[1]!.replace(/[.,%]+$/, '')
  }
  const upper = /^\s*(?:[-\u2010-\u2015]|to)\s*(\d[\d.,]*%?)/.exec(sentence.slice(after))
  if (upper) return upper[1]!.replace(/[.,%]+$/, '')
  return undefined
}

/** Whether a passage writes two figures as one range, in the claim's order. */
export function rangeInSentence(passage: string, figure: string, partner: string): boolean {
  const a = figurePattern(figure).source
  const b = figurePattern(partner).source
  const join = '\\s*(?:[-\\u2010-\\u2015]|to|and)\\s*'
  return new RegExp(`${b}${join}${a}|${a}${join}${b}`).test(passage)
}

/** The analysis set named in a fragment ("FAS", "mFAS", "full analysis set", "safety population"). */
export function analysisSetIn(fragment: string): string | undefined {
  const lower = fragment.toLowerCase()
  if (/\bmfas\b|\bmodified full analysis set\b/.test(lower)) return 'mfas'
  if (/\bfas\b|\bfull analysis set\b/.test(lower)) return 'fas'
  if (/\bsafety (?:population|set)\b|\btolerability population\b/.test(lower)) return 'safety'
  if (/\bretention population\b/.test(lower)) return 'retention'
  if (/\bitt\b|\bintention[- ]to[- ]treat\b/.test(lower)) return 'itt'
  if (/\bper[- ]protocol\b/.test(lower)) return 'pp'
  return undefined
}

/**
 * Whether the percentage at a position is a responder threshold rather
 * than a rate: "≥ 50% seizure reduction", "at least 50% reduction", "the
 * 50% responder rate". A rate of 50% is none of these.
 */
export function isThresholdAt(text: string, at: number, after: number): boolean {
  const before = text.slice(Math.max(0, at - 16), at)
  const rest = text.slice(after, after + 40)
  if (/(?:[≥>]\s?=?\s?|at least\s|more than\s|greater than\s|over\s)$/.test(before)) return true
  if (/^\s+or\s+(?:greater|more|higher)\b/.test(rest)) return true
  if (/^\s+respon/.test(rest)) return true
  // "a 50% reduction" defines a responder; "a 45.7% reduction in seizure
  // frequency" is a measured change. A threshold is a round figure.
  const round = /^(?:25|50|75|90|100)\s?%$/.test(text.slice(at, after).trim())
  return round &&
    /^\s+(?:(?:seizure|seizure[- ]frequency)\s+)?reduction/.test(rest)
}

/** The n a claim pairs with a share in the bracket after it: "(n = 1111)", "(2698/4201)", "(395 out of 1,674)". */
export function pairedNsAfter(rest: string): string[] {
  const m = /^[^%\d(]{0,40}?\(\s*(?:n\s*=\s*)?(\d[\d,]*)(?:\s*(?:\/|out of|of)\s*(\d[\d,]*))?/.exec(
    rest,
  )
  if (!m) return []
  return [m[1]!, m[2]].filter((n): n is string => n !== undefined).map((n) => n.replace(/,/g, ''))
}

/**
 * The ns a located text pairs with the share at an occurrence: the bracket
 * after it ("14.9% (n = 1111)", "64.2% (2698/4201)"), or the count before
 * it in a "13 (50%)" cell with the whole its block gives ("(N = 26)",
 * "of 1805"). Empty when the text pairs nothing with the figure there.
 */
export function pairedNsAt(lower: string, occ: LocatedFigure, figureLength: number): string[] {
  const rest = lower.slice(occ.at + figureLength, occ.at + figureLength + 60)
  const after =
    /^\s*\(\s*(?:[a-z]{2,6}\s*[;:,]\s*)?(?:n\s*=\s*)?(\d[\d,]*)(?:\s*(?:\/|out of|of)\s*(\d[\d,]*))?/
      .exec(rest)
  const out: string[] = []
  if (after) {
    for (const n of [after[1], after[2]]) if (n) out.push(n.replace(/,/g, ''))
    return out
  }
  // "19 patients (28%)" pairs 19 with the share just as "19 (28%)" does:
  // the noun the count counts may sit between them (loop 8 D8-05).
  const before = lower.slice(Math.max(0, occ.at - 40), occ.at)
  const counted = /(\d[\d,]*)(?: [a-z][a-z-]{2,}){0,3} \($/.exec(before)
  if (counted?.[1] && /^\s*\)/.test(rest)) {
    out.push(counted[1].replace(/,/g, ''))
    for (
      const w of occ.window.matchAll(
        /\bn\s*=\s*(\d[\d,]*)|\b(?:of|among)\s+(?:the\s+)?(\d[\d,]{2,})\b/g,
      )
    ) {
      const n = (w[1] ?? w[2])?.replace(/,/g, '')
      if (n && !out.includes(n)) out.push(n)
    }
  }
  return out
}

/**
 * Whether a count and an n make the share, as the paper and the claim
 * state them between them: "19 patients (28%)" in the paper and "(n = 67)"
 * in the claim are the same result, because 19/67 rounds to 28%
 * (review loop 8 D8-05). The tolerance is the
 * rounding the share itself shows, so a one-decimal share is held to a
 * tenth of a point.
 */
export function sharePairs(figure: string, count: string, n: string): boolean {
  const share = /^(\d+(?:\.\d+)?)\s*%$/.exec(figure.trim())
  if (!share) return false
  const value = Number(share[1])
  const numerator = Number(count.replace(/,/g, ''))
  const denominator = Number(n.replace(/,/g, ''))
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return false
  if (numerator > denominator) return false
  const decimals = (share[1]!.split('.')[1] ?? '').length
  const tolerance = 0.5 / Math.pow(10, decimals) + 0.01
  return Math.abs((numerator / denominator) * 100 - value) <= tolerance
}

/** What a sentence brings to a figure check, computed once per sentence. */
export interface ClaimFeatures {
  anchors: string[]
  words: string[]
  content: string[]
  /** Anchors the question also names: the cohort, drug or study the figure is attributed to. */
  mandatory: string[]
  outcomes: string[]
  timepoints: number[]
  /** Every figure the sentence states: two of them in one window place the claim. */
  figures: string[]
  /** The sentence as normalised, for the figure-plus-noun check. */
  normalised: string
  /** The population an earlier sentence named, when this one only points back at it. */
  inheritedPopulation?: ClaimPopulation
}

export function claimFeatures(
  sentence: string,
  lexicon: readonly string[],
  questionEntities: readonly string[] = [],
  /** The population an earlier sentence named, when this one only points back at it. */
  inheritedPopulation?: ClaimPopulation,
): ClaimFeatures {
  // "Thirteen participants" reads "13 participants" on the answer's side
  // too, so the count is checked and the word is not a claim term.
  const digits = numberWordsToDigits(sentence)
  const { anchors, words, content } = claimTerms(digits, lexicon)
  const question = new Set(questionEntities.map((e) => e.toLowerCase()))
  return {
    anchors,
    words,
    content,
    mandatory: anchors.filter((a) => question.has(a)),
    ...(inheritedPopulation ? { inheritedPopulation } : {}),
    outcomes: outcomeFamilies(sentence),
    timepoints: timepointsInMonths(normaliseFigures(digits)),
    figures: extractNumbers(sentence),
    // The claim is read as the sources are: "1,805 adults" is "1805 adults".
    normalised: normaliseFigures(digits).toLowerCase().replace(/,(?=\d{3}\b)/g, ''),
  }
}

/** A percentage, a decimal or a count of three digits or more: a figure unlikely to recur by chance. */
function isSpecificFigure(figure: string): boolean {
  return /%|\./.test(figure) || /^\d{3,}/.test(figure)
}

/**
 * Whether one text carries the figure beside the claim. The figure is
 * located first: each occurrence brings the sentence or table row that
 * carries it (and, for prose, the window of up to three sentences before
 * it within the paragraph). The claim is placed when that sentence shares
 * one of the claim's names, two of its specific words, the noun the figure
 * qualifies, a word of the quantity the figure measures, every outcome that
 * quantity names, or the name the question routes on; a table cell is
 * placed by its row label and column headings, and a "13 (50%)" cell by
 * the pair of figures the claim states together. The located sentence must
 * then not attribute the figure to a different outcome, follow-up,
 * statistic, responder threshold or denominator pairing. Every name the
 * figure's own clause gives it must be somewhere in the text: a figure the
 * sentence gives the Melbourne cohort cannot come from a paper that never
 * mentions Melbourne.
 */
export function figureSupportedBy(
  figure: string,
  claim: ClaimFeatures,
  text: PreparedSource,
): { supported: boolean; reason?: FigureCheck['reason']; passage?: string } {
  const anchorForms = claim.anchors.map((a) => termForms(a, text.pairs))
  const wordForms = claim.words.map((w) => termForms(w, text.pairs))
  const contentForms = claim.content.map((w) => termForms(w, text.pairs))
  const hits = (forms: RegExp[][], lower: string, original: string) =>
    forms.filter((alternatives) => alternatives.some((re) => re.test(lower) || re.test(original)))
      .length
  const quantity = quantityPhrase(claim, figure, new Set(claim.anchors))
  // A comparison sentence gives each study its own figure (loop 5 ED):
  // each paper is asked only for the names of the clause its figure sits
  // in, and for every one of them.
  for (const name of claim.mandatory) {
    if (!quantity.rawClause.includes(name)) continue
    const forms = termForms(name, text.pairs)
    if (!forms.some((re) => re.test(text.lower) || re.test(text.original))) {
      return { supported: false, reason: 'entity' }
    }
  }
  const phraseForms = quantity.words.map((w) => termForms(w, text.pairs))
  const routingForms = claim.mandatory.map((name) => termForms(name, text.pairs))
  const foreign = quantity.anchors.filter((a) => !isSubjectOf(a, text)).map((a) =>
    termForms(a, text.pairs)
  )
  // The noun the figure qualifies in the sentence: "220 participants",
  // "80% of EDs".
  const SMALL = '(?:\\s+(?:of|the|in|among|a|an|per|with))*'
  const nounMatch = new RegExp(`${figurePattern(figure).source}${SMALL}\\s+([a-z][a-z-]{2,})`)
    .exec(claim.normalised)
  const noun = nounMatch?.[1]
  // A count of people is placed by any noun for people: "147 patients
  // died" is the paper's "147 deceased PWE".
  const PEOPLE =
    /^(?:patient|participant|subject|adult|child|individual|people|person|pwe|case|control|women|men|deceased|death)/
  const nounRe = noun
    ? new RegExp(
      `${figurePattern(figure).source}${SMALL}\\s+${
        PEOPLE.test(noun)
          ? '(?:patients?|participants?|subjects?|adults?|children|individuals?|people|persons?|pwe|cases?|controls?|women|men|deceased|deaths?|died)'
          : escapeRegExp(noun.slice(0, 5))
      }`,
    )
    : null
  const sampleSize = isSampleSizeFigure(figure, claim.normalised)
  const timepoint = isTimepointFigure(figure)
  const result = !sampleSize && !timepoint
  // The follow-up the figure is stated at is the one in its own clause: a
  // "12-week trial" the question plans for is not the follow-up of the
  // placebo rate the sentence quotes (loop 5 TFD).
  const claimTimepoints = quantity.clause === claim.normalised
    ? claim.timepoints
    : timepointsInMonths(quantity.clause)
  // The other endpoint of the range the claim states this figure in.
  const rangePartner = rangePartnerOf(claim.normalised, figure)
  // Whether this paper uses an outcome modifier to tell two figures apart,
  // computed once per claim and cached.
  const distinguishing = new Map<string, boolean>()
  const distinguishes = (modifier: string): boolean => {
    let known = distinguishing.get(modifier)
    if (known === undefined) {
      known = distinguishesModifier(text.lower, quantity.families, modifier)
      distinguishing.set(modifier, known)
    }
    return known
  }
  // The population the claim states the figure for: the located sentence's
  // own population must cover it (loop 6 D6-01).
  const population = quantity.population?.anaphoric === false ? quantity.population : undefined
  const populationForms = (population?.words ?? []).map((w) => termForms(w, text.pairs))
  let reason: FigureCheck['reason'] = 'absent'
  for (const occ of locateFigure(figure, text)) {
    const lower = occ.window
    const original = occ.windowOriginal
    const ownSentence = occ.sentence
    const ownOriginal = occ.sentenceOriginal
    let beside = false
    // Two of the sentence's figures in one window ("937 (52%)", "14%-35%")
    // place a claim that names nothing: two numbers matching at once is not
    // a coincidence, as long as the companion is a share, a decimal or a
    // large count rather than a small integer or a timepoint a table
    // repeats. A sentence that names an intervention, cohort or study
    // still needs that name beside the figure.
    const companions = claim.figures.filter((o) =>
      o !== figure && !isTimepointFigure(o) && isSpecificFigure(o) && figurePattern(o).test(lower)
    )
    if (claim.anchors.length === 0 && claim.words.length === 0 && claim.content.length === 0) {
      beside = true
    } else if (claim.anchors.length === 0 && companions.length > 0) {
      beside = true
    } else if (nounRe && nounRe.test(lower)) {
      beside = true
    } else if (claim.anchors.length > 0 && hits(anchorForms, lower, original) >= 1) {
      beside = true
    } else if (
      claim.anchors.length === 0 && claim.words.length > 0 &&
      hits(wordForms, lower, original) >= Math.min(2, claim.words.length)
    ) {
      // Without names, two of the claim's words must be there - a lone
      // "seizure" next to a "21%" in an epilepsy paper says nothing about
      // which 21% that is.
      beside = true
    } else if (claim.anchors.length === 0 && claim.content.length > 0) {
      // A sentence of generic words ("the sample size is 220 participants,
      // 110 per group") is placed by most of its content words together.
      const found = hits(contentForms, lower, original)
      beside = found >= Math.min(3, claim.content.length) && found / claim.content.length >= 0.5
    } else if (
      claim.anchors.length > 0 && claim.words.length >= 3 && hits(wordForms, lower, original) >= 3
    ) {
      // Names all absent from the window: three of the claim's own words
      // still place it - a paper that names the drug once in the methods
      // and writes "the drug" thereafter is not a misattribution.
      beside = true
    }
    if (
      !beside && claim.anchors.length === 0 && claim.outcomes.length > 0 &&
      !timepoint && !sampleSize &&
      outcomeFamilies(ownSentence).some((o) => claim.outcomes.includes(o)) &&
      (claimTimepoints.length === 0 ||
        timepointsInMonths(lower).some((w) => claimTimepoints.some((s) => sameTimepoint(s, w))))
    ) {
      // A claim that names no intervention, cohort or study is placed by
      // its outcome: the figure, with its unit, in a sentence about the
      // claim's own outcome at the claim's own follow-up. "BRV retention
      // was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months" carries the
      // 12-month retention of 71.1% whatever the answer called the cohort
      // (D3-02). A claim that names LITT still needs LITT beside it.
      beside = true
    }
    // Locate first (loop 5 D5-01): the sentence or table row that carries
    // the figure places the claim when it shares a word of the quantity
    // the figure measures ("80% of EDs" beside "80% of EDs in Group 1",
    // "24 completed" beside "24 participants completed"), every outcome
    // that quantity names, or the name the question routes on. A table
    // cell is placed by its row label and column headings, and a "13
    // (50%)" cell by the count and share the claim states together.
    // A name the figure's own phrase gives it ("LITT achieved 76%") must
    // still be in the window, unless the paper is about that name (it
    // abbreviates it, or names it throughout): an RFTC review's 76% is
    // not LITT's, while the EXPERIENCE paper's seizure freedom rates are
    // brivaracetam's on every page.
    const named = foreign.every((forms) => forms.some((re) => re.test(lower) || re.test(original)))
    if (
      !beside && named && phraseForms.length > 0 &&
      hits(phraseForms, ownSentence, ownOriginal) >= 1
    ) {
      beside = true
    }
    if (
      !beside && named && result && quantity.families.length > 0 &&
      quantity.families.every((f) => outcomeFamilies(ownSentence).includes(f))
    ) {
      beside = true
    }
    if (
      !beside && named && routingForms.length > 0 &&
      hits(routingForms, ownSentence, ownOriginal) >= 1
    ) {
      beside = true
    }
    if (!beside && named && occ.row && countWithShare(claim, figure, ownSentence)) beside = true
    // A range the claim states ("a range of 23 to 71 years") is placed by
    // the same two numbers written as a range in the located sentence
    // ("(range = 23-71)"): two specific numbers in the same order is not a
    // coincidence (loop 6 D6-06).
    if (
      !beside && named && rangePartner !== undefined &&
      rangeInSentence(ownSentence, figure, rangePartner)
    ) {
      beside = true
    }
    if (!beside && sampleSize && isCountOfPeople(figure, ownSentence)) {
      // A count the answer states as a sample size ("n = 1644") is placed
      // by the paper writing it as a count of people too ("1644 adults",
      // "n = 1644") - never by a bare table cell "38 (79)", which counts
      // something else; the sentence's other figures still have to match.
      beside = true
    }
    // A bare number on a count row ("Number deceased 60 87") is a count of
    // what the label and headings say: the claim must share a word or an
    // outcome with them (loop 5 E4).
    // The column headings apply to every row, so only the row's own label
    // can say what its numbers count: "Number deceased" is the deaths,
    // whatever a "Depressive disorder" column heading says above it.
    const countRowPlaced = occ.countRow && sampleSize && named &&
      (hits(phraseForms, occ.label, occ.label) >= 1 ||
        hits(wordForms, occ.label, occ.label) >= 1 ||
        (quantity.families.length > 0 &&
          quantity.families.every((f) => outcomeFamilies(occ.label).includes(f))))
    if (!beside && countRowPlaced) beside = true
    // And the other way round: a sample size the claim states is never
    // placed by a bare number in a range or a score ("[6-231]") whatever
    // names sit beside it; the text's own sentence must count with it.
    if (beside && sampleSize && !isSampleSizeFigure(figure, ownSentence) && !countRowPlaced) {
      if (reason === 'absent') reason = 'terms'
      continue
    }
    if (!beside) {
      if (reason === 'absent') reason = 'terms'
      continue
    }
    // The claim's population must be entailed by the population the located
    // passage reports the figure for: "patients with psychiatric
    // comorbidity" does not carry "patients with psychiatric comorbidity
    // who switched from LEV to BRV", whose figure the paper gives in the
    // next paragraph (loop 6 D6-01). The passage is the located sentence
    // and the ones before it in its own paragraph, so a population the
    // paper frames a paragraph with still counts.
    if (result && populationForms.length > 0 && statesPopulation(occ.paragraphFull)) {
      // The frame that opens a paragraph names the population of every
      // figure in it, so the whole paragraph is what must cover the claim.
      // A passage that frames no population of its own contradicts none.
      const where = `${lower} ${occ.paragraphFull} ${occ.label}`
      const whereOriginal = `${original} ${occ.paragraphFull} ${occ.label}`
      const covered = populationForms.every((forms) =>
        forms.some((re) => re.test(where) || re.test(whereOriginal))
      )
      if (!covered) {
        reason = 'population'
        continue
      }
    }
    // The arm the figure belongs to, where both the claim and the located
    // sentence allocate one: a sentence reporting two arms gives each
    // figure to the arm its own phrase names, so a claim that says
    // "patients who received placebo" is not carried by the number sitting
    // beside "patients who received perampanel" (loop 8 D8-02).
    if (result) {
      const claimArm = allocationArm(quantity.rawClause)
      const sourceArm = allocationArm(ownSentence, occ.sentenceAt)
      if (
        claimArm && sourceArm && claimArm !== sourceArm &&
        !termForms(claimArm, text.pairs).some((re) => re.test(sourceArm)) &&
        !termForms(sourceArm, text.pairs).some((re) => re.test(claimArm))
      ) {
        reason = 'population'
        continue
      }
    }
    // The outcome test is exact where the paper itself is exact:
    // "continuous seizure freedom" does not answer "seizure freedom" in a
    // paper that reports both (loop 6 D6-03).
    if (
      result &&
      outcomeModifierConflict(
        quantity.modifiers,
        clauseAround(ownSentence, occ.sentenceAt),
        distinguishes,
      )
    ) {
      reason = 'outcome'
      continue
    }
    // The statistic's own qualifier travels with the figure: an "adjusted"
    // ratio is placed only by a passage that says adjusted (or names the
    // multivariable model), and a median by a passage that says median,
    // never by a table's univariable column or a sentence about the mean
    // (D4-18). The claim's terms are otherwise satisfied, so the reason
    // stays 'terms'.
    if (result && statisticQualifierConflict(claim, lower, quantity.rawClause)) {
      if (reason === 'absent') reason = 'terms'
      continue
    }
    // A sample size is placed by its noun and contradicts no outcome or
    // follow-up; a result is judged by the sentence it sits in first, then
    // by the passage before it.
    if (result) {
      if (timepointConflict(claimTimepoints, lower)) {
        reason = 'timepoint'
        continue
      }
      // Every outcome the quantity names must be in the located sentence's
      // window: an all-cause discontinuation is not an adverse-event
      // discontinuation, and a worsening-frequency rate is not a seizure
      // freedom rate (loop 5 TFA, XB).
      if (
        quantity.families.length > 0 &&
        !quantity.families.every((f) => outcomeFamilies(lower).includes(f))
      ) {
        reason = 'outcome'
        continue
      }
      const ownOutcomes = outcomeFamilies(ownSentence)
      const conflict = ownOutcomes.length > 0
        ? outcomeConflict(claim.outcomes, ownSentence)
        : outcomeConflict(claim.outcomes, lower)
      if (conflict) {
        reason = 'outcome'
        continue
      }
      // A responder threshold is not a rate: the paper's "50% responder
      // rate" cannot vouch for "the responder rate was 50%" (loop 5 DCC).
      if (figure.endsWith('%')) {
        const length = (figurePattern(figure).exec(text.lower.slice(occ.at)) ?? [''])[0].length
        if (quantity.threshold !== isThresholdAt(text.lower, occ.at, occ.at + length)) {
          if (reason === 'absent') reason = 'terms'
          continue
        }
        // The n the claim pairs with the share in its own bracket must be
        // the paper's pairing for that share: the bracket the located
        // sentence gives, or, when it gives none, an n in its window
        // (loop 5 TFA, TDE; D4-05).
        if (quantity.pairedNs.length > 0) {
          const paired = pairedNsAt(text.lower, occ, length)
          // A paper that names the analysis set beside the figure and its
          // size elsewhere ("Analyses included 1644 adults ... BRV
          // retention was ... 71.1% ... (FAS; Fig. 1d)") pairs that n with
          // the figure just as surely as a bracket would (loop 6 D6-06).
          const sameSet = quantity.analysisSet !== undefined &&
            analysisSetIn(ownSentence) === quantity.analysisSet
          // "full analysis set" is a claim about the paper's own wording.
          // Where the paper pairs no n with the figure at all, the claim's
          // whole bracket - the n and the set it names - has to come from
          // the figure's own sentence, or the answer assembled it: a
          // mixture-model class's 22% was served as "22% (n = 1,674, full
          // analysis set)" that way (loop 8 D8-01).
          if (
            paired.length === 0 && quantity.analysisSet !== undefined && !sameSet &&
            analysisSetIn(occ.label) !== quantity.analysisSet
          ) {
            if (reason === 'absent') reason = 'terms'
            continue
          }
          // A claim that gives the cohort n agrees with a paper that gives
          // the numerator, when the two make the share: "28% (n = 67)"
          // against "19 patients (28%)" is 19/67 = 28% (loop 8 D8-05).
          const agrees = paired.length > 0
            ? quantity.pairedNs.some((n) => paired.includes(n)) ||
              paired.some((c) => quantity.pairedNs.some((n) => sharePairs(figure, c, n)))
            // The n must come from the figure's own sentence or its table
            // row, never from elsewhere in the paragraph: a mixture-model
            // class's 22% took the pooled 1,674 that way (loop 8 D8-01).
            : quantity.pairedNs.some((n) =>
              figurePattern(n).test(occ.sentence) || figurePattern(n).test(occ.label)
            ) ||
              (sameSet && quantity.pairedNs.some((n) => isCountOfPeople(n, text.lower)))
          if (!agrees) {
            if (reason === 'absent') reason = 'terms'
            continue
          }
        }
      }
    }
    // The passage reported is the whole sentence: its opening frame names
    // the population the figure is for. Bounds read on the original case:
    // a lower-cased "Fig. S1a" would read as a sentence end.
    if (occ.row) return { supported: true, passage: ownOriginal }
    const whole = ownSentenceBounds(text.original, occ.at, false)
    return { supported: true, passage: text.original.slice(whole.start, whole.end) }
  }
  return { supported: false, reason }
}

/**
 * Whether a paper is about a name: it defines an abbreviation for it, or
 * names it eight times or more. The EXPERIENCE paper is about
 * brivaracetam; an RFTC review that compares itself with LITT is not
 * about LITT.
 */
export function isSubjectOf(name: string, text: PreparedSource): boolean {
  const forms = termForms(name, text.pairs)
  if (text.pairs.some((p) => p.phrase === name || p.phrase.endsWith(` ${name}`))) return true
  let count = 0
  const re = new RegExp(forms[0]!.source, 'g')
  while (re.exec(text.lower) !== null && count < 8) count++
  return count >= 8
}

/**
 * Whether a table cell pairs a count and a share the claim states together:
 * the claim's "13 out of 26, or 50%" is the row's "Female, n (%) 13 (50%)"
 * (loop 5 DCB).
 */
export function countWithShare(claim: ClaimFeatures, figure: string, row: string): boolean {
  const counts = claim.figures.filter((f) => f !== figure && /^\d+$/.test(f))
  const shares = claim.figures.filter((f) => f !== figure && f.endsWith('%'))
  if (figure.endsWith('%')) {
    return counts.some((c) =>
      new RegExp(`(?<![\\d.])${c}\\s*\\(${escapeRegExp(figure)}\\)`).test(row)
    )
  }
  if (/^\d+$/.test(figure)) {
    return shares.some((s) =>
      new RegExp(`(?<![\\d.])${figure}\\s*\\(${escapeRegExp(s)}\\)`).test(row)
    )
  }
  return false
}

/**
 * Whether the claim qualifies its statistic in a way the window does not:
 * the claim says "adjusted" (or writes aHR, aOR) and the window never says
 * adjusted or multivariable; the claim says "median" and the window gives a
 * mean but no median, or the other way round.
 */
export function statisticQualifierConflict(
  claim: ClaimFeatures,
  window: string,
  /** The clause the figure sits in: a "median" elsewhere in the sentence qualifies another figure. */
  clause?: string,
): boolean {
  const sentence = clause ?? claim.normalised
  if (
    /\badjusted\b|\ba(?:hr|or|rr|irr)\b/.test(sentence) &&
    !/\badjust|\bmultivaria|\ba(?:hr|or|rr|irr)\b/.test(window)
  ) return true
  if (/\bmedian\b/.test(sentence) && /\bmean\b/.test(window) && !/\bmedian\b/.test(window)) {
    return true
  }
  if (/\bmean\b/.test(sentence) && /\bmedian\b/.test(window) && !/\bmean\b/.test(window)) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// "all p < x" is a claim about each outcome the sentence lists
// ---------------------------------------------------------------------------

export interface PValueListClaim {
  /** The outcomes the sentence lists before the bound, lower-cased. */
  items: string[]
  /** The bound as written: "0.001", "0.05". */
  bound: string
  /** "<" or "=". */
  operator: string
}

/**
 * The "absenteeism, presenteeism and activity impairment (all p < 0.001)"
 * form: a list of outcomes followed by one bound for all of them. The
 * items are the comma- or "and"-separated phrases of the clause before
 * the bracket, each cut to its last four words. Undefined when the
 * sentence carries no such claim.
 */
export function pValueListClaim(sentence: string): PValueListClaim | undefined {
  const m = /([^.;:()]{8,240}?)\s*\(\s*all\s+p\s*([<=≤])\s*(0?\.\d+)\s*\)/i.exec(
    normaliseFigures(sentence),
  )
  if (!m) return undefined
  const clause = m[1]!.replace(
    /\b(?:over|at|after|within)\s+\d+\s+(?:months?|weeks?|years?)\b/gi,
    '',
  )
  const lead = clause.split(
    /\b(?:reductions?|increases?|improvements?|changes?|decreases?)\s+in\s+/i,
  )
  const list = lead.length > 1 ? lead[lead.length - 1]! : clause
  const items = list
    .split(/,\s*|\s+and\s+/i)
    .map((s) =>
      s.toLowerCase().replace(/^(?:and|or)\s+/, '').replace(/[^a-z\s-]/g, ' ').trim().split(/\s+/)
        .slice(-4).join(' ')
    )
    .filter((s) => s.length >= 4)
  if (items.length < 2) return undefined
  return { items, bound: m[3]!.replace(/^\./, '0.'), operator: m[2] === '=' ? '=' : '<' }
}

/**
 * The outcome in an "all p < x" list whose own p value in the text does
 * not satisfy the bound: "activity impairment (p = 0.002)" under "all p <
 * 0.001" (D4-13). Each item is looked up as its last two words followed,
 * within 60 characters, by a p value; an item the text never gives a p
 * value for is left to the ordinary figure check. Undefined when nothing
 * contradicts the bound.
 */
export function pValueListConflict(
  claim: PValueListClaim,
  text: PreparedSource,
): string | undefined {
  const bound = Number(claim.bound)
  for (const item of claim.items) {
    const key = item.split(' ').slice(-2).map((w) => w.slice(0, 7)).join('[a-z]*[\\s-]+')
    const re = new RegExp(
      `${key}[a-z]*[^.;()]{0,60}?\\(\\s*(?:hb-\\s*)?p\\s*-?\\s*(?:value)?\\s*([<=≤>])\\s*(0?\\.\\d+)\\s*\\)`,
      'i',
    )
    const m = re.exec(text.lower)
    if (!m) continue
    const value = Number(m[2]!.replace(/^\./, '0.'))
    const op = m[1]!
    const satisfied = op === '<' || op === '≤'
      ? value <= bound
      : op === '=' && (claim.operator === '<' ? value < bound : value === bound)
    if (!satisfied) return item
  }
  return undefined
}

/**
 * Checks every figure in each sentence against the texts that sentence is
 * bound to (`figureSupportedBy`). A sentence bound to no text is checked
 * against every cited text under the same rule, and the texts that support
 * it are reported so the sentence can inherit a marker.
 */
export function verifyFigures(
  sentences: readonly {
    text: string
    texts: readonly string[]
    /** For a table row, the column heading above each of its figures: the outcome the cell reports (D6-03). */
    headings?: ReadonlyMap<string, string>
  }[],
  allTexts: readonly string[],
  lexicon: readonly string[] = [],
  questionEntities: readonly string[] = [],
): FigureCheck[] {
  const out: FigureCheck[] = []
  const prepared = new Map<string, PreparedSource>()
  const prepare = (t: string) => {
    let v = prepared.get(t)
    if (v === undefined) {
      v = prepareSource(t)
      prepared.set(t, v)
    }
    return v
  }
  // A sentence that points back at the group the sentence before it named
  // ("continuous seizure freedom was achieved in 13.7% of these patients")
  // is checked against that group, not against no group at all (D6-01).
  let carried: ClaimPopulation | undefined
  for (const sentence of sentences) {
    const figures = extractNumbers(sentence.text)
    const stated = claimPopulation(sentence.text)
    if (stated && !stated.anaphoric) carried = stated
    if (figures.length === 0) {
      if (!stated) carried = undefined
      continue
    }
    const inherit = stated?.anaphoric === true ? carried : undefined
    const claim = claimFeatures(sentence.text, lexicon, questionEntities, inherit)
    const texts = (sentence.texts.length > 0 ? sentence.texts : allTexts).map(prepare)
    const pList = pValueListClaim(sentence.text)
    for (const figure of figures) {
      // A table cell says what it reports in the column heading above it,
      // and nowhere else: the heading is read as part of the claim so the
      // cell is checked against the outcome it is filed under (D6-03).
      const heading = sentence.headings?.get(figure)
      const cellClaim = heading
        ? claimFeatures(`${sentence.text} ${heading}`, lexicon, questionEntities, inherit)
        : claim
      const supportedBy: number[] = []
      let passage: string | undefined
      let reason: FigureCheck['reason'] | undefined
      texts.forEach((text, i) => {
        // The bound of an "all p < x" claim holds only when every listed
        // outcome's own p value in the text satisfies it (D4-13).
        if (pList && figure === pList.bound && pValueListConflict(pList, text)) {
          reason = 'pvalue'
          return
        }
        const verdict = figureSupportedBy(figure, cellClaim, text)
        if (verdict.supported) {
          supportedBy.push(i)
          if (passage === undefined) passage = verdict.passage
        } else if (reason === undefined || reason === 'absent') reason = verdict.reason
      })
      const supported = supportedBy.length > 0
      out.push({
        figure,
        sentence: sentence.text,
        supported,
        supportedBy,
        ...(passage !== undefined ? { passage } : {}),
        ...(supported ? {} : { reason: reason ?? 'absent' }),
      })
    }
  }
  return out
}

/**
 * The passage a figure belongs to: its own sentence and up to three before
 * it, never crossing a paragraph break, bounded so a long paragraph cannot
 * lend it a name from far away. The sentence after is excluded on purpose
 * - "76% at 12 months. ... 68% for LITT" must not let LITT claim the 76%.
 */
export function claimWindow(text: string, at: number): string {
  const { start, end } = claimWindowBounds(text, at)
  return text.slice(start, end)
}

/** The bounds `claimWindow` slices, for callers that slice a parallel text. */
export function claimWindowBounds(text: string, at: number): { start: number; end: number } {
  // A figure inside a bracket takes the window of the sentence the bracket
  // belongs to, whatever punctuation the bracket holds.
  const span = bracketSpan(text, at)
  const from = span ? span.open : at
  const floor = Math.max(0, from - 500)
  const before = text.slice(floor, from)
  // A semicolon ends a clause only before a word: "(aHR = 0.56; 95% CI
  // 0.31-1.01)" is one statistic, and the drug named before it vouches
  // for the interval after it. A paragraph break (a heading, a table row)
  // counts as a boundary too, so a table cell reaches its column heading.
  // A sentence may end in its reference numbers ("over time.10 ").
  const boundaries = [
    ...before.matchAll(
      new RegExp(
        `[.!?][\\d,-]{0,12}\\s+(?=[a-z0-9("])|;\\s+(?=[a-z(])|${PARAGRAPH_MARK}\\s*`,
        'g',
      ),
    ),
  ].map((m) => m.index + m[0].length)
  // Fewer than four boundaries in the span means the span is within three
  // sentences back: all of it is the window.
  const start = boundaries.length >= 4 ? boundaries[boundaries.length - 4]! : 0
  // The sentence after is never part of the window, nor the next paragraph.
  const tail = span ? span.close + 1 : at
  return { start: floor + start, end: sentenceEnd(text, tail, 250, true) }
}

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

/** Four-digit years the answer states, outside citation markers. */
export function yearsInAnswer(answer: string): string[] {
  const cleaned = answer.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ')
  const years = new Set<string>()
  for (const m of cleaned.matchAll(/(?<![\d.\-/])((?:19|20)\d{2})(?![\d.\-/%])/g)) {
    years.add(m[1]!)
  }
  return [...years]
}

/**
 * Years the answer states that neither the cited resources' metadata nor
 * their texts carry - the "a 2025 study" that was published in 2021.
 */
export function yearsUnsupported(
  answer: string,
  metadataYears: readonly string[],
  citedTexts: readonly string[],
): string[] {
  const known = new Set(metadataYears.map((y) => y.slice(0, 4)))
  const haystack = citedTexts.join('\n')
  return yearsInAnswer(answer).filter((year) =>
    !known.has(year) && !new RegExp(`(?<!\\d)${year}(?!\\d)`).test(haystack)
  )
}

// ---------------------------------------------------------------------------
// Safety verbs, bound to their medication
// ---------------------------------------------------------------------------

/**
 * A safety verb binds to a medication, never to a sentence (docs/persona-
 * reports/review loop 7 D7-03). "Carbamazepine is contraindicated in JME"
 * may only stand if a cited passage says that of carbamazepine: a passage
 * calling VALPROATE contraindicated a hundred characters away is not
 * support, and neither is one that only calls carbamazepine "not
 * recommended". So each verb in a passage is bound to the medication
 * nearest it, and a claim is supported only by a binding on the same
 * medication at the same strength or stronger.
 *
 * The strengths, weakest last:
 *  3 `prohibited`  - contraindicated, a black box warning, must not be used
 *  2 `discouraged` - should be avoided, not recommended, avoid X
 *
 * `aggravates` (worsens, exacerbates, precipitates) and `first-line` are
 * claims of a different kind, not weaker prohibitions, so each forms its
 * own family: a passage calling a drug "not recommended" does not say it
 * worsens seizures, and neither says anything about first-line use.
 */
export type SafetyFamily = 'safety' | 'aggravation' | 'firstline'

/** How strongly a verb speaks: only a passage at or above the claim's strength supports it. */
export const SAFETY_STRENGTH = {
  prohibited: 3,
  discouraged: 2,
  aggravates: 1,
  firstline: 1,
} as const

export type SafetyVerb = keyof typeof SAFETY_STRENGTH

const VERB_PATTERNS: { verb: SafetyVerb; family: SafetyFamily; re: RegExp }[] = [
  {
    verb: 'prohibited',
    family: 'safety',
    re:
      /contraindicat\w*|black[- ]box\w*|boxed warning|must not be (?:used|given|prescribed|taken|offered)|must be avoided|should never be (?:used|given|prescribed)|never be used/gi,
  },
  {
    verb: 'discouraged',
    family: 'safety',
    re:
      /should be avoided|should not be (?:used|given|prescribed|offered|considered)|to be avoided|best avoided|avoid(?:ed|ing|s)?\b|not recommended|not advised|inadvisable/gi,
  },
  {
    // Aggravation is a claim about what a drug does, not a weaker way of
    // prohibiting it: "not recommended" is not a statement that a drug
    // worsens seizures, so it is a family of its own (D7-03).
    verb: 'aggravates',
    family: 'aggravation',
    re: /worsen\w*|aggravat\w*|exacerbat\w*|precipitat\w*/gi,
  },
  {
    verb: 'firstline',
    family: 'firstline',
    re: /first[- ]line|first[- ]choice|drug of choice|treatment of choice/gi,
  },
]

/** Drug classes a clinical answer can call contraindicated without naming a drug. */
const DRUG_CLASS = /\b(?:sodium[- ]channel[- ]block\w*|barbiturate\w*|benzodiazepine\w*)\b/gi

/** The same class pattern without the global flag, for a stateless test. */
const IS_DRUG_CLASS = new RegExp(DRUG_CLASS.source, 'i')

/** A safety verb in a sentence, with the medication it binds to. */
export interface VerbBinding {
  drug: string
  verb: SafetyVerb
  family: SafetyFamily
  /** The sentence the binding was read from, trimmed. */
  sentence: string
  /** Where the medication and the verb sit in that sentence. */
  drugAt: number
  verbAt: number
  verbEnd: number
}

/** A back reference that carries the previous sentence's medications forward. */
const ANAPHOR =
  /\b(?:these|those|they|them|both|such)\b|\bthe (?:medications|drugs|agents|options)\b/i

/** A benefit reported in the same sentence is not a safety statement. */
const BENEFIT = /reduc|improv|effective|efficac|benefit|respon(?:se|ded)|seizure[- ]free/i

/** How far a verb may sit from the medication it binds to. */
const BIND_WINDOW = 120

/** Where each medication of the lexicon (and each drug class) is named in a sentence. */
function medicationMentions(
  sentence: string,
  lexicon: readonly string[],
): { drug: string; at: number; end: number }[] {
  const lower = sentence.toLowerCase()
  const out: { drug: string; at: number; end: number }[] = []
  for (const term of lexicon) {
    const t = term.toLowerCase()
    if (t.length < 5) continue
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
    for (const m of lower.matchAll(re)) out.push({ drug: t, at: m.index, end: m.index + t.length })
  }
  for (const m of sentence.matchAll(DRUG_CLASS)) {
    out.push({ drug: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Whether a verb at an offset is negated by the words just before it ("did not worsen"). */
function negated(sentence: string, at: number): boolean {
  return /\b(?:not|never|n't|without|no)\s+(?:\w+\s+){0,2}$/i.test(
    sentence.slice(Math.max(0, at - 40), at),
  )
}

/** Every safety verb in a sentence, the stronger one standing where two overlap. */
export function safetyVerbsIn(
  sentence: string,
): { verb: SafetyVerb; family: SafetyFamily; at: number; end: number }[] {
  const hits: { verb: SafetyVerb; family: SafetyFamily; at: number; end: number }[] = []
  for (const { verb, family, re } of VERB_PATTERNS) {
    for (const m of sentence.matchAll(new RegExp(re.source, 'gi'))) {
      if (negated(sentence, m.index)) continue
      if (family === 'aggravation' && BENEFIT.test(sentence)) continue
      hits.push({ verb, family, at: m.index, end: m.index + m[0].length })
    }
  }
  return hits.filter((h) =>
    !hits.some((o) =>
      o !== h && o.family === h.family && o.at < h.end && h.at < o.end &&
      (SAFETY_STRENGTH[o.verb] > SAFETY_STRENGTH[h.verb] ||
        (SAFETY_STRENGTH[o.verb] === SAFETY_STRENGTH[h.verb] && o.at < h.at))
    )
  )
}

/**
 * Every safety verb in a sentence bound to the medication nearest it. A
 * verb with no medication within `BIND_WINDOW` characters binds to nothing
 * and states nothing about any drug; where two verbs overlap ("must be
 * avoided" is both a prohibition and a discouragement) the stronger stands.
 */
export function verbBindings(
  raw: string,
  lexicon: readonly string[],
): VerbBinding[] {
  const sentence = raw.trim()
  const mentions = medicationMentions(sentence, lexicon)
  if (mentions.length === 0) return []
  const kept = safetyVerbsIn(sentence)
  const out: VerbBinding[] = []
  for (const hit of kept) {
    let best: { drug: string; at: number; end: number } | undefined
    let bestDistance = Infinity
    for (const mention of mentions) {
      const distance = mention.end <= hit.at
        ? hit.at - mention.end
        : mention.at >= hit.end
        ? mention.at - hit.end
        : 0
      // A medication before the verb is its subject; one after it is the
      // object of "avoid X". A tie goes to the subject.
      const bias = mention.at < hit.at ? 0 : 1
      if (distance + bias < bestDistance) {
        bestDistance = distance + bias
        best = mention
      }
    }
    if (!best || bestDistance > BIND_WINDOW) continue
    if (out.some((b) => b.drug === best!.drug && b.verb === hit.verb)) continue
    out.push({
      drug: best.drug,
      verb: hit.verb,
      family: hit.family,
      sentence,
      drugAt: best.at,
      verbAt: hit.at,
      verbEnd: hit.end,
    })
  }
  return out
}

/**
 * Words a sentence of prose cannot do without. A table row - "Generally
 * avoided | Eslicarbazepine | Good | Moderate" - has a verb in a cell and
 * no subject, so a safety verb cannot be bound in it and it is never
 * quoted back to the reader as what the sources say (D7-03).
 */
const FUNCTION_WORDS =
  /\b(?:the|an?|is|are|was|were|be|been|in|of|for|with|and|that|not|should|must|which|who|because|when|due)\b/gi

/** Whether a fragment is prose a verb can have a subject in. */
export function isProse(sentence: string): boolean {
  if (/\|/.test(sentence)) return false
  const words = sentence.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length
  if (words < 8) return true
  return (sentence.match(FUNCTION_WORDS) ?? []).length >= 2
}

/** The sentences of a text, whitespace collapsed, short enough to bind within. */
function safetySentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+/).filter((s) =>
    s.length <= 500 && isProse(s)
  )
}

/** Drugs a cited text calls contraindicated, to be avoided or seizure-worsening. */
export function drugsFlaggedInSources(
  texts: readonly { index: number; text: string }[],
  lexicon: readonly string[],
): { drug: string; index: number }[] {
  const out = new Map<string, number>()
  for (const { index, text } of texts) {
    for (const sentence of safetySentences(text)) {
      for (const binding of verbBindings(sentence, lexicon)) {
        // The addendum names drugs the answer left out, so a class the
        // answer may not name drug by drug is not listed.
        if (binding.family === 'firstline' || out.has(binding.drug)) continue
        if (IS_DRUG_CLASS.test(binding.drug)) continue
        out.set(binding.drug, index)
      }
    }
  }
  return [...out.entries()].map(([drug, index]) => ({ drug, index }))
}

/** Flagged drugs the answer never mentions. */
export function drugsMissingFromAnswer(
  answer: string,
  flagged: readonly { drug: string; index: number }[],
): { drug: string; index: number }[] {
  const lower = answer.toLowerCase()
  return flagged.filter((f) => !lower.includes(f.drug))
}

/** A drug (or drug class) the answer calls contraindicated, and the sentence saying so. */
export interface SafetyClaim {
  drug: string
  verb: SafetyVerb
  family: SafetyFamily
  sentence: string
}

/** What a claim's verb is called in the portal's own voice. */
const VERB_WORDS: Record<SafetyVerb, string> = {
  prohibited: 'contraindicated',
  discouraged: 'to be avoided',
  aggravates: 'seizure-aggravating',
  firstline: 'first-line',
}

/**
 * The safety claims each sentence of an answer makes, each bound to the
 * medication its verb governs. A negation or a hedge is not a claim.
 */
export function safetyClaims(
  answer: string,
  lexicon: readonly string[],
): SafetyClaim[] {
  const out: SafetyClaim[] = []
  const plain = answer.replace(/\s*\[\d{1,3}\]/g, '')
  for (const line of plain.split('\n')) {
    // "These medications" reaches back over the paragraph it sits in, not
    // only over the sentence before it.
    let previous: string[] = []
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*(])/)) {
      // A negation or a hedge is not a claim: "not contraindicated", "the
      // sources do not explicitly state that X is contraindicated".
      if (
        /\b(?:not|no|never)\s+(?:be\s+|considered\s+)?contraindicated|\b(?:do|does|did)\s+not\s+(?:\w+\s+)?(?:state|report|support|mention|say|indicate|confirm|establish|recommend|list|describe|specify|address|provide)\b|\bno (?:evidence|source|study|data)\b/i
          .test(sentence)
      ) {
        continue
      }
      const bindings = verbBindings(sentence, lexicon)
      // A class is the claim only when no drug is named: "vigabatrin is
      // contraindicated as it is a sodium channel blocker" is a claim about
      // vigabatrin, and the class must not vouch for it.
      const named = bindings.filter((b) => !IS_DRUG_CLASS.test(b.drug))
      const chosen = named.length > 0 ? named : bindings
      for (const binding of chosen) {
        out.push({
          drug: binding.drug,
          verb: binding.verb,
          family: binding.family,
          sentence: binding.sentence,
        })
      }
      // "Therefore, these medications are effectively contraindicated": the
      // subject is the drugs the sentence before named, and the claim is
      // checked against each of them (D7-03). Only an explicit back
      // reference carries the subject forward.
      if (chosen.length === 0 && previous.length > 0 && ANAPHOR.test(sentence)) {
        for (const hit of safetyVerbsIn(sentence.trim())) {
          for (const drug of previous) {
            out.push({ drug, verb: hit.verb, family: hit.family, sentence: sentence.trim() })
          }
        }
      }
      const mentioned = medicationMentions(sentence.trim(), lexicon)
        .filter((m) => !IS_DRUG_CLASS.test(m.drug))
        .map((m) => m.drug)
      previous = [...new Set([...previous, ...mentioned])]
    }
  }
  return out
}

/** What the cited passages say about a drug at or below the strength claimed. */
export interface SafetySupport {
  supported: boolean
  /** The passage that speaks of the drug but not strongly enough, and its marker. */
  weaker?: { binding: VerbBinding; index?: number }
}

/**
 * Whether a cited passage calls the drug what the answer calls it. The
 * verb must bind to that same drug, in the same family, at that strength or
 * stronger; a weaker statement about the same drug is returned so the
 * reader can be told what the sources actually say.
 */
export function safetySupport(
  claim: Pick<SafetyClaim, 'drug' | 'verb' | 'family'>,
  texts: readonly { index?: number; text: string }[],
  lexicon: readonly string[],
): SafetySupport {
  const wanted = SAFETY_STRENGTH[claim.verb]
  // "sodium channel-blocking" and "sodium channel blockers" are one class.
  const plain = claim.drug.toLowerCase().replace(/-/g, ' ')
  const stem = plain.replace(/s$/, '').slice(0, Math.max(5, plain.length - 3))
  const same = (drug: string) => drug.toLowerCase().replace(/-/g, ' ').includes(stem)
  let weaker: SafetySupport['weaker']
  for (const { index, text } of texts) {
    for (const sentence of safetySentences(text)) {
      for (const binding of verbBindings(sentence, [...lexicon, claim.drug])) {
        if (binding.family !== claim.family || !same(binding.drug)) continue
        if (SAFETY_STRENGTH[binding.verb] >= wanted) return { supported: true }
        if (!weaker) weaker = { binding, ...(index === undefined ? {} : { index }) }
      }
    }
  }
  return { supported: false, ...(weaker ? { weaker } : {}) }
}

/**
 * The clause a binding was read from, for quoting back: from the start of
 * the sentence the medication sits in to just past the verb, so the reader
 * sees "Carbamazepine, which is not recommended for treatment of JME"
 * rather than the whole extracted paragraph it was found in.
 */
function quoteFor(binding: VerbBinding): string {
  const sentence = binding.sentence
  const anchor = Math.min(binding.drugAt, binding.verbAt)
  const before = sentence.slice(0, anchor)
  // A sentence end the splitter could not see: a full stop carrying a
  // reference marker ("... for JME.24 Carbamazepine, which ...").
  let back = -1
  for (const m of before.matchAll(/[.;!?]\d{0,3}\s+/g)) back = m.index + m[0].length
  const from = back >= 0 ? back : Math.max(0, anchor - 120)
  let to = sentence.length
  const tail = sentence.slice(binding.verbEnd)
  const stop = /[,.;:]/.exec(tail.slice(8))
  if (stop) to = binding.verbEnd + 8 + stop.index
  const clause = sentence.slice(from, Math.min(to, from + 260))
    .replace(/\s*\[\d{1,3}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clause.length > 240 ? `${clause.slice(0, 237).trimEnd()}...` : clause
}

/**
 * Every drug an answer calls contraindicated, to be avoided or first-line
 * must be called that by a cited passage, of that same drug (D7-03). A
 * sentence none of whose drugs are supported is replaced by a plain
 * statement that the sources do not say so - with what they do say, when
 * they speak of the drug more weakly; a sentence with some support keeps
 * its text and gains the statement for the drugs that lack it.
 */
export function stripUnsupportedSafetyClaims(
  answer: string,
  texts: readonly { index?: number; text: string }[],
  lexicon: readonly string[],
): { text: string; unsupported: string[] } {
  const claims = safetyClaims(answer, lexicon)
  if (claims.length === 0) return { text: answer, unsupported: [] }
  const bySentence = new Map<string, SafetyClaim[]>()
  for (const claim of claims) {
    const list = bySentence.get(claim.sentence) ?? []
    list.push(claim)
    bySentence.set(claim.sentence, list)
  }
  const unsupported = new Set<string>()
  // The passage a drug is quoted from is shown once: a second note about
  // the same drug states what is missing without repeating the quote.
  const quoted = new Set<string>()
  let text = answer
  for (const [sentence, sentenceClaims] of bySentence) {
    const lacking: { claim: SafetyClaim; support: SafetySupport }[] = []
    for (const claim of sentenceClaims) {
      const support = safetySupport(claim, texts, lexicon)
      if (!support.supported) lacking.push({ claim, support })
    }
    if (lacking.length === 0) continue
    for (const { claim } of lacking) unsupported.add(claim.drug)
    const list = lacking.map((l) => l.claim.drug)
    const drugs = list.length > 1
      ? `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`
      : list[0]!
    const called = [...new Set(lacking.map((l) => VERB_WORDS[l.claim.verb]))].join(' or ')
    const weaker = lacking.find((l) => l.support.weaker && !quoted.has(l.claim.drug))?.support
      .weaker
    for (const { claim } of lacking) quoted.add(claim.drug)
    const instead = weaker
      ? ` What the cited sources do say: "${quoteFor(weaker.binding)}"${
        weaker.index === undefined ? '' : ` [${weaker.index}]`
      }.`
      : ''
    const note = `*The cited sources do not state that ${drugs} ${
      list.length > 1 ? 'are' : 'is'
    } ${called} here.${instead}*`
    // Match the sentence as it stands in the answer, markers included.
    const pattern = new RegExp(
      sentence.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
        '(?:\\s*\\[\\d{1,3}\\])*\\s+',
      ).replace(/\\\.$/, '(?:\\s*\\[\\d{1,3}\\])*\\.') + '(?:\\s*\\[\\d{1,3}\\])*',
    )
    text = lacking.length === sentenceClaims.length
      ? text.replace(pattern, note)
      : text.replace(pattern, (m) => `${m} ${note}`)
  }
  return { text, unsupported: [...unsupported] }
}

// ---------------------------------------------------------------------------
// The addendum
// ---------------------------------------------------------------------------

/** The Markdown addendum appended to an answer, or '' when nothing to add. */
export function auditAddendum(
  input: {
    missingDrugs: { drug: string; index: number }[]
    missingNumbers: string[]
    missingYears?: string[]
    /** Proportions stated without a denominator, with the n the passage gives when it does. */
    denominators?: DenominatorCheck[]
    /** Study designs, in the sources' own words, for citations whose first sentence named none. */
    designs?: { index: number; design: string }[]
    /** Attributions rewritten because the cited paper lacks the named author. */
    attributions?: { surname: string; replacedWith: string }[]
    /** Boundary sentences, already in the portal's voice. */
    notes?: string[]
  },
): string {
  const parts: string[] = []
  if (input.missingDrugs.length > 0) {
    const list = input.missingDrugs.map((d) => `${d.drug} [${d.index}]`).join(', ')
    parts.push(
      `**The cited sources also discuss ${list} in the context of contraindication or seizure worsening.** ` +
        'Check those passages before relying on the list above.',
    )
  }
  if (input.missingNumbers.length > 0) {
    parts.push(
      `*Figures in this answer that do not appear beside their claim in the cited passages: ${
        input.missingNumbers.join(', ')
      }. Verify against the sources before relying on them.*`,
    )
  }
  if (input.missingYears && input.missingYears.length > 0) {
    parts.push(
      `*Years stated in this answer that the cited resources do not carry: ${
        input.missingYears.join(', ')
      }. Check the publication year on each source.*`,
    )
  }
  if (input.denominators && input.denominators.length > 0) {
    const stated = input.denominators.filter((d) => d.stated)
    const bare = input.denominators.filter((d) => !d.stated)
    const pieces: string[] = []
    if (stated.length > 0) {
      pieces.push(
        `the cited passage gives ${
          stated.map((d) => `${d.stated} for ${d.figure}${d.index ? ` [${d.index}]` : ''}`).join(
            ', ',
          )
        }`,
      )
    }
    if (bare.length > 0) {
      pieces.push(
        `${bare.map((d) => d.figure).join(', ')} ${
          bare.length === 1 ? 'is' : 'are'
        } stated without a denominator, and the cited passage gives none beside the figure`,
      )
    }
    parts.push(`*Denominators: ${pieces.join('; ')}.*`)
  }
  if (input.designs && input.designs.length > 0) {
    parts.push(
      `*Study designs, in the sources' own words: ${
        input.designs.map((d) => `[${d.index}] ${d.design}`).join('; ')
      }.*`,
    )
  }
  if (input.attributions && input.attributions.length > 0) {
    const names = [...new Set(input.attributions.map((a) => a.surname))].join(', ')
    parts.push(
      `*${
        input.attributions.length === 1 ? 'One sentence' : `${input.attributions.length} sentences`
      } attributed work to ${names} while citing a paper without that author; the attribution was ` +
        "corrected to the cited paper's own authors.*",
    )
  }
  for (const note of input.notes ?? []) parts.push(note)
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
}

// ---------------------------------------------------------------------------
// Denominators: a proportion without its n is not a figure a clinician can
// repeat. The prompt asks for the n; this reports where it was left out and,
// when the cited passage states it, what it is.
// ---------------------------------------------------------------------------

/** "n = 1644", "(n=51)", "1644 patients", "of 1644 participants", "1,805 adults", "5/8", "29 (48%)". */
const COUNT_IN_SENTENCE =
  /\b(?:n\s*=\s*\d[\d,]*|\d[\d,]{1,}\s*(?:\/\s*\d[\d,]*)?\s+(?:patients|participants|subjects|adults|children|individuals|people|persons|cases|women|men|pwe|episodes|admissions|records|respondents|controls)\b|\b(?:of|among|in)\s+(?:the\s+)?\d[\d,]{1,}\b|\b\d+\s*\/\s*\d+\b|\b\d[\d,]*\s*\(\d{1,2}(?:\.\d+)?\s?%\))/i

/** Whether a sentence states a count that can serve as a denominator for its proportions. */
export function statesDenominator(sentence: string): boolean {
  return COUNT_IN_SENTENCE.test(sentence.replace(/\[\d{1,3}\]/g, ' '))
}

/**
 * Percentages in the sentence: the figures that need a denominator. The
 * "95%" of a confidence interval is not a proportion, and a hazard ratio,
 * an odds ratio, a standardised mortality ratio or a p value never takes
 * one - a ratio has no n of its own to pair with. Nor does a range or an
 * interquartile range: "17.1% (range 13-28%)" states one prevalence with
 * its spread, not three shares of three cohorts (
 * review loop 6 D6-08).
 */
export function proportions(sentence: string): string[] {
  // One spelling for the dashes first, so a range written with an en dash
  // ("13-28%" as the extraction writes it) is read as one range here too.
  const plain = normaliseFigures(sentence)
    // An estimate the source qualifies with its spread rather than with an
    // n - "17.1% (range 13-28%)", "45% (IQR 23-71)" - and the bounds of
    // that spread: neither is a share of a cohort with an n of its own.
    .replace(
      /\b\d+(?:\.\d+)?\s?%\s*\(\s*(?:range|IQR|interquartile range)\b[^)]*\)/gi,
      ' ',
    )
    .replace(/\(\s*(?:range|IQR|interquartile range)\b[^)]*\)/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s?%?\s?-\s?\d+(?:\.\d+)?\s?%/g, ' ')
    // A confidence interval and its bounds, an I-squared, a change: none is a share of a cohort.
    .replace(/\(?\b\d+(?:\.\d+)?\s?%\s?(?:CI\b|confidence interval)[^)]*\)?/gi, ' ')
    .replace(/\bI\s?[²2]\s*=\s*\d+(?:\.\d+)?\s?%/gi, ' ')
    .replace(
      /\b\d+(?:\.\d+)?\s?%\s+(?:higher|lower|greater|less|more|fewer|smaller|larger)\b/gi,
      ' ',
    )
    .replace(/\b\d+(?:\.\d+)?\s?%\s*(?:CI\b|confidence)/g, ' ')
    // An effect size ("a 20% greater reduction", "fell by 14%") is a change,
    // not a share of a cohort: no denominator applies.
    .replace(
      /\b(?:by|a|an|up to)\s+\d+(?:\.\d+)?\s?%(?:\s+\w+){0,2}\s+(?:greater|reduction|increase|decrease|lower|higher|improvement|change|rise|fall|drop|relative)\b/gi,
      ' ',
    )
    .replace(
      /\b\d+(?:\.\d+)?\s?%\s+(?:reduction|increase|decrease|improvement|change|rise|fall|drop)\b/gi,
      ' ',
    )
    .replace(
      /\b(?:fell|rose|reduced|increased|decreased|dropped|improved|declined|lower|higher|greater|less|more|reduction|increase|decrease)\s+(?:by\s+)?\d+(?:\.\d+)?\s?%/gi,
      ' ',
    )
    // The threshold that names a responder ("50% responder rate", "≥ 50%
    // seizure reduction") is a definition, not a share of anyone (D4-05).
    .replace(
      /(?:[≥>]=?|at least|more than|over)?\s*\b\d{2}\s?%\s+(?:(?:seizure\s+)?(?:reduction|response|responder|responders)\b)/gi,
      ' ',
    )
  return [...new Set(extractNumbers(plain).filter((f) => f.endsWith('%')))]
}

/** The sentence of a normalised text that contains the position, within its paragraph, and where it starts. */
function sentenceAround(text: string, at: number): { sentence: string; start: number } {
  const floor = Math.max(0, at - 400)
  const before = text.slice(floor, at)
  const startMatch = new RegExp(`.*(?:[.!?]\\s+(?=[A-Z0-9("])|${PARAGRAPH_MARK}\\s*)`, 's').exec(
    before,
  )
  const start = startMatch ? startMatch[0].length : 0
  const after = text.slice(at, at + 300)
  const endMatch = new RegExp(`[.!?](?:\\s|$)|\\s${PARAGRAPH_MARK}`).exec(after)
  const end = endMatch ? endMatch.index + 1 : after.length
  return { sentence: before.slice(start) + after.slice(0, end), start: floor + start }
}

/**
 * The n a cited text pairs with a proportion in the same parenthesis or
 * the same table cell, and nowhere else (
 * review loop 4 D4-05, D3-13): "64.2% (2698/4201)", "14.9% (n = 1111)",
 * "29 (48%)" and the "38 (79)" of a table row. The n nearest the figure
 * elsewhere in the sentence is never taken - "36.7% (n = 867), and 36.9%
 * (n = 822)" pairs 36.9% with 822 only, and a passage that gives the
 * figure without its own bracket gives no denominator. Undefined when no
 * occurrence carries one.
 */
export function denominatorBeside(figure: string, texts: readonly string[]): string | undefined {
  const re = figurePattern(figure, 'g')
  for (const raw of texts) {
    const text = normaliseText(raw)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const paired = denominatorInParenthesis(text, m.index, m[0].length, figure)
      if (paired) return paired
    }
  }
  return undefined
}

/**
 * The denominator written in the same parenthesis as the figure at `at`
 * in a normalised text, or the count the figure is the share of ("29
 * (48%)"), or undefined.
 */
function denominatorInParenthesis(
  text: string,
  at: number,
  length: number,
  figure: string,
): string | undefined {
  const rest = text.slice(at + length)
  // "64.2% (3031/4721)" - the fraction right after the figure is its n.
  const fraction = /^\s*\((\d[\d,]*\s*\/\s*\d[\d,]*)\)/.exec(rest)
  if (fraction?.[1]) return fraction[1].replace(/\s+/g, '')
  // "14.9% (n = 1111)", "14.9% (n = 1111, FAS)".
  const bracketed = /^\s*\(\s*n\s*=\s*(\d(?:[\d,]*\d)?)(?:\s*[,;]\s*[^)]{0,40})?\)/i.exec(rest)
  if (bracketed?.[1]) return `n = ${bracketed[1]}`
  // "(n = 1111; 14.9%)", "(14.9%; n = 1111)": the figure inside a bracket
  // that also carries an n, and nothing else.
  const open = text.lastIndexOf('(', at)
  const close = text.indexOf(')', at)
  if (open !== -1 && close !== -1 && close > at && text.slice(open, at).indexOf(')') === -1) {
    const inside = text.slice(open + 1, close)
    if (inside.length <= 60) {
      const n = /\bn\s*=\s*(\d(?:[\d,]*\d)?)/i.exec(inside)
      if (n?.[1]) return `n = ${n[1]}`
    }
  }
  // "29 (48%) of 60 patients", "29 (48%) patients met", a table's
  // "38 (79%)" and the "232 [39.8%]" a results sentence writes in square
  // brackets (review loop 6 D6-08): the count the
  // share was taken of, with the whole when the same sentence gives it -
  // in its own "of N" clause or in the "(n = N)" one clause further on.
  const before = text.slice(Math.max(0, at - 12), at)
  const counted = /(\d[\d,]*) [([]$/.exec(before)
  const { sentence } = sentenceAround(text, at)
  if (counted?.[1] && /^\s*[)\]]/.test(rest)) {
    const whole = /\b(?:of|among)\s+(?:the\s+)?(\d[\d,]{1,})\b/i.exec(sentence)
    if (whole?.[1]) return `${counted[1]} of ${whole[1]}`
    // One n in the sentence cannot be mis-paired: "... from LEV to BRV
    // (n = 583), the most common reasons were lack of effectiveness
    // (232 [39.8%])" gives 232 of 583.
    const ns = [
      ...new Set(
        [...sentence.matchAll(/\bn\s*=\s*(\d(?:[\d,]*\d)?)/gi)].map((m) => m[1]!.replace(/,/g, '')),
      ),
    ]
    if (ns.length === 1) return `${counted[1]} of ${ns[0]}`
    return `${counted[1]} (${figure})`
  }
  // One share and one "(n = N)" in the sentence cannot be mis-paired:
  // "retention was 71.1% in the full analysis set (n = 1644)".
  const shares = sentence.match(/(?<![\d.])\d+(?:\.\d+)?\s?%(?!\s?(?:CI|confidence))/g) ?? []
  const ns = sentence.match(/\(\s*n\s*=\s*\d(?:[\d,]*\d)?\s*\)/gi) ?? []
  if (shares.length === 1 && ns.length === 1) {
    const n = /\d(?:[\d,]*\d)?/.exec(ns[0]!)
    if (n) return `n = ${n[0]}`
  }
  return undefined
}

export interface DenominatorCheck {
  figure: string
  /** The n the cited passage states beside the figure, when it does. */
  stated?: string
  /** The marker of the passage the n came from. */
  index?: number
}

/** A Markdown table row - "| Brivaracetam | EXPERIENCE | 1111 | 14.9% |". */
function isTableRowText(text: string): boolean {
  return /^\s*\|.*\|\s*$/.test(text.trim())
}

/**
 * Whether a passage states this share as a fitted statistic rather than as
 * a count over a cohort: "We found F1 = 0.8, suggesting that 80% of EDs in
 * Group 1 were clustered during the sleep period" (
 * review loop 6 D6-08). An F score, an AUC, an R squared, a kappa or an
 * intraclass correlation is fitted to the data and has no n of its own to
 * pair with, so the addendum has nothing to ask for.
 */
export function isFittedStatistic(figure: string, texts: readonly string[]): boolean {
  if (!figure.endsWith('%')) return false
  const value = Number.parseFloat(figure)
  if (!Number.isFinite(value)) return false
  const wanted = new Set([
    String(value / 100),
    (value / 100).toFixed(2),
    (value / 100).toFixed(3),
  ])
  const pattern =
    /\b(?:F\d|F-?score|AUC|AUROC|R\s?[²2]|kappa|κ|ICC|c-?statistic)\b[^.]{0,20}?(0?\.\d+)/gi
  for (const raw of texts) {
    for (const m of normaliseText(raw).matchAll(pattern)) {
      const decimal = m[1]!.startsWith('.') ? `0${m[1]}` : m[1]!
      if (wanted.has(decimal) || wanted.has(String(Number.parseFloat(decimal)))) return true
    }
  }
  return false
}

/**
 * Whether the passage qualifies the share with its spread rather than with
 * an n: "45% (IQR 23-71)", "17.1% (range 13-28%)". The paper has answered
 * the question the addendum would ask.
 */
function qualifiedBySpread(figure: string, texts: readonly string[]): boolean {
  const re = figurePattern(figure, 'g')
  for (const raw of texts) {
    const text = normaliseText(raw)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (
        /^\s*[([]\s*(?:range|IQR|interquartile range)\b/i.test(
          text.slice(m.index + m[0].length),
        )
      ) return true
    }
  }
  return false
}

/**
 * Proportions the answer states in a sentence that carries no count of its
 * own, each with the denominator the located passage gives in the figure's
 * own parenthesis or table cell (review loop 5
 * D5-03, D5-13): only the sentence the audit verified the figure in is
 * read, never another occurrence of the same number elsewhere in the
 * paper. A quoted sentence, a table row (the table has its own n column,
 * loop 6 D6-08), a figure the paper states as a decimal proportion or as a
 * fitted statistic ("F1 = 0.8"), a share the paper qualifies with a range
 * or an interquartile range, a confidence interval and an effect size take
 * no denominator and are not listed.
 */
export function denominatorsMissing(
  sentences: readonly {
    text: string
    /** The passages the audit located each figure in, with the marker of the paper. */
    located: readonly { figure: string; index: number; passage: string }[]
  }[],
): DenominatorCheck[] {
  const out: DenominatorCheck[] = []
  const seen = new Set<string>()
  for (const sentence of sentences) {
    if (/^\s*The paper(?:'s own finding| itself reports)/.test(sentence.text)) continue
    // A table states its denominators in its own n column: the addendum
    // under it would be asking the table for what the table is for.
    if (isTableRowText(sentence.text)) continue
    const figures = proportions(sentence.text)
    if (figures.length === 0 || statesDenominator(sentence.text)) continue
    for (const figure of figures) {
      if (seen.has(figure)) continue
      const places = sentence.located.filter((l) => l.figure === figure)
      if (places.length === 0) continue
      // A share the paper gives as a proportion has no n beside it to add.
      const asPercent = places.filter((l) =>
        new RegExp(
          `(?<![\\d.])${figure.replace('%', '').replace('.', '\\.')}\\s?(?:%|percent|per cent)`,
        )
          .test(normaliseText(l.passage))
      )
      if (asPercent.length === 0) continue
      const passages = asPercent.map((l) => l.passage)
      if (isFittedStatistic(figure, passages) || qualifiedBySpread(figure, passages)) {
        seen.add(figure)
        continue
      }
      seen.add(figure)
      let found: DenominatorCheck = { figure }
      for (const place of asPercent) {
        const stated = denominatorBeside(figure, [place.passage])
        if (stated) {
          found = { figure, stated, index: place.index }
          break
        }
      }
      out.push(found)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Study design, in the source's own words
// ---------------------------------------------------------------------------

/** Design phrases in priority order: the most specific self-description wins. */
const DESIGNS: [RegExp, string][] = [
  [/\bsystematic review\b|\bmeta-?analys/i, 'a systematic review'],
  [/\bpooled analysis\b|\bindividual patient data\b/i, 'a pooled analysis'],
  // A paper that IS a protocol says so of itself; "the study protocol was
  // approved" is every trial's ethics line.
  [
    /\b(?:this|the present) (?:study |trial )?protocol\b|\bprotocol for an? \b|\b(?:describes?|presents?|outlines?|reports?) the (?:study |trial )?protocol\b|\bstudy protocol\b.{0,60}\b(?:randomi[sz]ed|controlled) trial\b|^[\s\S]{0,1500}\bstudy ?protocols?\b/i,
    'a trial protocol',
  ],
  [
    /\brandomi[sz]ed\b.{0,40}\b(?:trial|study)\b|\bplacebo-controlled\b|\bdouble-blind/i,
    'a randomised controlled trial',
  ],
  [/\bnested,? case[-‐–—]?\s?control\b/i, 'a nested case-control study'],
  [/\bcase[-‐–—]?\s?control\b/i, 'a case-control study'],
  [/\bfirst-in-human\b/i, 'a first-in-human study'],
  [
    /\bprospective\b.{0,30}\bcohort\b|\bcohort study\b|\bobservational cohort\b/i,
    'an observational cohort study',
  ],
  [/\bretrospective\b.{0,30}\b(?:cohort|study|analysis|review)\b/i, 'a retrospective cohort study'],
  [/\bcross-sectional\b/i, 'a cross-sectional study'],
  [/\bcase series\b/i, 'a case series'],
  [/\bcase report\b/i, 'a case report'],
  [/\bsurvey\b/i, 'a survey'],
  [
    // A paper that IS a model says so; a data study that "used a
    // mathematical model" to interpret its recordings is not one.
    /\bmodel(?:ling|ing) study\b|\bsimulation study\b|\bwe simulated\b|\bin silico\b|\b(?:computational|dynamic(?:al)? network) model of\b/i,
    'a modelling study',
  ],
  [/\bnarrative review\b|\breview article\b|\bthis review\b/i, 'a narrative review'],
  [/\bobservational study\b|\bprospective study\b|\bprospective, /i, 'an observational study'],
]

/**
 * How a paper describes its own design, from its opening pages: "a nested
 * case-control study", "a modelling study". Undefined when the text never
 * says - the audit reports designs, it never guesses them.
 */
export function studyDesignOf(text: string): string | undefined {
  // A section label the extraction letter-spaces ("S T U D Y P R O T O C O L")
  // reads as its word.
  const head = text.slice(0, 8000).replace(
    /\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g,
    (m) => m.replace(/ /g, ''),
  )
  for (const [re, label] of DESIGNS) if (re.test(head)) return label
  return undefined
}
