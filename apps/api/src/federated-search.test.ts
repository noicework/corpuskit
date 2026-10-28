import { expect } from '@std/expect'
import { type ScoredResource, SearchResultsSchema } from '@research-portal/core'
import { PeerError } from '@research-portal/retrieval'
import { aragPeerFetch } from '../../../e2e/support/arag-peer-double.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import {
  federatedCollections,
  interleave,
  offersFederatedSearch,
  type SearchCollection,
  searchCollections,
} from './federated-search.ts'
import { peerKeyName } from './bindings.ts'

const resource = (id: string): ScoredResource => ({
  id,
  title: id,
  summary: 'A synthetic passage about soil research.',
  type: 'document',
  topicIds: [],
  keyFacts: [],
  relevance: 0.8,
  citedCount: 0,
})
const collection = (id: string, search: SearchCollection['search']): SearchCollection => ({
  source: { id, label: `${id} collection`, kind: 'peer', transport: 'mcp' },
  search,
})

Deno.test('shared search interleaves unequal sources fairly, preserving each ranking', () => {
  expect(interleave([[1, 2, 3, 4], [5], [6, 7], []])).toEqual([1, 5, 6, 2, 7, 3, 4])
  expect(interleave([])).toEqual([])
  expect(interleave([[], []])).toEqual([])
})

Deno.test('shared searches start in parallel, bound every source and report safe ordered failures', async () => {
  const started: string[] = []
  let aborted = false
  const result = await searchCollections('soil', [
    collection('slow', (signal) => {
      started.push('slow')
      signal.addEventListener('abort', () => aborted = true)
      return new Promise(() => {})
    }),
    collection('host', async () => {
      started.push('host')
      return Array.from({ length: 20 }, (_, i) => resource(`host-${i}`))
    }),
    collection('refused', () => {
      started.push('refused')
      throw new PeerError('unauthorised', 'Do not release upstream detail')
    }),
    collection('broken', () => {
      throw new Error('Do not release secret configuration')
    }),
    collection('partner', async () => [resource('partner-0'), resource('partner-1')]),
  ], { timeoutMs: 15 })
  expect(started).toEqual(['slow', 'host', 'refused'])
  expect(aborted).toBe(true)
  expect(result.resources.slice(0, 4).map((r) => r.id)).toEqual([
    'host-0',
    'partner-0',
    'host-1',
    'partner-1',
  ])
  expect(result.resources.length).toBe(10)
  expect(result.failedSources?.map((s) => [s.id, s.reason])).toEqual([
    ['slow', 'timeout'],
    ['refused', 'unauthorised'],
    ['broken', 'error'],
  ])
  expect(JSON.stringify(result)).not.toContain('Do not release')
  expect(SearchResultsSchema.safeParse(result).success).toBe(true)
})

Deno.test('shared search reports every source failing and honours an already cancelled reader', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  const result = await searchCollections('soil', [collection('partner', async () => {
    called = true
    return [resource('r')]
  })], { signal: controller.signal })
  expect(called).toBe(false)
  expect(result.resources).toEqual([])
  expect(result.failedSources).toHaveLength(1)
})

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`${adapter}: shared search keeps existing read guards, opt-in, participation and per-source limits`, async () => {
    const f = createEnforcementFixture({ rateLimitAskPerMin: 3 }, adapter)
    const path = '/api/t/a/search?q=soil&federated=1'
    try {
      expect((await f.requestAs(null, path)).status).toBe(401)
      expect((await f.requestAs(f.unassigned, path)).status).toBe(403)
      f.assertNoProtectedDispatch()
      const reader = f.sessionFor('viewer')
      const originalConfig = f.stores.tenants.get('a')!
      const first = await f.requestAs(reader, path)
      expect(first.status).toBe(200)
      const body = SearchResultsSchema.parse(await first.json())
      expect(body.resources.every((r) => r.source?.kind === 'hosted')).toBe(true)
      expect(body.failedSources).toMatchObject([{
        id: 'peer:fixture-peer',
        reason: 'unauthorised',
      }])
      // Two sources cost two turns: a second request cannot fit in a three-turn bucket.
      const calls = f.providerCalls.length
      expect((await f.requestAs(reader, path)).status).toBe(429)
      expect(f.providerCalls.length).toBe(calls)
      // A normal one-portal search stays available and has its unchanged response shape.
      const ordinary = await f.requestAs(reader, '/api/t/a/search?q=soil')
      expect(ordinary.status).toBe(200)
      expect((await ordinary.json()).sources).toBeUndefined()
      f.stores.tenants.patch('a', { federation: { participates: false } })
      expect(offersFederatedSearch(f.stores.tenants.get('a')!)).toBe(false)
      expect((await f.requestAs(reader, path)).status).toBe(404)
      f.stores.tenants.patch('a', { agentAsk: false })
      expect((await f.requestAs(reader, path)).status).toBe(404)
      f.stores.tenants.patch('a', { agentAsk: true, federation: originalConfig.federation })
      f.stores.lifecycle.set('a', { status: 'read_only', limits: { asksPerDay: 0 } })
      expect((await f.requestFrom('192.0.2.22', reader, path)).status).toBe(200)
      f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
      expect((await f.requestAs(reader, path)).status).toBe(423)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: shared peer entry point withholds excluded resources and unapproved links`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const config = f.stores.tenants.get('a')!
      const peer = config.federation!.peers![0]!
      await f.stores.bindings.set(peerKeyName('a', peer.id), {
        baseUrl: 'https://fixture-zone.dp.progress.cloud/api/v1/kb/fixture-box',
        kbId: 'fixture-box',
        token: 'synthetic-partner-read-key',
      })
      const peerFetch = aragPeerFetch([{
        zone: 'fixture-zone',
        kbId: 'fixture-box',
        key: 'synthetic-partner-read-key',
        documents: [
          {
            resourceId: 'soil',
            title: 'Soil research',
            text: 'Soil carbon improved in trials.',
            originUrl: 'https://partner.example.org/soil',
          },
          {
            resourceId: 'withheld',
            title: 'Withheld',
            text: 'Never release this.',
            excluded: true,
          },
        ],
      }])
      const run = (linkOrigins: boolean) =>
        searchCollections(
          'soil',
          federatedCollections({
            config: { ...config, federation: { peers: [{ ...peer, linkOrigins }] } },
            query: 'soil',
            provider: new DoubleProvider(),
            bindings: f.stores.bindings,
            peerFetch,
            merchandise: (result) => result,
          }),
        )
      const privateLinks = SearchResultsSchema.parse(await run(false))
      expect(privateLinks.resources.some((r) => r.title === 'Withheld')).toBe(false)
      expect(privateLinks.resources.some((r) => r.peerUrl)).toBe(false)
      const linked = SearchResultsSchema.parse(await run(true))
      expect(linked.resources.find((r) => r.source?.kind === 'peer')?.peerUrl).toBe(
        'https://partner.example.org/soil',
      )
      expect(JSON.stringify(linked)).not.toContain('synthetic-partner-read-key')
      expect(JSON.stringify(linked)).not.toContain('fixture-zone')
    } finally {
      f.close()
    }
  })
}
