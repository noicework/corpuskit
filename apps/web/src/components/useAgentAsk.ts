import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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

/**
 * How long a run outlives the last page watching it. When a fresh read of the session finds
 * the reader's access changed (a new role, say), the access layer swaps the portal for the
 * access gate for a moment and remounts the page; a run that died with the page would reset a
 * two-minute answer. The page re-attaches well inside this; a reader who has left for another
 * page is not kept waiting on.
 */
const RUN_GRACE_MS = 5000

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

interface RunSnapshot {
  state: AgentAskState
  record: AgentAnswerRecord | null
  question: string | null
  startedAt: number | null
  /** Who was signed in when the question was sent; a different identity ends the run. */
  identity: string | null
}

/**
 * One portal's run, held outside React so it survives the page being remounted (see
 * `RUN_GRACE_MS`). The page reads it through `useSyncExternalStore`.
 */
interface RunEntry {
  snapshot: RunSnapshot
  listeners: Set<() => void>
  controller: AbortController | null
  limit: ReturnType<typeof setTimeout> | null
  release: ReturnType<typeof setTimeout> | null
}

const runs = new Map<string, RunEntry>()

const IDLE: RunSnapshot = {
  state: initialAgentAskState(),
  record: null,
  question: null,
  startedAt: null,
  identity: null,
}

function entryFor(slug: string): RunEntry {
  let entry = runs.get(slug)
  if (!entry) {
    entry = { snapshot: IDLE, listeners: new Set(), controller: null, limit: null, release: null }
    runs.set(slug, entry)
  }
  return entry
}

function update(entry: RunEntry, patch: (snapshot: RunSnapshot) => RunSnapshot): void {
  entry.snapshot = patch(entry.snapshot)
  for (const listener of entry.listeners) listener()
}

function clearLimit(entry: RunEntry): void {
  if (entry.limit !== null) clearTimeout(entry.limit)
  entry.limit = null
}

/** Ends the run on the reader's side, keeping what arrived. */
function endRun(
  entry: RunEntry,
  controller: AbortController,
  ending: Parameters<typeof endAgentAsk>[1],
): void {
  if (entry.controller !== controller || controller.signal.aborted) return
  controller.abort()
  clearLimit(entry)
  update(entry, (snapshot) => ({
    ...snapshot,
    state: endAgentAsk(snapshot.state, ending, Date.now()),
  }))
}

/**
 * Runs one agent ask at a time for a portal and folds its events into the view state. Asking
 * again ends the previous stream. The reader stopping, the page's own time limit and a broken
 * connection each end the state with what had arrived kept. The run lives outside the page, so
 * the page being remounted (the access layer does that when the reader's access changes) does
 * not lose it: the new page picks the run up where it is.
 */
export function useAgentAsk(options: {
  slug: string
  /** Whether the reader may ask, checked when the ask is sent. */
  canAsk: () => boolean
  /**
   * The signed-in identity, null while access is being re-read. The run is read outside the
   * access generation (see `AgentAskStreamOptions.durable`), so this is what ends it when the
   * person at the keyboard changes.
   */
  identityKey: string | null
  messages: { timeout: string; unavailable: string; dropped: string; notOffered: string }
}): UseAgentAsk {
  const { slug, canAsk, identityKey, messages } = options
  const subscribe = useCallback((listener: () => void) => {
    const current = entryFor(slug)
    if (current.release !== null) clearTimeout(current.release)
    current.release = null
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
      if (current.listeners.size > 0 || current.controller === null) return
      // Nobody is watching: give a remount its moment, then stop the stream and keep the rest.
      current.release = setTimeout(() => {
        current.release = null
        if (current.listeners.size > 0 || current.controller === null) return
        endRun(current, current.controller, { code: 'cancelled' })
        current.controller = null
      }, RUN_GRACE_MS)
    }
  }, [slug])
  const snapshot = useSyncExternalStore(
    subscribe,
    () => entryFor(slug).snapshot,
    () => entryFor(slug).snapshot,
  )
  const streaming = snapshot.state.status === 'streaming'
  const [now, setNow] = useState(() => Date.now())

  // One tick a second while the stream runs: the elapsed clock and the open steps' counters
  // are what keeps a long wait visibly alive.
  useEffect(() => {
    if (!streaming) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [streaming])

  const stop = useCallback(() => {
    const current = entryFor(slug)
    const controller = current.controller
    if (!controller) return
    endRun(current, controller, { code: 'cancelled' })
    current.controller = null
    setNow(Date.now())
  }, [slug])

  // A different signed-in identity than the one that asked ends the run: the stream is not
  // tied to the access generation, so this is where that guarantee is kept.
  useEffect(() => {
    if (identityKey === null || !streaming) return
    if (snapshot.identity !== null && snapshot.identity !== identityKey) stop()
  }, [identityKey, streaming, snapshot.identity, stop])

  const ask = useCallback((run: AgentAskRun) => {
    const current = entryFor(slug)
    if (current.controller) {
      endRun(current, current.controller, { code: 'cancelled' })
      current.controller = null
    }
    if (!canAsk()) return
    const controller = new AbortController()
    current.controller = controller
    const sentAt = Date.now()
    setNow(sentAt)
    update(current, () => ({
      state: { ...initialAgentAskState(), status: 'streaming' },
      record: emptyAgentAnswer(run.query),
      question: run.query,
      startedAt: sentAt,
      identity: identityKey,
    }))
    const live = () => current.controller === controller && !controller.signal.aborted
    const end = (ending: Parameters<typeof endAgentAsk>[1]) => {
      endRun(current, controller, ending)
      if (current.controller === controller) current.controller = null
    }
    current.limit = setTimeout(
      () => end({ code: 'timeout', message: messages.timeout }),
      AGENT_ASK_TIME_LIMIT_MS,
    )

    const onEvent = (event: AgentAskEvent) => {
      if (!live()) return
      update(current, (snapshot) => ({
        ...snapshot,
        state: applyAgentAskEvent(snapshot.state, event, Date.now()),
        record: snapshot.record ? applyAgentEvent(snapshot.record, event) : snapshot.record,
      }))
      if (event.type === 'done' || event.type === 'error') {
        clearLimit(current)
        if (current.controller === controller) current.controller = null
      }
    }
    const body = { query: run.query }
    const durable = { durable: true }
    const stream = run.slugs.length > 1
      ? streamAgentAskAcross({ ...body, slugs: run.slugs }, onEvent, controller.signal, durable)
      : streamAgentAsk(run.slugs[0] ?? slug, body, onEvent, controller.signal, durable)
    stream.then(() => {
      // The stream closed without its last event: the connection went, not the agent.
      end({ code: 'upstream', message: messages.dropped })
    }).catch((err: unknown) => {
      if (!live()) return
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
  }, [
    slug,
    canAsk,
    identityKey,
    messages.timeout,
    messages.unavailable,
    messages.dropped,
    messages.notOffered,
  ])

  const elapsedMs = snapshot.startedAt === null ? 0 : Math.max(0, now - snapshot.startedAt)
  return {
    state: snapshot.state,
    record: snapshot.record,
    question: snapshot.question,
    elapsedMs,
    streaming,
    ask,
    stop,
  }
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
