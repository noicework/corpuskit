/**
 * Author-aware answers. A question that names an author the catalogue knows
 * ("What has O'Neill and colleagues published on seizure cycles?") is a
 * question about that author's papers: retrieval is scoped to them, and no
 * sentence may say "X and colleagues" over a citation to a paper X did not
 * write. Both are deterministic: the catalogue's author index is the only
 * source of truth, and an attribution is rewritten to the cited paper's own
 * first author or removed - never to a guess.
 */
import type { Citation, ResourceSummary } from '@research-portal/core'

/** Words that are capitalised in a question for reasons other than being a surname. */
const NOT_A_SURNAME = new Set([
  'what',
  'which',
  'when',
  'where',
  'who',
  'how',
  'does',
  'did',
  'has',
  'have',
  'is',
  'are',
  'was',
  'were',
  'can',
  'could',
  'should',
  'would',
  'the',
  'and',
  'for',
  'from',
  'with',
  'that',
  'this',
  'these',
  'those',
  'compare',
  'summarise',
  'summarize',
  'list',
  'find',
  'give',
  'tell',
  'explain',
  'describe',
  'melbourne',
  'australia',
  'australian',
  'victoria',
  'sydney',
  'epilepsy',
  'seizure',
  'seizures',
  'group',
  'study',
  'trial',
  'cohort',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
])

