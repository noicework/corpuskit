import { expect } from '@std/expect'
import { TenantConfigSchema } from './index.ts'

const legacy = {
  slug: 'a',
  branding: {
    productName: 'Research',
    organisation: 'Research',
    tagline: 'Research',
    colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

Deno.test('tenant access mode defaults only absent or undefined legacy fields', () => {
  expect(TenantConfigSchema.parse(legacy).accessMode).toBe('public')
  expect(TenantConfigSchema.parse({ ...legacy, accessMode: undefined }).accessMode).toBe('public')
  for (const accessMode of ['public', 'authenticated', 'restricted']) {
    expect(TenantConfigSchema.parse({ ...legacy, accessMode }).accessMode).toBe(accessMode)
  }
  for (const accessMode of [null, '', 'Public', 'private', false, {}, []]) {
    expect(TenantConfigSchema.safeParse({ ...legacy, accessMode }).success).toBe(false)
  }
})
