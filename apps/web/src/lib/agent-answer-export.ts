import type {
  AgentAskErrorCode,
  AgentAskEvent,
  AgentAskMode,
  AgentChunk,
  AgentSource,
  Citation,
} from '@research-portal/core'
import { answerHtml, escapeHtml } from './answer-export.ts'
import { portalError, type PortalLanguage } from './locale-messages.ts'
import { englishResearchUi, type ResearchUi } from './research-copy.ts'
import { wordDocumentHtml } from './word-document.ts'

/**
 * The evidence brief: an agent ask answer (docs/AGENT-ASK.md) saved as a Word
 * document, with its references grouped by the source collection each one
 * came from.
 *
 * The agent ask stream is a sequence of events, so the page keeps one
 * `AgentAnswerRecord` per turn by folding the events through
 * `applyAgentEvent`. The brief is written from those records alone: the
 * answer text with its `[marker]` citations renumbered `[1]`, `[2]`... in
 * order of first appearance, then, under "References", one group per
 * collection in the order the stream announced them, each entry carrying its
 * number, title and a link (the passage's own address, or the portal resource
 * when the collection is a portal of this deployment; a federated partner's
 * passage with no link is quoted instead), and last the
 * collections that could not be searched (`sources-failed`), so a reader of
 * the saved file knows what the answer did not draw on.
 */

export interface AgentAnswerCitation {
  marker: string
  sourceId: string
  chunkId: string
  title: string
  url?: string
}

export type AgentFailedSource = AgentSource & { reason: 'timeout' | 'unauthorised' | 'error' }

/** One agent ask turn: the question and everything the stream said about its answer. */
export interface AgentAnswerRecord {
  question: string
  /** Who wrote the answer; unknown until `agent-start` arrives. */
  mode: AgentAskMode | null
  /** The collections the answer could search, in the order the stream announced them. */
  sources: readonly AgentSource[]
  /** The passages each collection returned, by source id. */
  passages: Readonly<Record<string, readonly AgentChunk[]>>
  /** The collections that could not be searched. */
  failed: readonly AgentFailedSource[]
  text: string
  citations: readonly AgentAnswerCitation[]
  status: 'streaming' | 'done' | 'error'
  error?: { code: AgentAskErrorCode; message: string }
}

export function emptyAgentAnswer(question: string): AgentAnswerRecord {
  return {
    question,
    mode: null,
    sources: [],
    passages: {},
    failed: [],
    text: '',
    citations: [],
    status: 'streaming',
  }
}

/** The record after one more event. Steps and reasoning carry nothing the brief needs. */
export function applyAgentEvent(
  record: AgentAnswerRecord,
  event: AgentAskEvent,
): AgentAnswerRecord {
  switch (event.type) {
    case 'agent-start':
      return { ...record, mode: event.mode, sources: event.sources }
    case 'agent-sources': {
      const known = record.sources.some((source) => source.id === event.source.id)
      const sources = known ? record.sources : [...record.sources, event.source]
      const held = record.passages[event.source.id] ?? []
      const ids = new Set(held.map((chunk) => chunk.id))
      const fresh = event.chunks.filter((chunk) => !ids.has(chunk.id))
      return {
        ...record,
        sources,
        passages: { ...record.passages, [event.source.id]: [...held, ...fresh] },
      }
    }
    case 'sources-failed':
      return { ...record, failed: event.sources }
    case 'delta':
      return { ...record, text: record.text + event.text }
    case 'citation': {
      const { type: _type, ...citation } = event
      return { ...record, citations: [...record.citations, citation] }
    }
    case 'done':
      return { ...record, text: event.text ?? record.text, status: 'done' }
    case 'error':
      return {
        ...record,
        status: 'error',
        error: { code: event.code, message: event.message },
      }
    default:
      return record
  }
}

/** A whole stream folded into one record. */
export function collectAgentAnswer(
  question: string,
  events: Iterable<AgentAskEvent>,
): AgentAnswerRecord {
  let record = emptyAgentAnswer(question)
  for (const event of events) record = applyAgentEvent(record, event)
  return record
}

