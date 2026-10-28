// ---------------------------------------------------------------------------
// A retrieval agent session's NDJSON stream (one `AragAnswer` object per
// line) normalised into the portal's agent ask events (docs/AGENT-ASK.md).
//
// Pure: no I/O, and no clock but the one it is given. Lenient by design:
// a line that is not JSON, not an object, or carries an operation it does
// not know is skipped, and fields it does not read are ignored, so an
// upstream that adds fields or sends a malformed line degrades to a
// shorter stream rather than a broken one.
// ---------------------------------------------------------------------------
import type { AgentAskEvent, AgentChunk, AgentSource } from '@research-portal/core'

/** `AragAnswer.operation`. */
const OPERATION = {
  answer: 0,
  quit: 1,
  start: 2,
  done: 3,
  error: 4,
  agentRequest: 5,
  answerChunk: 6,
  reasoning: 7,
} as const

export interface AgentStreamOptions {
  /** The sources the agent is configured with: announced first, and their labels win. */
  sources?: readonly AgentSource[]
  /** The clock, in milliseconds, for durations the stream does not report itself. */
  now?: () => number
}

type Line = Record<string, unknown>
interface OpenStep {
  id: string
  module: string
  title: string
  reason?: string
  startedAt: number
}
interface ContextChunk {
  id: string
  title: string
  sourceId: string
  url?: string
}

