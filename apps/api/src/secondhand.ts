/**
 * Section-aware reading of an extracted paper (
 * review loop 2 D2-06, D2-14). The platform's extraction keeps the
 * section headings of a journal article ("Abstract", "1 | INTRODUCTION",
 * "3 Results", "Discussion", "References"), so a paragraph can be placed in
 * its section and a figure the answer states can be checked for where in
 * the cited paper it appears. A figure that occurs only in the introduction
 * or the discussion is the paper quoting earlier literature, not its own
 * finding, and the reader is told so in one sentence.
 */

import { extractNumbers, isClockToken } from './answer-audit.ts'

export type Section =
  | 'abstract'
  | 'introduction'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'references'
  | 'other'

export interface SectionSpan {
  section: Section
  start: number
  end: number
}

// A heading may be numbered ("3 | Results"), or a Markdown heading ("##
// Introduction:") in a text the platform extracted from HTML (loop 5 TFD).
const HEADING =
  /(?:^|\n)[ \t]*(?:#{1,4}[ \t]+|\*\*)?(?:\d{1,2}(?:\.\d{1,2})*\.?[ \t]*\|?[ \t]*)?(abstract|summary|introduction|background|(?:materials?,? (?:and|&) )?methods?(?: (?:and|&) (?:analysis|analyses|materials|design))?|(?:patients|participants|subjects) and methods|methods\/design|study design(?: and (?:methods|participants|setting))?|trial design|methodology|results(?: and discussion)?|findings|discussion|conclusions?|references|bibliography|acknowledg(?:e)?ments?|supplementary (?:material|information))\b[ \t]*(?::|\||\*\*|\n|$)/gi

function canonical(heading: string): Section {
  const h = heading.toLowerCase()
  if (h.startsWith('abstract') || h === 'summary') return 'abstract'
  if (h.startsWith('introduction') || h.startsWith('background')) return 'introduction'
  if (/method|patients and|participants and|subjects and|design/.test(h)) return 'methods'
  if (h.startsWith('results') || h.startsWith('findings')) return 'results'
  if (h.startsWith('discussion')) return 'discussion'
  if (h.startsWith('conclusion')) return 'conclusion'
  return 'references'
}

/**
 * The sections of an extracted text, in order, from its headings. Text
 * before the first heading is `other` (masthead, title, authors). A
 * structured abstract's own "Methods:" and "Results:" lines are part of the
 * abstract: a heading that follows a colon-style abstract heading within
 * 2,500 characters and before any body "Introduction" stays abstract.
 */
export function sectionSpans(text: string): SectionSpan[] {
  const marks: { section: Section; at: number }[] = []
  for (const m of text.matchAll(HEADING)) {
    const at = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0)
    marks.push({ section: canonical(m[1]!), at })
  }
  const spans: SectionSpan[] = []
  let cursor = 0
  let current: Section = 'other'
  let abstractAt = -1
  let bodyStarted = false
  for (const mark of marks) {
    let section = mark.section
    if (section === 'abstract') abstractAt = mark.at
    if (section === 'introduction') bodyStarted = true
    // A structured abstract's sub-headings stay within the abstract.
    if (
      !bodyStarted && abstractAt >= 0 && mark.at - abstractAt < 2500 &&
      (section === 'methods' || section === 'results' || section === 'conclusion' ||
        section === 'discussion')
    ) {
      section = 'abstract'
    }
    if (section === current) continue
    if (mark.at > cursor) spans.push({ section: current, start: cursor, end: mark.at })
    cursor = mark.at
    current = section
  }
  if (text.length > cursor) spans.push({ section: current, start: cursor, end: text.length })
  return spans
}

/** The section an offset into the text falls in. */
export function sectionAt(spans: readonly SectionSpan[], offset: number): Section {
  for (const span of spans) if (offset >= span.start && offset < span.end) return span.section
  return 'other'
}

/** Whether the text carries any body heading at all (otherwise nothing can be excluded). */
export function hasBodyHeadings(spans: readonly SectionSpan[]): boolean {
  return spans.some((s) => s.section === 'results' || s.section === 'introduction')
}

