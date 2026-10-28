import { expect } from '@std/expect'
import { type TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

Deno.test('federation exclusion edits preserve other labels and user metadata, and invalidate resource caches', async () => {
  const tenant = { slug: 'label-fixture' } as TenantConfig
  const raw = {
    id: 'report',
    title: 'Soil trial report',
    usermetadata: {
      note: 'Keep this metadata',
      classifications: [{ labelset: 'topic', label: 'soil' }, {
        labelset: 'region',
        label: 'south',
      }],
    },
    computedmetadata: {},
  }
  const writes: Record<string, unknown>[] = []
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://fixture.rag.progress.cloud/api/v1/kb/fixture',
      token: 'fixture-only',
    }),
    fetchImpl: (_input, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        writes.push(body)
        raw.usermetadata = body.usermetadata
        return Promise.resolve(Response.json({}))
      }
      return Promise.resolve(Response.json(raw))
    },
  })
  expect((await provider.resource(tenant, 'report'))?.federationExcluded).toBeUndefined()
  expect(await provider.setResourceFederationExcluded(tenant, 'report', true)).toBe(true)
  expect((await provider.resource(tenant, 'report'))?.federationExcluded).toBe(true)
  expect(raw.usermetadata).toEqual({
    note: 'Keep this metadata',
    classifications: [
      { labelset: 'topic', label: 'soil' },
      { labelset: 'region', label: 'south' },
      { labelset: 'federation', label: 'exclude' },
    ],
  })
  expect(await provider.setResourceFederationExcluded(tenant, 'report', true)).toBe(true)
  expect(raw.usermetadata.classifications.length).toBe(3)
  expect(await provider.setResourceFederationExcluded(tenant, 'report', false)).toBe(true)
  expect(raw.usermetadata.classifications.length).toBe(2)
  expect((await provider.resource(tenant, 'report'))?.federationExcluded).toBeUndefined()
  raw.computedmetadata = { classifications: [{ labelset: 'federation', label: 'exclude' }] }
  expect(await provider.setResourceFederationExcluded(tenant, 'report', false)).toBe(false)
  expect(writes.length).toBe(3)
})
