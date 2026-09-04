/**
 * Shared client for the portal's `/ask` Server-Sent Event stream.
 *
 * The same `data: <json>\n\n` parsing loop had been copy-pasted into every
 * script that talks to a live portal; this is the one copy. The event
 * contract it consumes is defined by `AskEventSchema` in
 * packages/core/src/index.ts - see that schema for the authoritative shapes.
 */

/** A decoded SSE frame. Loosely typed on purpose: a harness must survive an event it does not know about. */
export type AskEventLike = Record<string, unknown> & { type?: unknown }

/** Parses a `text/event-stream` response body into its `data:` JSON payloads, in order. */
export async function* sseEvents(response: Response): AsyncGenerator<AskEventLike> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          try {
            yield JSON.parse(raw) as AskEventLike
          } catch {
            // A partial/malformed line - skip rather than abort the whole stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Everything one ask produced, captured for grading and for transcript review. */
export interface AskCapture {
  /** False when the harness never got a usable stream (HTTP error, timeout, no `done`). */
  ok: boolean
  detail?: string
  /** Authoritative final prose (`done.text`), falling back to accumulated deltas. */
  text: string
  refused: boolean
  /**
   * Size of the LAST `sources` event. The stream re-sends the full set as
   * retrieval progresses (replace, not append), and a refusal sends a
   * corrective empty set - so the last one is the truth.
   */
  sourcesCount: number
  /** Largest `sources` set seen - non-zero on a refusal that had retrieved something first. */
  sourcesPeak: number
  /** Distinct `resourceId`s across all citation events - "did it really synthesise". */
  distinctCitations: number
  citationIndices: number[]
  /** Titles of cited resources, for the transcript. */
  citedTitles: string[]
  /** Top retrieved resources (title + relevance), for the transcript. */
  topSources: { title: string; sourceName?: string; relevance: number }[]
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
  /** The query as the platform rephrased it, when an `interpreted` event arrived. */
  interpreted?: string
  /** Sub-queries the platform decomposed the question into, when any. */
  searched?: string[]
  firstTokenMs: number | null
  totalMs: number
  inputTokens?: number
  outputTokens?: number
}

export interface AskRequest {
  query: string
  depth?: 'default' | 'deep'
  topicIds?: string[]
  resourceId?: string
}

/**
 * Runs one ask against a live portal and captures the whole stream.
 *
 * Never throws for a portal-side problem: a failure comes back as
 * `ok: false` with a `detail`, so a harness can score it as a harness error
 * rather than confusing it with the portal honestly refusing.
 */
export async function runAsk(
  base: string,
  tenant: string,
  req: AskRequest,
  timeoutMs = 90_000,
): Promise<AskCapture> {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const capture: AskCapture = {
    ok: false,
    text: '',
    refused: false,
    sourcesCount: 0,
    sourcesPeak: 0,
    distinctCitations: 0,
    citationIndices: [],
    citedTitles: [],
    topSources: [],
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
    firstTokenMs: null,
    totalMs: 0,
  }

  let streamedText = ''
  let sawDone = false
  let sawError: string | null = null
  const citedResourceIds = new Set<string>()
  const citedTitles = new Set<string>()

  try {
    const res = await fetch(`${base}/api/t/${tenant}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!res.ok) {
      let body = ''
      try {
        body = (await res.text()).slice(0, 200)
      } catch {
        // Body already consumed or unreadable - the status alone is enough.
      }
      capture.detail = `HTTP ${res.status}${body ? ` ${body}` : ''}`
      capture.totalMs = performance.now() - start
      return capture
    }

    for await (const event of sseEvents(res)) {
      switch (event.type) {
        case 'sources': {
          const resources = event.resources
          if (!Array.isArray(resources)) break
          capture.sourcesCount = resources.length
          capture.sourcesPeak = Math.max(capture.sourcesPeak, resources.length)
          if (resources.length > 0) {
            capture.topSources = resources.slice(0, 5).map((r) => {
              const row = r as Record<string, unknown>
              return {
                title: typeof row.title === 'string' ? row.title : '(untitled)',
                sourceName: typeof row.sourceName === 'string' ? row.sourceName : undefined,
                relevance: typeof row.relevance === 'number' ? row.relevance : 0,
              }
            })
          }
          break
        }
        case 'delta': {
          if (capture.firstTokenMs === null) capture.firstTokenMs = performance.now() - start
          if (typeof event.text === 'string') streamedText += event.text
          break
        }
        case 'citation': {
          const c = event.citation as
            | { index?: unknown; resourceId?: unknown; title?: unknown }
            | undefined
          if (!c) break
          if (typeof c.index === 'number') capture.citationIndices.push(c.index)
          if (typeof c.resourceId === 'string') citedResourceIds.add(c.resourceId)
          if (typeof c.title === 'string') citedTitles.add(c.title)
          break
        }
        case 'quality': {
          capture.answerRelevance = typeof event.answerRelevance === 'number'
            ? event.answerRelevance
            : null
          capture.groundedness = typeof event.groundedness === 'number' ? event.groundedness : null
          capture.contextRelevance = typeof event.contextRelevance === 'number'
            ? event.contextRelevance
            : null
          break
        }
        case 'interpreted': {
          if (typeof event.query === 'string') capture.interpreted = event.query
          break
        }
        case 'searched': {
          if (Array.isArray(event.queries)) {
            capture.searched = event.queries.filter((q): q is string => typeof q === 'string')
          }
          break
        }
        case 'usage': {
          if (typeof event.inputTokens === 'number') capture.inputTokens = event.inputTokens
          if (typeof event.outputTokens === 'number') capture.outputTokens = event.outputTokens
          break
        }
        case 'done': {
          sawDone = true
          capture.refused = event.refused === true
          capture.text = typeof event.text === 'string' ? event.text : streamedText
          break
        }
        case 'error': {
          sawError = typeof event.message === 'string' ? event.message : 'unknown error'
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    capture.detail = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
      ? err.message
      : String(err)
    capture.totalMs = performance.now() - start
    return capture
  } finally {
    clearTimeout(timeout)
  }

  capture.totalMs = performance.now() - start
  capture.distinctCitations = citedResourceIds.size
  capture.citedTitles = [...citedTitles]

  if (!sawDone) {
    capture.detail = sawError ? `stream errored: ${sawError}` : 'stream ended without a done event'
    if (!capture.text) capture.text = streamedText
    return capture
  }

  capture.ok = true
  if (sawError) capture.detail = sawError
  return capture
}

/**
 * Every `[n]` marker in the final answer text must resolve to a citation
 * index the platform actually emitted - the claim-level grounding guarantee
 * the UI relies on.
 */
export function citationIntegrity(
  finalText: string,
  citationIndices: Set<number>,
): { markers: number[]; unresolved: number[] } {
  const markers = [...finalText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
  const unresolved = markers.filter((n) => !citationIndices.has(n))
  return { markers, unresolved }
}
