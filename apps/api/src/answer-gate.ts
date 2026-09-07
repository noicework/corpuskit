/**
 * The figure gate: what the audit found becomes a decision about the text,
 * not a footnote under it. A sentence whose figures the cited passages do
 * not carry beside the claim - about that outcome, at that follow-up, for
 * the cohort, drug or study the sentence names - is removed, and the answer
 * says so. A figure sentence with no marker inherits the marker of the one
 * cited text that carries every figure it states, or goes the same way.
 * Alongside it: the effect size a cited passage carries for the question
 * when the answer stated none, and the study-design line that leads an
 * answer grounded on a modelling or preclinical paper. Deterministic, no
 * model in the loop.
 */
import type { Citation } from '@research-portal/core'
import type { BindResult, BoundSentence } from './citation-binding.ts'
import { renderBound } from './citation-binding.ts'
import {
  claimTerms,
  extractNumbers,
  type FigureCheck,
  figurePattern,
  normaliseFigures,
  normaliseSource,
  outcomeFamilies,
  studyDesignOf,
} from './answer-audit.ts'

export interface RemovedSentence {
  text: string
  figures: string[]
  reason: NonNullable<FigureCheck['reason']> | 'conclusion'
}

export interface GateResult {
  text: string
  sentences: BoundSentence[]
  /** The citations a kept sentence still points at, renumbered in order of first appearance. */
  citations: Citation[]
  /** Old marker number to new, for callers that keyed anything by the pre-gate numbering. */
  renumber: Map<number, number>
  removed: RemovedSentence[]
  /** Sentences that had no marker and gained the one text that carries all their figures. */
  inherited: number
  /** Table rows kept with their failing cells blanked rather than dropped (D5-05). */
  blanked: BlankedRow[]
}

export interface BlankedRow {
  text: string
  figures: string[]
}

/** What a blanked table cell reads. */
export const BLANKED_CELL = 'not verified'

/**
 * The column heading above each figure of each Markdown table row in an
 * answer, keyed by the row's text and then by the figure. A cell states no
 * outcome of its own - "11.7% (FAS)" - so without its heading the check has
 * nothing to match, and a continuous seizure freedom rate passed under a
 * seizure freedom heading (loop 6 D6-03).
 */