/** Whether a turn has an answer worth saving: finished, with text. */
export function hasExportableAnswer(record: AgentAnswerRecord): boolean {
  return record.status === 'done' && record.text.trim().length > 0
}

/** Whether any turn of a trail can be exported. */
export function hasExportableTurn(turns: readonly AgentAnswerRecord[]): boolean {
  return turns.some(hasExportableAnswer)
}

// ---------------------------------------------------------------------------
// Numbering. An agent cites `[block-AA]`, a composed answer `[1]`; the brief
// numbers every citation by first appearance in the answer, so the markers
// read `[1]`, `[2]`... in reading order whatever the writer used.
// ---------------------------------------------------------------------------

export interface NumberedCitation extends AgentAnswerCitation {
  number: number
}

const MARKER = /\[([^\[\]\s]+)\]/g

export function numberCitations(record: AgentAnswerRecord): NumberedCitation[] {
  const byMarker = new Map<string, AgentAnswerCitation>()
  for (const citation of record.citations) {
    if (!byMarker.has(citation.marker)) byMarker.set(citation.marker, citation)
  }
  const ordered: AgentAnswerCitation[] = []
  const seen = new Set<string>()
  for (const match of record.text.matchAll(MARKER)) {
    const marker = match[1]!
    const citation = byMarker.get(marker)
    if (citation && !seen.has(marker)) {
      seen.add(marker)
      ordered.push(citation)
    }
  }
  // A citation whose marker never appears in the text is still something the
  // answer drew on: it closes the list.
  for (const [marker, citation] of byMarker) {
    if (!seen.has(marker)) ordered.push(citation)
  }
  return ordered.map((citation, index) => ({ ...citation, number: index + 1 }))
}

/** The answer text with each cited `[marker]` rewritten to its number and unresolved agent markers removed. */
export function renumberedText(record: AgentAnswerRecord, numbered: NumberedCitation[]): string {
  const numbers = new Map(numbered.map((citation) => [citation.marker, citation.number]))
  return record.text.replace(MARKER, (whole, marker: string) => {
    const number = numbers.get(marker)
    if (number !== undefined) return `[${number}]`
    // An agent marker with no citation event resolves to nothing, as a
    // stray number does in the Ask export; other bracketed text is kept.
    return /^block-[A-Za-z0-9]+$/.test(marker) ? '' : whole
  })
}

/** The answer body as HTML blocks, markers as superscripts - the export twin of the page. */
export function agentAnswerHtml(record: AgentAnswerRecord): string {
  const numbered = numberCitations(record)
  const citations: Citation[] = numbered.map((citation) => ({
    index: citation.number,
    resourceId: citation.chunkId,
    title: citation.title || citation.chunkId,
  }))
  return answerHtml(renumberedText(record, numbered), citations)
}

// ---------------------------------------------------------------------------
// Grouping by collection.
// ---------------------------------------------------------------------------

/** Resolves a portal resource to an absolute address the saved document can open. */
export type PortalResourceUrl = (portal: string, resourceId: string) => string

export interface ReferenceEntry extends NumberedCitation {
  /** Where the reference opens: the passage's own address or the portal resource. */
  href?: string
  /** The link is into a portal of this deployment rather than an outside address. */
  portalLink: boolean
  /** The cited passage itself, carried when there is nothing to link to (a federated partner's). */
  passage?: string
}

export interface ReferenceGroup {
  source: AgentSource
  entries: ReferenceEntry[]
}

function entryFor(
  citation: NumberedCitation,
  source: AgentSource,
  passages: readonly AgentChunk[],
  resourceUrl: PortalResourceUrl,
): ReferenceEntry {
  const chunk = passages.find((candidate) => candidate.id === citation.chunkId)
  const url = citation.url ?? chunk?.url
  if (url) return { ...citation, href: url, portalLink: false }
  if (source.portal && chunk?.resourceId) {
    return { ...citation, href: resourceUrl(source.portal, chunk.resourceId), portalLink: true }
  }
  // Nothing to open (a partner's passage with origin links off): the passage
  // itself is what a reader of the saved file can check.
  const passage = chunk?.text.replace(/\s+/g, ' ').trim()
  return { ...citation, portalLink: false, ...(passage ? { passage } : {}) }
}

