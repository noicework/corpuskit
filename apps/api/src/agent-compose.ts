/**
 * Agent ask without an agent (docs/AGENT-ASK.md). The portal searches each collection itself,
 * each within a time limit, composes one answer from the passages they returned on the host
 * portal's own generation path, and checks every citation against its passage with the same
 * deterministic binding the Ask answer uses to finalise the streamed text.
 *
 * It streams the agent ask events an agent would, with `mode: 'orchestrated'`, so a view can say
 * the portal composed the answer and never present it as an agent's. A collection that fails or
 * runs out of time ends its step `failed` and is named in one `sources-failed` event; the answer
 * comes from the rest.
 */
import type { AgentAskEvent, AgentChunk, AgentSource, TenantConfig } from '@research-portal/core'
import {
  AgentAskError,
  type AgentAskOptions,
  COMPOSE_MAX_PASSAGES,
  COMPOSE_PASSAGE_CHARS,
  COMPOSE_PASSAGES_PER_SOURCE,
  type ComposePassage,
  type RetrievalProvider,
} from '@research-portal/retrieval'
import { composeDeadline, ComposeTimedOut } from './compose-deadline.ts'
import { bindSentences, renderBound, sentenceFeatures } from './citation-binding.ts'

/** How long one collection's search may take before it is reported as not answering. */
export const SOURCE_TIMEOUT_MS = 20_000
/** How long composing the answer may take. */
export const COMPOSE_TIMEOUT_MS = 90_000
/** Passages kept from each collection, and the weakest match kept. */
const PASSAGES_PER_SOURCE = COMPOSE_PASSAGES_PER_SOURCE
const MIN_RELEVANCE = 0.3
const PASSAGE_CHARS = COMPOSE_PASSAGE_CHARS

/** Said when the collections answered but none had a passage on the question. */
export const NO_PASSAGES =
  'None of the collections has passages that answer this question. Try asking it another way.'
/** Said when the composed answer kept no citation its passage supports. */
export const NO_SUPPORTED_ANSWER =
  "The collections' passages did not support a cited answer to this question."

/**
 * One source of a composed answer that is not a portal of this deployment: a federated peer.
 * `search` gets a signal that aborts at the source's time limit or when the reader leaves.
 */
export interface ComposeSource {
  source: AgentSource
  search(question: string, signal: AbortSignal): Promise<AgentChunk[]>
}

export interface AgentAnswerOptions {
  provider: RetrievalProvider
  /** The portal that answers: its agent, or its generation path when composing. */
  host: TenantConfig
  /** The portals searched when composing, each one source. The host is usually among them. */
  portals: readonly TenantConfig[]
  /** Federated peers searched beside the portals. */
  peers?: readonly ComposeSource[]
  /**
   * Asked again for every other portal as the answer is assembled: one that has stopped taking
   * part in federated answers since its search began is left out of the answer.
   */
  stillParticipates?: (slug: string) => boolean
  question: string
  context?: AgentAskOptions['context']
  signal?: AbortSignal
  sourceTimeoutMs?: number
  composeTimeoutMs?: number
  now?: () => number
}

/** A portal as a source of a composed answer. */
export function portalSource(config: TenantConfig): AgentSource {
  return {
    id: config.slug,
    label: config.branding.productName,
    portal: config.slug,
    kind: 'hosted',
  }
}

/**
 * The host portal's agent when it has one, otherwise the portal's own composition across
 * `portals`. The agent is used when it starts: a throw before its first event (no agent
 * configured, or a session refused) falls back to composing. Once the agent has started, its
 * errors end the stream as they are.
 */
