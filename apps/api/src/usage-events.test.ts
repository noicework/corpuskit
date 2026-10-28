import { expect } from '@std/expect'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { OpenEventSchema } from './usage-events.ts'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('open beacon accepts exactly one source id and bounded identifiers and ranks', () => {
  const valid = { searchId: 'search-1', resourceId: 'doc_1', rank: 1 }
  expect(OpenEventSchema.safeParse(valid).success).toBe(true)
  expect(
    OpenEventSchema.safeParse({ answerId: 'answer-1', resourceId: 'doc_1', rank: 1000 }).success,
  ).toBe(true)
  for (
    const body of [
      null,
      {},
      { ...valid, answerId: 'a' },
      { ...valid, searchId: undefined },
      { ...valid, rank: 0 },
      { ...valid, rank: 1.5 },
      { ...valid, rank: 1001 },
      { ...valid, resourceId: '../secret' },
      { ...valid, resourceId: 'x'.repeat(129) },
      { ...valid, userId: 'reader' },
      { ...valid, ip: '192.0.2.1' },
      { ...valid, question: 'private' },
    ]
  ) {
    expect(OpenEventSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  }
})

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`${adapter}: search timing and beacons are scoped, anonymous, audited, disabled by policy and erased together`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const search = await f.requestAs(null, '/api/t/public-a/search?q=abalone')
      expect(search.status).toBe(200)
      const result = await search.json()
      expect(result.searchId).toMatch(/^[a-z0-9-]+$/)
      const records = () => f.stores.insights.eventsBetween('public-a', 0, Infinity).events
      expect(records()).toHaveLength(1)
      expect(records()[0]).toMatchObject({ kind: 'search', id: result.searchId })
      const measured = records()[0]!
      expect(measured.kind === 'search' && measured.durationSec).toBeGreaterThanOrEqual(0)
      const body = { searchId: result.searchId, resourceId: result.resources[0].id, rank: 1 }
      const open = () => f.requestAs(null, '/api/t/public-a/events/open', json(body))
      expect((await open()).status).toBe(204)
      expect(records()[1]).toEqual({
        kind: 'open',
        ts: new Date(f.now()).toISOString(),
        source: 'search',
        sourceId: result.searchId,
        resourceId: body.resourceId,
        rank: 1,
      })
      expect(JSON.stringify(records())).not.toMatch(/question|userId|clientId|192\.0\.2/)
      expect(
        f.rbac.audit.read({ scope: { kind: 'portal', slug: 'public-a' } }).some((e) =>
          e.action === 'local.mutation' && JSON.parse(e.detail_json).mutation === 'insights.record'
        ),
      ).toBe(true)
      expect((await f.requestAs(null, '/api/t/public-b/events/open', json(body))).status).toBe(400)
      expect(
        (await f.requestAs(null, '/api/t/public-a/events/open', json({ ...body, rank: 999 })))
          .status,
      ).toBe(400)
      expect(
        (await f.requestAs(null, '/api/t/public-a/events/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }))
          .status,
      ).toBe(400)
      expect(
        (await f.requestAs(null, '/api/t/public-a/events/open', {
          ...json(body),
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        })).status,
      ).toBe(403)
      expect(
        (await f.requestAs(null, '/api/t/public-a/events/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ' '.repeat(1025),
        })).status,
      ).toBe(400)
      f.stores.lifecycle.set('public-a', { status: 'suspended', limits: null })
      expect((await open()).status).toBe(423)
      f.stores.lifecycle.set('public-a', { status: 'read_only', limits: null })
      f.failAudit()
      expect((await open()).status).toBe(500)
      expect(records()).toHaveLength(2)
      f.recoverAudit()
      expect((await open()).status).toBe(204)
      f.advance(24 * 3600 * 1000 + 1)
      expect((await open()).status).toBe(400)
      f.stores.tenants.patch('public-a', { analyticsEnabled: false })
      expect((await open()).status).toBe(204)
      expect((await f.requestAs(null, '/api/t/public-a/search?q=abalone')).status).toBe(200)
      expect(records()).toHaveLength(3)
      f.stores.insights.erase('public-a')
      expect(records()).toEqual([])
      expect(f.stores.insights.summary('public-a').totalAsks).toBe(0)
    } finally {
      f.close()
    }
  })

  Deno.test(`${adapter}: beacon rate limit admits 60 opens per address per minute and then recovers`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const result = await (await f.requestAs(null, '/api/t/public-a/search?q=abalone')).json()
      const init = json({ searchId: result.searchId, resourceId: result.resources[0].id, rank: 1 })
      for (let i = 0; i < 60; i++) {
        expect((await f.requestFrom('192.0.2.1', null, '/api/t/public-a/events/open', init)).status)
          .toBe(204)
      }
      const limited = await f.requestFrom('192.0.2.1', null, '/api/t/public-a/events/open', init)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      expect((await f.requestFrom('192.0.2.2', null, '/api/t/public-a/events/open', init)).status)
        .toBe(204)
      f.advance(60_001)
      expect((await f.requestFrom('192.0.2.1', null, '/api/t/public-a/events/open', init)).status)
        .toBe(204)
    } finally {
      f.close()
    }
  })
}

class MeteredProvider extends DoubleProvider {
  override async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    yield* super.ask(tenant, query)
    yield { type: 'usage', inputTokens: 120, outputTokens: 30, totalSec: 2 }
    yield { type: 'usage', inputTokens: 0, outputTokens: 0, totalSec: 2, tokensReported: false }
  }
}
Deno.test('answer logs retain final cited topics and real token usage without replacing it with timing-only zeros', async () => {
  const f = createEnforcementFixture({ provider: new MeteredProvider() })
  try {
    const response = await f.requestAs(
      null,
      '/api/t/public-a/ask',
      json({ query: 'What do abalone surveys find?' }),
    )
    expect(response.status).toBe(200)
    const stream = await response.text()
    const asks = f.stores.insights.asksBetween('public-a', 0, Infinity).asks
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      citedResources: [{
        resourceId: 'res-1',
        rank: 1,
        topicIds: ['stock-assessment', 'marine-sustainability'],
      }],
    })
    expect(stream).toContain(`"answerId":"${asks[0]!.answerId}"`)
    const body = { answerId: asks[0]!.answerId, resourceId: 'res-1', rank: 1 }
    expect((await f.requestAs(null, '/api/t/public-a/events/open', json(body))).status).toBe(204)
  } finally {
    f.close()
  }
})
