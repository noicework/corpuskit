/**
 * Shape checks on generated answer text that need no model in the loop.
 *
 * Two live here. A model-authored reference list: review-style prompts
 * sometimes end an answer with "References:" followed by numbered one-line
 * descriptions ("1. Study on LITT efficacy at 12 months.") whose numbering
 * has nothing to do with the citation chips the platform binds. The
 * evidence panel is the reference list; the model's own is stripped.
 *
 * And the sentinel phrases the generation prompt and the platform's guardrail
 * leak into prose - "the context does not provide", "Not enough data to
 * answer this", "[inference]" - which a reader should never see verbatim.
 * They are rewritten into the portal's own voice (`rewriteSentinels`), on
 * the streamed deltas as well as the final text (`SentinelStream`).
 */

const HEADING =
  /(?:^|\n)[ \t]*(?:-{3,}[ \t]*\n[ \t]*)?(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*(?:references?|reference list|sources?|citations?|bibliography)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*(?=\n|$)/i

/**
 * Where a trailing model-authored reference block begins, or -1. The heading
 * must sit on its own line and be followed only by list items (numbered,
 * bulleted or bracketed) or nothing at all - a paragraph that merely
 * mentions sources is left alone.
 */
export function referenceBlockStart(text: string, titles: readonly string[] = []): number {
  // A trailing run of "[n] Title." lines is a reference list even without a
  // heading: bracketed entries are never prose, while a numbered list only
  // counts under a heading (numbered items are how the model structures a
  // real answer).
  const trailing = /(?:^|\n)((?:[ \t]*\[\d{1,3}\][ \t]+\S[^\n]*(?:\n|$))+)\s*$/.exec(text)
  if (trailing && trailing.index >= 0) {
    const at = trailing.index + (text[trailing.index] === '\n' ? 0 : 0)
    const headed = headedBlockStart(text.slice(0, at))
    return headed === -1 ? at : headed
  }
  const headed = headedBlockStart(text)
  if (headed !== -1) return headed
  return trailingBibliographyStart(text, titles)
}

/**
 * "Surname et al. (2017). Title of the paper.[1]" - an author-year entry
 * the model appended to its last paragraph or wrote as a line of its own.
 * Anchored at a sentence start, with no nested repetition, so it cannot
 * backtrack.
 */
const AUTHOR_YEAR_ENTRY =
  /^[A-Z][A-Za-z'’-]+(?: [A-Z][A-Za-z'’-]+){0,3}(?:,? (?:[A-Z]\.?){1,3})?(?:,? et al\.?)?,? \((?:19|20)\d{2}[a-z]?\)\.?(?: [A-Z]|$)/

/** Sentence boundaries at which a trailing entry may start: after ". ", "?[1] " and the like. */
const SENTENCE_START = /(?:^|(?<=[.!?]["'”’)]*(?:\[\d{1,3}\])*\s))(?=[A-Z])/g

function normaliseTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Where a trailing run of reference-like sentences begins, or -1. A
 * sentence counts when it is an author-year entry, or when it is one of
 * the cited titles written out ("Multiday cycles of heart rate are
 * associated with seizure likelihood: An observational cohort study.[1]").
 * Only sentences that run to the very end of the text are cut.
 */
export function trailingBibliographyStart(text: string, titles: readonly string[] = []): number {
  const wanted = titles.map(normaliseTitle).filter((t) => t.length >= 20)
  const starts = [...text.matchAll(SENTENCE_START)].map((m) => m.index)
  const sentences = starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1]! : text.length
    return { from, plain: text.slice(from, to).replace(/\s*\[\d{1,3}\]/g, '').trim() }
  })
  const authorYear = sentences.map((s) => AUTHOR_YEAR_ENTRY.test(s.plain))
  const knownTitle = sentences.map((s) => {
    const candidate = normaliseTitle(s.plain)
    return candidate.length >= 20 &&
      wanted.some((t) => candidate === t || candidate.startsWith(t) || t.startsWith(candidate))
  })
  // "Seneviratne et al. (2017)." then "Electroencephalography in ... Syndromes."
  // - the title sentence of an author-year entry that closed on its year.
  const titleOfEntry = sentences.map((_s, i) =>
    i > 0 && authorYear[i - 1] === true && /\)\.?$/.test(sentences[i - 1]!.plain)
  )
  let cut = -1
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (!sentences[i]!.plain) continue
    if (!(authorYear[i] || knownTitle[i] || titleOfEntry[i])) break
    cut = sentences[i]!.from
  }
  return cut
}