/** Diacritics and apostrophes removed: "O'Neill", "O’Neill" and "ONeill" are one surname (D3-04). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`']/g, '')
    .toLowerCase()
}

/** Surname from an "Surname AB" / "Surname, A. B." / "A. B. Surname" author string. */
export function surnameOf(author: string): string {
  const cleaned = author.replace(/[’‘`]/g, "'").replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const parts = cleaned.split(' ')
  // Initials are the all-caps short tokens; whatever remains is the surname.
  const names = parts.filter((part) => !/^[A-Z]{1,3}$/.test(part))
  if (names.length > 0 && names.length < parts.length) return names.join(' ')
  return parts[parts.length - 1] ?? ''
}

/** Whether a resource's author list carries the surname. */
export function hasAuthor(resource: { authors?: string[] }, surname: string): boolean {
  const wanted = fold(surname)
  return (resource.authors ?? []).some((a) => fold(surnameOf(a)) === wanted)
}

export interface NamedAuthor {
  surname: string
  /** Ids of the catalogue resources carrying the author. */
  resourceIds: string[]
}

/**
 * The surnames in a question that the catalogue's author index recognises,
 * with the resources each names. A candidate is a capitalised word of four
 * letters or more (apostrophes and hyphens allowed) that is not a lexicon
 * term, a known non-name, or an all-caps acronym; it must be an author of
 * at least one catalogue resource.
 */
export function authorsNamed(
  query: string,
  catalogue: readonly ResourceSummary[],
  lexicon: readonly string[] = [],
): NamedAuthor[] {
  const lexiconLower = new Set(lexicon.map((t) => t.toLowerCase()))
  const out: NamedAuthor[] = []
  const seen = new Set<string>()
  // The possessive is part of the name's shape, not of the name: "O'Neill's
  // papers" names O'Neill (D3-11).
  for (
    const m of query.matchAll(
      /(?<![\w'’])([A-Z][a-z]*['’]?[A-Z]?[a-z]+(?:-[A-Z][a-z]+)?)(?:['’]s\b)?(?![\w'’])/g,
    )
  ) {
    const word = m[1]!
    const lower = fold(word)
    if (word.length < 4 || seen.has(lower)) continue
    if (NOT_A_SURNAME.has(lower) || lexiconLower.has(lower)) continue
    // A surname scopes retrieval only in an author construction: "X's
    // papers", "papers by X", "X et al.", "X and colleagues", "what did X
    // find". "Grant background: ..." names no author, whatever the
    // catalogue holds under Grant (D5-07).
    if (!namesAnAuthor(query, word)) continue
    const resourceIds = catalogue.filter((r) => hasAuthor(r, word)).map((r) => r.id)
    if (resourceIds.length === 0) continue
    seen.add(lower)
    out.push({ surname: word, resourceIds })
  }
  return out
}

/**
 * Whether the question uses the surname in an author construction. The
 * shapes: "X's papers/work/group/studies/publications/findings/research",
 * "papers/work/studies by X", "by X and colleagues", "X et al.", "X and
 * colleagues/co-workers/collaborators", "the X group/lab/team", "authored
 * by X", and "what has/did X (and colleagues) publish/find/report/show".
 */
export function namesAnAuthor(query: string, surname: string): boolean {
  const name = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]")
  const shapes = [
    `\\b${name}['’]s\\s+(?:own\\s+)?(?:papers?|publications?|articles?|studies|work|group|lab|team|research|findings|results|cohorts?|series|reports?)\\b`,
    `\\b(?:papers?|publications?|articles?|studies|work|research|reports?|findings)\\s+(?:by|from|of)\\s+${name}\\b`,
    `\\b${name}\\s+et\\s+al\\b`,
    `\\b${name}\\s+and\\s+(?:colleagues|co-?workers|collaborators|others)\\b`,
    `\\b(?:by|from)\\s+${name}\\b`,
    `\\bthe\\s+${name}\\s+(?:group|lab|team)\\b`,
    `\\b(?:authored|written|published|led)\\s+by\\s+${name}\\b`,
    `\\b(?:has|have|had|did|does|do)\\s+${name}\\b`,
    `\\b${name}\\s+(?:publish|published|find|found|finds|report|reported|reports|show|showed|shows|describe|described|describes|conclude|concluded|study|studied|examine|examined|investigate|investigated|write|wrote|writes|argue|argued)\\b`,
  ]
  return shapes.some((shape) => new RegExp(shape, 'i').test(query))
}

/**
 * The trailing clause of a listing question that asks one attribute of each
 * paper rather than a second topic: "..., and what sample size did they
 * enrol?", "... and how many participants were in each?" (loop 6 D6-10).
 */
const PER_PAPER_CLAUSE =
  /,?\s*(?:and\s+)?(?:what|how many)\s+(?:sample\s+sizes?|participants?|patients?|people|subjects?)\b[^?]*|,?\s*(?:and\s+)?what\s+(?:was|were|is|are)\s+(?:the\s+)?(?:sample\s+sizes?|cohort\s+sizes?|enrolments?|enrollments?)\b[^?]*/gi

/**
 * Whether the question asks each listed paper for the number of people it
 * enrolled. The answer to that is per paper, from the paper's own words -
 * not from one retrieval that can only reach one of them (D6-10).
 */
export function asksEnrolment(query: string): boolean {
  return /\b(?:sample\s+size|cohort\s+size|enrol(?:l)?ment|how many\s+(?:participants|patients|people|subjects|were\s+(?:enrolled|recruited|included)))\b/i
    .test(query)
}

/**
 * The retrieval text for an author-scoped question: the question with the
 * attribution scaffolding removed ("What has O'Neill and colleagues
 * published on seizure cycles?" becomes "seizure cycles"). Retrieval is
 * already scoped to the author's articles, and the surname in the text
 * otherwise matches the reference lists of their other papers rather than
 * the papers' own findings (D1-05). Empty when nothing but scaffolding
 * remains.
 */
export function authorTopicQuery(query: string, surnames: readonly string[]): string {
  let text = query
  for (const surname of surnames) {
    text = text.replace(attributionPattern(surname), ' ')
    text = text.replace(
      new RegExp(
        `\\b(?:the\\s+)?${
          surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]")
        }(?:['’]s)?\\b`,
        'gi',
      ),
      ' ',
    )
  }
  text = text
    // "..., and what sample size did they enrol?" asks a per-paper
    // attribute, not a second topic: it is answered per paper from the
    // catalogue and the papers' own text (loop 6 D6-10), so it never
    // reaches the retrieval text.
    .replace(PER_PAPER_CLAUSE, ' ')
    // "Which of X's papers report on Y, and what did each find?" is Y (D3-11).
    .replace(
      /\bwhich\s+of\b|\b(?:papers?|publications?|articles?|studies|work)\s+(?:report|reported|describe|described|address|addressed|examine|examined|study|studied|investigate|investigated|cover|covered|deal)\w*\s*(?:on|about|with)?\b|,?\s*(?:and\s+)?what\s+(?:did|do|does)\s+(?:each|they|it|those|these)\s+(?:find|report|show|conclude|say)\b/gi,
      ' ',
    )
    .replace(
      /\b(?:what|which|where|when)\s+(?:has|have|had|did|does|do|is|are|was|were)\b|\b(?:has|have)\s+(?:been\s+)?(?:published|written|authored|reported|found|shown|studied|investigated)\b|\b(?:published|publish|publications?|papers?|work|works|studies|research|contributions?)\s+(?:on|about|into|regarding|concerning)\b|\b(?:their|his|her|the)\s+(?:work|research|papers?|publications?|studies)\b/gi,
      ' ',
    )
    .replace(/^\s*(?:on|about|into|regarding|concerning)\b/i, ' ')
    .replace(/[?.!]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.split(/\s+/).filter((w) => w.length > 0).length >= 2 ? text : ''
}

/** "X and colleagues", "X et al.", "X and co-workers", "X's group", "the X group". */
function attributionPattern(surname: string): RegExp {
  const name = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]")
  return new RegExp(
    `\\b(?:the\\s+)?${name}(?:['’]s\\s+(?:group|team|colleagues)|\\s+(?:and|&)\\s+(?:colleagues|co-?workers|collaborators|others)|\\s+et\\s+al\\.?|\\s+group)`,
    'gi',
  )
}

export interface AttributionFix {
  surname: string
  sentence: string
  /** The replacement made: the cited paper's first author, or a neutral subject. */
  replacedWith: string
}

/**
 * Rewrites every sentence that attributes work to a named author while
 * citing only papers that author did not write. One cited paper: its own
 * first author takes the attribution ("Xiong and colleagues"). Several with
 * different first authors, or an unknown author list: a neutral subject
 * ("Other authors"). A sentence with no markers is left alone - it may be
 * summarising the author's own papers cited elsewhere.
 */
export function correctAttributions(
  text: string,
  authors: readonly NamedAuthor[],
  citations: readonly Citation[],
  authorsOf: (resourceId: string) => string[] | undefined,
): { text: string; fixes: AttributionFix[] } {
  if (authors.length === 0) return { text, fixes: [] }
  const byIndex = new Map(citations.map((c) => [c.index, c.resourceId]))
  const fixes: AttributionFix[] = []
  const lines = text.split('\n').map((line) => {
    if (!/\[\d{1,3}\]/.test(line)) return line
    const sentences = line.split(/(?<=[.!?]["'”’)]*(?:\s*\[\d{1,3}\])*)\s+(?=[A-Z*(])/)
    return sentences.map((sentence) => {
      const markers = [...sentence.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]))
      if (markers.length === 0) return sentence
      let out = sentence
      for (const author of authors) {
        const pattern = attributionPattern(author.surname)
        if (!pattern.test(out)) continue
        const cited = [
          ...new Set(markers.map((n) => byIndex.get(n)).filter((id): id is string => !!id)),
        ]
        if (cited.length === 0) continue
        const lists = cited.map((id) => authorsOf(id))
        if (
          lists.some((list) => list !== undefined && hasAuthor({ authors: list }, author.surname))
        ) continue
        const firsts = [...new Set(lists.map((list) => list?.[0] ? surnameOf(list[0]) : undefined))]
        const single = firsts.length === 1 ? firsts[0] : undefined
        const replacement = single ? `${single} and colleagues` : 'Other authors'
        pattern.lastIndex = 0
        out = out.replace(pattern, (m) => {
          const lead = /^the\s+/i.test(m) ? '' : ''
          return `${lead}${replacement}`
        })
        // "The X group" became "Other authors": fix a possessive that followed.
        fixes.push({
          surname: author.surname,
          sentence: sentence.trim(),
          replacedWith: replacement,
        })
      }
      return out
    }).join(' ')
  })
  return { text: lines.join('\n'), fixes }
}

// ---------------------------------------------------------------------------
// A list of an author's papers (D3-11). "Which of X's papers report on Y, and
// what did each find?" is answered from the author-scoped retrieval, and the
// generator names the papers it chose to; the ones it left out are listed
// after it from the same sources, each with its own marker, so a paper in
// the grounding set is never missing from the answer.
// ---------------------------------------------------------------------------

/** Whether a question asks for a list of papers rather than a finding. */
export function isPaperListingQuestion(query: string): boolean {
  // The paper noun heads the interrogative phrase ("which of X's papers",
  // "what papers", "list the papers"); "what did the studies find" asks
  // for a finding, not a list.
  return /\b(?:which|what)\s+(?:of\s+(?:the\s+)?(?:[A-Za-z'’-]+\s+){0,2}?)?(?:[A-Za-z'’-]+\s+)?(?:papers?|publications?|articles?|studies|work)\b|\b(?:list|name|enumerate)\s+(?:the\s+|all\s+|every\s+)?(?:[A-Za-z'’-]+\s+)?(?:papers?|publications?|articles?|studies)\b/i
    .test(query)
}

/** The prompt addendum for an author-scoped listing question. */
export function paperListingAddendum(surname: string, topic: string): string {
  return `The sources are limited to papers by ${surname} in this collection. The question asks ` +
    `which of them concern ${topic || 'the topic'}: name every source paper that does, by its ` +
    'exact title, with what it found and a marker after each, and leave none of them out.'
}

const LISTING_STOP = new Set([
  'what',
  'which',
  'with',
  'from',
  'that',
  'this',
  'have',
  'does',
  'each',
  'find',
  'report',
  'papers',
  'paper',
  'study',
  'studies',
  'about',
  'their',
])

/** The topic's content words, hyphens and case folded: "sub-scalp EEG" is {subscalp, eeg}. */
function topicWords(topic: string): string[] {
  return [
    ...new Set(
      topic.toLowerCase().replace(/-/g, '').match(/[a-z][a-z0-9]{2,}/g) ?? [],
    ),
  ].filter((w) => !LISTING_STOP.has(w))
}

/**
 * Whether a source is about the topic: its title carries at least one of
 * the topic's words and, with its matched passage, all of them (one may be
 * missing from a longer topic). A summary that mentions the topic in
 * passing does not make a paper about it.
 */
function carriesTopic(
  source: { title: string; matchedPassage?: string },
  words: readonly string[],
): boolean {
  if (words.length === 0) return false
  const fold = (text: string) => text.toLowerCase().replace(/-/g, '')
  const title = fold(source.title)
  const titleHits = words.filter((w) => title.includes(w)).length
  if (titleHits === 0) return false
  const have = `${title} ${fold(source.matchedPassage ?? '')}`
  const hits = words.filter((w) => have.includes(w)).length
  return hits >= (words.length >= 3 ? words.length - 1 : words.length)
}

/** Whether the answer already names the paper (by the head of its title). */
function mentionsTitle(text: string, title: string): boolean {
  const head = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6)
    .join(' ')
  return head.length > 0 &&
    text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(head)
}

export interface PaperListingSource {
  id: string
  title: string
  summary?: string
  matchedPassage?: string
  year?: string
  journal?: string
  kind?: string
}

/**
 * The listing a review question is owed: one item per paper, with its
 * title, year and journal from the catalogue and a marker bound to it
 * (loop 6 D6-10 answered "Which of O'Neill's papers report patient-reported
 * outcomes after a first seizure" by naming one paper while citing two).
 * The list holds every author-scoped paper the answer cited, in citation
 * order, then every other scoped source on the topic; a paper named in the
 * prose is still listed, because the list is the answer to the question
 * asked. `note` is the per-paper attribute, already quoted and cited by the
 * caller, when the question asked one.
 */
export function appendOmittedPapers(input: {
  text: string
  query: string
  topic: string
  surname: string
  sources: readonly PaperListingSource[]
  scopeIds: readonly string[]
  citations: readonly Citation[]
  kindLabel: (id: string) => string
  /** Per-paper attribute lines, keyed by resource id (D6-10). */
  notes?: Record<string, string>
}): { text: string; citations: Citation[]; added: number; listed: string[] } {
  const unchanged = {
    text: input.text,
    citations: [...input.citations],
    added: 0,
    listed: [] as string[],
  }
  if (!isPaperListingQuestion(input.query)) return unchanged
  const scope = new Set(input.scopeIds)
  const byId = new Map(input.sources.map((s) => [s.id, s]))
  // The papers the answer itself cited, in the order it cited them: each is
  // evidence the answer already leant on, so each is owed a line.
  const cited = input.citations
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((c) => byId.get(c.resourceId))
    .filter((s): s is PaperListingSource => s !== undefined && scope.has(s.id))
  const words = topicWords(input.topic)
  const onTopic = words.length > 0
    ? input.sources.filter((s) => scope.has(s.id) && carriesTopic(s, words))
    : []
  const listed: PaperListingSource[] = []
  for (const source of [...cited, ...onTopic]) {
    if (!listed.some((s) => s.id === source.id)) listed.push(source)
  }
  // Nothing to add when the answer named the only paper there is and asked
  // for no per-paper attribute.
  const notes = input.notes ?? {}
  if (
    listed.length === 0 ||
    (listed.length === 1 && !notes[listed[0]!.id] && mentionsTitle(input.text, listed[0]!.title))
  ) return unchanged
  const citations = [...input.citations]
  let next = citations.reduce((m, c) => Math.max(m, c.index), 0) + 1
  const lines = listed.map((s) => {
    let citation = citations.find((c) => c.resourceId === s.id)
    if (!citation) {
      citation = {
        index: next++,
        resourceId: s.id,
        title: s.title,
        ...(s.matchedPassage ? { passage: s.matchedPassage } : {}),
      }
      citations.push(citation)
    }
    const meta = [s.year, s.journal, s.kind ? input.kindLabel(s.kind) : undefined]
      .filter(Boolean).join(', ')
    const note = notes[s.id]
    return `- *${s.title}*${meta ? ` (${meta})` : ''} [${citation.index}]${
      note ? ` - ${note}` : ''
    }`
  })
  const heading = input.topic
    ? `Papers by ${input.surname} in this collection on ${input.topic}:`
    : `Papers by ${input.surname} in this collection:`
  return {
    text: `${input.text.trimEnd()}\n\n${heading}\n\n${lines.join('\n')}`,
    citations,
    added: listed.filter((s) => !mentionsTitle(input.text, s.title)).length,
    listed: listed.map((s) => s.id),
  }
}

/**
 * The sentence a paper states its enrolment in, quoted verbatim: "A total
 * of 196 participants were enrolled". A protocol states a plan rather than
 * an enrolment, and says so ("450 patients will be recruited"), so it is
 * returned marked as planned and never offered as a result (D5-11, D6-10).
 * Undefined when the paper's text states neither.
 */
export function enrolmentSentence(
  text: string,
): { sentence: string; planned: boolean } | undefined {
  const COUNT =
    /(?:\bn\s*=\s*)?\b\d[\d,]{1,}\s+(?:participants|patients|subjects|adults|children|individuals|people|women|men|cases)\b/i
  const VERB =
    /\b(?:enrol(?:l)?ed|recruited|included|randomi[sz]ed|implanted|completed|underwent|participated|consented|were studied|comprised|analysed|analyzed)\b/i
  const PLANNED =
    /\b(?:will be|aims? to|aimed to|plans? to|planned to|intend(?:s|ed)? to|target(?:s|ed)?|estimated sample size|sample size calculation|anticipated)\b/i
  let planned: { sentence: string; planned: boolean } | undefined
  // The abstract and methods come first in an extracted paper, and the
  // enrolment is stated there; only the first 40,000 characters are read.
  const sentences = text.slice(0, 40_000)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("])/)
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (sentence.length < 20 || sentence.length > 300) continue
    if (!COUNT.test(sentence) || !VERB.test(sentence)) continue
    if (PLANNED.test(sentence)) {
      planned ??= { sentence, planned: true }
      continue
    }
    return { sentence, planned: false }
  }
  return planned
}
