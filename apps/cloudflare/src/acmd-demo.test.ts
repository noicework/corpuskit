import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { KbBinding } from '@research-portal/retrieval'
import { ACMD_DEMO_TENANT, initialiseAcmdDemo } from './acmd-demo.ts'

function fixture(writable = true) {
  const configs = new Map<string, TenantConfig>()
  const connections = new Map<string, KbBinding>()
  return {
    configs,
    connections,
    tenants: {
      get: (slug: string) => configs.get(slug),
      seed: (config: TenantConfig) => configs.set(config.slug, config),
    },
    bindings: {
      get: (slug: string) => connections.get(slug),
      set: (slug: string, value: KbBinding) => {
        if (!writable) throw new Error('binding_key_missing')
        connections.set(slug, value)
      },
      encryptionStatus: () => ({ configured: writable, required: true, writable }),
    },
  }
}

Deno.test('ACMD is restricted to the demo and reuses only its documentation binding', async () => {
  const f = fixture()
  const docs = { baseUrl: 'https://example.test/kb/docs', token: 'test-only-docs-token' }
  f.connections.set('demo', docs)
  for (const environment of ['production', 'test', undefined]) {
    await initialiseAcmdDemo(f.tenants, f.bindings, environment)
    expect(f.configs.size).toBe(0)
    expect(f.connections.has('acmd')).toBe(false)
  }
  await initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.configs.get('acmd')?.hostname).toBe('acmd.corpuskit.org')
  expect(f.connections.get('acmd')).toEqual(docs)
  expect(f.connections.get('demo')).toEqual(docs)
})

Deno.test('ACMD preserves later branding and a dedicated knowledge box across restarts', async () => {
  const f = fixture()
  const edited = { ...ACMD_DEMO_TENANT, searchPlaceholder: 'Search ACMD research' }
  const dedicated = { baseUrl: 'https://example.test/kb/acmd', token: 'test-only-acmd-token' }
  f.configs.set('acmd', edited)
  f.connections.set('acmd', dedicated)
  await initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.configs.get('acmd')).toEqual(edited)
  expect(f.connections.get('acmd')).toEqual(dedicated)
})

Deno.test('ACMD waits for the demo binding without falling back to another portal', async () => {
  const f = fixture()
  f.connections.set('grains', { baseUrl: 'https://example.test/kb/grains', token: 'test-only' })
  await initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.connections.has('acmd')).toBe(false)
  const docs = { baseUrl: 'https://example.test/kb/docs', token: 'test-only-docs-token' }
  f.connections.set('demo', docs)
  await initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.connections.get('acmd')).toEqual(docs)
})

Deno.test('ACMD still seeds its portal when new bindings cannot be sealed', async () => {
  const f = fixture(false)
  const docs = { baseUrl: 'https://example.test/kb/docs', token: 'test-only-docs-token' }
  f.connections.set('demo', docs)
  await initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.configs.get('acmd')?.slug).toBe('acmd')
  expect(f.connections.has('acmd')).toBe(false)
})