function headedBlockStart(text: string): number {
  let from = 0
  while (from < text.length) {
    const rest = text.slice(from)
    const m = HEADING.exec(rest)
    if (!m) return -1
    const at = from + m.index
    const after = rest.slice(m.index + m[0].length)
    const lines = after.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const listOnly = lines.every((l) => /^(?:\d+[.)]|[-*•]|\[\d+\])\s*/.test(l))
    if (listOnly) return at
    from = at + m[0].length
  }
  return -1
}

/** `at` moved back over a horizontal rule and blank lines that only introduced the block. */
function cutPoint(text: string, at: number): number {
  const before = text.slice(0, at)
  const trimmed = before.replace(/(?:\s*\n[ \t]*-{3,}[ \t]*)?\s*$/, '')
  return trimmed.length
}

/**
 * The text with any trailing model-authored reference block removed. The
 * cited titles, when given, let a bare title sentence at the end be
 * recognised as a reference line.
 */
export function stripModelReferences(text: string, titles: readonly string[] = []): string {
  const at = referenceBlockStart(text, titles)
  if (at === -1) return text
  return text.slice(0, cutPoint(text, at)).replace(/[ \t]+$/, '')
}

// ---------------------------------------------------------------------------
// A final text that stops mid-sentence
// ---------------------------------------------------------------------------

/** A last word no English sentence ends on: a conjunction, a preposition, an article, "Therefore,". */
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/

const DANGLING_WORD =
  /\b(?:and|or|but|nor|so|yet|which|that|because|although|though|whereas|while|whether|if|as|than|the|a|an|of|to|in|on|at|by|for|with|from|into|onto|about|between|among|therefore|thus|hence|however|moreover|furthermore|additionally|also|is|are|was|were|be|been|has|have|had|may|might|can|could|would|should|will|not|no)[,;:]?$/i

/**
 * Whether a finished answer ends mid-sentence: no closing punctuation on its
 * last line, a trailing comma, colon or dash, or a dangling conjunction.
 * Markers after the last word are looked through ("...analysis.[1] Therefore,").
 */
