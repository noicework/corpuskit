import {
  type FederationPeer,
  participatesInFederation,
  type TenantConfig,
} from '@research-portal/core'
import { PeerError, searchPeer } from '@research-portal/retrieval'
import type { ComposeSource } from './agent-compose.ts'
import { appendAudit, type AuditStore, createAuditEvent } from './audit.ts'
import { type BindingStoreApi, peerKeyName } from './bindings.ts'
import type { PortalRequestContext } from './app.ts'

/** Shared HTTP and MCP peer retrieval, using sealed keys and the host's audit log. */
export function federationPeerSources(options: {
  host: TenantConfig
  bindings: BindingStoreApi
  fetchImpl?: typeof fetch
  audit: AuditStore
  context: PortalRequestContext
  now?: () => number
}): ComposeSource[] {
  const { host } = options
  if (!participatesInFederation(host)) return []
  const peers = (host.federation?.peers ?? []).filter((peer): peer is FederationPeer =>
    Boolean(peer.zone && peer.kbId)
  )
  return peers.map((peer) => ({
    source: {
      id: `peer:${peer.id}`,
      label: peer.label,
      kind: 'peer' as const,
      transport: peer.kind === 'arag-mcp' ? 'mcp' as const : 'kb' as const,
    },
    search: async (question, signal) => {
      const started = Date.now()
      const record = (failure?: 'timeout' | 'unauthorised' | 'error') => {
        const context = options.context
        appendAudit(
          options.audit,
          createAuditEvent({
            requestId: context.requestId,
            actor: context.actor ?? { kind: 'anonymous' },
            action: 'federation.peer.call',
            scope: { kind: 'portal', slug: host.slug },
            target: { kind: 'request' },
            outcome: failure ? 'failure' : 'success',
            detail: {
              peerId: peer.id,
              peerKind: peer.kind,
              durationMs: Math.max(0, Date.now() - started),
              ...(failure ? { peerFailure: failure } : {}),
            },
          }, options.now),
        )
      }
      try {
        const key = options.bindings.get(peerKeyName(host.slug, peer.id))
        if (!key) throw new PeerError('unauthorised', 'No key is stored for this peer')
        const passages = await searchPeer(peer, key.token, question, {
          signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
        record()
        return passages.map((passage, index) => ({
          id: `peer:${peer.id}/${passage.resourceId}/${index}`,
          title: passage.title,
          text: passage.text.slice(0, 1200),
          // Off by default: a link would name the partner on a public portal.
          ...(peer.linkOrigins && passage.originUrl ? { url: passage.originUrl } : {}),
        }))
      } catch (error) {
        record(
          signal.aborted && !(error instanceof PeerError)
            ? 'timeout'
            : error instanceof PeerError
            ? error.failure
            : 'error',
        )
        throw error
      }
    },
  }))
}