export async function* agentAnswer(options: AgentAnswerOptions): AsyncGenerator<AgentAskEvent> {
  const { provider, host } = options
  if (provider.agentAsk) {
    let events: AsyncIterator<AgentAskEvent> | undefined
    let first: IteratorResult<AgentAskEvent> | undefined
    try {
      events = provider.agentAsk(host, options.question, {
        ...(options.context ? { context: options.context } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })[Symbol.asyncIterator]()
      first = await events.next()
    } catch (error) {
      if ((!provider.compose && !provider.composeStream) || options.signal?.aborted) throw error
      if (!(error instanceof AgentAskError && error.code === 'not_configured')) {
        console.error(`[agent-ask] agent unavailable, composing instead: ${String(error)}`)
      }
    }
    if (events && first) {
      if (first.done) return
      yield first.value
      yield* { [Symbol.asyncIterator]: () => events! }
      return
    }
  }
  if (!provider.compose && !provider.composeStream) {
    throw new AgentAskError('not_configured', 'This portal has neither an agent nor a composer')
  }
  yield* composeAcross(options)
}

/** The portal's own answer across `portals`: search each, compose once, check every citation. */
export async function* composeAcross(
  options: AgentAnswerOptions,
): AsyncGenerator<AgentAskEvent> {
  const { provider, host, question, signal } = options
  const compose = provider.compose?.bind(provider)
  const composeStream = provider.composeStream?.bind(provider)
  if (!compose && !composeStream) {
    throw new AgentAskError('not_configured', 'This portal cannot compose answers')
  }
  if (signal?.aborted) return
  const now = options.now ?? Date.now
  const started = now()
  const sourceTimeout = options.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS
  // The host's own collection is its own: only another portal's resources can be withheld.
  const searches: { source: AgentSource; slug?: string; search: ComposeSource['search'] }[] = [
    ...options.portals.map((config) => ({
      source: portalSource(config),
      slug: config.slug,
      search: async (query: string, signal: AbortSignal) =>
        chunksFrom(
          config.slug,
          (await provider.search(config, query, { pageSize: 8, passagesOnly: true, signal }))
            .resources.filter((resource) =>
              config.slug === host.slug || !resource.federationExcluded
            ),
        ),
    })),
    ...(options.peers ?? []).map((peer) => ({ source: peer.source, search: peer.search })),
  ]
  const sources = searches.map((entry) => entry.source)
  type Failure = 'timeout' | 'unauthorised' | 'error'
  type Lookup = { index: number; elapsedMs: number; chunks?: AgentChunk[]; failure?: Failure }
  const pending = new Map<number, Promise<Lookup>>()
  const limits: ReturnType<typeof composeDeadline>[] = []
  const sourceStarted: number[] = []
  searches.forEach((entry, index) => {
    const limit = composeDeadline(sourceTimeout, signal)
    limits.push(limit)
    sourceStarted[index] = now()
    pending.set(
      index,
      limit.run(() => entry.search(question, limit.signal)).then(
        (chunks): Lookup => ({
          index,
          chunks,
          elapsedMs: Math.max(0, Math.round(now() - sourceStarted[index]!)),
        }),
        (error): Lookup => {
          return {
            index,
            elapsedMs: Math.max(0, Math.round(now() - sourceStarted[index]!)),
            failure: error instanceof ComposeTimedOut
              ? 'timeout'
              : (error as { failure?: unknown })?.failure === 'unauthorised'
              ? 'unauthorised'
              : 'error',
          }
        },
      ).finally(() => limit.close()),
    )
  })
  const found: AgentChunk[][] = sources.map(() => [])
  const failed: (AgentSource & { reason: Failure })[] = []
  try {
    yield { type: 'agent-start', mode: 'orchestrated', sources }

    // Every collection is searched at once, and reported in the order they answer.
    const stepId = (source: AgentSource) => `source/${source.id}`
    for (const source of sources) {
      yield {
        type: 'agent-step',
        id: stepId(source),
        module: 'search',
        title: `Searching ${source.label}`,
        status: 'started',
      }
    }
    while (pending.size > 0) {
      const lookup = await Promise.race(pending.values())
      pending.delete(lookup.index)
      if (signal?.aborted) return
      const source = sources[lookup.index]!
      const elapsedMs = lookup.elapsedMs
      if (lookup.failure) {
        failed.push({ ...source, reason: lookup.failure })
        yield {
          type: 'agent-step',
          id: stepId(source),
          module: 'search',
          title: `Searching ${source.label}`,
          status: 'failed',
          elapsedMs,
          reason: lookup.failure === 'timeout'
            ? `No answer within ${
              sourceTimeout >= 1000
                ? countOf(Math.round(sourceTimeout / 1000), 'second')
                : countOf(sourceTimeout, 'millisecond')
            }.`
            : lookup.failure === 'unauthorised'
            ? 'The collection refused its key.'
            : 'The collection could not be searched.',
        }
        continue
      }
      const chunks = lookup.chunks!.filter((chunk) => chunk.text.trim()).slice(
        0,
        PASSAGES_PER_SOURCE,
      )
        .map((chunk) => ({ ...chunk, text: chunk.text.slice(0, PASSAGE_CHARS) }))
      found[lookup.index] = chunks
      yield {
        type: 'agent-step',
        id: stepId(source),
        module: 'search',
        title: `Searching ${source.label}`,
        status: 'completed',
        elapsedMs,
      }
      yield { type: 'agent-sources', stepId: stepId(source), source, chunks }
    }
  } finally {
    for (const limit of limits) limit.close()
  }
  // Checked again now the answer is assembled: a portal that has left federation since its
  // search began contributes nothing to it.
  searches.forEach((entry, index) => {
    if (
      entry.slug && entry.slug !== host.slug && options.stillParticipates?.(entry.slug) === false
    ) {
      found[index] = []
    }
  })
  if (failed.length > 0) {
    // In the portals' order, not the order they failed in.
    const order = new Map(sources.map((source, index) => [source.id, index]))
    failed.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    yield { type: 'sources-failed', sources: failed }
  }

  // Numbered in the portals' order, so a citation number never depends on who answered first.
  // Round-robin admission stops the first large collection crowding every other one out.
  const admitted = new Set<AgentChunk>()
  for (let rank = 0; rank < PASSAGES_PER_SOURCE; rank++) {
    for (const chunks of found) {
      if (chunks[rank] && admitted.size < COMPOSE_MAX_PASSAGES) admitted.add(chunks[rank]!)
    }
  }
  const gathered = sources.flatMap((source, index) =>
    found[index]!.filter((chunk) => admitted.has(chunk)).map((chunk) => ({ source, chunk }))
  )
  if (gathered.length === 0) {
    if (failed.length === sources.length) {
      yield {
        type: 'error',
        code: 'upstream',
        message: 'None of the collections could be searched.',
        retryable: true,
      }
      return
    }
    yield { type: 'delta', text: NO_PASSAGES }
    yield { type: 'done', elapsedMs: Math.max(0, Math.round(now() - started)) }
    return
  }

  const composeStep = {
    type: 'agent-step' as const,
    id: 'compose',
    module: 'compose',
    title: `Composing one answer from ${countOf(gathered.length, 'passage')}`,
  }
  yield { ...composeStep, status: 'started' }
  const composeStarted = now()
  const passages: ComposePassage[] = gathered.map(({ source, chunk }) => ({
    source: source.label,
    title: chunk.title,
    text: chunk.text,
  }))
  let text: string
  let firstTokenMs: number | undefined
  const limit = composeDeadline(options.composeTimeoutMs ?? COMPOSE_TIMEOUT_MS, signal)
  let iterator: AsyncIterator<string> | undefined
  let streamed = false
  try {
    const opts = { ...(options.context ? { context: options.context } : {}), signal: limit.signal }
    if (composeStream) {
      text = ''
      iterator = composeStream(host, question, passages, opts)[Symbol.asyncIterator]()
      for (;;) {
        const next = await limit.run(() => iterator!.next())
        if (next.done) break
        if (!next.value) continue
        firstTokenMs ??= Math.max(0, Math.round(now() - composeStarted))
        text += next.value
        streamed = true
        yield { type: 'delta', text: next.value }
      }
    } else {
      text = await limit.run(() => compose!(host, question, passages, opts))
    }
  } catch (error) {
    if (signal?.aborted) return
    const timedOut = error instanceof ComposeTimedOut
    yield {
      ...composeStep,
      status: 'failed',
      elapsedMs: Math.max(0, Math.round(now() - composeStarted)),
    }
    yield {
      type: 'error',
      code: timedOut ? 'timeout' : 'upstream',
      message: timedOut ? 'Composing the answer took too long.' : String(error),
      retryable: true,
    }
    return
  } finally {
    limit.close()
    // An upstream iterator may still be settling after an abort; never wait on it indefinitely.
    void iterator?.return?.().catch(() => {})
  }
  if (signal?.aborted) return
  yield {
    ...composeStep,
    status: 'completed',
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    elapsedMs: Math.max(0, Math.round(now() - composeStarted)),
  }

  // The same binding the Ask answer gets: each sentence keeps only the markers whose passage
  // carries its words, figures and names, and the survivors are renumbered by first appearance.
  // A sentence stating a figure that no passage supports is removed outright.
  const verifyStep = {
    type: 'agent-step' as const,
    id: 'verify',
    module: 'verify',
    title: 'Checking each citation against its passage',
  }
  yield { ...verifyStep, status: 'started' }
  const verifyStarted = now()
  const lexicon = host.entityTerms ?? []
  const bound = bindSentences({
    text,
    citations: gathered.map(({ chunk }, index) => ({
      index: index + 1,
      resourceId: chunk.id,
      title: chunk.title || 'Untitled passage',
    })),
    texts: new Map(gathered.map(({ chunk }, index) => [index + 1, chunk.text])),
    lexicon,
  })
  const removed = new Set(
    bound.sentences.flatMap((sentence, index) =>
      sentence.bound.length === 0 && sentenceFeatures(sentence.text, lexicon).numbers.length > 0
        ? [index]
        : []
    ),
  )
  const answer = renderBound(bound.layout, bound.sentences, removed)
  const notes = [
    bound.dropped > 0
      ? `${countOf(bound.dropped, 'citation')} removed: the passage does not support it`
      : '',
    removed.size > 0
      ? `${countOf(removed.size, 'sentence')} with an unsupported figure removed`
      : '',
  ].filter(Boolean)
  yield {
    ...verifyStep,
    status: 'completed',
    elapsedMs: Math.max(0, Math.round(now() - verifyStarted)),
    ...(notes.length > 0 ? { reason: `${notes.join('; ')}.` } : {}),
  }
  if (bound.citations.length === 0 || !answer.trim()) {
    if (!streamed) yield { type: 'delta', text: NO_SUPPORTED_ANSWER }
    yield {
      type: 'done',
      elapsedMs: Math.max(0, Math.round(now() - started)),
      text: NO_SUPPORTED_ANSWER,
    }
    return
  }
  if (!streamed) {
    for (const paragraph of answer.split(/(?<=\n\n)/)) yield { type: 'delta', text: paragraph }
  }
  const byChunk = new Map(gathered.map((entry) => [entry.chunk.id, entry]))
  for (const citation of bound.citations) {
    const { source, chunk } = byChunk.get(citation.resourceId)!
    yield {
      type: 'citation',
      marker: String(citation.index),
      sourceId: source.id,
      chunkId: chunk.id,
      title: citation.title,
      ...(chunk.url ? { url: chunk.url } : {}),
    }
  }
  yield { type: 'done', elapsedMs: Math.max(0, Math.round(now() - started)), text: answer }
}

/** A portal's strongest passages for the question, as chunks of its source. */
function chunksFrom(
  slug: string,
  resources: readonly {
    id: string
    title: string
    summary?: string
    relevance: number
    matchedPassage?: string
  }[],
): AgentChunk[] {
  return resources
    .filter((resource) => resource.relevance >= MIN_RELEVANCE)
    .flatMap((resource) => {
      const text = (resource.matchedPassage ?? resource.summary ?? '').trim()
      return text
        ? [{
          id: `${slug}/${resource.id}`,
          title: resource.title,
          text: text.slice(0, PASSAGE_CHARS),
          resourceId: resource.id,
        }]
        : []
    })
    .slice(0, PASSAGES_PER_SOURCE)
}

function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
