/**
 * Attributes a model-named source in Generate and Assessment to a real,
 * retrieved resource, or drops it.
 *
 * Resolves the model's own claimed source title against the resources
 * actually retrieved for the request; an invented or unmatched title is
 * never shown. Used by the `/generate` route in `app.ts`.
 * Serves: R22 (P6-07); PR #4, #9, #11, #14.
 */
import type { ScoredResource } from '@research-portal/core'

/**
 * Source attribution for structured artefacts (Generate and Assessment).
 *
 * The model is asked to name, per briefing section and per quiz question, the
 * title of the context source it drew on. A model-written title is only ever
 * shown if it names a source that was actually retrieved for the request -
 * matched against the merchandised title and the raw source name - and it is
 * resolved to that resource's id so the reader can open it. An invented or
 * unmatched attribution is dropped, never displayed (the comparison matrix's
 * rule, applied to the other artefacts).
 */

export interface AttributedSource {
  resourceId: string
  title: string
}

/** One numbered reference in a briefing, built from the resource record, never from the model. */
export interface BriefingReference {
  index: number
  resourceId: string
  title: string
  journal?: string
  year?: string
  authors?: string[]
}

/** The record fields a reference is built from. */
export type ReferenceSource =
  & Pick<ScoredResource, 'id' | 'title' | 'sourceName'>
  & Partial<Pick<ScoredResource, 'journal' | 'year' | 'authors' | 'published'>>

/**
 * Free-text citation labels the model writes despite instruction -
 * "(Journal of Neurology, 2024)", "(Broadley et al.)", "(Smith and Jones, 2021)",
 * "(2024)" - are removed: the reference list carries the real record. A
 * parenthesis that holds anything else (a figure, an acronym, a
 * confidence interval) is left alone.
 */
export function stripCitationLabels(text: string): string {
  const AUTHOR = "[A-Z][A-Za-z'\u2019-]+"
  const YEAR = '(?:19|20)\\d\\d[a-z]?'
  const label = new RegExp(
    '\\s*\\((?:' +
      // Journal or study name, comma, year
      `[A-Z][A-Za-z&.'\u2019 -]{2,80},\\s*${YEAR}` +
      // Author et al. / Author and Author, year / Author, year
      `|${AUTHOR}(?:\\s+(?:and|&)\\s+${AUTHOR})?(?:\\s+et\\s+al\\.?)(?:,?\\s*${YEAR})?` +
      `|${AUTHOR}(?:\\s+(?:and|&)\\s+${AUTHOR})?,?\\s*${YEAR}` +
      // A bare year
      `|${YEAR}` +
      ')\\)',
    'g',
  )
  return text.replace(label, '').replace(/\s+([,.;:?!])/g, '$1').replace(/\s{2,}/g, ' ').trim()
}

function referenceFor(index: number, source: ReferenceSource): BriefingReference {
  const year = source.year ?? (source.published ? source.published.slice(0, 4) : undefined)
  return {
    index,
    resourceId: source.id,
    title: source.title,
    ...(source.journal ? { journal: source.journal } : {}),
    ...(year ? { year } : {}),
    ...(source.authors?.length ? { authors: source.authors } : {}),
  }
}

/** Content words plus figures, for tracing a takeaway to the section that states it. */
function claimTokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z][a-z-]{3,}|\d+(?:\.\d+)?%?/g) ?? []).filter((w) =>
      !STOP.has(w)
    ),
  )
}

/** Share of a takeaway's tokens a section must carry to be its source. */
export const MIN_TAKEAWAY_OVERLAP = 0.35

/**
 * The reference numbers a takeaway inherits: those of the section that
 * states it (best token overlap, at least `MIN_TAKEAWAY_OVERLAP`). A takeaway
 * no section states gets none, and renders without a marker.
 */
export function traceTakeaway(
  takeaway: string,
  sections: readonly { heading: string; content: string; refs: number[] }[],
): number[] {
  const words = claimTokens(takeaway)
  if (words.size === 0) return []
  let best: { refs: number[]; overlap: number } | null = null
  for (const section of sections) {
    const have = claimTokens(`${section.heading} ${section.content}`)
    let hits = 0
    for (const w of words) if (have.has(w)) hits++
    const overlap = hits / words.size
    if (overlap >= MIN_TAKEAWAY_OVERLAP && (!best || overlap > best.overlap)) {
      best = { refs: section.refs, overlap }
    }
  }
  return best?.refs ?? []
}