export function endsMidSentence(text: string): boolean {
  const lines = text.trimEnd().split('\n')
  const last = (lines[lines.length - 1] ?? '').replace(/\s*\[\d{1,3}\]/g, '').trimEnd()
  if (!last) return false
  // A heading or a list item introducing nothing is a different defect; a
  // one-word line is not a sentence to judge.
  if (/^\s*#{1,6}\s/.test(last)) return false
  // A Markdown table row is complete when its closing pipe is there; a
  // row cut by the generation budget has none (D4-06). A list item that
  // ends on a figure, a closing bracket or a marker is a complete item.
  if (/^\s*\|.*\|\s*$/.test(last)) return false
  if (/^\s*\|/.test(last)) return true
  if (LIST_ITEM.test(last) && /(?:\d|%|\))\s*$/.test(last)) return false
  if (/[.!?]["'”’)*_]*$/.test(last)) return false
  if (/[,;:\-–]$/.test(last)) return true
  return DANGLING_WORD.test(last) || /\s\S+$/.test(last)
}

/**
 * The text cut back to its last complete sentence when it ends mid-sentence,
 * and whether it was cut. The incomplete tail is dropped only when a complete
 * sentence remains before it in the same paragraph; otherwise the dangling
 * paragraph goes as a whole, unless it is the only one - then the text stands
 * and is merely flagged.
 */
export function trimTruncatedTail(text: string): { text: string; truncated: boolean } {
  if (!endsMidSentence(text)) return { text, truncated: false }
  const trimmed = text.trimEnd()
  const lines = trimmed.split('\n')
  const lastIndex = lines.length - 1
  const last = lines[lastIndex] ?? ''
  // The last sentence boundary in the final line, markers kept with their sentence.
  const boundary = /[.!?]["'”’)*_]*(?:\s*\[\d{1,3}\])*(?=\s+\S)/g
  let cut = -1
  let m: RegExpExecArray | null
  while ((m = boundary.exec(last)) !== null) cut = m.index + m[0].length
  if (cut > 0) {
    lines[lastIndex] = last.slice(0, cut).trimEnd()
    return { text: lines.join('\n'), truncated: true }
  }
  const before = lines.slice(0, lastIndex).join('\n').trimEnd()
  if (before.replace(/^\s*#{1,6}\s.*$/gm, '').trim().length === 0) {
    return { text, truncated: true }
  }
  return { text: before, truncated: true }
}

/**
 * Incremental form for a token stream: given the text emitted so far and the
 * full text accumulated, returns the slice that may still be forwarded and
 * whether forwarding is currently held at a reference heading. The hold is
 * not sticky: a line that looked like a heading at a chunk boundary
 * ("Sources" as the first word of a sentence) releases again once the next
 * chunk shows it was prose. The final `done` text is stripped the same way.
 */
export function forwardableSlice(
  emittedLength: number,
  full: string,
): { text: string; stop: boolean } {
  const at = referenceBlockStart(full)
  if (at === -1) return { text: full.slice(emittedLength), stop: false }
  const cut = cutPoint(full, at)
  return { text: cut > emittedLength ? full.slice(emittedLength, cut) : '', stop: true }
}

// ---------------------------------------------------------------------------
// Format leaks: code fences, empty headings, header-only tables (D5-16, D5-05)
// ---------------------------------------------------------------------------

/** A Markdown code-fence line, with or without a language tag. */
const FENCE_LINE = /^[ \t]*`{3,}[\w-]*[ \t]*$/

/**
 * The text without its code fences: a generator asked for a table wrapped
 * it in "```markdown", which the surface then rendered as a code block
 * with no rows (D5-05). The fence lines go; what they enclosed stands as
 * Markdown. A closing fence with content after it on the same line keeps
 * that content.
 */
export function stripCodeFences(text: string): string {
  if (!/`{3,}/.test(text)) return text
  return text
    .split('\n')
    .filter((line) => !FENCE_LINE.test(line))
    .map((line) =>
      line.replace(/^[ \t]*`{3,}[\w-]*[ \t]+(?=\S)/, '').replace(/[ \t]*`{3,}[ \t]*$/, '')
    )
    .join('\n')
}

/** Streaming form: fence lines are dropped from a released chunk; a fence split across chunks is caught at `done`. */
export function stripFenceLines(chunk: string): string {
  if (!/`{3,}/.test(chunk)) return chunk
  return chunk.split('\n').filter((line) => !FENCE_LINE.test(line)).join('\n')
}

/**
 * Headings with nothing under them go: a "**Validation:**" or "### LGI1"
 * whose section the gate emptied is a promise of content that is not there
 * (D5-16). A heading is a Markdown heading line or a bold label on a line
 * of its own; it is empty when the next non-blank line is another heading
 * or the end of the text.
 */
export function dropEmptyHeadings(text: string): string {
  const lines = text.split('\n')
  const isHeading = (line: string) =>
    /^\s*#{1,6}\s+\S/.test(line) || /^\s*\*\*[^*\n]{1,80}\*\*:?\s*$/.test(line)
  const keep: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!isHeading(line)) {
      keep.push(line)
      continue
    }
    let next = i + 1
    while (next < lines.length && lines[next]!.trim() === '') next++
    const following = lines[next]
    const empty = following === undefined || isHeading(following) ||
      /^\s*\*[^*].*\*\s*$/.test(following) && next === lines.length - 1
    if (empty) continue
    keep.push(line)
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * A table reduced to its header and rule with no body row is no table:
 * it is removed rather than shown as an empty grid (D5-05). The caller
 * decides what an answer with nothing left means.
 */
export function dropHeaderOnlyTables(text: string): string {
  const lines = text.split('\n')
  const isRow = (line: string | undefined) => line !== undefined && /^\s*\|.*\|\s*$/.test(line)
  const isRule = (line: string | undefined) =>
    line !== undefined && /^\s*\|?[\s|:-]+\|?\s*$/.test(line) && /-/.test(line)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && isRule(lines[i + 1]) && !isRow(lines[i + 2])) {
      i += 1
      continue
    }
    out.push(lines[i]!)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Every format leak fixed at once, in the order the gate needs: fences first, then empty tables and headings. */
export function cleanFormatLeaks(text: string): string {
  return dropEmptyHeadings(dropHeaderOnlyTables(stripCodeFences(text)))
}

// ---------------------------------------------------------------------------
// Sentinel phrases
// ---------------------------------------------------------------------------

/** The platform's guardrail sentence and the prompt's own coverage line, as whole sentences. */
export const TEMPLATE_SENTENCE =
  /(?:^|(?<=\s))["'“(]?(?:not enough (?:data|information|context) to (?:answer|confirm|determine|say|assess|establish)[^.!?\n]*|if you need more information,? the portal'?s sources do not cover (?:it|this|that)[^.!?\n]*)[.!?]?["'”)]?/gi

/** Verb agreement once "the context" (singular) becomes "the cited sources" (plural). */
const SINGULAR_VERBS: Record<string, string> = {
  'does not': 'do not',
  "doesn't": 'do not',
  does: 'do',
  is: 'are',
  "isn't": 'are not',
  has: 'have',
  was: 'were',
  'has not': 'have not',
  "hasn't": 'have not',
}

const THIRD_PERSON =
  /^(provide|indicate|mention|state|include|contain|describe|suggest|report|show|lack|specify|offer|give|say|note|discuss|highlight|identify|present|refer|explain|address|cover|support|confirm|imply|appear|seem|detail|outline|list|emphasise|emphasize|focus|establish|demonstrate|reveal|clarify)(e?s)$/i

/**
 * Rewrites the sentinel phrases a reader should never see. "[inference]"
 * becomes the "(inference)" hedge the surfaces style; "the context" becomes
 * "the cited sources" with its verb made plural; the platform's "Not enough
 * data to answer this" and the prompt's "If you need more information, the
 * portal's sources do not cover it" are removed as sentences. A text that is
 * nothing but those sentences comes back empty, which the caller turns into
 * the portal's own decline.
 */
export function rewriteSentinels(text: string): string {
  // The prompt asks the model to mark its own inferences; the token leaked
  // into answers as "(inference).[1]" and reads as a template (D5-16). The
  // gate judges every figure regardless, so the mark carries nothing the
  // reader needs.
  let out = text.replace(/\s*[[(]inference[\])]/gi, '')
  out = out.replace(TEMPLATE_SENTENCE, '')
  out = out.replace(
    /\b(the|this|that|in the|from the|within the|per the|by the|of the)\s+(?:provided\s+|given\s+|available\s+|supplied\s+|retrieved\s+)?context\b(\s+)((?:does not|doesn't|has not|hasn't|isn't|does|is|has|was)\b|[a-z]+)?/gi,
    (_m, lead: string, gap: string, verb: string | undefined) => {
      const noun = `${lead} cited sources`
      if (!verb) return noun + gap
      const lower = verb.toLowerCase()
      if (SINGULAR_VERBS[lower]) return `${noun}${gap}${SINGULAR_VERBS[lower]}`
      const third = THIRD_PERSON.exec(lower)
      if (third) return `${noun}${gap}${third[1]}`
      return `${noun}${gap}${verb}`
    },
  )
  // A sentence that was removed leaves doubled spaces or an orphaned line.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * Streaming form of `rewriteSentinels`: text is released only up to the last
 * sentence or line boundary, so a phrase that straddles two chunks is still
 * seen whole. `flush` releases the remainder at the end of the stream. The
 * final `done` text is rewritten separately and replaces what streamed.
 */
export class SentinelStream {
  private pending = ''

  push(chunk: string): string {
    this.pending += chunk
    // Release through the last boundary that leaves something pending: the
    // tail of a sentence is where a template sentence would still be growing.
    let cut = -1
    const re = /[.!?:](?=["'”)]?\s)|\n/g
    let m: RegExpExecArray | null
    while ((m = re.exec(this.pending)) !== null) {
      // A sentence end releases through the space after it; a newline is
      // its own boundary and releases nothing past it, or the first letter
      // of a sentinel that opens the next line ("\n\nThe context does not")
      // would go out before the rewriter could see the phrase.
      const end = m.index + m[0].length + (m[0] === '\n' ? 0 : 1)
      if (end < this.pending.length) cut = end
    }
    // A sentence that has ended at the very end of the buffer is complete:
    // its template phrases are whole and the rewriter can see them, so it
    // goes out now rather than waiting for the next sentence to start (a
    // one-sentence answer otherwise reaches the reader only at flush, with
    // the audit badge, as nothing then everything - D3-05). A digit before
    // the stop is held: "71." may be the head of "71.1%".
    if (cut < 0 && /[^\d\s][.!?]["'”)]?$/.test(this.pending)) cut = this.pending.length
    if (cut <= 0) return ''
    const out = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    return rewriteChunk(out)
  }

  flush(): string {
    const out = rewriteChunk(this.pending)
    this.pending = ''
    return out
  }
}

/** `rewriteSentinels` without the trim, so streamed chunks keep their joins. */
function rewriteChunk(chunk: string): string {
  if (!chunk) return ''
  const leading = /^\s*/.exec(chunk)?.[0] ?? ''
  const trailing = /\s*$/.exec(chunk)?.[0] ?? ''
  const core = rewriteSentinels(chunk)
  if (!core) return trailing.includes('\n') ? trailing : ''
  return leading + core + trailing
}

// ---------------------------------------------------------------------------
// The portal's own decline copy
// ---------------------------------------------------------------------------

/**
 * Whether streamed text is one of the fixed decline strings the retrieval
 * provider substitutes for a guardrail refusal. Held back by the ask handler,
 * which composes the decline itself once it knows the nearest matches.
 */
export function looksLikeProviderDecline(text: string): boolean {
  return /^\s*(this portal's content does not hold enough relevant material|the help documentation does not cover this yet)/i
    .test(text)
}

/**
 * The decline for an answer the figure gate emptied: the generator stated
 * figures no cited passage carries beside their claim, so the answer is
 * withheld and the reader told which figures failed and what to ask next.
 */
export function withheldDecline(
  nearestTitles: readonly string[],
  figures: readonly string[],
  /** Titles of retrieved papers that carry the figures somewhere, though not beside the claim (D3-15). */
  foundIn: readonly string[] = [],
  /** Figures the cited paper carries only where it cites other studies (D4-02). */
  secondhand: readonly string[] = [],
): string {
  const titles = nearestTitles.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 3)
  const label = (f: string) => f.replace(/(\d)((?:month|week|year|day|hour)s)$/, '$1 $2')
  const listed = figures.map(label).slice(0, 8)
  const stated = listed.length > 0 ? ` (${listed.join(', ')})` : ''
  const found = foundIn.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 2)
  const quoted = secondhand.map(label).filter((f) => listed.includes(f)).slice(0, 6)
  const where = quoted.length > 0
    ? ` The cited paper carries ${quoted.join(', ')} only where it cites other studies (its ` +
      'introduction or discussion), not among its own results, so the figure is not that ' +
      "paper's finding about the cohort you asked about."
    : found.length > 0
    ? ` The figures were found in ${
      found.map((t) => `*${t}*`).join(' and ')
    } but could not be tied to the claim as the answer stated it.`
    : ''
  const nearest = titles.length > 0
    ? ` The closest matches in the corpus are ${
      titles.map((t) => `*${t}*`).join(', ')
    } - listed below.`
    : ''
  return 'The generated answer stated figures' + stated +
    ' that no retrieved passage carries beside their claim, so it has been withheld rather than ' +
    'shown.' + where + nearest +
    ' Ask about one paper directly to see the figures it reports, or narrow the question to ' +
    'one cohort, drug or study.'
}

/**
 * The decline for a question about a relationship the collection holds no
 * study of - "adherence and death" when no retrieved paper's title,
 * summary or takeaways pairs the two (D3-12): the boundary stated plainly,
 * then the closest matches so coverage is told from evidence.
 */
export function pairDecline(
  pair: { exposure: string; outcome: string },
  nearestTitles: readonly string[],
): string {
  const titles = nearestTitles.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 3)
  const nearest = titles.length > 0
    ? ` The nearest papers are ${
      titles.map((t) => `*${t}*`).join(titles.length === 2 ? ' and ' : ', ')
    } - listed below, none of which studies that relationship.`
    : ''
  return `This collection holds no study of the relationship between ${pair.exposure} and ` +
    `${pair.outcome}, so no answer has been generated rather than one stitched from papers about ` +
    `other things.${nearest} Ask about one of those papers directly to see what it reports.`
}

/**
 * The corpus-wide decline, naming the closest resources retrieval found so
 * the reader learns what the corpus does hold rather than hitting a dead end.
 */
export function corpusDecline(
  nearestTitles: readonly string[],
  bestMatchPct?: number,
  opts: {
    /** No resource clears the grounding gate on meaning: say so instead of naming near misses. */
    noCloseMatch?: boolean
    /** A study the question named that the collection holds no paper for (D7-08). */
    missingStudy?: string
  } = {},
): string {
  const titles = opts.noCloseMatch
    ? []
    : nearestTitles.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 3)
  const strength = typeof bestMatchPct === 'number'
    ? ` The closest passages found were only weakly related (best match ${
      Math.round(bestMatchPct)
    }%).`
    : ''
  // Coverage told from evidence: a study the question names that no paper
  // in the collection reports is said so plainly, rather than left to be
  // inferred from "does not answer this question" (D7-08).
  const missing = opts.missingStudy
    ? ` This collection holds no paper reporting ${opts.missingStudy}.`
    : ''
  const lead = "This portal's sources do not answer this question directly, so no answer has " +
    `been generated.${missing}${strength}`
  const nearest = opts.noCloseMatch
    ? ' No source in the corpus comes close to this question, so none is listed as a match.'
    : titles.length > 0
    ? ` The closest matches in the corpus are ${
      titles.map((t) => `*${t}*`).join(titles.length === 2 ? ' and ' : ', ')
    } - listed below but not used.`
    : ''
  return `${lead}${nearest} Try narrowing the question to what the corpus covers, or browse ` +
    'the Library to see what it holds.'
}

/** The single-document decline for document chat - never the corpus-wide copy. */
export function documentDecline(): string {
  return 'This document does not state an answer to that question. Ask about something it ' +
    'covers - its methods, findings or limitations - or search the whole corpus instead.'
}