const isRecord = (value: unknown): value is Line =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const seconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const httpUrl = (value: unknown): string | undefined => {
  const candidate = text(value)
  if (!/^https?:\/\//i.test(candidate)) return undefined
  try {
    return new URL(candidate).href
  } catch {
    return undefined
  }
}

/**
 * Turns `AragAnswer` lines into agent ask events, one line at a time.
 *
 * - A step opens the first time its key (`agent_path`, else `module`) is seen and closes the next
 *   time: `failed` when that line carries an `error`, `completed` otherwise. A first sighting that
 *   is already finished (`timeit` above zero, or an `error`) opens and closes at once. A key seen
 *   again after it closed opens a new step, `<key>#2`.
 * - A `context` becomes one `agent-sources` event per driver among its chunks (`origin_agent`,
 *   else the context's `agent_id`, `source` or `agent`), attached to the step whose
 *   `agent_path` is `context/<id>`, or else to the line's own step.
 * - `answer_citations.metadata` entries become `citation` events, resolved through their
 *   `context_id` and `chunk_index`; one whose context or chunk never arrived is dropped.
 * - Answer chunks are `delta`s; a final `answer` is sent whole only when no chunk streamed.
 * - `done` or `quit` ends the stream with `done`, `error` with `error`; steps still open close
 *   with it. Lines after the end are ignored.
 */
export class AgentStreamNormaliser {
  readonly #sources: AgentSource[]
  readonly #now: () => number
  readonly #startedAt: number
  readonly #open = new Map<string, OpenStep>()
  readonly #lastId = new Map<string, string>()
  readonly #occurrences = new Map<string, number>()
  readonly #contexts = new Map<string, ContextChunk[]>()
  readonly #cited = new Set<string>()
  #streamed = false
  #finished = false

  constructor(options: AgentStreamOptions = {}) {
    this.#sources = (options.sources ?? []).map((source) => ({ ...source }))
    this.#now = options.now ?? Date.now
    this.#startedAt = this.#now()
  }

  /** Whether the stream has ended: nothing further is read. */
  get finished(): boolean {
    return this.#finished
  }

  /** The stream's first event, sent before any line arrives. */
  start(): AgentAskEvent {
    return {
      type: 'agent-start',
      mode: 'agent',
      sources: this.#sources.map((source) => ({ ...source })),
    }
  }

  /** The events one line produces: a raw NDJSON line, or the value already parsed from one. */
  push(input: unknown): AgentAskEvent[] {
    if (this.#finished) return []
    let line = input
    if (typeof input === 'string') {
      try {
        line = JSON.parse(input)
      } catch {
        return []
      }
    }
    if (!isRecord(line)) return []
    const operation = typeof line.operation === 'number' ? line.operation : OPERATION.answer
    const events: AgentAskEvent[] = []
    let stepId: string | undefined
    if (isRecord(line.step)) stepId = this.#step(line.step, events)
    if (isRecord(line.context)) this.#context(line.context, stepId, events)
    if (operation === OPERATION.reasoning && isRecord(line.reasoning)) {
      const reasoning = line.reasoning
      if (typeof reasoning.text === 'string') {
        events.push({ type: 'reasoning', text: reasoning.text, last: reasoning.last === true })
      }
    }
    if (operation === OPERATION.answerChunk && isRecord(line.streaming_response_chunk)) {
      const chunk = line.streaming_response_chunk.text
      if (typeof chunk === 'string' && chunk) {
        this.#streamed = true
        events.push({ type: 'delta', text: chunk })
      }
    }
    if (operation === OPERATION.answer && typeof line.answer === 'string' && line.answer) {
      if (!this.#streamed) events.push({ type: 'delta', text: line.answer })
      this.#streamed = true
    }
    if (isRecord(line.answer_citations)) this.#citations(line.answer_citations, events)
    if (operation === OPERATION.done || operation === OPERATION.quit) {
      this.#closeAll('completed', events)
      events.push({ type: 'done', elapsedMs: this.#elapsedSince(this.#startedAt) })
      this.#finished = true
    } else if (operation === OPERATION.error) {
      this.#closeAll('failed', events)
      const exception = isRecord(line.exception) ? line.exception : {}
      const step = isRecord(line.step) ? line.step : {}
      events.push({
        type: 'error',
        code: 'upstream',
        message: text(exception.detail) || text(exception.message) || text(line.error) ||
          text(step.error) || 'The agent reported an error.',
        retryable: true,
      })
      this.#finished = true
    }
    return events
  }

  /** The events the end of input produces: an `error` when the stream broke off unfinished. */
  finish(): AgentAskEvent[] {
    if (this.#finished) return []
    const events: AgentAskEvent[] = []
    this.#closeAll('failed', events)
    events.push({
      type: 'error',
      code: 'upstream',
      message: 'The agent stopped before it finished answering.',
      retryable: true,
    })
    this.#finished = true
    return events
  }

  #step(step: Line, events: AgentAskEvent[]): string {
    const module = text(step.module) || 'step'
    const key = text(step.agent_path) || module
    const reason = text(step.reason) || undefined
    const failed = text(step.error) !== ''
    const timeit = seconds(step.timeit)
    let open = this.#open.get(key)
    if (open) {
      this.#close(key, open, failed ? 'failed' : 'completed', timeit, reason, events)
      return open.id
    }
    const seen = this.#occurrences.get(key) ?? 0
    open = {
      id: seen === 0 ? key : `${key}#${seen + 1}`,
      module,
      title: text(step.title) || module,
      ...(reason ? { reason } : {}),
      startedAt: this.#now(),
    }
    this.#occurrences.set(key, seen + 1)
    this.#lastId.set(key, open.id)
    this.#open.set(key, open)
    events.push({
      type: 'agent-step',
      id: open.id,
      module: open.module,
      title: open.title,
      status: 'started',
      ...(open.reason ? { reason: open.reason } : {}),
    })
    if (failed || (timeit !== undefined && timeit > 0)) {
      this.#close(key, open, failed ? 'failed' : 'completed', timeit, undefined, events)
    }
    return open.id
  }

  #close(
    key: string,
    open: OpenStep,
    status: 'completed' | 'failed',
    timeit: number | undefined,
    reason: string | undefined,
    events: AgentAskEvent[],
  ) {
    this.#open.delete(key)
    const why = reason ?? open.reason
    events.push({
      type: 'agent-step',
      id: open.id,
      module: open.module,
      title: open.title,
      status,
      elapsedMs: timeit !== undefined
        ? Math.round(timeit * 1000)
        : this.#elapsedSince(open.startedAt),
      ...(why ? { reason: why } : {}),
    })
  }

  #closeAll(status: 'completed' | 'failed', events: AgentAskEvent[]) {
    for (const [key, open] of [...this.#open]) {
      this.#close(key, open, status, undefined, undefined, events)
    }
  }

  #context(context: Line, lineStepId: string | undefined, events: AgentAskEvent[]) {
    const id = text(context.id)
    const driver = text(context.agent_id) || text(context.source) || text(context.agent) ||
      'agent'
    const ownLabel = text(context.source) || text(context.agent) || driver
    const stepId = (id ? this.#lastId.get(`context/${id}`) : undefined) ?? lineStepId ??
      (id ? `context/${id}` : 'context')
    const question = text(context.question) || undefined
    const labelFor = (sourceId: string) =>
      this.#sources.find((source) => source.id === sourceId)?.label ??
        (sourceId === driver ? ownLabel : sourceId)
    const groups = new Map<string, AgentChunk[]>()
    const indexed: ContextChunk[] = []
    const raw = Array.isArray(context.chunks) ? context.chunks : []
    raw.forEach((value, index) => {
      if (!isRecord(value)) return
      const sourceId = text(value.origin_agent) || driver
      const url = httpUrl(value.url) ?? httpUrl(value.origin_url)
      const chunk: AgentChunk = {
        id: text(value.chunk_id) || `${id || 'context'}/${index}`,
        title: text(value.title) || labelFor(sourceId),
        text: typeof value.text === 'string' ? value.text : '',
        ...(url ? { url } : {}),
      }
      indexed[index] = { id: chunk.id, title: chunk.title, sourceId, ...(url ? { url } : {}) }
      const group = groups.get(sourceId) ?? []
      group.push(chunk)
      groups.set(sourceId, group)
    })
    if (id) this.#contexts.set(id, indexed)
    if (groups.size === 0) groups.set(driver, [])
    for (const [sourceId, chunks] of groups) {
      events.push({
        type: 'agent-sources',
        stepId,
        source: { id: sourceId, label: labelFor(sourceId) },
        ...(question ? { question } : {}),
        chunks,
      })
    }
  }

  #citations(citations: Line, events: AgentAskEvent[]) {
    if (!isRecord(citations.metadata)) return
    for (const [marker, value] of Object.entries(citations.metadata)) {
      if (!marker || this.#cited.has(marker) || !isRecord(value)) continue
      const chunks = this.#contexts.get(text(value.context_id))
      const index = value.chunk_index
      const chunk = chunks && typeof index === 'number' && Number.isInteger(index)
        ? chunks[index]
        : undefined
      if (!chunk) continue
      const origins = Array.isArray(value.origin_urls) ? value.origin_urls : []
      const url = origins.map(httpUrl).find((candidate) => candidate !== undefined) ?? chunk.url
      this.#cited.add(marker)
      events.push({
        type: 'citation',
        marker,
        sourceId: chunk.sourceId,
        chunkId: chunk.id,
        title: chunk.title,
        ...(url ? { url } : {}),
      })
    }
  }

  #elapsedSince(start: number): number {
    return Math.max(0, Math.round(this.#now() - start))
  }
}

/**
 * Normalise a whole session stream: `agent-start` at once, then the events of each line as it
 * arrives (parsed values, as `ndjson()` yields them, or raw lines). It stops reading at the end of
 * the answer, which ends the upstream iteration, and reports a stream that broke off as an error.
 */
export async function* normaliseAgentStream(
  lines: AsyncIterable<unknown>,
  options: AgentStreamOptions = {},
): AsyncGenerator<AgentAskEvent> {
  const normaliser = new AgentStreamNormaliser(options)
  yield normaliser.start()
  for await (const line of lines) {
    yield* normaliser.push(line)
    if (normaliser.finished) return
  }
  yield* normaliser.finish()
}