/**
 * Whether the paper has a Results section at all. "Second-hand" is defined
 * against one: a figure is the paper's own when it appears among its own
 * results, and somebody else's when it appears only where the paper cites
 * other work. A review article has no Results section - its headings are
 * "Newly Approved Drugs", "Investigational Drugs" - so the splitter reads
 * its whole body as one long introduction, and every figure in it looks
 * second-hand. That is how the fenfluramine dosing question came back with
 * its four correct figures (0.7 mg/kg/day, 26 mg/day, 0.4, 17) and a note
 * calling all four second-hand: they sit in the review's own dosing
 * paragraph, which is as first-hand as a review gets.
 *
 * With no Results section the section a figure sits in says nothing about
 * where it came from, so provenance is decided on the paper's own
 * attribution cues alone ("as reported by", "et al.", a numbered reference
 * marker), which are unaffected.
 */
export function reportsOwnResults(spans: readonly SectionSpan[]): boolean {
  return spans.some((s) => s.section === 'results')
}

/**
 * Offsets of every occurrence of a figure in the text, as a whole number.
 * A thousands separator in the text ("2,698") still matches "2698"; the
 * text itself is not rewritten, so offsets line up with the section spans.
 */
export function figureOffsets(figure: string, text: string): number[] {
  const bare = figure.replace(/[%\s,]/g, '')
  if (!bare || !/\d/.test(bare)) return []
  // A thousands separator may be a comma or a space in the extraction.
  const body = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(\d)(?=\d)/g, '$1[, ]?')
  // A percentage matches only as a percentage: "14%" is not "14 days".
  const tail = figure.trim().endsWith('%') ? '\\s?%' : '(?![\\d])'
  const pattern = new RegExp(`(?<![\\d.,])${body}${tail}`, 'g')
  const out: number[] = []
  for (const m of text.matchAll(pattern)) out.push(m.index ?? 0)
  return out
}

/**
 * Whether an offset sits on a table row or a figure or table legend: a
 * pipe-table line, a line that reads "label n (%)", or a line within a
 * few lines after a "Table N" or "Figure N" caption.
 */
export function inTableOrLegend(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset) + 1
  const lineEnd = text.indexOf('\n', offset)
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
  if (/^\|.*\|$/.test(line)) return true
  if (/^[A-Za-z][^.!?|]{1,80}?\s\d[\d,]*\s\(\d{1,3}(?:\.\d+)?\)[a-z]?\s*$/.test(line)) return true
  if (/^(?:table|figure|fig\.?)\s+S?\d+/i.test(line)) return true
  // A line of nothing but statistics ("221 3.25 <0.001") is a table row
  // whose label the extraction put on the line before (D4-18): prose never
  // writes a line of bare numbers.
  if (
    /^[\d.,<>=≤≥±%()\s/–-]+$/.test(line) && (line.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2
  ) return true
  const before = text.slice(Math.max(0, lineStart - 600), lineStart)
  const caption = /(?:^|\n)[ \t]*(?:table|figure|fig\.?|graphical abstract)\s*S?\d*\b[^\n]*$/i
  const lines = before.split('\n').slice(-6).join('\n')
  if (caption.test(lines) && !/\n\s*\n[^\n]*\n\s*\n/.test(lines)) return true
  // A block of short lines is the text of a figure or graphical abstract
  // ("13 subjects with epilepsy", "312 saliva samples collected"): the
  // paper's own data, however the extraction placed it (loop 5 N07).
  // Prose, a table caption and a reference list all run to long lines.
  if (line.length <= 48 && !/[.!?]$/.test(line)) {
    const near = [
      ...text.slice(Math.max(0, lineStart - 400), lineStart).split('\n').map((l) => l.trim())
        .filter((l) => l.length > 0).slice(-3),
      ...text.slice(lineEnd === -1 ? text.length : lineEnd + 1).slice(0, 400).split('\n').map((
        l,
      ) => l.trim()).filter((l) => l.length > 0).slice(0, 3),
    ]
    if (near.length >= 4 && near.filter((l) => l.length <= 48).length >= near.length - 1) {
      return true
    }
  }
  return false
}

