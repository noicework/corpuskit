import {
  type FederationPeer,
  offersAgentAsk,
  participatesInFederation,
  type ScoredResource,
  type SearchResults,
  type SearchSource,
  type SearchSourceFailure,
  type TenantConfig,
} from '@research-portal/core'
import { PeerError, type RetrievalProvider, searchPeer } from '@research-portal/retrieval'
import { SOURCE_TIMEOUT_MS } from './agent-compose.ts'
import { type BindingStoreApi, peerKeyName } from './bindings.ts'

const RESULTS_PER_SOURCE = 8

/** Same opt-in and participation rule as one-portal agent ask. */
export function offersFederatedSearch(config: TenantConfig): boolean {
  return offersAgentAsk(config) && participatesInFederation(config) &&
    (config.federation?.peers?.length ?? 0) > 0
}

/**
 * One result per non-empty source per round, in configuration order (host first).
 * Keep each source's ranking. Scores from separate collections are never compared.
 */
export function interleave<T>(sources: readonly (readonly T[])[]): T[] {
  const merged: T[] = []
  const rounds = Math.max(0, ...sources.map((items) => items.length))
  for (let rank = 0; rank < rounds; rank++) {
    for (const items of sources) if (rank < items.length) merged.push(items[rank]!)
  }
  return merged
}

export interface SearchCollection {
  source: SearchSource
  search(signal: AbortSignal): Promise<ScoredResource[]>
}

/** Parallel, bounded searches; a failed or timed-out collection never hides another's results. */
export async function searchCollections(
  query: string,
  collections: readonly SearchCollection[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SearchResults> {
  const settled = await Promise.all(collections.map(async ({ source, search }) => {
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      if (options.signal?.aborted) controller.abort(options.signal.reason)
      const stopped = new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason)
        if (controller.signal.aborted) rejectAbort()
        else controller.signal.addEventListener('abort', rejectAbort, { once: true })
        timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('Source search timed out'))
        }, options.timeoutMs ?? SOURCE_TIMEOUT_MS)
      })
      const resources = await Promise.race([
        stopped,
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return search(controller.signal)
        }),
      ])
      return {
        resources: resources.slice(0, RESULTS_PER_SOURCE).map((resource) => ({
          ...resource,
          source,
        })),
      }
    } catch (error) {
      const failure: SearchSourceFailure = {
        ...source,
        reason: timedOut ? 'timeout' : error instanceof PeerError ? error.failure : 'error',
      }
      return { resources: [], failure }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }))
  return {
    query,
    resources: interleave(settled.map((entry) => entry.resources)),
    relatedQuestions: [],
    sources: collections.map((entry) => entry.source),
    failedSources: settled.flatMap((entry) => entry.failure ? [entry.failure] : []),
  }
}

export function federatedCollections(options: {
  config: TenantConfig
  query: string
  provider: RetrievalProvider
  bindings: BindingStoreApi
  peerFetch?: typeof fetch
  /** Apply the host's existing merchandising without changing partner passages. */
  merchandise: (results: SearchResults) => SearchResults
}): SearchCollection[] {
  const { config, query, provider, bindings } = options
  return [
    {
      source: {
        id: config.slug,
        label: config.branding.productName,
        kind: 'hosted',
        transport: 'hosted',
      },
      // Its own excluded resources still appear inside their portal, exactly as in agent ask.
      search: async () =>
        options.merchandise(
          await provider.search(config, query, { pageSize: RESULTS_PER_SOURCE }),
        ).resources,
    },
    ...(config.federation?.peers ?? []).map((configured): SearchCollection => {
      // Server-side tenant records hold complete peers; reader projections omit their address.
      const peer = configured as FederationPeer
      const source: SearchSource = {
        id: `peer:${peer.id}`,
        label: peer.label,
        kind: 'peer',
        transport: ({ 'arag-kb': 'kb', 'arag-mcp': 'mcp', mcp: 'mcp', hosted: 'hosted' } as Record<
          string,
          SearchSource['transport']
        >)[peer.kind] ?? 'mcp',
      }
      return {
        source,
        search: async (signal) => {
          const key = bindings.get(peerKeyName(config.slug, peer.id))
          if (!key) throw new PeerError('unauthorised', 'No key is stored for this peer')
          // Shared entry point owns transport, exclusion policy and allowed outbound requests.
          const passages = await searchPeer(peer, key.token, query, {
            signal,
            ...(options.peerFetch ? { fetchImpl: options.peerFetch } : {}),
          })
          return passages.map((passage, index) => ({
            id: `${source.id}/${passage.resourceId}/${index}`,
            title: passage.title,
            summary: passage.text,
            type: 'document' as const,
            topicIds: [],
            keyFacts: [],
            relevance: 0,
            citedCount: 0,
            matchedPassage: passage.text,
            ...(peer.linkOrigins && passage.originUrl ? { peerUrl: passage.originUrl } : {}),
          }))
        },
      }
    }),
  ]
}
