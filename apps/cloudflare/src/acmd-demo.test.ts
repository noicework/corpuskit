import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import type { KbBinding } from '@research-portal/retrieval'
import { ACMD_DEMO_TENANT, initialiseAcmdDemo } from './acmd-demo.ts'

function fixture() {
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
      set: (slug: string, value: KbBinding) => connections.set(slug, value),
    },
  }
}

Deno.test('ACMD is restricted to the demo and reuses only its documentation binding', () => {
  const f = fixture()
  const docs = { baseUrl: 'https://example.test/kb/docs', token: 'test-only-docs-token' }
  f.connections.set('demo', docs)
  for (const environment of ['production', 'test', undefined]) {
    initialiseAcmdDemo(f.tenants, f.bindings, environment)
    expect(f.configs.size).toBe(0)
    expect(f.connections.has('acmd')).toBe(false)
  }
  initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.configs.get('acmd')?.hostname).toBe('acmd.corpuskit.org')
  expect(f.connections.get('acmd')).toEqual(docs)
  expect(f.connections.get('demo')).toEqual(docs)
})

Deno.test('ACMD preserves later branding and a dedicated knowledge box across restarts', () => {
  const f = fixture()
  const edited = { ...ACMD_DEMO_TENANT, searchPlaceholder: 'Search ACMD research' }
  const dedicated = { baseUrl: 'https://example.test/kb/acmd', token: 'test-only-acmd-token' }
  f.configs.set('acmd', edited)
  f.connections.set('acmd', dedicated)
  initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.configs.get('acmd')).toEqual(edited)
  expect(f.connections.get('acmd')).toEqual(dedicated)
})

Deno.test('ACMD waits for the demo binding without falling back to another portal', () => {
  const f = fixture()
  f.connections.set('grains', { baseUrl: 'https://example.test/kb/grains', token: 'test-only' })
  initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.connections.has('acmd')).toBe(false)
  const docs = { baseUrl: 'https://example.test/kb/docs', token: 'test-only-docs-token' }
  f.connections.set('demo', docs)
  initialiseAcmdDemo(f.tenants, f.bindings, 'demo')
  expect(f.connections.get('acmd')).toEqual(docs)
})