/**
 * The cited references, one group per collection in the order the stream
 * announced the collections. A citation from a collection the stream never
 * announced closes the list under the source id it names. Collections that
 * returned passages but were not cited have no group: the brief lists what
 * the answer rests on.
 */
export function referenceGroups(
  record: AgentAnswerRecord,
  resourceUrl: PortalResourceUrl,
): ReferenceGroup[] {
  const numbered = numberCitations(record)
  const groups = new Map<string, ReferenceGroup>()
  for (const source of record.sources) groups.set(source.id, { source, entries: [] })
  for (const citation of numbered) {
    let group = groups.get(citation.sourceId)
    if (!group) {
      group = { source: { id: citation.sourceId, label: citation.sourceId }, entries: [] }
      groups.set(citation.sourceId, group)
    }
    group.entries.push(
      entryFor(citation, group.source, record.passages[group.source.id] ?? [], resourceUrl),
    )
  }
  return [...groups.values()].filter((group) => group.entries.length > 0)
}

// ---------------------------------------------------------------------------
// HTML.
// ---------------------------------------------------------------------------

function failureText(reason: AgentFailedSource['reason'], ui: ResearchUi): string {
  switch (reason) {
    case 'timeout':
      return ui('No answer within the time limit')
    case 'unauthorised':
      return ui('This partner could not be reached')
    default:
      return ui('Could not be searched')
  }
}

/** What a collection is when it is not this deployment's own: a federated partner, by transport. */
export function sourceKindLabel(source: AgentSource, ui: ResearchUi = englishResearchUi): string {
  if (source.kind !== 'peer') return ''
  return source.transport === 'mcp' ? ui('partner over MCP') : ui('federated partner')
}

/** "Partner A research (federated partner)", or the label alone for a hosted collection. */
function sourceHeading(source: AgentSource, ui: ResearchUi): string {
  const kind = sourceKindLabel(source, ui)
  return kind ? `${source.label} (${kind})` : source.label
}

/** "Composed by {product} across 3 collections" or "Answered by a retrieval agent from one collection". */
export function writerLine(
  record: AgentAnswerRecord,
  productName: string,
  ui: ResearchUi = englishResearchUi,
): string {
  const count = record.sources.length
  if (record.mode === 'orchestrated') {
    if (count === 0) return ui('Composed by {product}', { product: productName })
    if (count === 1) {
      return ui('Composed by {product} from one collection', { product: productName })
    }
    return ui('Composed by {product} across {count} collections', { product: productName, count })
  }
  if (count === 0) return ui('Answered by a retrieval agent')
  if (count === 1) return ui('Answered by a retrieval agent from one collection')
  return ui('Answered by a retrieval agent across {count} collections', { count })
}

/** Each collection with what it gave the answer: "Label (4 passages)" or its failure. */
export function collectionsLine(
  record: AgentAnswerRecord,
  ui: ResearchUi = englishResearchUi,
): string {
  return record.sources.map((source) => {
    const failure = record.failed.find((failed) => failed.id === source.id)
    const count = record.passages[source.id]?.length ?? 0
    const outcome = failure
      ? failureText(failure.reason, ui)
      : count === 1
      ? ui('1 passage')
      : ui('{count} passages', { count })
    const kind = sourceKindLabel(source, ui)
    return `${source.label} (${kind ? `${kind}, ` : ''}${outcome})`
  }).join(' · ')
}

