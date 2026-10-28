/**
 * Suggestions for a search field, matched in the browser against lists the portal already has:
 * its documents' titles, its topics and its suggested questions. Nothing here calls a server, so
 * typing costs nothing beyond the one title list fetched for the session.
 */

/** A matched span of an option's text, as `[start, end)` offsets. */
export type MatchRange = readonly [number, number]

export interface SuggestSources {
  documents: readonly {
    id: string
    title: string
    kind?: string
    type?: string
    topicIds?: readonly string[]
  }[]
  topics: readonly { id: string; label: string }[]
  questions: readonly { id: string; text: string }[]
}

export type Suggestion =
  | {
    type: 'document'
    id: string
    text: string
    ranges: MatchRange[]
    kind?: string
    resourceType?: string
    topicId?: string
  }
  | { type: 'topic'; id: string; text: string; ranges: MatchRange[] }
  | { type: 'question'; id: string; text: string; ranges: MatchRange[] }
  | { type: 'search'; text: string }
  | { type: 'ask'; text: string }

export type SuggestionGroupId = 'actions' | 'documents' | 'topics' | 'questions'

export interface SuggestionGroup {
  id: SuggestionGroupId
  items: Suggestion[]
}

/** Fewer characters than this match too much to be worth a list. */
export const SUGGEST_MIN_CHARS = 2
/** Rows in the whole list, the search and ask rows included. */
export const SUGGEST_MAX_ROWS = 8

/** At most this many rows from each list, whatever the others leave free. */
const GROUP_MAX = { documents: 6, topics: 3, questions: 3 } as const
/**
 * The order rows are handed out in, one slot a turn: documents take two turns to every one of
 * the others, so a busy corpus shows four documents, a topic and a question.
 */
const TURNS = ['documents', 'documents', 'topics', 'questions'] as const

const WORD_CHAR = /[\p{L}\p{N}]/u
/** Scripts written without spaces, where a match inside a run of letters is still a real one. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

/** The query as matched: trimmed, single-spaced. */
export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ')
}

function startsWord(text: string, index: number): boolean {
  return index === 0 || !WORD_CHAR.test(text[index - 1]!)
}

/** Where `needle` first occurs in `haystack` at the start of a word, else -1. */
function wordStart(haystack: string, needle: string): number {
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return -1
    if (startsWord(haystack, index)) return index
    from = index + 1
  }
  return -1
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * How well `text` matches `query`, or null when it does not. Higher scores rank first: the whole
 * text, then a prefix, then the start of a word, then (for three or more characters, or a script
 * written without spaces) anywhere, then every word of a several-word query starting a word in
 * any order. Matching ignores case. The ranges mark what to highlight; they are empty when
 * lower-casing changed the text's length, so a highlight is never drawn in the wrong place.
 */
export function matchText(
  text: string,
  query: string,
): { score: number; ranges: MatchRange[] } | null {
  const needle = normaliseQuery(query).toLowerCase()
  if (needle.length === 0) return null
  const haystack = text.toLowerCase()
  const aligned = haystack.length === text.length
  const result = (score: number, ranges: MatchRange[]) => ({
    score,
    ranges: aligned ? mergeRanges(ranges) : [],
  })

  if (haystack === needle) return result(1000, [[0, text.length]])
  const word = wordStart(haystack, needle)
  if (word === 0) return result(900, [[0, needle.length]])
  if (word > 0) return result(700 - Math.min(word, 100), [[word, word + needle.length]])
  const anywhere = haystack.indexOf(needle)
  if (anywhere >= 0 && (needle.length >= 3 || UNSPACED.test(needle))) {
    return result(400 - Math.min(anywhere, 100), [[anywhere, anywhere + needle.length]])
  }

  const tokens = needle.split(' ')
  if (tokens.length < 2) return null
  const ranges: MatchRange[] = []
  for (const token of tokens) {
    const index = wordStart(haystack, token)
    if (index < 0) return null
    ranges.push([index, index + token.length])
  }
  return result(300 - Math.min(ranges[0]![0], 100), ranges)
}

