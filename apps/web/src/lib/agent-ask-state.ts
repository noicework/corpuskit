import type {
  AgentAskErrorCode,
  AgentAskEvent,
  AgentAskMode,
  AgentChunk,
  AgentSource,
  AgentStepStatus,
} from '@research-portal/core'

// ---------------------------------------------------------------------------
// The agent ask view's state: what the reader has seen of one streamed answer
// (docs/AGENT-ASK.md), folded from the events one at a time. Pure, so the
// page can replay a fixture into it in a test without a DOM. Every event's
// guarantees are taken from the contract: `agent-start` first, each step
// opened once and closed at most once, citations after the text, exactly one
// `done` or `error` last.
// ---------------------------------------------------------------------------

/** Where a step sits in the agent's work, read from its id and module. */
export type AgentPhase = 'preparing' | 'searching' | 'summarising' | 'checking' | 'writing'

/** The phases in the order the work happens, which is the order the timeline shows them. */
export const PHASE_ORDER: readonly AgentPhase[] = [
  'preparing',
  'searching',
  'summarising',
  'checking',
  'writing',
]

export interface AgentStep {
  id: string
  module: string
  title: string
  status: AgentStepStatus
  phase: AgentPhase
  /** The reader's clock when the step opened, for a live counter while it runs. */
  startedAt: number
  /** How long the step took, from its closing event (or the reader's clock when the stream ended). */
  elapsedMs?: number
  /** The agent's own reason for the step, when it gave one. */
  reason?: string
}

/** One lookup a source answered: the question put to it and the passages it returned. */
export interface AgentLookup {
  stepId: string
  question?: string
  chunks: AgentChunk[]
}

export type SourceFailure = 'timeout' | 'unauthorised' | 'error'

/** One source the answer can draw on, with everything it has returned so far. */
export interface AgentSourceGroup {
  source: AgentSource
  lookups: AgentLookup[]
  /** Set from `sources-failed`: the source could not be searched. */
  failed?: SourceFailure
}

export interface AgentCitation {
  marker: string
  sourceId: string
  chunkId: string
  title: string
  url?: string
}

export interface AgentAskError {
  code: AgentAskErrorCode
  message: string
  retryable: boolean
}

/**
 * `idle` before the first event; `streaming` while events arrive; `done` after `done`;
 * `error` after `error` (or the reader's own time limit); `cancelled` when the reader stopped it.
 */
export type AgentAskStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

export interface AgentAskState {
  status: AgentAskStatus
  mode: AgentAskMode | null
  sources: AgentSourceGroup[]
  steps: AgentStep[]
  /** Closed runs of the agent thinking aloud, in order. */
  reasoning: string[]
  /** The run of reasoning still open (no `last` yet). */
  reasoningOpen: string
  text: string
  citations: AgentCitation[]
  /** The sources named by `sources-failed`, in its order. */
  failedSources: (AgentSource & { reason: SourceFailure })[]
  /** The agent's own total, from `done`. */
  elapsedMs: number | null
  error: AgentAskError | null
}

export function initialAgentAskState(): AgentAskState {
  return {
    status: 'idle',
    mode: null,
    sources: [],
    steps: [],
    reasoning: [],
    reasoningOpen: '',
    text: '',
    citations: [],
    failedSources: [],
    elapsedMs: null,
    error: null,
  }
}

/** The phase a step belongs to, from the contract's id prefixes, then its module. */
export function phaseOf(step: { id: string; module: string }): AgentPhase {
  // A summary of what a lookup found is its own kind of work, whichever lookup it follows.
  if (step.module === 'summarize' || /\/summary$/.test(step.id)) return 'summarising'
  const prefix = step.id.split('/')[0] ?? ''
  switch (prefix) {
    case 'preprocess':
      return 'preparing'
    case 'context':
    case 'source':
      return 'searching'
    case 'postprocess':
    case 'verify':
      return 'checking'
    case 'generate':
    case 'compose':
      return 'writing'
  }
  switch (step.module) {
    case 'rephrase':
    case 'planner':
      return 'preparing'
    case 'basic_ask':
    case 'search':
      return 'searching'
    case 'rerank':
    case 'validation':
    case 'verify':
      return 'checking'
    case 'generation':
    case 'compose':
      return 'writing'
  }
  return 'preparing'
}

/** The steps still open: closed by the stream's end, or by the reader. */
function closeOpenSteps(
  steps: AgentStep[],
  status: AgentStepStatus,
  now: number,
): AgentStep[] {
  return steps.map((step) =>
    step.status === 'started'
      ? { ...step, status, elapsedMs: Math.max(0, now - step.startedAt) }
      : step
  )
}

