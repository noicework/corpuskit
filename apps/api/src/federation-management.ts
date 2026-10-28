import type { Hono } from 'hono'
import {
  FederationPeerSchema,
  participatesInFederation,
  type TenantConfig,
} from '@research-portal/core'
import type { AragProvider, RetrievalProvider } from '@research-portal/retrieval'
import type { SealedBindingStore } from './bindings.ts'
import { peerKeyName } from './bindings.ts'
import { declaredRoute } from './permissions.ts'
import { type EnrichmentStoreApi, merchandiseSummaries } from './enrichments.ts'

const kindSamples = {
  'arag-kb': { zone: 'test-zone', kbId: 'fixture-box' },
  'arag-mcp': { zone: 'test-zone', kbId: 'fixture-box' },
  mcp: {
    url: 'https://partner.example.test/mcp',
    headerName: 'Authorization',
    tool: 'search',
    argument: 'query',
  },
  hosted: { slug: 'soil-research' },
}

/** Uses the same schema as PATCH, so capability detection never probes an external endpoint. */
export function supportedPeerKinds(): string[] {
  return Object.entries(kindSamples).filter(([kind, sample]) =>
    FederationPeerSchema.safeParse({ id: 'partner', label: 'Partner', kind, ...sample }).success
  ).map(([kind]) => kind)
}

export function registerFederationManagement(app: Hono, services: {
  tenant(slug: string): TenantConfig | undefined
  bindings: Pick<SealedBindingStore, 'get'>
  provider: RetrievalProvider
  enrichments: EnrichmentStoreApi
  management?: Pick<AragProvider, 'setResourceFederationExcluded'>
}) {
  app.get(declaredRoute('GET', '/api/admin/t/:slug/federation'), (c) => {
    const config = services.tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    c.header('Cache-Control', 'private, no-store')
    return c.json({
      participates: participatesInFederation(config),
      agentAsk: config.agentAsk === true,
      supportedKinds: supportedPeerKinds(),
      peers: (config.federation?.peers ?? []).map((peer) => ({
        ...peer,
        keySet: !!services.bindings.get(peerKeyName(config.slug, peer.id)),
      })),
    })
  })
  app.get(declaredRoute('GET', '/api/admin/t/:slug/federation/documents'), async (c) => {
    const config = services.tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const items = await services.provider.listResources(config, {
      includeHidden: true,
      signal: c.req.raw.signal,
    })
    return c.json({
      items: merchandiseSummaries(services.enrichments, config.slug, items).map((
        { id, title, federationExcluded },
      ) => ({
        id,
        title,
        excluded: federationExcluded === true,
      })),
      writable: !!services.management?.setResourceFederationExcluded,
    })
  })
  app.put(
    declaredRoute('PUT', '/api/admin/t/:slug/resources/:id/federation-exclusion'),
    async (c) => {
      const config = services.tenant(c.req.param('slug'))
      if (!config) return c.json({ error: 'unknown_tenant' }, 404)
      const raw = await c.req.json().catch(() => null)
      if (!raw || typeof raw.excluded !== 'boolean' || Object.keys(raw).length !== 1) {
        return c
          .json({ error: 'invalid_request' }, 400)
      }
      if (!services.management?.setResourceFederationExcluded) {
        return c.json({ error: 'unavailable' }, 503)
      }
      const id = c.req.param('id')
      const resource = await services.provider.resource(config, id, { hidden: true })
      if (!resource || resource.id !== id) return c.json({ error: 'not_found' }, 404)
      const changed = await services.management.setResourceFederationExcluded(
        config,
        id,
        raw.excluded,
      )
      if (!changed) return c.json({ error: 'computed_exclusion' }, 409)
      return c.json({ ok: true })
    },
  )
}
