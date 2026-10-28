import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { DEFAULT_RESEARCH_ENRICHMENT, type TenantConfig } from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { peerKeyName } from './bindings.ts'

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
for (const runtime of ['local', 'durable'] as const) {
  Deno.test(`${runtime} federation management redacts credentials, scopes access and guards exclusion writes`, async () => {
    let calls = 0
    class LabelDouble extends DoubleProvider {
      async setResourceFederationExcluded(_config: TenantConfig, id: string, excluded: boolean) {
        calls++
        this.resources = this.resources.map((resource) => {
          if (resource.id !== id) return resource
          const { federationExcluded: _excluded, ...rest } = resource
          return { ...rest, ...(excluded ? { federationExcluded: true as const } : {}) }
        })
        return true
      }
    }
    const provider = new LabelDouble()
    const f = createEnforcementFixture({
      provider,
      management: provider as unknown as AragProvider,
    }, runtime)
    try {
      const admin = f.sessionFor('portal-admin', 'a')
      const curator = f.sessionFor('curator', 'a')
      const path = '/api/admin/t/a/federation'
      for (const role of ['viewer', 'curator'] as const) {
        expect((await f.requestAs(f.sessionFor(role, 'a'), path)).status).toBe(403)
      }
      expect((await f.requestAs(f.sessionFor('portal-admin', 'b'), path)).status).toBe(403)
      const storedKey = 'fixture-secret-key-never-returned'
      await f.stores.bindings.set(peerKeyName('a', 'fixture-peer'), {
        baseUrl: 'https://test-zone.dp.progress.cloud/api/v1/kb/peer-box',
        kbId: 'peer-box',
        token: storedKey,
      })
      const response = await f.requestAs(admin, path)
      expect(response.headers.get('cache-control')).toContain('no-store')
      const text = await response.text()
      expect(text).not.toContain(storedKey)
      const snapshot = JSON.parse(text)
      expect(snapshot.peers[0].keySet).toBe(true)
      expect(snapshot.supportedKinds).toContain('arag-kb')
      f.stores.enrichments.put('a', 'res-1', {
        schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
        generatedAt: '2026-10-28T00:00:00Z',
        data: { title: 'Soil trial research report', summary: 'Soil research findings.' },
      })
      const documents = await f.requestAs(curator, path + '/documents')
      expect(documents.status).toBe(200)
      expect((await documents.json()).items[0].title).toBe('Soil trial research report')
      const exclusion = '/api/admin/t/a/resources/res-1/federation-exclusion'
      expect(
        (await f.requestAs(f.sessionFor('viewer', 'a'), exclusion, json({ excluded: true })))
          .status,
      ).toBe(403)
      expect(calls).toBe(0)
      expect((await f.requestAs(curator, exclusion, json({ excluded: true }))).status).toBe(200)
      expect(calls).toBe(1)
      expect((await (await f.requestAs(curator, path + '/documents')).json()).items[0].excluded)
        .toBe(true)
      expect((await f.requestAs(curator, exclusion, json({ excluded: false }))).status).toBe(200)
      expect((await f.requestAs(curator, exclusion, json({ excluded: 'false' }))).status).toBe(400)
      expect(
        (await f.requestAs(curator, exclusion.replace('res-1', 'absent'), json({ excluded: true })))
          .status,
      ).toBe(404)
      const before = calls
      f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
      expect((await f.requestAs(curator, exclusion, json({ excluded: true }))).status).toBe(423)
      expect(calls).toBe(before)
      expect(
        f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } }).some((row) =>
          row.action === 'request.privileged' && row.outcome === 'success' &&
          row.target_id === 'res-1'
        ),
      ).toBe(true)
    } finally {
      f.close()
    }
  })
}
