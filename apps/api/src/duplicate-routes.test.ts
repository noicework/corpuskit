import { expect } from '@std/expect'
import { DoubleProvider, RESOURCE_ONE } from '../../../e2e/support/double-provider.ts'
import { tenantConfig } from './tenants.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { DuplicateReviewStore } from './duplicate-store.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { localOwnedStores } from './local-owned-stores.ts'

const json = (decision: string, pair = 'res-1/res-copy') => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair, decision }),
})

Deno.test('review pages stay bounded and pending results advance past remembered decisions', async () => {
  class ManyDuplicates extends DoubleProvider {
    protected override resources = Array.from(
      { length: 12 },
      (_, i) => ({ ...RESOURCE_ONE, id: `item-${i}` }),
    )
  }
  const f = createEnforcementFixture({ provider: new ManyDuplicates() })
  try {
    const curator = f.sessionFor('curator')
    const path = '/api/admin/t/a/duplicates'
    const first = await (await f.requestAs(curator, `${path}?reviewed=false`)).json()
    const second = await (await f.requestAs(curator, `${path}?page=2&reviewed=false`)).json()
    expect(first.totalCandidates).toBe(66)
    expect(first.candidates).toHaveLength(50)
    expect(second.candidates).toHaveLength(16)
    expect(new Set([...first.candidates, ...second.candidates].map((p) => p.id)).size).toBe(66)
    const pair = first.candidates[0].id
    expect((await f.requestAs(curator, `${path}/review`, json('not-duplicate', pair))).status).toBe(
      200,
    )
    const pending = await (await f.requestAs(curator, `${path}?reviewed=false`)).json()
    expect(pending.totalCandidates).toBe(65)
    expect(pending.candidates.some((p: { id: string }) => p.id === pair)).toBe(false)
    expect(f.providerCalls.filter((call) => call.method === 'listResources')).toHaveLength(1)
  } finally {
    f.close()
  }
})

Deno.test('overlap pages and CSV cover distinct collection pairs and reuse computed metadata', async () => {
  const f = createEnforcementFixture({ provider: DoubleProvider.withDuplicates() })
  try {
    for (let i = 0; i < 12; i++) {
      f.stores.tenants.seed({ ...tenantConfig('marine')!, slug: `collection-${i}` })
    }
    const admin = f.sessionFor('platform-admin')
    const first = await (await f.requestAs(admin, '/api/admin/overlap')).json()
    const calls = f.providerCalls.length
    await f.requestAs(admin, '/api/admin/overlap')
    expect(f.providerCalls.length).toBe(calls)
    const second = await (await f.requestAs(admin, '/api/admin/overlap?page=2')).json()
    expect(first.rows).toHaveLength(50)
    expect(second.rows).toHaveLength(50)
    expect(new Set([...first.rows, ...second.rows].map((p) => `${p.left}/${p.right}`)).size).toBe(
      100,
    )
    expect(first.totalRows).toBeGreaterThan(100)
    const secondCalls = f.providerCalls.length
    expect(second.rows[0].sharedTitles).toBe(6)
    const csv = await (await f.requestAs(admin, '/api/admin/overlap/export?page=2')).text()
    expect(csv).toContain(`"${second.rows[0].left}","${second.rows[0].right}"`)
    expect(csv).not.toContain(`"${first.rows[0].left}","${first.rows[0].right}"`)
    expect(f.providerCalls.length).toBe(secondCalls)
  } finally {
    f.close()
  }
})