/**
 * Whether the sentence around an offset speaks of the paper's own work:
 * "our cohort", "this trial", "we found", "the present study", "in this
 * analysis". Section is not provenance (loop 6 D6-04, D6-07): a Discussion
 * sentence whose subject is the paper itself reports the paper's own
 * finding, wherever the extraction placed it.
 */
export function speaksOfOwnWork(text: string, offset: number): boolean {
  const sentence = ownWorkSentence(text, offset)
  if (/\bet al\.?/i.test(sentence)) return false
  return /\b(?:our|we)\s+(?:[a-z-]+\s+){0,3}(?:cohort|study|series|trial|analysis|analyses|data|results?|findings?|patients|participants|sample|population|observations?)\b|\bwe (?:found|observed|report|reported|showed|show|noted|identified|demonstrated)\b|\b(?:this|the present|the current) (?:study|trial|cohort|analysis|series|report|paper|investigation)\b|\bin (?:this|our) (?:study|trial|cohort|analysis|series)\b/i
    .test(sentence)
}

/**
 * Whether the figure at an offset is printed with its own denominator inside
 * the same parenthesis: "(PHYSICIANS: n = 19, 100%)", "(n = 1674, 23.6%)".
 * A paper that prints the group it counted beside the proportion is counting
 * it itself. Earlier work is quoted as a claim ("rose to over 22% after
 * 2020[6]"), not as a denominator, so this reads the paper's own numbers
 * wherever the extraction placed them.
 *
 * It is what a consensus statement's recommendations look like. The
 * international Dravet consensus prints each recommendation with the panel
 * vote behind it - "Lamotrigine may have a very limited role in adults ...
 * (PHYSICIANS: n = 19, 100%)" - in a block the extraction puts after the
 * Discussion heading, so the vote read as second-hand and the whole
 * recommendation was cut out of the answer to "which anti-seizure
 * medications are contraindicated in SCN1A Dravet syndrome?".
 *
 * A parenthesis that quotes earlier work is not the paper's own count, so a
 * sentence carrying an attribution cue or a reference marker is excluded.
 */
export function carriesOwnDenominator(text: string, offset: number): boolean {
  const before = text.slice(Math.max(0, offset - 200), offset)
  const open = before.lastIndexOf('(')
  if (open === -1) return false
  const inside = before.slice(open + 1)
  // The parenthesis is still open at the figure, and it carries a count.
  if (inside.includes(')') || !/\bn\s*=\s*\d/i.test(inside)) return false
  return !citesEarlierWork(text, offset) &&
    !endsWithReferenceMarker(ownWorkSentence(text, offset))
}

/**
 * The whole sentence around an offset, bounded by a full stop or a blank
 * line but never by a single line break: a PDF extraction wraps
 * "Consistent with this observation, our cohort had / an 80% favorable
 * mRS score at 12 months." over two lines, and the subject sits on the
 * first of them (loop 6 D6-07).
 */
function ownWorkSentence(text: string, offset: number): string {
  const lines = lineBoundsAround(text, offset)
  const before = text.slice(lines.start, offset)
  const start = lines.start + Math.max(0, before.lastIndexOf('. ') + 1)
  const rest = text.slice(offset, lines.end)
  const stop = rest.search(/\.\s/)
  return text.slice(start, offset + (stop === -1 ? rest.length : stop + 1))
}

/** Whether a line is a section heading rather than prose. */
function isHeadingLine(line: string): boolean {
  const re = new RegExp(HEADING.source, 'i')
  return re.test(`\n${line}\n`)
}

/**
 * The bounds of the block of prose lines around an offset: its own line
 * plus one line each side, stopping at a blank line or a section heading.
 * A PDF extraction wraps one sentence over several lines, so a single line
 * break is not a sentence end; a heading is.
 */