/** Instruction appended to the system prompt for a briefing (roadmap R22, P6-07). */
export const BRIEFING_INSTRUCTIONS =
  'You are writing a research briefing for a specialist reader. Every section must be built ' +
  'from the retrieved passages and must carry the concrete figures those passages report - ' +
  'effect sizes, sensitivities, AUCs, hazard ratios, cohort sizes, follow-up lengths, dataset ' +
  'names, doses - naming the study, trial or cohort beside each figure in plain prose. Never ' +
  'write a generality where the passages give a number. Do not write parenthetical citations ' +
  'such as (Journal, 2024) or (Author et al.): the portal adds numbered references from its own ' +
  'records. Report only what a passage itself found; a figure a passage quotes from earlier ' +
  'literature must be described as such, never as a finding of that study. In each ' +
  "section's `sources` list the exact titles of the context documents that section draws on; " +
  'a section with no source will be discarded, so only write sections the passages support. ' +
  "In each section's `statements` list every figure the section states, with the outcome it " +
  "measures and the population or analysis set it applies to in the source's own words, and " +
  'the exact source title; a figure given for a subgroup must say so. Australian English.'

/**
 * Appended to the briefing instructions when the application supplies the
 * grounding blocks itself (briefing-grounding.ts): one block per paper,
 * headed by the exact title the model must name in each section's sources.
 */
export const BRIEFING_CONTEXT_RULE =
  'The extra context supplies one block per paper, each headed `Source: "<title>"` followed ' +
  "by that paper's key takeaways, summary and its own Abstract, Results, Methods and " +
  'Conclusion paragraphs (labelled by section). Build every section from those blocks and ' +
  "name each block's exact title in the section's `sources`. Report each paper's own " +
  'hazard ratios, odds ratios, proportions and cohort sizes with their confidence intervals ' +
  'and denominators as the blocks give them; a figure the paper attributes to a ' +
  "meta-analysis or to earlier studies is not that paper's finding and must be described as such."

/** Paragraph budget for the platform's own retrieval when a briefing's context is supplied. */
export const BRIEFING_RETRIEVAL_TOP_K = 4

/** Instruction appended to the system prompt for an assessment quiz (roadmap R21, P8-11). */
export const ASSESSMENT_INSTRUCTIONS =
  'You are writing a knowledge check for a specialist reader. Every question must be answerable ' +
  "from one retrieved passage; put that document's exact title in `source` and copy eight to " +
  'twenty words of that passage, verbatim, into `source_quote`. Write stems about ' +
  'what the sources actually report - a figure, a proportion, an effect size, a comparison ' +
  'between two interventions, groups or study designs - and make every distractor a plausible ' +
  'value or claim a specialist could mistake for the answer, never an obviously absurd option. ' +
  'Prefer a stem that turns on a figure the passage states - a proportion, an effect size, a ' +
  'cohort size, a follow-up length - over one that turns on a definition. The portal checks ' +
  "every question's quote against the paper it came from and discards any it cannot find, so " +
  'write two more questions than the brief asks for and quote each one exactly. ' +
  'Write each stem as a question a reader would be asked in a clinic or a journal club: name ' +
  'the study, cohort, drug or measure it concerns, and never refer to "the context", "the ' +
  'passage", "the provided text" or "the document" - the reader cannot see them. Never write ' +
  'a question from a reference list, a citation entry or a bibliography: only from what a ' +
  'passage itself reports. Australian English.'

const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()

/** Content words of a title: four or more letters, lower-cased, de-duplicated. */
const contentWords = (value: string): Set<string> =>
  new Set((value.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))

const STOP = new Set(['with', 'from', 'that', 'this', 'study', 'analysis', 'using', 'their'])

/**
 * The share of the label's content words that also appear in the title. A
 * model paraphrases or shortens titles ("the Retrospective Linkage Study of
 * AE project" for "Retrospective linkage study of autoimmune encephalitis in
 * Australia: protocol"), so containment alone misses real attributions.
 */