function referenceEntryHtml(entry: ReferenceEntry, ui: ResearchUi): string {
  const parts = [`[${entry.number}]`, `<em>${escapeHtml(entry.title || entry.chunkId)}</em>.`]
  if (entry.href) {
    const text = entry.portalLink ? ui('Open in the portal') : entry.href
    parts.push(`<a href="${escapeHtml(entry.href)}">${escapeHtml(text)}</a>.`)
  }
  const passage = entry.passage ? `<blockquote>${escapeHtml(entry.passage)}</blockquote>` : ''
  return `<p>${parts.join(' ')}</p>${passage}`
}

/**
 * The reference section: a heading per collection with its numbered entries,
 * then the collections that could not be searched. Empty when the answer
 * cited nothing and every collection answered.
 */
export function agentReferencesHtml(
  record: AgentAnswerRecord,
  resourceUrl: PortalResourceUrl,
  ui: ResearchUi = englishResearchUi,
): string {
  const groups = referenceGroups(record, resourceUrl)
  if (groups.length === 0 && record.failed.length === 0) return ''
  const groupsHtml = groups.map((group) =>
    `<h4>${escapeHtml(sourceHeading(group.source, ui))}</h4>${
      group.entries.map((entry) => referenceEntryHtml(entry, ui)).join('')
    }`
  ).join('')
  const failedHtml = record.failed.length > 0
    ? `<h4>${escapeHtml(ui('Collections not searched'))}</h4><ul>${
      record.failed.map((source) =>
        `<li>${escapeHtml(sourceHeading(source, ui))} - ${
          escapeHtml(failureText(source.reason, ui))
        }</li>`
      ).join('')
    }</ul>`
    : ''
  return `<h3>${escapeHtml(ui('References'))}</h3>${groupsHtml}${failedHtml}`
}

/** One turn: the question, who answered, what was searched, the answer and its references. */
export function agentTurnHtml(
  record: AgentAnswerRecord,
  productName: string,
  resourceUrl: PortalResourceUrl,
  ui: ResearchUi = englishResearchUi,
  language: PortalLanguage = 'en',
): string {
  const question = `<h2>${escapeHtml(record.question)}</h2>`
  if (record.status === 'error' || !hasExportableAnswer(record)) {
    const detail = portalError(
      language,
      record.error?.message ?? '',
      'The answer service is unavailable.',
    )
    return `${question}<p><em>${escapeHtml(ui('Answer unavailable'))} - ${
      escapeHtml(detail)
    }</em></p>`
  }
  const writer = `<p><em>${escapeHtml(writerLine(record, productName, ui))}</em></p>`
  const collections = record.sources.length > 0
    ? `<p>${escapeHtml(ui('Collections'))}: ${escapeHtml(collectionsLine(record, ui))}</p>`
    : ''
  return `${question}${writer}${collections}${agentAnswerHtml(record)}${
    agentReferencesHtml(record, resourceUrl, ui)
  }`
}

/** The trail's title: its first question, cut to a line. */
export function agentTrailTitle(turns: readonly AgentAnswerRecord[]): string {
  const first = turns.find((turn) => turn.question.trim().length > 0)?.question.trim() ?? ''
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first
}

/**
 * The whole brief as a Word-compatible document: the portal's name, the date,
 * then every turn. `resourceUrl` makes portal links absolute so they resolve
 * from the saved file.
 */
export function agentTrailToWordHtml(
  portalName: string,
  title: string,
  turns: readonly AgentAnswerRecord[],
  resourceUrl: PortalResourceUrl,
  ui: ResearchUi = englishResearchUi,
  language: PortalLanguage = 'en',
  now: Date = new Date(),
): string {
  const dateLine = now.toLocaleDateString(language === 'ja' ? 'ja-JP' : 'en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const body = `<h1>${escapeHtml(portalName)}</h1>
<p>${escapeHtml(title)} &middot; ${escapeHtml(ui('Evidence brief'))} &middot; ${
    escapeHtml(dateLine)
  }</p>
${turns.map((turn) => agentTurnHtml(turn, portalName, resourceUrl, ui, language)).join('')}`
  return wordDocumentHtml(title, body)
}
