import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { DEFAULT_RESEARCH_ENRICHMENT, type TenantConfig } from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { peerKeyName } from './bindings.ts'
import { patchTenantWithFederationKeys } from './federation-management.ts'

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
for (const runtime of ['local', 'durable'] as const) {
  for (const appearance of [false, true]) {
    Deno.test(`${runtime} federation PATCH removes peer keys and audits removal${appearance ? ' with appearance' : ''}`, async () => {
      const f = createEnforcementFixture({}, runtime)
      try {
        const admin = f.sessionFor('portal-admin', 'a')
        const original = f.stores.tenants.get('a')!.federation!.peers!
        const binding = {
          baseUrl: 'https://fixture-zone.dp.progress.cloud/api/v1/kb/fixture-box',
          kbId: 'fixture-box',
          token: 'synthetic-peer-key-to-delete',
        }
        const removedKey = peerKeyName('a', original[0]!.id)
        const retained = { ...original[0]!, id: 'retained-peer', label: 'Retained partner' }
        const retainedKey = peerKeyName('a', retained.id)
        f.stores.tenants.patch('a', { federation: { peers: [...original, retained] } })
        for (const name of [removedKey, retainedKey, peerKeyName('b', original[0]!.id), 'a']) {
          await f.stores.bindings.set(name, binding)
        }
        const patch = (body: unknown) =>
          f.requestAs(admin, '/api/admin/tenants/a', { ...json(body), method: 'PATCH' })
        // Other federation settings, edits and refused requests must not discard credentials.
        expect((await patch({ federation: { participates: false } })).status).toBe(200)
        expect((await patch({ federation: { peers: [...original, retained] } })).status).toBe(200)
        expect((await patch({ federation: { peers: [{ id: 'invalid' }] } })).status).toBe(400)
        expect(
          (await f.requestAs(f.sessionFor('curator', 'a'), '/api/admin/tenants/a', {
            ...json({ federation: { peers: [] } }),
            method: 'PATCH',
          })).status,
        ).toBe(403)
        expect(f.stores.bindings.get(removedKey)).toBeDefined()
        expect(
          (await patch({
            federation: { peers: [retained] },
            ...(appearance ? { name: 'Research collection' } : {}),
          })).status,
        ).toBe(200)
        expect(f.stores.bindings.get(removedKey)).toBeUndefined()
        for (const name of [retainedKey, peerKeyName('b', original[0]!.id), 'a']) {
          expect(f.stores.bindings.get(name)).toBeDefined()
        }
        const stored = f.state.get<Record<string, unknown>>('bindings', {})
        expect(Object.hasOwn(stored, removedKey)).toBe(false)
        const rows = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } })
        const removal = rows.find((row) =>
          row.action === 'tenant.behaviour.update' && row.outcome === 'success' &&
          JSON.parse(row.detail_json).removedPeerIds === original[0]!.id
        )!
        expect(removal.actor_id).toBe(admin.oid)
        expect(Number.isFinite(Date.parse(removal.at))).toBe(true)
        if (runtime === 'durable') {
          expect(
            rows.some((row) =>
              row.request_id === removal.request_id && row.action === 'local.mutation' &&
              JSON.parse(row.detail_json).mutation === 'bindings.remove'
            ),
          ).toBe(true)
        }
        expect(JSON.stringify(rows)).not.toContain(binding.token)
        expect((await patch({ federation: { peers: [...original, retained] } })).status).toBe(200)
        const snapshot = await (await f.requestAs(admin, '/api/admin/t/a/federation')).json()
        expect(snapshot.peers.find((peer: { id: string }) => peer.id === original[0]!.id).keySet)
          .toBe(false)
        expect(snapshot.peers.find((peer: { id: string }) => peer.id === retained.id).keySet)
          .toBe(true)
        expect((await patch({ federation: { peers: [] } })).status).toBe(200)
        expect(f.stores.bindings.get(retainedKey)).toBeUndefined()
      } finally {
        f.close()
      }
    })
  }
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

Deno.test('federation PATCH refuses to drop peers if credential deletion fails', () => {
  let patched = false
  const config = {
    slug: 'soil-hub',
    federation: { peers: [{ id: 'partner' }] },
  } as TenantConfig
  expect(() =>
    patchTenantWithFederationKeys(
      {
        tenants: {
          patch: () => {
            patched = true
          },
        },
        bindings: {
          removePeers: () => {
            throw new Error('storage failure')
          },
        },
      },
      config,
      { federation: { peers: [] } },
    )
  ).toThrow('storage failure')
  expect(patched).toBe(false)
})