function lineBoundsAround(text: string, offset: number): { start: number; end: number } {
  let start = text.lastIndexOf('\n', offset - 1) + 1
  let end = text.indexOf('\n', offset)
  if (end === -1) end = text.length
  const previousEnd = start - 1
  if (previousEnd > 0) {
    const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1
    const previous = text.slice(previousStart, previousEnd)
    if (previous.trim().length > 0 && !isHeadingLine(previous)) start = previousStart
  }
  const nextStart = end + 1
  if (nextStart < text.length) {
    let nextEnd = text.indexOf('\n', nextStart)
    if (nextEnd === -1) nextEnd = text.length
    const next = text.slice(nextStart, nextEnd)
    if (next.trim().length > 0 && !isHeadingLine(next)) end = nextEnd
  }
  return { start, end }
}

/** The sentence around an offset, bounded by a full stop or a line break. */
function sentenceAround(text: string, offset: number): string {
  const start = Math.max(0, text.lastIndexOf('. ', offset) + 1, text.lastIndexOf('\n', offset) + 1)
  const endDot = text.indexOf('. ', offset)
  const endLine = text.indexOf('\n', offset)
  const ends = [endDot, endLine].filter((e) => e !== -1)
  const end = ends.length > 0 ? Math.min(...ends) : text.length
  return text.slice(start, end)
}

/**
 * Whether a sentence ends on a numbered citation ("... to over 22% after
 * 2020.[6, 7]"): the paper is quoting other work, whatever section the
 * sentence sits in, and its own abstract cannot clear the figure (D5-15).
 */
export function endsWithReferenceMarker(sentence: string): boolean {
  return /(?:[.!?]|\d\s?%|\d)\s*\[\s*\d{1,3}(?:\s*[,;\u2010-\u2015-]\s*\d{1,3})*\s*\]/.test(
    sentence,
  )
}

/** Whether the sentence around an offset attributes its figure to earlier work. */
export function citesEarlierWork(text: string, offset: number): boolean {
  const sentence = sentenceAround(text, offset)
  return /\b(?:previous|prior|earlier|published|historical)\b[^.]{0,60}\b(?:stud(?:y|ies)|data|report|reports|literature|cohort|estimate|estimates|series|work)\b|\b(?:according to|as reported|reported by|reported in|derived from|taken from|based on (?:the )?(?:previous|prior|earlier|published))\b|\bet al\.?/i
    .test(sentence)
}

/** Sections where a paper's own findings live. */
const OWN: ReadonlySet<Section> = new Set(['abstract', 'methods', 'results', 'conclusion', 'other'])

/**
 * How much longer a located passage is in the raw extraction than in the
 * normalised text the audit quotes: the raw carries the line breaks,
 * hyphenation and column gutters the normalisation collapsed, which on this
 * corpus runs under a tenth of the passage. A quarter is generous and still
 * ends well inside the paragraph, so a figure past the passage's end is a
 * different occurrence and is not judged as this one.
 */
const PASSAGE_SLACK = 1.25

export interface SecondhandFigure {
  figure: string
  /** Citation index of the paper the figure was attributed to. */
  index: number
}

/**
 * Figures the answer attributes to a cited paper that appear in that paper
 * only in its introduction or discussion, where it cites other studies.
 * A paper without body headings is never judged; a figure absent from the
 * paper altogether is the audit's business, not this check's.
 */