Deno.test('reviews persist across refresh, are isolated and audited without document text', async () => {
  const f = createEnforcementFixture({ provider: DoubleProvider.withDuplicates() })
  try {
    const curator = f.sessionFor('curator')
    const path = '/api/admin/t/a/duplicates'
    const report = await (await f.requestAs(curator, path)).json()
    expect(report.candidates).toHaveLength(2)
    const before = f.providerCalls.length
    await f.requestAs(curator, path)
    expect(f.providerCalls.length).toBe(before)
    for (const decision of ['not-duplicate', 'keep-both']) {
      expect((await f.requestAs(curator, `${path}/review`, json(decision))).status).toBe(200)
      const refreshed = await (await f.requestAs(curator, `${path}/refresh`, { method: 'POST' }))
        .json()
      expect(refreshed.candidates.find((p: { id: string }) => p.id === 'res-1/res-copy').decision)
        .toBe(decision)
    }
    expect(f.stores.duplicates.reviews('b')).toEqual({})
    const events = f.rbac.audit.read({
      scope: { kind: 'portal', slug: 'a' },
      action: 'duplicate.review',
    })
    expect(
      new Set(
        events.filter((event) => event.outcome === 'success').map((event) => event.request_id),
      ).size,
    ).toBe(2)
    expect(JSON.parse(events.find((event) => event.outcome === 'success')!.detail_json))
      .toMatchObject({ permission: 'content.write', decision: 'keep-both' })
    expect(JSON.stringify(events)).not.toContain('Abalone')
    expect((await f.requestAs(curator, `${path}/review`, json('retire-one'))).status).toBe(400)
    expect((await f.requestAs(curator, `${path}/review`, json('keep-both', 'foreign/pair'))).status)
      .toBe(404)
    expect(f.providerCalls.every((call) => call.method === 'listResources')).toBe(true)
    const cachedCalls = f.providerCalls.length
    f.advance(86_400_001)
    const renewed = {
      ...curator,
      claimIssuedAt: f.now(),
      createdAt: f.now(),
      expiresAt: f.now() + 28_800_000,
    }
    expect((await f.requestAs(renewed, path)).status).toBe(200)
    expect(f.providerCalls.length).toBe(cachedCalls + 1)
  } finally {
    f.close()
  }
})

Deno.test('review lifecycle guards prevent writes before provider dispatch', async () => {
  const f = createEnforcementFixture({ provider: DoubleProvider.withDuplicates() })
  try {
    for (const status of ['read_only', 'suspended'] as const) {
      f.stores.lifecycle.set('a', { status, limits: null })
      const before = f.providerCalls.length
      const response = await f.requestAs(
        f.sessionFor('curator'),
        '/api/admin/t/a/duplicates/review',
        json('keep-both'),
      )
      expect(response.status).toBe(423)
      expect(f.providerCalls.length).toBe(before)
      expect(f.stores.duplicates.reviews('a')).toEqual({})
    }
  } finally {
    f.close()
  }
})

Deno.test('durable review and local SQL decisions survive store reconstruction and erase only their portal', () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const store = new DuplicateReviewStore(db)
    store.decide('first', 'one/two', 'not-duplicate')
    store.decide('second', 'one/two', 'keep-both')
    const restarted = new DuplicateReviewStore(db)
    expect(restarted.reviews('first')['one/two']!.decision).toBe('not-duplicate')
    expect(restarted.erase('first')).toBe(1)
    expect(restarted.erase('first')).toBe(0)
    expect(restarted.reviews('second')['one/two']!.decision).toBe('keep-both')
  } finally {
    db.close()
  }
})

for (const runtime of ['local', 'durable'] as const) {
  for (const failure of ['mutation', 'named'] as const) {
    Deno.test(`${runtime} review SQL rolls back when ${failure} audit completion fails`, async () => {
      const f = createEnforcementFixture({ provider: DoubleProvider.withDuplicates() })
      const directory = Deno.makeTempDirSync({ prefix: 'duplicates-audit-' })
      try {
        const local = localOwnedStores(directory, f.database, f.rbac.audit)
        const store = runtime === 'local' ? local.duplicates : f.stores.duplicates
        const context = runtime === 'local' ? local.localMutations : f.stores.localMutations
        f.database.exec(
          `CREATE TRIGGER fail_duplicate_audit BEFORE INSERT ON audit_events ${
            failure === 'named' ? "WHEN NEW.action = 'duplicate.review'" : ''
          } BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`,
        )
        await expect(context.run(
          {
            requestId: 'review-rollback',
            actor: { kind: 'system' },
            action: 'duplicate.review',
            scope: { kind: 'portal', slug: 'a' },
            target: { kind: 'duplicate-pair', id: 'one/two' },
            detail: { permission: 'content.write', decision: 'keep-both' },
          },
          new AbortController().signal,
          async () => store.decide('a', 'one/two', 'keep-both'),
        )).rejects.toThrow()
        expect(store.reviews('a')).toEqual({})
      } finally {
        f.close()
        Deno.removeSync(directory, { recursive: true })
      }
    })
  }
}
