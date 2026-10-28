import { expect } from '@std/expect'
import {
  DemoTourCopySchema,
  demoTourMode,
  showsRegionalDiscovery,
  TenantConfigSchema,
} from './index.ts'

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

Deno.test('the regional discovery band is opt-in: hidden when absent or false, shown only when true', () => {
  expect(showsRegionalDiscovery(TenantConfigSchema.parse(legacy))).toBe(false)
  expect(showsRegionalDiscovery(TenantConfigSchema.parse({ ...legacy, regionalDiscovery: false })))
    .toBe(false)
  expect(showsRegionalDiscovery(TenantConfigSchema.parse({ ...legacy, regionalDiscovery: true })))
    .toBe(true)
  for (const regionalDiscovery of ['true', 1, null]) {
    expect(TenantConfigSchema.safeParse({ ...legacy, regionalDiscovery }).success).toBe(false)
  }
})

Deno.test('the guided tour is off unless a portal opts in to offering it or opening it', () => {
  expect(demoTourMode(TenantConfigSchema.parse(legacy))).toBe('off')
  for (const demoTour of ['off', 'request', 'auto'] as const) {
    expect(demoTourMode(TenantConfigSchema.parse({ ...legacy, demoTour }))).toBe(demoTour)
  }
  for (const demoTour of [true, false, 'on', 1, null]) {
    expect(TenantConfigSchema.safeParse({ ...legacy, demoTour }).success).toBe(false)
  }
})

Deno.test('demo tour copy names each scene once and links only where a layout may', () => {
  const copy = {
    heading: 'Take the tour',
    intro: 'Three scenes.',
    scenes: [
      { id: 'federated', question: 'What limits yield in a dry season?' },
      { id: 'participation' },
      { id: 'gaps', title: 'Ask the unanswerable', href: '/manage?tab=insights' },
    ],
  }
  expect(DemoTourCopySchema.parse(copy)).toEqual(copy)
  expect(TenantConfigSchema.parse({ ...legacy, copy: { demoTour: copy } }).copy?.demoTour)
    .toEqual(copy)
  for (
    const invalid of [
      { scenes: [] },
      { scenes: [{ id: 'federated' }, { id: 'federated' }] },
      { scenes: [{ id: 'fireworks' }] },
      { scenes: [{ id: 'mcp', href: 'javascript:alert(1)' }] },
      { scenes: [{ id: 'mcp', href: 'tools' }] },
      { scenes: [{ id: 'mcp', title: '   ' }] },
      { scenes: [{ id: 'mcp', hidden: true }] },
      { heading: '' },
      { order: ['mcp'] },
    ]
  ) {
    expect(DemoTourCopySchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    expect(TenantConfigSchema.safeParse({ ...legacy, copy: { demoTour: invalid } }).success)
      .toBe(false)
  }
})