function flushReasoning(state: AgentAskState): Pick<AgentAskState, 'reasoning' | 'reasoningOpen'> {
  const open = state.reasoningOpen.trim()
  return {
    reasoning: open ? [...state.reasoning, open] : state.reasoning,
    reasoningOpen: '',
  }
}

/**
 * Folds one event into the state. `now` is the reader's clock (`performance.now()` or
 * `Date.now()`, as long as it is the same one each call), used for live step counters.
 */
export function applyAgentAskEvent(
  state: AgentAskState,
  event: AgentAskEvent,
  now: number,
): AgentAskState {
  switch (event.type) {
    case 'agent-start': {
      const known = new Map(state.sources.map((group) => [group.source.id, group]))
      const sources = event.sources.map((source) => known.get(source.id) ?? { source, lookups: [] })
      for (const group of state.sources) {
        if (!sources.some((item) => item.source.id === group.source.id)) sources.push(group)
      }
      return { ...state, status: 'streaming', mode: event.mode, sources }
    }
    case 'agent-step': {
      const index = state.steps.findIndex((step) => step.id === event.id)
      if (event.status === 'started') {
        // Opened twice is a contract breach; the first opening stands.
        if (index >= 0) return state
        const step: AgentStep = {
          id: event.id,
          module: event.module,
          title: event.title,
          status: 'started',
          phase: phaseOf(event),
          startedAt: now,
          ...(event.reason ? { reason: event.reason } : {}),
        }
        return { ...state, status: 'streaming', steps: [...state.steps, step] }
      }
      const closing = {
        status: event.status,
        elapsedMs: event.elapsedMs ?? Math.max(0, now - (state.steps[index]?.startedAt ?? now)),
        ...(event.reason ? { reason: event.reason } : {}),
      }
      if (index < 0) {
        // Closed without opening: shown as a step that ran, so nothing the agent did is lost.
        const step: AgentStep = {
          id: event.id,
          module: event.module,
          title: event.title,
          phase: phaseOf(event),
          startedAt: now - closing.elapsedMs,
          ...closing,
        }
        return { ...state, status: 'streaming', steps: [...state.steps, step] }
      }
      const current = state.steps[index]!
      if (current.status !== 'started') return state
      const steps = state.steps.slice()
      steps[index] = { ...current, title: event.title, ...closing }
      return { ...state, status: 'streaming', steps }
    }
    case 'agent-sources': {
      const index = state.sources.findIndex((group) => group.source.id === event.source.id)
      const group: AgentSourceGroup = index >= 0
        ? state.sources[index]!
        : { source: event.source, lookups: [] }
      const lookupIndex = group.lookups.findIndex((lookup) => lookup.stepId === event.stepId)
      const lookups = group.lookups.slice()
      if (lookupIndex >= 0) {
        const lookup = lookups[lookupIndex]!
        lookups[lookupIndex] = {
          ...lookup,
          ...(event.question ? { question: event.question } : {}),
          chunks: [...lookup.chunks, ...event.chunks],
        }
      } else {
        lookups.push({
          stepId: event.stepId,
          ...(event.question ? { question: event.question } : {}),
          chunks: event.chunks,
        })
      }
      const sources = state.sources.slice()
      const next = { ...group, lookups }
      if (index >= 0) sources[index] = next
      else sources.push(next)
      return { ...state, status: 'streaming', sources }
    }
    case 'sources-failed': {
      const failed = new Map(event.sources.map((source) => [source.id, source.reason]))
      const sources = state.sources.map((group) => {
        const reason = failed.get(group.source.id)
        return reason ? { ...group, failed: reason } : group
      })
      for (const source of event.sources) {
        if (!sources.some((group) => group.source.id === source.id)) {
          const { reason, ...rest } = source
          sources.push({ source: rest, lookups: [], failed: reason })
        }
      }
      return { ...state, status: 'streaming', sources, failedSources: event.sources }
    }
    case 'reasoning': {
      const open = state.reasoningOpen + event.text
      if (!event.last) return { ...state, status: 'streaming', reasoningOpen: open }
      const trimmed = open.trim()
      return {
        ...state,
        status: 'streaming',
        reasoning: trimmed ? [...state.reasoning, trimmed] : state.reasoning,
        reasoningOpen: '',
      }
    }
    case 'delta':
      return { ...state, status: 'streaming', text: state.text + event.text }
    case 'citation': {
      if (state.citations.some((citation) => citation.marker === event.marker)) return state
      const { type: _type, ...citation } = event
      return { ...state, status: 'streaming', citations: [...state.citations, citation] }
    }
    case 'done':
      return {
        ...state,
        ...flushReasoning(state),
        status: 'done',
        steps: closeOpenSteps(state.steps, 'completed', now),
        elapsedMs: event.elapsedMs,
        // The citation-checked final text replaces the provisional deltas when the server sends it.
        ...(event.text !== undefined ? { text: event.text } : {}),
      }
    case 'error':
      return {
        ...state,
        ...flushReasoning(state),
        status: 'error',
        steps: closeOpenSteps(state.steps, 'failed', now),
        error: { code: event.code, message: event.message, retryable: event.retryable },
      }
  }
}

