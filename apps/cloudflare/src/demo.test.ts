import { expect } from '@std/expect'
import { DEMO_TENANT, initialiseDemo } from './demo.ts'

Deno.test('demo bootstrap only writes to a new demo instance', () => {
  const calls: unknown[] = []
  let current: typeof DEMO_TENANT | undefined
  const tenants = {
    get: () => current,
    seed: (config: typeof DEMO_TENANT) => {
      current = config
      calls.push(config)
    },
    setDisabled: (slug: string, disabled: boolean) => calls.push({ slug, disabled }),
  }
  initialiseDemo(tenants, 'production')
  expect(calls).toEqual([])
  initialiseDemo(tenants, 'demo')
  expect(calls).toEqual([
    DEMO_TENANT,
    { slug: 'marine', disabled: true },
    { slug: 'grains', disabled: true },
  ])
  initialiseDemo(tenants, 'demo')
  expect(calls).toHaveLength(3)
  expect(DEMO_TENANT.regionalDiscovery).toBe(false)
})