export const MIN_WORD_OVERLAP = 0.6

function wordOverlap(label: string, title: string): number {
  const a = contentWords(label)
  if (a.size < 3) return 0
  const b = contentWords(title)
  let hits = 0
  for (const w of a) if (b.has(w)) hits++
  return hits / a.size
}

/**
 * Resolve a model-written source label to a retrieved resource. Exact or
 * containment matches on the merchandised title or the raw source name win
 * outright; otherwise the title sharing the most content words with the
 * label wins if at least `MIN_WORD_OVERLAP` of the label's words appear in
 * it. A label shorter than four characters never matches.
 */
export function resolveSource(
  label: string,
  sources: Pick<ScoredResource, 'id' | 'title' | 'sourceName'>[],
): AttributedSource | null {
  const wanted = normalise(label)
  if (wanted.length < 4) return null
  for (const source of sources) {
    const candidates = [source.title, source.sourceName]
      .filter((t): t is string => Boolean(t))
      .map(normalise)
      .filter((t) => t.length >= 4)
    if (candidates.some((t) => t === wanted || t.includes(wanted) || wanted.includes(t))) {
      return { resourceId: source.id, title: source.title }
    }
  }
  let best: { source: (typeof sources)[number]; overlap: number } | null = null
  for (const source of sources) {
    const overlap = Math.max(
      wordOverlap(wanted, source.title),
      source.sourceName ? wordOverlap(wanted, source.sourceName) : 0,
    )
    if (overlap >= MIN_WORD_OVERLAP && (!best || overlap > best.overlap)) best = { source, overlap }
  }
  return best ? { resourceId: best.source.id, title: best.source.title } : null
}

export interface BriefingSectionIn {
  heading?: string
  content?: string
  sources?: unknown
  statements?: unknown
}

/** One figure the model stated, with what it measures, whom it applies to and where it came from. */
export interface BriefingStatementIn {
  figure?: string
  outcome?: string
  population?: string
  study?: string
}

export interface AttributedBriefingSection {
  heading: string
  content: string
  sources: AttributedSource[]
  /** Reference numbers into the briefing's `references`, in citation order. */
  refs: number[]
  /** The model's per-figure statements, for the figure audit. */
  statements?: BriefingStatementIn[]
}

/**
 * Attribute a briefing's sections and refuse the ones nothing supports. A
 * section keeps only the sources that resolve to retrieved resources; a
 * section left with none is removed and its heading reported in
 * `omitted_sections`, so the reader sees what was withheld rather than an
 * unsourced paragraph presented as fact.
 */