/**
 * The stream ended on the reader's side: they stopped it (`cancelled`), the portal's own time
 * limit passed (`timeout`), or the connection failed (`upstream`). Open steps close as failed
 * and whatever arrived is kept.
 */
export function endAgentAsk(
  state: AgentAskState,
  ending:
    | { code: 'cancelled' }
    | { code: 'timeout' | 'upstream' | 'not_configured'; message: string },
  now: number,
): AgentAskState {
  if (state.status === 'done' || state.status === 'error') return state
  const steps = closeOpenSteps(state.steps, 'failed', now)
  if (ending.code === 'cancelled') {
    return { ...state, ...flushReasoning(state), status: 'cancelled', steps }
  }
  return {
    ...state,
    ...flushReasoning(state),
    status: 'error',
    steps,
    error: {
      code: ending.code,
      message: ending.message,
      retryable: ending.code !== 'not_configured',
    },
  }
}

// ---------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------

/** A `[marker]` in the answer text: `[block-AA]` from an agent, `[1]` when composed. */
const MARKER = /\[(block-[A-Za-z0-9]+|\d+)\]/g

export type AnswerSegment = { kind: 'text'; text: string } | { kind: 'marker'; marker: string }

/** Splits a run of answer text on its citation markers. */
export function splitAnswerMarkers(text: string): AnswerSegment[] {
  const out: AnswerSegment[] = []
  let last = 0
  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0
    if (index > last) out.push({ kind: 'text', text: text.slice(last, index) })
    out.push({ kind: 'marker', marker: match[1]! })
    last = index + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * The number each marker shows as, in order of first appearance in the text, then any
 * citation the text never mentions. A composed answer's `[1]`, `[2]` keep their numbers; an
 * agent's `[block-AA]`, `[block-AB]` read as 1, 2. A marker whose citation has not arrived
 * yet still gets its number, so the numbering never shifts as citations land.
 */
export function citationNumbers(
  text: string,
  citations: readonly AgentCitation[],
): Map<string, number> {
  const numbers = new Map<string, number>()
  for (const match of text.matchAll(MARKER)) {
    const marker = match[1]!
    if (!numbers.has(marker)) numbers.set(marker, numbers.size + 1)
  }
  for (const citation of citations) {
    if (!numbers.has(citation.marker)) numbers.set(citation.marker, numbers.size + 1)
  }
  return numbers
}

/** Where a passage lives: its own address, else the portal resource it came from. */
export function chunkHref(
  source: AgentSource,
  chunk: Pick<AgentChunk, 'url' | 'resourceId'>,
): string | undefined {
  if (chunk.url) return chunk.url
  if (source.portal && chunk.resourceId) {
    return `/t/${encodeURIComponent(source.portal)}/library/${encodeURIComponent(chunk.resourceId)}`
  }
  return undefined
}

/** The passage a citation points at, from the sources seen so far. */
export function citedChunk(
  state: Pick<AgentAskState, 'sources'>,
  citation: Pick<AgentCitation, 'sourceId' | 'chunkId'>,
): { source: AgentSource; chunk: AgentChunk } | undefined {
  const group = state.sources.find((item) => item.source.id === citation.sourceId)
  if (!group) return undefined
  for (const lookup of group.lookups) {
    const chunk = lookup.chunks.find((item) => item.id === citation.chunkId)
    if (chunk) return { source: group.source, chunk }
  }
  return undefined
}

/** Where a citation's marker should take the reader, or nowhere when nothing is known. */
export function citationHref(
  state: Pick<AgentAskState, 'sources'>,
  citation: AgentCitation,
): string | undefined {
  if (citation.url) return citation.url
  const cited = citedChunk(state, citation)
  if (cited) return chunkHref(cited.source, cited.chunk)
  const group = state.sources.find((item) => item.source.id === citation.sourceId)
  return group ? chunkHref(group.source, { resourceId: undefined, url: undefined }) : undefined
}

export type SourceState = 'queued' | 'searching' | 'found' | 'failed'

/**
 * What one source is doing: queued until a lookup opens, searching while a lookup step for it
 * is open, found once it has returned passages, failed when `sources-failed` named it.
 */
export function sourceState(group: AgentSourceGroup, steps: readonly AgentStep[]): SourceState {
  if (group.failed) return 'failed'
  const passages = group.lookups.reduce((count, lookup) => count + lookup.chunks.length, 0)
  const searching = steps.some((step) =>
    step.status === 'started' && step.phase === 'searching' && stepSearches(step, group.source)
  )
  if (searching) return 'searching'
  if (passages > 0 || group.lookups.length > 0) return 'found'
  return 'queued'
}

/** Whether a lookup step is this source's: `source/<slug>` when composed, else its title names it. */
function stepSearches(step: AgentStep, source: AgentSource): boolean {
  if (
    step.id === `source/${source.id}` || (source.portal && step.id === `source/${source.portal}`)
  ) {
    return true
  }
  return step.title.toLowerCase().includes(source.label.toLowerCase())
}

/**
 * How a source is introduced beside its name: a federated partner's collection is said to be
 * one, and one reached over MCP says so; a portal of this deployment needs no introduction.
 */
export function sourceKindLabel(
  source: Pick<AgentSource, 'kind' | 'transport'>,
): 'federated partner' | 'partner over MCP' | undefined {
  if (source.kind !== 'peer') return undefined
  return source.transport === 'mcp' ? 'partner over MCP' : 'federated partner'
}

/** The passages a source has returned, across its lookups. */
export function passageCount(group: AgentSourceGroup): number {
  return group.lookups.reduce((count, lookup) => count + lookup.chunks.length, 0)
}

/** The sources that contributed at least one passage. */
export function contributingSources(state: Pick<AgentAskState, 'sources'>): AgentSourceGroup[] {
  return state.sources.filter((group) => !group.failed && passageCount(group) > 0)
}

/** The sources a finished answer cites, in the order the sources were announced. */
export function citedSources(
  state: Pick<AgentAskState, 'sources' | 'citations'>,
): AgentSourceGroup[] {
  const ids = new Set(state.citations.map((citation) => citation.sourceId))
  return state.sources.filter((group) => ids.has(group.source.id))
}

/** `1:05` for a running clock: minutes and zero-padded seconds. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * A duration as a reader says it: tenths under ten seconds (`3.1 s`), whole seconds under a
 * minute (`19 s`), then minutes and seconds (`1 min 30 s`). The units are the caller's words.
 */
export function durationLabel(
  ms: number,
  words: { seconds: string; minutes: string } = { seconds: 's', minutes: 'min' },
): string {
  const clamped = Math.max(0, ms)
  if (clamped < 10_000) return `${(Math.round(clamped / 100) / 10).toFixed(1)} ${words.seconds}`
  const total = Math.round(clamped / 1000)
  if (total < 60) return `${total} ${words.seconds}`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0
    ? `${minutes} ${words.minutes}`
    : `${minutes} ${words.minutes} ${seconds} ${words.seconds}`
}

/**
 * How many steps an answer is expected to take, known from `agent-start` before any step opens,
 * so the count never starts at "0 of 1". An agent understands the question, plans, searches and
 * summarises each source, ranks, checks coverage and writes: 2N + 5 for N sources. Composing
 * searches each source, composes and verifies: N + 2. A baseline, not a promise: the view shows
 * the larger of this and the steps it has seen, and the real count once the stream ends.
 */
export function expectedStepCount(mode: AgentAskMode | null, sourceCount: number): number {
  if (mode === 'agent') return 2 * sourceCount + 5
  if (mode === 'orchestrated') return sourceCount + 2
  return 0
}

/** The step count to show: the baseline while streaming, and what happened once it is over. */
export function stepTotal(
  state: Pick<AgentAskState, 'status' | 'mode' | 'sources' | 'steps'>,
): number {
  return state.status === 'streaming'
    ? Math.max(expectedStepCount(state.mode, state.sources.length), state.steps.length)
    : state.steps.length
}

/** The step the agent is on now: the most recently opened step still running. */
export function activeStep(steps: readonly AgentStep[]): AgentStep | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!
    if (step.status === 'started') return step
  }
  return undefined
}