interface Ranked<T> {
  item: T
  text: string
  score: number
  ranges: MatchRange[]
}

function rank<T>(items: readonly T[], textOf: (item: T) => string, query: string): Ranked<T>[] {
  const ranked: Ranked<T>[] = []
  for (const item of items) {
    const text = textOf(item)
    const match = matchText(text, query)
    if (match) ranked.push({ item, text, ...match })
  }
  // Best match first; among equals, the shorter (closer) text, then alphabetical, so the order
  // never depends on the order the lists arrived in.
  return ranked.sort((a, b) =>
    b.score - a.score || a.text.length - b.text.length || a.text.localeCompare(b.text)
  )
}

/**
 * The grouped suggestions for a query: the search and ask rows (in the field's own order - the
 * header searches first, the hero asks first) and then the documents, topics and questions that
 * match, at most `SUGGEST_MAX_ROWS` rows in all. Empty below `SUGGEST_MIN_CHARS`.
 */
export function buildSuggestions(
  sources: SuggestSources,
  query: string,
  options: { primary?: 'search' | 'ask'; maxRows?: number } = {},
): SuggestionGroup[] {
  const text = normaliseQuery(query)
  if (text.length < SUGGEST_MIN_CHARS) return []
  const primary = options.primary ?? 'search'
  const maxRows = options.maxRows ?? SUGGEST_MAX_ROWS

  const actions: Suggestion[] = primary === 'search'
    ? [{ type: 'search', text }, { type: 'ask', text }]
    : [{ type: 'ask', text }, { type: 'search', text }]

  const ranked = {
    documents: rank(sources.documents, (doc) => doc.title, text),
    topics: rank(sources.topics, (topic) => topic.label, text),
    questions: rank(sources.questions, (question) => question.text, text),
  }
  const take = { documents: 0, topics: 0, questions: 0 }
  const budget = Math.max(0, maxRows - actions.length)
  let used = 0
  let progressed = true
  while (used < budget && progressed) {
    progressed = false
    for (const group of TURNS) {
      if (used >= budget) break
      if (take[group] < Math.min(ranked[group].length, GROUP_MAX[group])) {
        take[group]++
        used++
        progressed = true
      }
    }
  }

  const groups: SuggestionGroup[] = [{ id: 'actions', items: actions }]
  const documents = ranked.documents.slice(0, take.documents).map(({ item, ranges }) => ({
    type: 'document' as const,
    id: item.id,
    text: item.title,
    ranges,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.type ? { resourceType: item.type } : {}),
    ...(item.topicIds?.[0] ? { topicId: item.topicIds[0] } : {}),
  }))
  if (documents.length > 0) groups.push({ id: 'documents', items: documents })
  const topics = ranked.topics.slice(0, take.topics).map(({ item, ranges }) => ({
    type: 'topic' as const,
    id: item.id,
    text: item.label,
    ranges,
  }))
  if (topics.length > 0) groups.push({ id: 'topics', items: topics })
  const questions = ranked.questions.slice(0, take.questions).map(({ item, ranges }) => ({
    type: 'question' as const,
    id: item.id,
    text: item.text,
    ranges,
  }))
  if (questions.length > 0) groups.push({ id: 'questions', items: questions })
  return groups
}

/** The groups' rows in the order the keyboard walks them. */
export function flattenSuggestions(groups: readonly SuggestionGroup[]): Suggestion[] {
  return groups.flatMap((group) => group.items)
}

/** Text split into plain and matched runs, for drawing a highlight. */
export function highlightRuns(
  text: string,
  ranges: readonly MatchRange[],
): { text: string; match: boolean }[] {
  const runs: { text: string; match: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start < at || end > text.length || start >= end) continue
    if (start > at) runs.push({ text: text.slice(at, start), match: false })
    runs.push({ text: text.slice(start, end), match: true })
    at = end
  }
  if (at < text.length) runs.push({ text: text.slice(at), match: false })
  return runs
}