export function rowKey(row: string): string {
  return row.replace(/\s*\[\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim()
}

export function tableCellHeadings(answer: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  const cells = (line: string) =>
    line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  let headings: string[] | undefined
  for (const raw of answer.split('\n')) {
    const line = raw.trim()
    // The generator puts a row's markers after its closing pipe
    // ("| ... | 14.9% |[1]"): they are not a cell.
    const bare = line.replace(/(?:\s*\[\d{1,3}\])+$/, '').trim()
    if (!/^\|.*\|$/.test(bare)) {
      headings = undefined
      continue
    }
    const parts = cells(bare)
    if (parts.every((c) => /^:?-+:?$/.test(c) || c.length === 0)) continue
    if (!headings) {
      headings = parts
      continue
    }
    const byFigure = new Map<string, string>()
    parts.forEach((cell, i) => {
      const heading = headings![i]
      if (!heading || heading.length < 3) return
      const label = heading.replace(/\s*\[\d{1,3}\]/g, '').trim()
      for (const figure of extractNumbers(cell)) {
        if (!byFigure.has(figure)) byFigure.set(figure, label)
      }
    })
    if (byFigure.size > 0) out.set(rowKey(line), byFigure)
  }
  return out
}

/** A bound sentence that is a Markdown table row with a body (not a header or a rule). */
export function isTableRow(text: string): boolean {
  return /^\s*\|.*\|\s*$/.test(text) && !/^\s*\|[\s|:-]*\|\s*$/.test(text) && /\d/.test(text)
}

/**
 * Column headings that ask for a quantity. A cell under one of these either
 * carries a figure the check can pass or fail, or carries nothing the check
 * can read at all.
 */
const QUANTITY_HEADING =
  /\b(?:n|no\.|number|size|sizes|rate|rates|retention|freedom|response|responder|proportion|percentage|percent|dose|doses|duration|follow-?up|months?|years?|weeks?|days?|age|count|counts|incidence|prevalence|mortality|survival|efficacy|reduction)\b|%/i

/** A cell that names an analysis set, or says nothing, rather than stating a value. */
const NOT_A_VALUE =
  /^(?:fas|itt|pp|mitt|full analysis set|safety population|retention population|intention[- ]to[- ]treat|per[- ]protocol|not reported|not specified|not stated|not given|not available|not detailed|unknown|unclear|n\/?a|none|-|--)$/i

/**
 * A Markdown table with every cell that states no readable value, in a
 * column whose heading asks for a quantity, marked "not verified" - the
 * mark How this works promises for a cell the check could not verify. A
 * loop 6 reformat table read "FAS" in its n column and "not reported" in
 * its retention column, neither of which the check can pass or fail
 * (review loop 6 D6-16a). The row keeps its place
 * and its other cells either way.
 */
export function markUnverifiableCells(text: string): { text: string; marked: number } {
  let marked = 0
  let quantityColumns: Set<number> | null = null
  const out = text.split('\n').map((line) => {
    const m = /^(\s*\|)(.*)(\|\s*)$/.exec(line)
    if (!m) {
      quantityColumns = null
      return line
    }
    const cells = m[2]!.split('|')
    // The rule row ("|---|---|") separates the heading from the body.
    if (/^[\s|:-]*$/.test(m[2]!)) return line
    if (quantityColumns === null) {
      quantityColumns = new Set(
        cells.flatMap((cell, index) =>
          QUANTITY_HEADING.test(cell.replace(/\[\d{1,3}\]/g, ' ').trim()) ? [index] : []
        ),
      )
      return line
    }
    const columns = quantityColumns
    const next = cells.map((cell, index) => {
      if (!columns.has(index)) return cell
      const bare = cell.replace(/\[\d{1,3}\]/g, ' ').replace(/[*_`]/g, '').trim()
      if (!bare || /\d/.test(bare) || !NOT_A_VALUE.test(bare)) return cell
      marked += 1
      return ` ${BLANKED_CELL} `
    })
    return `${m[1]}${next.join('|')}${m[3]}`
  })
  return { text: out.join('\n'), marked }
}

/**
 * The row with every cell that carries one of the failing figures replaced
 * by the blank mark, the other cells untouched. A figure matches a cell
 * with thousands separators and spaces ignored.
 */
export function blankFailingCells(row: string, figures: readonly string[]): string {
  const loose = (value: string) => value.replace(/[,\s\u00a0\u2009]/g, '').toLowerCase()
  const wanted = figures.map(loose).filter((f) => f.length > 0)
  const m = /^(\s*\|)(.*)(\|\s*)$/.exec(row)
  if (!m) return row
  const cells = m[2]!.split('|')
  const blanked = cells.map((cell) => {
    const bare = loose(cell)
    return wanted.some((f) => bare.includes(f)) ? ` ${BLANKED_CELL} ` : cell
  })
  return `${m[1]}${blanked.join('|')}${m[3]}`
}

/**
 * Applies the figure checks to the bound answer. `checks` come from
 * `verifyFigures` over `bound.sentences` in order; for a sentence bound to
 * no text they were run against every usable cited text, whose positions
 * map to citation indices through `markerOfText`. `candidates` are the
 * citations a sentence may inherit, in the same numbering as the bound
 * sentences (the binding's, when it kept the provider's numbers): a text
 * the binding dropped every marker to can still lend one here.
 */
export function gateFigures(
  bound: BindResult,
  checks: readonly FigureCheck[],
  markerOfText: readonly number[],
  candidates: readonly Citation[] = bound.citations,
): GateResult {
  const removed: RemovedSentence[] = []
  const blanked: BlankedRow[] = []
  const removedIndices = new Set<number>()
  let inherited = 0
  const sentences = bound.sentences.map((sentence, i) => {
    const own = checks.filter((c) => c.sentence === sentence.text)
    if (own.length === 0) return sentence
    const failing = own.filter((c) => !c.supported)
    if (sentence.bound.length > 0) {
      if (failing.length === 0) return sentence
      // A table row keeps its place with the failing cells blanked: a
      // table that lost a row is a table about fewer studies than the
      // reader asked for, and the verified cells still stand (D5-05).
      if (isTableRow(sentence.text)) {
        const figures = figuresToName(failing)
        const text = blankFailingCells(sentence.text, figures)
        if (text !== sentence.text) {
          blanked.push({ text: sentence.text, figures })
          return { ...sentence, text }
        }
      }
      removedIndices.add(i)
      removed.push({
        text: sentence.text,
        figures: figuresToName(failing),
        reason: dominantReason(failing),
      })
      return sentence
    }
    // A table row with no marker keeps its place too: its failing cells
    // blanked, and the one text that carries every passing figure lends
    // its marker when there is one (D5-05).
    if (isTableRow(sentence.text)) {
      const figures = figuresToName(failing)
      const text = failing.length > 0 ? blankFailingCells(sentence.text, figures) : sentence.text
      if (failing.length === 0 || text !== sentence.text) {
        if (failing.length > 0) blanked.push({ text: sentence.text, figures })
        const passing = own.filter((c) => c.supported)
        const common = passing.length > 0
          ? passing
            .map((c) => new Set(c.supportedBy))
            .reduce<Set<number> | null>(
              (acc, set) => acc === null ? set : new Set([...acc].filter((n) => set.has(n))),
              null,
            )
          : null
        const position = common ? [...common].sort((a, b) => a - b)[0] : undefined
        const marker = position === undefined ? undefined : markerOfText[position]
        if (marker !== undefined) {
          inherited += 1
          return { ...sentence, text, bound: [marker] }
        }
        return { ...sentence, text }
      }
    }
    // No marker: the one text that carries every figure lends its marker.
    if (failing.length === 0) {
      const common = own
        .map((c) => new Set(c.supportedBy))
        .reduce<Set<number> | null>(
          (acc, set) => acc === null ? set : new Set([...acc].filter((n) => set.has(n))),
          null,
        )
      const position = common ? [...common].sort((a, b) => a - b)[0] : undefined
      const marker = position === undefined ? undefined : markerOfText[position]
      if (marker !== undefined) {
        inherited += 1
        return { ...sentence, bound: [marker] }
      }
    }
    removedIndices.add(i)
    removed.push({
      text: sentence.text,
      figures: figuresToName(failing.length > 0 ? failing : own),
      reason: failing.length > 0 ? dominantReason(failing) : 'absent',
    })
    return sentence
  })
  // Removal is real (review loop 8 D8-02): a figure
  // a removed sentence stated is not left printed elsewhere in the same
  // answer unless the sentence that still carries it passed its own check
  // for it. A repeat with no passing check of its own - an unmarked
  // sentence the check never saw, or one checked on other figures - is a
  // number the answer says it could not verify and shows anyway, so it
  // goes too, and a table row keeps its place with the cell blanked.
  const swept = new Set(removed.flatMap((r) => r.figures))
  if (swept.size > 0) {
    sentences.forEach((sentence, i) => {
      if (removedIndices.has(i)) return
      const own = checks.filter((c) => c.sentence === sentence.text)
      const normalised = normaliseFigures(sentence.text)
      const repeated = [...swept].filter((figure) =>
        figurePattern(figure).test(normalised) &&
        !own.some((c) => c.figure === figure && c.supported)
      )
      if (repeated.length === 0) return
      if (isTableRow(sentence.text)) {
        const text = blankFailingCells(sentence.text, repeated)
        if (text !== sentence.text) {
          blanked.push({ text: sentence.text, figures: repeated })
          sentences[i] = { ...sentence, text }
          return
        }
      }
      removedIndices.add(i)
      removed.push({ text: sentence.text, figures: repeated, reason: 'absent' })
    })
  }
  // A conclusion that rested on removed sentences goes with them (D3-06):
  // "Thus, perampanel had a lower retention rate" with the retention
  // sentences gone is a claim with nothing behind it. A kept sentence that
  // opens with a connective to a removed one loses the connective (D3-15).
  if (removedIndices.size > 0) {
    for (const line of bound.layout) {
      if (line.kind !== 'sentences') continue
      let previousRemoved = false
      for (const i of line.sentences) {
        const sentence = sentences[i]!
        if (removedIndices.has(i)) {
          previousRemoved = true
          continue
        }
        if (previousRemoved && CONNECTIVE.test(sentence.text)) {
          sentences[i] = { ...sentence, text: stripConnective(sentence.text) }
        }
        previousRemoved = false
      }
    }
    let anyRemovedBefore = false
    for (const line of bound.layout) {
      if (line.kind !== 'sentences') continue
      for (const i of line.sentences) {
        if (removedIndices.has(i)) {
          anyRemovedBefore = true
          continue
        }
        const sentence = sentences[i]!
        const hasFigures = checks.some((c) => c.sentence === sentence.text)
        if (anyRemovedBefore && !hasFigures && CONCLUSION.test(sentence.text)) {
          removedIndices.add(i)
          removed.push({ text: sentence.text, figures: [], reason: 'conclusion' })
        }
      }
    }
  }
  // A citation every sentence of which was removed leaves the answer with
  // it, and the rest are renumbered by first appearance so the markers, the
  // chips and "n cited" describe the gated text.
  const order: number[] = []
  sentences.forEach((s, i) => {
    if (removedIndices.has(i)) return
    for (const n of s.bound) if (!order.includes(n)) order.push(n)
  })
  const renumber = new Map(order.map((old, i) => [old, i + 1]))
  const renumbered = sentences.map((s) => ({
    ...s,
    bound: s.bound.map((n) => renumber.get(n)).filter((n): n is number => n !== undefined).sort((
      a,
      b,
    ) => a - b),
  }))
  const citations = order.map((old) => {
    const source = candidates.find((c) => c.index === old) ??
      bound.citations.find((c) => c.index === old)!
    return { ...source, index: renumber.get(old)! }
  })
  return {
    text: renderBound(bound.layout, renumbered, removedIndices),
    sentences: renumbered.filter((_, i) => !removedIndices.has(i)),
    citations,
    renumber,
    removed,
    inherited,
    blanked,
  }
}

/**
 * The answer without the notes appended under it: the body a reader takes
 * the figures from. The addendum is a run of trailing paragraphs, each one
 * a whole italic note or the bold contraindication line, so the body ends
 * where the last paragraph that is neither begins (D8-02).
 */
export function answerBody(text: string): string {
  const paragraphs = text.split(/\n{2,}/)
  let end = paragraphs.length
  while (end > 0) {
    const paragraph = paragraphs[end - 1]!.trim()
    const note = /^\*[^*][\s\S]*\*$/.test(paragraph) ||
      paragraph.startsWith('**The cited sources also discuss')
    if (!note && paragraph.length > 0) break
    end -= 1
  }
  return paragraphs.slice(0, end).join('\n\n')
}

/**
 * The figures a text still prints, of those an audit reports as removed
 * (review loop 8 D8-02). The invariant the answer
 * and the briefing both hold to: what the notice calls removed is not on
 * the page. Empty is the only passing result.
 */
export function figuresStillPrinted(
  figures: readonly string[],
  body: string,
): string[] {
  const normalised = normaliseFigures(body)
  return [...new Set(figures)].filter((figure) => figurePattern(figure).test(normalised))
}

/**
 * The removals as the answer can honestly report them: a figure the body
 * still carries was not removed from the answer, whatever the sentence
 * that also stated it, so the notice does not name it (D8-02). The gate's
 * own sweep has already taken every repeat the check did not verify where
 * it stands, so what survives here is verified in its own sentence.
 */
export function reconcileRemovals(
  removed: readonly RemovedSentence[],
  body: string,
): RemovedSentence[] {
  const printed = new Set(figuresStillPrinted(removed.flatMap((r) => r.figures), body))
  if (printed.size === 0) return [...removed]
  return removed.map((r) => ({ ...r, figures: r.figures.filter((f) => !printed.has(f)) }))
}

/**
 * The line naming a sentence the answer states with no citation behind it
 * (review loop 8 D8-04, and the How this works
 * promise about citations). The sentence stays - it is often the model's
 * own framing of what the cited ones say - but the reader is told which
 * one the portal could not tie to a passage, rather than being left to
 * count markers.
 */
export function uncitedNote(sentences: readonly { text: string; bound: number[] }[]): string {
  const uncited = sentences.filter((s) => s.bound.length === 0 && assertsFinding(s.text))
  if (uncited.length === 0 || uncited.length === sentences.length) return ''
  const first = uncited[0]!.text.replace(/\s+/g, ' ').trim()
  const quoted = first.length > 120 ? `${first.slice(0, 117)}...` : first
  return uncited.length === 1
    ? `*One sentence in this answer carries no citation - "${quoted}" - because no retrieved ` +
      "passage was found to carry it. Read it as the answer's own framing, not as a sourced " +
      'claim.*'
    : `*${uncited.length} sentences in this answer carry no citation, the first of them ` +
      `"${quoted}", because no retrieved passage was found to carry them. Read them as the ` +
      "answer's own framing, not as sourced claims.*"
}

/**
 * Whether a sentence asserts something about the evidence, rather than
 * framing the answer around it. A heading, a bold label, a list lead-in
 * ending in a colon, a table row and the portal's own italic notes assert
 * nothing; a sentence with a reporting or stative verb does.
 */
export function assertsFinding(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 25 || trimmed.endsWith(':')) return false
  if (trimmed.startsWith('*') || /^#{1,6}\s/.test(trimmed)) return false
  if (isTableRow(trimmed)) return false
  if (/^\*\*[^*]+\*\*:?$/.test(trimmed)) return false
  // A sentence about what the sources do not say is the portal's own
  // account of the collection, not a claim that needs a passage behind it.
  if (
    /\b(?:cited sources|the sources|this collection|the corpus|retrieved passages?)\b[^.]{0,80}\b(?:do not|does not|did not|cannot|never|no )/i
      .test(trimmed)
  ) return false
  return /\b(?:is|are|was|were|has|have|had|can|could|may|might|show|shows|showed|find|finds|found|report|reports|reported|suggest|suggests|suggested|indicate|indicates|indicated|remain|remains|remained|achiev\w+|reduc\w+|increas\w+|associated|includ\w+|require\w*|improv\w+|predict\w*)\b/i
    .test(trimmed)
}

/** A sentence that draws a conclusion from what came before it. */
export const CONCLUSION =
  /^\s*(?:Thus|Therefore|Hence|Overall|In summary|In conclusion|Taken together|Consequently|This (?:suggests|indicates|means|shows)|These (?:findings|results|figures|data) (?:suggest|indicate|show))\b/i

/** A connective that ties a sentence to the one before it. */
export const CONNECTIVE =
  /^\s*(?:Additionally|In addition|Furthermore|Moreover|Also|Similarly|Likewise|However|Conversely|In contrast|By contrast|Meanwhile|Further),?\s+/i

/** The sentence without its leading connective, its first letter capitalised. */
export function stripConnective(sentence: string): string {
  const rest = sentence.replace(CONNECTIVE, '')
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/**
 * The figures worth naming for a removed sentence: its results, not the
 * timepoint that fell with them ("80%, 231" rather than "80%, 12 months,
 * 231"); the timepoints only when nothing else failed.
 */
function figuresToName(checks: readonly FigureCheck[]): string[] {
  const results = checks.filter((c) => !/(?:month|week|year|day|hour)s$/.test(c.figure))
  return (results.length > 0 ? results : checks).map((c) => c.figure)
}

function dominantReason(failing: readonly FigureCheck[]): RemovedSentence['reason'] {
  const order: RemovedSentence['reason'][] = [
    'secondhand',
    'entity',
    'pvalue',
    'outcome',
    'timepoint',
    'terms',
    'absent',
  ]
  for (const reason of order) if (failing.some((c) => c.reason === reason)) return reason
  return 'absent'
}

/** "12months" reads "12 months" in a note. */
function figureLabel(token: string): string {
  return token.replace(/(\d)((?:month|week|year|day|hour)s)$/, '$1 $2')
}

/**
 * The line that says what the gate removed and why, in the portal's voice,
 * or undefined when nothing was.
 */
export function removalNote(
  removed: readonly RemovedSentence[],
  extra: {
    /** Titles of resources that carry a removed figure somewhere, though not beside its claim. */
    foundIn?: readonly string[]
    /** Sentences replaced by the named paper's own figure sentence. */
    replaced?: number
  } = {},
): string | undefined {
  const parts: string[] = []
  const figured = removed.filter((r) => r.reason !== 'conclusion')
  const conclusions = removed.length - figured.length
  if (figured.length > 0) {
    const figures = [...new Set(figured.flatMap((r) => r.figures))].map(figureLabel)
    const reasons = new Set(figured.map((r) => r.reason))
    const why: string[] = []
    if (reasons.has('secondhand')) {
      why.push(
        'the cited paper carries them only where it cites other studies, not among its own results',
      )
    }
    if (reasons.has('entity')) {
      why.push('the cited passage never names the cohort, drug or study the sentence gave them to')
    }
    if (reasons.has('pvalue')) {
      why.push('the cited passage gives a different p value for one of the outcomes listed')
    }
    if (reasons.has('outcome') || reasons.has('timepoint')) {
      why.push('the cited passage carries them for a different outcome or follow-up')
    }
    if (reasons.has('terms') || reasons.has('absent')) {
      const found = (extra.foundIn ?? []).slice(0, 2)
      why.push(
        found.length > 0
          ? `the figures were found in *${
            found.join('* and *')
          }* but could not be tied to the claim as the answer stated it`
          : 'no retrieved passage carries them beside the claim',
      )
    }
    const count = figured.length === 1 ? 'One sentence was' : `${figured.length} sentences were`
    const tail = conclusions > 0
      ? `, and ${
        conclusions === 1 ? 'a conclusion' : `${conclusions} conclusions`
      } that rested on ${figured.length === 1 ? 'it' : 'them'}`
      : ''
    // Every figure the sentence stated still stands, verified, in a
    // sentence of its own: the sentence went, the figures did not, and the
    // notice says so rather than naming a number the reader can see (D8-02).
    parts.push(
      figures.length === 0
        ? `${count} removed from this answer${tail}: the figures ${
          figured.length === 1 ? 'it' : 'they'
        } stated stand where the answer reports them beside their own claim, but not as ${
          figured.length === 1 ? 'this sentence' : 'these sentences'
        } framed them.`
        : `${count} removed from this answer${tail}: ${
          figured.length === 1 ? 'its' : 'their'
        } figures (${figures.join(', ')}) could not be verified - ${why.join('; ')}.`,
    )
  } else if (conclusions > 0) {
    parts.push(
      `${conclusions === 1 ? 'One conclusion was' : `${conclusions} conclusions were`} removed ` +
        'because the sentences it rested on were replaced.',
    )
  }
  if ((extra.replaced ?? 0) > 0) {
    parts.push(
      `${extra.replaced === 1 ? 'One sentence' : `${extra.replaced} sentences`} cited to the ` +
        `wrong paper ${extra.replaced === 1 ? 'was' : 'were'} replaced by the sentence of the ` +
        'paper that carries the same figure at the same time point, quoted and cited.',
    )
  }
  if (parts.length === 0) return undefined
  if (figured.length > 0) parts.push('Ask about one paper to see the figures it reports.')
  return `*${parts.join(' ')}*`
}

// ---------------------------------------------------------------------------
// The effect size the passage carries when the answer stated none
// ---------------------------------------------------------------------------

/**
 * A question that asks whether one thing changes the risk or outcome of
 * another. A bare comparison ("perampanel versus brivaracetam retention")
 * is not one: its answer is two rates, and a ratio the paper carries for
 * something else would be noise beside them.
 */
export function asksForEffect(query: string): boolean {
  return /\b(?:risk|increase|increases|increased|reduce|reduces|reduced|associated|association|hazard|odds|effect|effects|improve|improves|protective|predict|predictor|predictors)\b/i
    .test(query)
}

/** Whether the answer already states a ratio with its interval. */
export function statesEffectSize(answer: string): boolean {
  return /\b(?:a?HR|a?OR|RR|IRR|hazard ratio|odds ratio|risk ratio|relative risk|rate ratio)\b[^.]{0,160}?\d+\.\d+/i
    .test(answer)
}

const EFFECT_SIZE =
  /((?:adjusted |crude |unadjusted |multivariable )?(?:hazard|odds|risk|rate|incidence rate) ratios?(?: \[a?[HOR]R\])?|\ba?(?:HR|OR|RR|IRR)\b)\s*(?:\(a?[HOR]R\))?\s*(?:of|=|:|was|were|is)?\s*[\[(]?\s*(\d+\.\d+)\s*[\])]?[^.]{0,25}?(?:95\s?%\s*(?:CI|confidence interval)\s*[:=]?\s*[\[(]?\s*\d+\.?\d*\s*(?:-|to)\s*\d+\.?\d*\s*[\])]?)(?:[,;]?\s*p\s*[=<>]\s*0?\.\d+)?/gi

export interface EffectSize {
  index: number
  /** The passage's own words, from the ratio to the interval (and p value when given). */
  statement: string
  /** What the effect is for, in the passage's own words: the clause before the ratio. */
  subject?: string
}

/**
 * The effect sizes with intervals the cited texts carry in a sentence that
 * names one of the question's terms or outcomes - the aHR that answers "does
 * X increase the risk of Y" when the answer paraphrased it away. At most
 * one per text, at most two in all, only when the answer states none.
 */
export function effectSizesFor(
  query: string,
  answer: string,
  texts: readonly { index: number; text: string }[],
  lexicon: readonly string[],
): EffectSize[] {
  if (!asksForEffect(query) || statesEffectSize(answer)) return []
  const lower = query.toLowerCase()
  const terms = lexicon.map((t) => t.toLowerCase()).filter((t) =>
    t.length >= 4 && lower.includes(t)
  )
  for (const m of query.matchAll(/\b[A-Z][A-Z0-9]{2,7}\b/g)) {
    if (!/^(?:EEG|MRI|PET|ASM|ASMS|RCT|ILAE|CI|HR|OR|RR)$/.test(m[0])) {
      terms.push(m[0].toLowerCase())
    }
  }
  const outcomes = outcomeFamilies(query)
  // The effect must be an effect of what the answer is about: an aHR for
  // lamotrigine offered under an answer about tonic-clonic seizure
  // frequency answers a different question, and no effect size is better
  // than the wrong one (loop 6 D6-05). The exposure words are the answer's
  // own distinctive words, less the terms the question already names.
  const body = answer.replace(/^\s*\*.*$/gm, ' ').replace(/\s*\[\d{1,3}\]/g, ' ')
  const exposure = claimTerms(body, lexicon).words
    .filter((w) => w.length >= 5 && !terms.some((t) => t.startsWith(w.slice(0, 5))))
    .slice(0, 12)
  const out: EffectSize[] = []
  for (const { index, text } of texts) {
    const source = normaliseSource(text)
    for (const sentence of source.split(/(?<=[.!?])\s+(?=[A-Z0-9("])|\s¶\s/)) {
      if (sentence.length > 700) continue
      const sentenceLower = sentence.toLowerCase()
      const named = terms.some((t) => sentenceLower.includes(t)) ||
        (outcomes.length > 0 && outcomeFamilies(sentence).some((o) => outcomes.includes(o)))
      if (!named) continue
      if (
        exposure.length > 0 && !exposure.some((w) => sentenceLower.includes(w.slice(0, 5)))
      ) continue
      const hit = new RegExp(EFFECT_SIZE.source, 'i').exec(sentence)
      if (!hit) continue
      // A covariate list ("age; OR 1.02 ... diagnosis; OR 1.64 ...") is a
      // model's terms, not an effect the question asked about (D3-10).
      if (isCovariateList(sentence)) continue
      const statement = hit[0].replace(/\s+/g, ' ').trim()
        .replace(
          /([^(\[]*)[)\]]$/,
          (m, before: string) => before.includes('(') || before.includes('[') ? m : before,
        )
      const subject = effectSubject(sentence.slice(0, hit.index))
      out.push({ index, statement, ...(subject ? { subject } : {}) })
      break
    }
    if (out.length >= 2) break
  }
  return out
}

/** Whether a sentence lists several ratios with their terms - a regression table in prose. */
export function isCovariateList(sentence: string): boolean {
  const ratios = sentence.match(/\b(?:a?OR|a?HR|RR)\s*[=:]?\s*\d+\.\d+/g) ?? []
  if (ratios.length >= 3) return true
  if (
    /\b(?:covariates?|multivariable model|regression model|independent(?:ly)? (?:associated|predictor))\b/i
      .test(sentence) && ratios.length >= 2
  ) return true
  // A variable's name straight before its ratio ("anti-LGI1 diagnosis;
  // OR 1.64") is a model term, not a finding about an exposure.
  return /\b(?:diagnosis|age|sex|gender|status|score|level|duration|onset|delay|subtype|type)\b[^.;()]{0,20}[;:,]\s*(?:a?OR|a?HR|RR)\s*[=:]?\s*\d/i
    .test(sentence)
}

/**
 * The clause an effect size is for, from the sentence before the ratio:
 * "Rituximab, adjusted for concomitant use of other immunotherapies, was
 * associated with increased time to first relapse" reads as "rituximab
 * and time to first relapse". At most twelve words, trailing bracket
 * dropped; undefined when the clause is empty.
 */
export function effectSubject(before: string): string | undefined {
  const clause = before.replace(/\s+/g, ' ')
    // A section heading the extraction glued on, then the adjustment
    // clauses: "after controlling for X," and ", adjusted for Y,".
    .replace(/^\s*(?:Results|Conclusions?|Findings|Interpretation)\s+(?=[A-Z])/, '')
    .replace(
      /^\s*(?:after|when|while)\s+(?:controlling|adjusting|accounting)\s+for\s+[^,;]{2,80},\s*/i,
      '',
    )
    .replace(
      /,\s*(?:adjusted|controlling|accounting|after adjustment)\s+for\s+[^,;]{2,80},\s*/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .replace(/[\s(,;:]+$/, '').trim()
  if (!clause) return undefined
  const words = clause.split(' ')
  if (words.length < 2) return undefined
  const short = words.length > 14 ? `... ${words.slice(-12).join(' ')}` : clause
  return short.charAt(0).toLowerCase() + short.slice(1)
}

/** The addendum line for effect sizes the answer left out, each named for what it is an effect of. */
export function effectSizeNote(sizes: readonly EffectSize[]): string | undefined {
  if (sizes.length === 0) return undefined
  return `*Effect size in the cited passage: ${
    sizes.map((s) => `${s.subject ? `for "${s.subject}", ` : ''}${s.statement} [${s.index}]`).join(
      '; ',
    )
  }.*`
}

// ---------------------------------------------------------------------------
// Study design first
// ---------------------------------------------------------------------------

/** Words that name a study design, for the first-citation check. */
export const DESIGN_WORD =
  /\b(?:randomi[sz]ed|trial|cohort|case-control|case series|case report|cross-sectional|survey|model(?:ling|ing)?|simulation|simulated|in silico|preclinical|animal|review|meta-analysis|pooled analysis|protocol|first-in-human|observational|retrospective|prospective)\b/i

/**
 * The design line that leads an answer when a cited paper is a modelling,
 * simulation or preclinical study and the first sentence citing it named
 * no design: its results are simulated or from the bench, and the reader
 * must know that before the finding. Undefined when every such source was
 * introduced properly, or none is of that kind.
 */
export function designLead(
  citations: readonly { index: number; title: string; kind?: string; text?: string }[],
  sentences: readonly BoundSentence[],
): string | undefined {
  const byDesign = new Map<string, { markers: number[]; caveat: string; plural: string }>()
  for (const citation of citations) {
    const design = nonClinicalDesign(citation)
    if (!design) continue
    const first = sentences.find((s) => s.bound.includes(citation.index))
    if (first && DESIGN_WORD.test(first.text)) continue
    const entry = byDesign.get(design.label) ??
      { markers: [], caveat: design.caveat, plural: design.plural }
    entry.markers.push(citation.index)
    byDesign.set(design.label, entry)
  }
  if (byDesign.size === 0) return undefined
  const lines = [...byDesign.entries()].map(([label, { markers, caveat, plural }]) =>
    markers.length === 1
      ? `[${markers[0]}] is ${label} - ${caveat}`
      : `${markers.map((m) => `[${m}]`).join(' and ')} are ${plural} - ${
        caveat.replace(/^its /, 'their ')
      }`
  )
  return `*Study design: ${lines.join('; ')}.*`
}

/** Whether a cited paper reports modelling or bench results rather than patients' outcomes. */
export function nonClinicalDesign(
  citation: { title: string; kind?: string; text?: string },
): { label: string; plural: string; caveat: string } | undefined {
  if (citation.kind === 'preclinical') {
    return {
      label: 'a preclinical study',
      plural: 'preclinical studies',
      caveat: 'its results come from animals, cells or tissue, not from patients',
    }
  }
  // The title names the design, or the paper's own opening pages do in the
  // strong forms `studyDesignOf` accepts; a data study that interpreted
  // its recordings "using a mathematical model" is not a modelling study.
  const modelling =
    /\b(?:in silico|simulation|simulated|computational|mathematical|dynamic(?:al)? network|network model|model(?:l)?ing study)\b/i
      .test(citation.title) ||
    (citation.text !== undefined && studyDesignOf(citation.text) === 'a modelling study')
  if (modelling) {
    return {
      label: 'a modelling study',
      plural: 'modelling studies',
      caveat: 'its results are simulated, not demonstrated in patients',
    }
  }
  return undefined
}
