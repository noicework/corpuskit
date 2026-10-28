// ---------------------------------------------------------------------------
// Replays the synthetic retrieval agent sessions (packages/retrieval/src/
// providers/arag/fixtures/agent-*.ndjson) through the real normaliser, for
// the DoubleProvider and the agent ask stub server (docs/AGENT-ASK.md).
// Each fixture line is one AragAnswer object plus a replay-only `_t`: the
// milliseconds after the request at which the line arrives.
// ---------------------------------------------------------------------------
import type { AgentAskEvent, AgentSource } from '@research-portal/core'
import { normaliseAgentStream } from '@research-portal/retrieval'

export const AGENT_SCENARIOS = ['happy', 'error', 'slow-start'] as const
export type AgentScenario = typeof AGENT_SCENARIOS[number]

/** The sources the fixture agent is configured with: the drivers its contexts name. */
export const AGENT_STUB_SOURCES: readonly AgentSource[] = [
  { id: 'drv-fisheries', label: 'Fisheries research' },
  { id: 'drv-grains', label: 'Grains research' },
  { id: 'drv-rural', label: 'Rural industries research' },
]

const FIXTURES: Record<AgentScenario, string> = {
  'happy': 'agent-happy.ndjson',
  'error': 'agent-error.ndjson',
  'slow-start': 'agent-slow-start.ndjson',
}

/** The raw NDJSON text of one scenario's fixture. */
export function agentFixture(scenario: AgentScenario): string {
  return Deno.readTextFileSync(
    new URL(
      `../../packages/retrieval/src/providers/arag/fixtures/${FIXTURES[scenario]}`,
      import.meta.url,
    ),
  )
}

export interface AgentStubRequest {
  scenario: AgentScenario
  /** Replay without waiting. */
  fast: boolean
  /** No agent: the portal composes the answer across its collections instead. */
  compose: boolean
  /** When composing, the second collection's search hangs past its time limit, or fails. */
  sourceFailure?: 'timeout' | 'error'
}

/**
 * What a question asks the stub for. `#error` or `#slow` picks that agent scenario (the happy
 * path otherwise), `#compose` takes the agent away so the portal composes, `#source-timeout` and
 * `#source-error` fail one collection while composing, and `#fast` skips the waiting.
 */
export function agentScenarioFor(question: string): AgentStubRequest {
  const tags = new Set(question.toLowerCase().match(/#[a-z-]+/g) ?? [])
  return {
    scenario: tags.has('#error') ? 'error' : tags.has('#slow') ? 'slow-start' : 'happy',
    fast: tags.has('#fast'),
    compose: tags.has('#compose'),
    ...(tags.has('#source-timeout')
      ? { sourceFailure: 'timeout' as const }
      : tags.has('#source-error')
      ? { sourceFailure: 'error' as const }
      : {}),
  }
}

/** The passages each driver of the happy-path session returned, by driver id. */
export function agentFixturePassages(): Map<string, { id: string; title: string; text: string }[]> {
  const out = new Map<string, { id: string; title: string; text: string }[]>()
  for (const line of agentFixture('happy').split('\n')) {
    if (!line.trim()) continue
    const context = (JSON.parse(line) as {
      context?: {
        agent_id: string
        chunks: { chunk_id: string; title: string; text: string }[]
      }
    }).context
    if (!context) continue
    const passages = out.get(context.agent_id) ?? []
    for (const chunk of context.chunks) {
      passages.push({ id: chunk.chunk_id.split('/')[0]!, title: chunk.title, text: chunk.text })
    }
    out.set(context.agent_id, passages)
  }
  return out
}

/** Wait `ms`, or reject at once with the signal's reason. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export interface ReplayOptions {
  /** 1 replays at the recorded pace, 2 twice as fast, 0 without waiting. */
  speed?: number
  /** Ends the replay at once: the next read rejects with the abort reason. */
  signal?: AbortSignal
}

/**
 * One scenario as the agent would send it: each line at its `_t`. Also the clock the normaliser
 * reads, so reported durations follow the recording whatever the replay speed.
 */
export function replayAgentSession(scenario: AgentScenario, options: ReplayOptions = {}) {
  const speed = options.speed ?? 1
  let clock = 0
  async function* lines(): AsyncGenerator<string> {
    const started = performance.now()
    for (const line of agentFixture(scenario).split('\n')) {
      if (!line.trim()) continue
      let at = clock
      try {
        const value = JSON.parse(line) as { _t?: unknown }
        if (typeof value._t === 'number' && Number.isFinite(value._t)) at = value._t
      } catch {
        // A malformed line still replays: the normaliser is the one that skips it.
      }
      if (speed > 0) await pause(at / speed - (performance.now() - started), options.signal)
      else if (options.signal?.aborted) throw options.signal.reason
      clock = Math.max(clock, at)
      yield line
    }
  }
  return { lines: lines(), now: () => clock }
}

/** A scenario normalised into the agent ask events a reader receives. */
export function replayAgentAsk(
  scenario: AgentScenario,
  options: ReplayOptions = {},
): AsyncGenerator<AgentAskEvent> {
  const session = replayAgentSession(scenario, options)
  return normaliseAgentStream(session.lines, { sources: AGENT_STUB_SOURCES, now: session.now })
}