export function attributeBriefing(
  object:
    & { sections?: unknown; key_takeaways?: unknown; executive_summary?: unknown }
    & Record<
      string,
      unknown
    >,
  sources: ReferenceSource[],
): {
  sections: AttributedBriefingSection[]
  key_takeaways: string[]
  omitted_sections: string[]
  /** Numbered references, in order of first citation, built from the resource records. */
  references: BriefingReference[]
  /** Reference numbers per key takeaway (parallel to `key_takeaways`); empty when untraced. */
  takeaway_refs: number[][]
} & Record<string, unknown> {
  const sections: AttributedBriefingSection[] = []
  const omitted: string[] = []
  const references: BriefingReference[] = []
  const indexOf = (source: AttributedSource): number => {
    const existing = references.find((r) => r.resourceId === source.resourceId)
    if (existing) return existing.index
    const record = sources.find((s) => s.id === source.resourceId)
    const reference = referenceFor(
      references.length + 1,
      record ?? { id: source.resourceId, title: source.title },
    )
    references.push(reference)
    return reference.index
  }
  const raw = Array.isArray(object.sections) ? object.sections as BriefingSectionIn[] : []
  for (const section of raw) {
    const heading = typeof section?.heading === 'string' ? section.heading.trim() : ''
    const content = typeof section?.content === 'string' ? stripCitationLabels(section.content) : ''
    if (!heading && !content) continue
    const labels = Array.isArray(section.sources)
      ? section.sources.filter((s): s is string => typeof s === 'string')
      : []
    const resolved: AttributedSource[] = []
    for (const label of labels) {
      const match = resolveSource(label, sources)
      if (match && !resolved.some((r) => r.resourceId === match.resourceId)) resolved.push(match)
    }
    if (resolved.length === 0) {
      omitted.push(heading || content.slice(0, 60))
      continue
    }
    const statements = Array.isArray(section.statements)
      ? section.statements.filter((st): st is BriefingStatementIn =>
        st !== null && typeof st === 'object'
      ).map((st) => ({
        ...(typeof st.figure === 'string' ? { figure: st.figure } : {}),
        ...(typeof st.outcome === 'string' ? { outcome: st.outcome } : {}),
        ...(typeof st.population === 'string' ? { population: st.population } : {}),
        ...(typeof st.study === 'string' ? { study: st.study } : {}),
      }))
      : []
    sections.push({ heading, content, sources: resolved, refs: resolved.map(indexOf), statements })
  }
  const takeaways = Array.isArray(object.key_takeaways)
    ? object.key_takeaways.filter((t): t is string => typeof t === 'string').map(
      stripCitationLabels,
    )
    : []
  const summary = typeof object.executive_summary === 'string'
    ? stripCitationLabels(object.executive_summary)
    : object.executive_summary
  return {
    ...object,
    ...(summary !== undefined ? { executive_summary: summary } : {}),
    key_takeaways: takeaways,
    takeaway_refs: takeaways.map((t) => traceTakeaway(t, sections)),
    sections,
    omitted_sections: omitted,
    references,
  }
}

export interface QuizQuestionIn {
  source?: unknown
  source_quote?: unknown
  [key: string]: unknown
}

/** Share of a quote's content words that a passage must carry to count as its origin. */
export const MIN_QUOTE_OVERLAP = 0.7

/**
 * Resolve a verbatim quote to the retrieved resource whose grounding passage
 * carries it. The model sees passages, not titles, so a quote is the
 * attribution it can actually make reliably, and it is checked first: the
 * title the model writes is its recollection, and loop 6 D6-09 shows the
 * two disagreeing. A quote is matched by content-word overlap against every
 * passage, best passage wins, and it needs at least four content words to
 * count.
 */
export function resolveByQuote(
  quote: string,
  passagesByResource: Record<string, string[]>,
): string | null {
  const words = contentWords(quote)
  if (words.size < 4) return null
  let best: { id: string; overlap: number } | null = null
  for (const [id, passages] of Object.entries(passagesByResource)) {
    for (const passage of passages) {
      const have = contentWords(passage)
      let hits = 0
      for (const w of words) if (have.has(w)) hits++
      const overlap = hits / words.size
      if (overlap >= MIN_QUOTE_OVERLAP && (!best || overlap > best.overlap)) best = { id, overlap }
    }
  }
  return best?.id ?? null
}

/**
 * The blocks of an extracted paper a quote can be located in: its
 * paragraphs, and each consecutive pair of them, so a quote that runs over
 * a paragraph break is still found.
 */
function quoteBlocks(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 30)
  const pairs = paragraphs.slice(0, -1).map((p, i) => `${p} ${paragraphs[i + 1]}`)
  return [...paragraphs, ...pairs]
}

/**
 * Whether a paper's own extracted text carries the quote, by the same
 * content-word measure `resolveByQuote` uses over retrieved passages. The
 * full text is the arbiter for a quiz question's Source link: the passages
 * the model saw are a slice of the corpus, and a question whose quote no
 * retrieved paper carries is not a question this portal asks (loop 6
 * D6-09).
 */
export function textCarriesQuote(quote: string, text: string): boolean {
  if (resolveByQuote(quote, { source: quoteBlocks(text) }) !== 'source') return false
  // Word overlap resolves a quote to a paper; only a verbatim run proves it
  // (review loop 7 D7-11). A machine-written page
  // summary reuses the paper's own vocabulary, so a bag-of-words check
  // passed a sentence that appears nowhere in the paper - and the reader
  // was shown it in quotation marks as the paper's own words.
  return carriesVerbatimRun(quote, text)
}

