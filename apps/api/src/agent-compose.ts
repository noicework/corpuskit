/**
 * Agent ask without an agent (docs/AGENT-ASK.md). The portal searches each collection itself,
 * each within a time limit, composes one answer from the passages they returned on the host
 * portal's own generation path, and checks every citation against its passage with the same
 * deterministic binding the Ask answer uses before the reader sees it.
 *
 * It streams the agent ask events an agent would, with `mode: 'orchestrated'`, so a view can say
 * the portal composed the answer and never present it as an agent's. A collection that fails or
 * runs out of time ends its step `failed` and is named in one `sources-failed` event; the answer
 * comes from the rest.
 */
import type {
  AgentAskEvent,
  AgentChunk,
  AgentSource,
  AnswerRecord,
  TenantConfig,
} from '@research-portal/core'
import {
  AgentAskError,
  type AgentAskOptions,
  type ComposePassage,
  type RetrievalProvider,
} from '@research-portal/retrieval'
import { bindSentences, renderBound, sentenceFeatures } from './citation-binding.ts'
import { agentRecordVerification } from './agent-record-verification.ts'

/** How long one collection's search may take before it is reported as not answering. */
export const SOURCE_TIMEOUT_MS = 20_000
/** How long composing the answer may take. */
export const COMPOSE_TIMEOUT_MS = 90_000
/** Passages kept from each collection, and the weakest match kept. */
const PASSAGES_PER_SOURCE = 4
const MIN_RELEVANCE = 0.3
const PASSAGE_CHARS = 1200

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
  /** Server-only evidence of the citation gate, never an extra public event. */
  onVerification?: (check: {
    decisions: NonNullable<AnswerRecord['agent']>['citationDecisions']
    sentencesChecked: number
    sentencesCited: number
    sentencesDropped: number
  }) => void
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

class TimedOut extends Error {}

/** The promise's result, or a rejection once `ms` pass or the signal aborts. */
function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const settle = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const timer = setTimeout(() => {
      settle()
      reject(new TimedOut())
    }, ms)
    const abort = () => {
      settle()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      settle()
      resolve(value)
    }, (error) => {
      settle()
      reject(error)
    })
  })
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
      if (!provider.compose || options.signal?.aborted) throw error
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
  if (!provider.compose) {
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
  if (!compose) throw new AgentAskError('not_configured', 'This portal cannot compose answers')
  const now = options.now ?? Date.now
  const started = now()
  const sourceTimeout = options.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS
  // The host's own collection is its own: only another portal's resources can be withheld.
  const searches: { source: AgentSource; slug?: string; search: ComposeSource['search'] }[] = [
    ...options.portals.map((config) => ({
      source: portalSource(config),
      slug: config.slug,
      search: async (query: string) =>
        chunksFrom(
          config.slug,
          (await provider.search(config, query, { pageSize: 8 })).resources.filter((resource) =>
            config.slug === host.slug || !resource.federationExcluded
          ),
        ),
    })),
    ...(options.peers ?? []).map((peer) => ({ source: peer.source, search: peer.search })),
  ]
  const sources = searches.map((entry) => entry.source)
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
  type Failure = 'timeout' | 'unauthorised' | 'error'
  type Lookup = { index: number; chunks?: AgentChunk[]; failure?: Failure }
  const pending = new Map<number, Promise<Lookup>>()
  const limits: AbortController[] = []
  searches.forEach((entry, index) => {
    // Aborted at the time limit, so a peer's request is cut off rather than left running.
    const limit = new AbortController()
    limits.push(limit)
    const abort = () => limit.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(
      index,
      within(entry.search(question, limit.signal), sourceTimeout, signal).then(
        (chunks): Lookup => ({ index, chunks }),
        (error): Lookup => {
          if (error instanceof TimedOut) limit.abort(error)
          return {
            index,
            failure: error instanceof TimedOut
              ? 'timeout'
              : (error as { failure?: unknown })?.failure === 'unauthorised'
              ? 'unauthorised'
              : 'error',
          }
        },
      ).finally(() => signal?.removeEventListener('abort', abort)),
    )
  })
  const found: AgentChunk[][] = sources.map(() => [])
  const failed: (AgentSource & { reason: Failure })[] = []
  while (pending.size > 0) {
    const lookup = await Promise.race(pending.values())
    pending.delete(lookup.index)
    if (signal?.aborted) return
    const source = sources[lookup.index]!
    const elapsedMs = Math.max(0, Math.round(now() - started))
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
    found[lookup.index] = lookup.chunks!
    yield {
      type: 'agent-step',
      id: stepId(source),
      module: 'search',
      title: `Searching ${source.label}`,
      status: 'completed',
      elapsedMs,
    }
    yield { type: 'agent-sources', stepId: stepId(source), source, chunks: lookup.chunks! }
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
  const gathered = sources.flatMap((source, index) =>
    found[index]!.map((chunk) => ({ source, chunk }))
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
  try {
    text = await within(
      compose(host, question, passages, options.context ? { context: options.context } : {}),
      options.composeTimeoutMs ?? COMPOSE_TIMEOUT_MS,
      signal,
    )
  } catch (error) {
    if (signal?.aborted) return
    const timedOut = error instanceof TimedOut
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
  }
  if (signal?.aborted) return
  yield {
    ...composeStep,
    status: 'completed',
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
  options.onVerification?.(agentRecordVerification({ text, bound, gathered, removed }))
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
    yield { type: 'delta', text: NO_SUPPORTED_ANSWER }
    yield { type: 'done', elapsedMs: Math.max(0, Math.round(now() - started)) }
    return
  }
  for (const paragraph of answer.split(/(?<=\n\n)/)) yield { type: 'delta', text: paragraph }
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
  yield { type: 'done', elapsedMs: Math.max(0, Math.round(now() - started)) }
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
