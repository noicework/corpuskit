import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAskEvent } from '@research-portal/core'
import { ApiError, streamAgentAsk, streamAgentAskAcross } from '../api/client.ts'
import {
  type AgentAnswerRecord,
  applyAgentEvent,
  emptyAgentAnswer,
} from '../lib/agent-answer-export.ts'
import {
  activeStep,
  type AgentAskState,
  applyAgentAskEvent,
  endAgentAsk,
  initialAgentAskState,
} from '../lib/agent-ask-state.ts'

/**
 * How long the reader waits for an answer before the page gives up on its own: a real agent
 * session runs one to two minutes, so five is a hang, not a slow answer.
 */
export const AGENT_ASK_TIME_LIMIT_MS = 300_000

/** The least time between two step announcements to assistive technology. */
const ANNOUNCE_EVERY_MS = 2500

export interface AgentAskRun {
  query: string
  /** The portals to search, the host first. One slug asks that portal alone. */
  slugs: string[]
}

export interface UseAgentAsk {
  state: AgentAskState
  /** The same stream as the evidence brief's record, for the Export control; null before the first ask. */
  record: AgentAnswerRecord | null
  /** The question being answered, or the last one; null before the first ask. */
  question: string | null
  /** Milliseconds since the question was sent, ticking each second while the stream runs. */
  elapsedMs: number
  /** Whether the stream is running (so the composer offers Stop). */
  streaming: boolean
  ask: (run: AgentAskRun) => void
  stop: () => void
}

/**
 * Runs one agent ask at a time and folds its events into the view state. Asking again ends the
 * previous stream. The reader stopping, the page's own time limit and a broken connection each
 * end the state with what had arrived kept.
 */
export function useAgentAsk(options: {
  slug: string
  /** Whether the reader may still ask: checked before every event is applied. */
  canAsk: () => boolean
  messages: { timeout: string; unavailable: string; dropped: string; notOffered: string }
}): UseAgentAsk {
  const { slug, canAsk, messages } = options
  const [state, setState] = useState<AgentAskState>(initialAgentAskState)
  const [record, setRecord] = useState<AgentAnswerRecord | null>(null)
  const [question, setQuestion] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streaming = state.status === 'streaming'

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  useEffect(() => () => {
    abortRef.current?.abort()
    clearTimer()
  }, [])

  // One tick a second while the stream runs: the elapsed clock and the open steps' counters
  // are what keeps a long wait visibly alive.
  useEffect(() => {
    if (!streaming) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [streaming])

  const stop = useCallback(() => {
    const controller = abortRef.current
    if (!controller) return
    controller.abort()
    clearTimer()
    setState((prev) => endAgentAsk(prev, { code: 'cancelled' }, Date.now()))
    setNow(Date.now())
  }, [])

  const ask = useCallback((run: AgentAskRun) => {
    abortRef.current?.abort()
    clearTimer()
    if (!canAsk()) return
    const controller = new AbortController()
    abortRef.current = controller
    const sentAt = Date.now()
    setQuestion(run.query)
    setStartedAt(sentAt)
    setNow(sentAt)
    setState({ ...initialAgentAskState(), status: 'streaming' })
    setRecord(emptyAgentAnswer(run.query))

    const current = () => abortRef.current === controller && !controller.signal.aborted
    const end = (
      ending:
        | { code: 'cancelled' }
        | { code: 'timeout' | 'upstream' | 'not_configured'; message: string },
    ) => {
      if (!current()) return
      controller.abort()
      clearTimer()
      setState((prev) => endAgentAsk(prev, ending, Date.now()))
      setNow(Date.now())
    }
    timerRef.current = setTimeout(
      () => end({ code: 'timeout', message: messages.timeout }),
      AGENT_ASK_TIME_LIMIT_MS,
    )

    const onEvent = (event: AgentAskEvent) => {
      if (!current() || !canAsk()) return
      setState((prev) => applyAgentAskEvent(prev, event, Date.now()))
      setRecord((prev) => prev ? applyAgentEvent(prev, event) : prev)
      if (event.type === 'done' || event.type === 'error') clearTimer()
    }
    const body = { query: run.query }
    const stream = run.slugs.length > 1
      ? streamAgentAskAcross({ ...body, slugs: run.slugs }, onEvent, controller.signal)
      : streamAgentAsk(run.slugs[0] ?? slug, body, onEvent, controller.signal)
    stream.then(() => {
      // The stream closed without its last event: the connection went, not the agent.
      end({ code: 'upstream', message: messages.dropped })
    }).catch((err: unknown) => {
      if (!current()) return
      // The portal's own words, never the browser's or an upstream one. The detail stays in
      // the console, where a developer can read it.
      console.error('agent ask stream failed', err)
      if (err instanceof ApiError && err.status === 404) {
        end({ code: 'not_configured', message: messages.notOffered })
        return
      }
      const message = err instanceof ApiError && err.status === 429
        ? err.message
        : messages.unavailable
      end({ code: 'upstream', message })
    })
  }, [slug, canAsk, messages.timeout, messages.unavailable, messages.dropped, messages.notOffered])

  const elapsedMs = startedAt === null ? 0 : Math.max(0, now - startedAt)
  return { state, record, question, elapsedMs, streaming, ask, stop }
}

/**
 * What the page tells assistive technology, as one polite status line: the step the agent is
 * on (at most one every few seconds, the latest wins), the failed-source notice once, and the
 * answer's completion. Never the answer text as it streams. Errors are the alert's job.
 */
export function useAgentAnnouncements(
  state: AgentAskState,
  words: {
    step: (title: string) => string
    failed: (labels: string[]) => string
    done: (citations: number, collections: number) => string
    cancelled: string
  },
): string {
  const [announcement, setAnnouncement] = useState('')
  const lastStepRef = useRef<string | null>(null)
  const lastAnnouncedAt = useRef(0)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failedRef = useRef(false)

  const say = useCallback((text: string, immediate: boolean) => {
    if (pendingRef.current !== null) clearTimeout(pendingRef.current)
    pendingRef.current = null
    const wait = immediate
      ? 0
      : Math.max(0, lastAnnouncedAt.current + ANNOUNCE_EVERY_MS - Date.now())
    const speak = () => {
      lastAnnouncedAt.current = Date.now()
      setAnnouncement(text)
    }
    if (wait === 0) speak()
    else pendingRef.current = setTimeout(speak, wait)
  }, [])

  useEffect(() => () => {
    if (pendingRef.current !== null) clearTimeout(pendingRef.current)
  }, [])

  useEffect(() => {
    if (state.status === 'idle') {
      lastStepRef.current = null
      failedRef.current = false
      return
    }
    if (state.status === 'streaming') {
      if (state.failedSources.length > 0 && !failedRef.current) {
        failedRef.current = true
        say(words.failed(state.failedSources.map((source) => source.label)), true)
        return
      }
      const step = activeStep(state.steps)
      if (step && step.id !== lastStepRef.current) {
        lastStepRef.current = step.id
        say(words.step(step.title), false)
      }
      return
    }
    if (state.status === 'done') {
      const collections = new Set(state.citations.map((citation) => citation.sourceId)).size
      say(words.done(state.citations.length, collections), true)
    } else if (state.status === 'cancelled') {
      say(words.cancelled, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.steps, state.failedSources, state.citations])

  return announcement
}