export function secondhandFigures(
  sentences: readonly {
    text: string
    bound: readonly number[]
    /** The passage the audit located a figure in, per marker: judged instead of every occurrence of the number. */
    located?: readonly { figure: string; index: number; passage: string }[]
  }[],
  texts: ReadonlyMap<number, string>,
): SecondhandFigure[] {
  const spansByIndex = new Map<number, SectionSpan[]>()
  const spansFor = (index: number): SectionSpan[] | undefined => {
    if (!spansByIndex.has(index)) {
      const text = texts.get(index)
      spansByIndex.set(index, text ? sectionSpans(text) : [])
    }
    return spansByIndex.get(index)
  }
  const out: SecondhandFigure[] = []
  const seen = new Set<string>()
  for (const sentence of sentences) {
    // The figures the audit checks, less the ones a section cannot place:
    // a clock time, a follow-up in weeks or months, a bare integer under
    // 100 (a week label, a table cell, a page number).
    const figures = extractNumbers(sentence.text).filter((f) =>
      !isClockToken(f) && !/(?:month|week|year|day|hour)s$/.test(f) &&
      !(/^\d+$/.test(f) && Number(f) < 100)
    ).map((f) => f.replace(/mg.*$/, ''))
    for (const figure of figures) {
      if (/^(?:19|20)\d\d$/.test(figure) || /^\d$/.test(figure)) continue
      for (const index of sentence.bound) {
        const text = texts.get(index)
        const spans = spansFor(index)
        if (!text || !spans) continue
        const place = (sentence.located ?? []).find((l) => l.figure === figure && l.index === index)
        const at = place ? offsetOfPassage(text, place.passage) : -1
        // Where the FIGURE sits inside the located passage, not where the
        // passage begins. The passage runs to a paragraph, and a proportion
        // several lines into it is judged on its own line's punctuation and
        // its own parenthesis: "(PHYSICIANS: n = 19, 100%)" is a count, and
        // the passage's opening words are not. It must be the same passage,
        // so an occurrence past its end or in another section is not it.
        const inPassage = at >= 0 && place
          ? figureOffsets(figure, text).filter((o) =>
            o >= at && o <= at + Math.ceil(place.passage.length * PASSAGE_SLACK) &&
            sectionAt(spans, o) === sectionAt(spans, at)
          )
          : []
        const offsets = at >= 0
          ? (inPassage.length > 0 ? inPassage : [at])
          : figureOffsets(figure, text)
        if (offsets.length === 0) continue
        // A table row or a figure legend is the paper's own data wherever
        // the extraction placed it (D3-08); a figure the paper's own
        // sentence attributes to earlier work ("based on previous
        // incidence data", "as reported by") is second-hand wherever it
        // sits, a Methods power calculation included. A text without
        // body headings, and a paper with no Results section of its own
        // (a review, a consensus statement), is judged on that attribution
        // alone: see `reportsOwnResults`.
        const sectioned = hasBodyHeadings(spans) && reportsOwnResults(spans)
        const sections = new Set(
          offsets.map((o) =>
            inTableOrLegend(text, o) || speaksOfOwnWork(text, o) ||
              carriesOwnDenominator(text, o)
              ? 'results'
              // A sentence that carries a numbered citation is quoting
              // other work whatever section it sits in (D5-15).
              : citesEarlierWork(text, o) || endsWithReferenceMarker(ownWorkSentence(text, o))
              ? 'discussion'
              : sectioned
              ? sectionAt(spans, o)
              : 'other'
          ),
        )
        if ([...sections].some((s) => OWN.has(s))) continue
        const quoted = at >= 0 &&
          (citesEarlierWork(text, at) || endsWithReferenceMarker(ownWorkSentence(text, at)))
        if (
          sectioned && at >= 0 && !quoted &&
          figureOffsets(figure, text).some((o) =>
            o !== at && !citesEarlierWork(text, o) && sectionAt(spans, o) === 'abstract'
          )
        ) continue
        // Check the abstract before declaring anything second-hand: a
        // Discussion sentence restating a figure the paper's own abstract
        // reports is that paper's finding (loop 6 D6-04, the lacosamide
        // trial's own placebo 50% responder rate of 46.3%). Only the
        // abstract counts: a number a Results sentence happens to share
        // with an Introduction figure is a different quantity (D5-15).
        const key = `${figure}:${index}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ figure, index })
      }
    }
  }
  return out
}

/**
 * Where a normalised passage sits in the raw extracted text, by its first
 * words, tolerant of the line breaks, hyphenation and separators the
 * normalisation removed; -1 when it cannot be found.
 */
export function offsetOfPassage(text: string, passage: string): number {
  const words = (passage.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []).slice(0, 5)
  if (words.length < 2) return -1
  const pattern = words
    .map((w) =>
      w.replace(/-/g, '').split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
        '[-\\s]?',
      )
    )
    .join('[\\s\\S]{1,24}?')
  const m = new RegExp(pattern, 'i').exec(text)
  return m ? m.index : -1
}

/**
 * The sentences of an answer with the citation markers each carries, for
 * `secondhandFigures`. Lines without a marker contribute nothing.
 */
export function markedSentences(text: string): { text: string; bound: number[] }[] {
  const out: { text: string; bound: number[] }[] = []
  for (const line of text.split('\n')) {
    if (!/\[\d{1,3}\]/.test(line) || /^\s*\*/.test(line)) continue
    const sentences = line.split(/(?<=[.!?]["'”’)]*(?:\s*\[\d{1,3}\])*)\s+(?=[A-Z*(])/)
    for (const sentence of sentences) {
      const bound = [...sentence.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]))
      if (bound.length > 0) out.push({ text: sentence.replace(/\[\d{1,3}\]/g, ''), bound })
    }
  }
  return out
}

/** The one-line boundary note for second-hand figures, or undefined when there are none. */
export function secondhandNote(figures: readonly SecondhandFigure[]): string | undefined {
  if (figures.length === 0) return undefined
  const items = figures.slice(0, 6).map((f) => `${f.figure} [${f.index}]`).join(', ')
  return `*Second-hand figures: ${items} ${
    figures.length === 1 ? 'appears' : 'appear'
  } in the cited paper only where it cites other studies (its introduction, its discussion or ` +
    'a figure it takes from earlier work), not among its own results.*'
}

// ---------------------------------------------------------------------------
// Work the answer attributes to someone else (
// review loop 8, the sleep-deprivation answer): "Rajna and Veres showed
// that sleep deprivation ... increased seizure risk by 6-fold", cited to a
// paper neither of them wrote. The figure check never saw it - "6-fold" is
// not a figure token - but the sentence says plainly whose result it is.
// ---------------------------------------------------------------------------

/** "Rajna and Veres showed", "Dell et al. found", "Smith and colleagues reported". */
const ATTRIBUTED =
  /\b([A-Z][a-z]{2,}(?:['’][A-Za-z]+)?)\s+(?:(?:and|&)\s+(?:[A-Z][a-z]{2,}|colleagues|co-?workers)|et\s+al\.?)\s+(?:showed|found|reported|demonstrated|observed|described|concluded|noted|documented)\b/g

/** A surname the answer credits a finding to, with the marker on that sentence. */
export interface AttributedFinding {
  surname: string
  index: number
  sentence: string
}

/**
 * Findings the answer credits by name to authors the cited paper was not
 * written by: the paper is reporting someone else's work, which is what
 * second-hand means, whether or not the sentence carries a figure token.
 */
export function attributedElsewhere(
  sentences: readonly { text: string; bound: number[] }[],
  authorsOf: (index: number) => readonly string[] | undefined,
): AttributedFinding[] {
  const out: AttributedFinding[] = []
  const seen = new Set<string>()
  for (const sentence of sentences) {
    const re = new RegExp(ATTRIBUTED.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(sentence.text)) !== null) {
      const surname = m[1]!
      const index = sentence.bound[0]
      if (index === undefined || seen.has(surname.toLowerCase())) continue
      // The paper's own authors are not someone else.
      const written = sentence.bound.some((n) =>
        (authorsOf(n) ?? []).some((a) => new RegExp(`\\b${surname}\\b`, 'i').test(a))
      )
      if (written) continue
      // A citation whose author list could not be read says nothing.
      if (sentence.bound.every((n) => (authorsOf(n) ?? []).length === 0)) continue
      seen.add(surname.toLowerCase())
      out.push({ surname, index, sentence: sentence.text.trim() })
    }
  }
  return out
}

/** The one-line note for findings the answer credits to other authors. */
export function attributedNote(findings: readonly AttributedFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const items = findings.slice(0, 3).map((f) => `${f.surname} [${f.index}]`).join(', ')
  return `*Work credited to other authors: ${items} did not write the paper cited beside ` +
    `${findings.length === 1 ? 'that finding' : 'those findings'}, so it is that paper's ` +
    'account of earlier work rather than its own result. Check the original before relying on it.*'
}