/** The longest run of consecutive words a quote and a text share. */
export function verbatimRun(quote: string, text: string): number {
  const words = quote.toLowerCase().match(/[a-z0-9][a-z0-9.%-]*/g) ?? []
  if (words.length === 0) return 0
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9.%-]+/g, ' ').trim()} `
  let best = 0
  for (let start = 0; start < words.length; start++) {
    let run = 0
    for (let end = start; end < words.length; end++) {
      const phrase = words.slice(start, end + 1).join(' ')
      if (!haystack.includes(` ${phrase} `)) break
      run = end - start + 1
    }
    if (run > best) best = run
  }
  return best
}

/**
 * Whether a text carries the quote as the paper's own words: a run of at
 * least eight consecutive words, or the whole quote when it is shorter.
 */
export function carriesVerbatimRun(quote: string, text: string): boolean {
  const words = quote.toLowerCase().match(/[a-z0-9][a-z0-9.%-]*/g) ?? []
  if (words.length === 0) return false
  return verbatimRun(quote, text) >= Math.min(8, words.length)
}

/**
 * Rotate a question's options so the correct answer is not always first.
 * The model reliably writes the correct option first and points
 * `correct_index` at 0, which a test-taker learns in two questions. The
 * rotation is by question position, so it is deterministic and keeps the
 * option order otherwise intact.
 */
export function rotateOptions(
  question: QuizQuestionIn,
  position: number,
): QuizQuestionIn {
  const options = Array.isArray(question.options)
    ? question.options.filter((o): o is string => typeof o === 'string')
    : []
  const correct = typeof question.correct_index === 'number' ? question.correct_index : 0
  if (options.length < 2 || correct < 0 || correct >= options.length) return question
  const shift = position % options.length
  const rotated = options.map((_, i) => options[(i - shift + options.length) % options.length]!)
  return { ...question, options: rotated, correct_index: (correct + shift) % options.length }
}

/**
 * A stem or explanation with the model's prompt-speak removed: "according to
 * the context", "as discussed in the provided text" and the like refer to a
 * passage the reader never sees. The phrase goes, the sentence keeps its
 * punctuation and its capital.
 */
export function cleanQuizProse(text: string): string {
  const CONTEXT =
    '(?:the |this |that |our )?(?:provided |given |retrieved |above |following |study |source )?' +
    '(?:context|passage|text|excerpt|document|source|sources|material|content|information provided|information)' +
    '(?: passage| provided| given| above| below)?'
  const cleaned = text
    .replace(
      new RegExp(
        `,?\\s*(?:according to|as (?:discussed|described|mentioned|stated|reported|noted|outlined|presented|indicated|highlighted|explained|shown) in|based on|as per|drawing on|from|in|per|within)\\s+${CONTEXT}(?=[\\s,.?!;:]|$)`,
        'gi',
      ),
      '',
    )
    .replace(
      new RegExp(
        `^\\s*${CONTEXT}\\s+(?:states|says|mentions|discusses|describes|notes|reports|indicates|suggests|highlights|explains) that\\s+`,
        'i',
      ),
      '',
    )
    // A phrase that opened the sentence leaves its comma behind.
    .replace(/^\s*[,;:]\s*/, '')
    .replace(/\s+([,.?!;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!cleaned) return text.trim()
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

/**
 * Whether a quote was lifted from a reference list rather than a passage: an
 * "et al." with a year, a DOI, or a volume-and-pages tail. A question written
 * from a bibliography entry tests nothing the corpus reports.
 */
export function isReferenceQuote(quote: string): boolean {
  const q = quote.trim()
  if (!q) return false
  // "the study by Kurowski et al." - a stem written about a cited paper.
  if (
    /\b(?:stud(?:y|ies)|report|trial|review|paper|workshop|article|work)\s+(?:by|from|of)\s+[A-Z][\w'\u2019-]+(?:\s+(?:and|&)\s+[A-Z][\w'\u2019-]+)?\s+et\s+al\b/
      .test(q)
  ) {
    return true
  }
  return /\bet al\.?,?\s*(?:\(?(?:19|20)\d\d\)?|[A-Z][\w .&]+\.\s*(?:19|20)\d\d)/.test(q) ||
    /\bdoi:|\bhttps?:\/\/doi\.org|\bvol\.\s*\d|\b\d{1,4}\s*[(:]\s*\d+\s*[):]\s*\d+/.test(q) ||
    /\b(?:19|20)\d\d;\s*\d+/.test(q)
}

/**
 * Attribute quiz questions: `source` (the model's title) becomes
 * `source_resource_id` plus `source_title` when it resolves; otherwise both
 * are null and the question stands without an attribution rather than with
 * an invented one. Options are rotated per question (see `rotateOptions`).
 */
export function attributeQuiz(
  object: { questions?: unknown } & Record<string, unknown>,
  sources: Pick<ScoredResource, 'id' | 'title' | 'sourceName'>[],
  passagesByResource: Record<string, string[]> = {},
  /** Whether a grounding passage is a reference list (the retrieval layer's detector). */
  isReferencePassage: (passage: string) => boolean = () => false,
): Record<string, unknown> {
  const raw = Array.isArray(object.questions) ? object.questions as QuizQuestionIn[] : []
  // A question written from a reference-list entry - its stem names a cited
  // paper, its quote is a bibliography line, or the passage its quote came
  // from is a reference list - is dropped, and counted, rather than asked.
  const passageOf = (quote: string): string | undefined => {
    const words = contentWords(quote)
    if (words.size < 4) return undefined
    let best: { passage: string; overlap: number } | null = null
    for (const passages of Object.values(passagesByResource)) {
      for (const passage of passages) {
        const have = contentWords(passage)
        let hits = 0
        for (const w of words) if (have.has(w)) hits++
        const overlap = hits / words.size
        if (overlap >= MIN_QUOTE_OVERLAP && (!best || overlap > best.overlap)) {
          best = { passage, overlap }
        }
      }
    }
    return best?.passage
  }
  const fromReferenceList = (q: QuizQuestionIn): boolean => {
    const quote = typeof q.source_quote === 'string' ? q.source_quote : ''
    const stem = typeof q.question === 'string' ? q.question : ''
    if ((quote && isReferenceQuote(quote)) || (stem && isReferenceQuote(stem))) return true
    const passage = quote ? passageOf(quote) : undefined
    return passage !== undefined && isReferencePassage(passage)
  }
  const fromReferences = raw.filter(fromReferenceList).length
  const questions = raw.filter((q) => !fromReferenceList(q)).map((question, position) => {
    const label = typeof question.source === 'string' ? question.source : ''
    const quote = typeof question.source_quote === 'string' ? question.source_quote : ''
    // The quote is the evidence and the title is the model's recollection of
    // it, so the paper that carries the quote wins: loop 6 D6-09 attributed
    // a rituximab question to the anti-LGI1 paper because that was the title
    // the model wrote, while the quoted sentence lived in another paper
    // entirely. The label only stands where the quote locates nowhere.
    let match: AttributedSource | null = null
    if (quote) {
      const id = resolveByQuote(quote, passagesByResource)
      const source = id ? sources.find((s) => s.id === id) : undefined
      if (source) match = { resourceId: source.id, title: source.title }
    }
    if (!match && label) match = resolveSource(label, sources)
    const { source: _source, source_quote: _quote, ...rest } = rotateOptions(question, position)
    return {
      ...rest,
      ...(typeof rest.question === 'string' ? { question: cleanQuizProse(rest.question) } : {}),
      ...(typeof rest.explanation === 'string'
        ? { explanation: cleanQuizProse(rest.explanation) }
        : {}),
      source_resource_id: match?.resourceId ?? null,
      source_title: match?.title ?? null,
      // The model's own quote, kept for audit only - never shown as an
      // attribution. Its label is kept only where it names the same paper
      // the quote resolved to: a label naming a different paper beside a
      // resolved id is two attributions for one question, and the reader
      // has no way to tell which is the source (D7-11).
      source_label: label && match && resolveSource(label, sources)?.resourceId === match.resourceId
        ? label
        : null,
      source_quote: quote || null,
    }
  })
  return { ...object, questions, omitted_questions: fromReferences }
}
