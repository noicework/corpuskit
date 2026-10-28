import { expect } from '@std/expect'
import {
  BrandingSchema,
  portalConfigurationExport,
  PortalConfigurationImportSchema,
  TenantConfigSchema,
} from './index.ts'

const config = TenantConfigSchema.parse({
  slug: 'synthetic',
  accessMode: 'restricted',
  hostname: 'synthetic.example.org',
  branding: {
    productName: '研究ポータル',
    organisation: 'Synthetic research',
    tagline: 'Synthetic demo data',
    colours: { primary: '#004466', accent: '#66aabb', heroFrom: '#003355', heroTo: '#005577' },
    colourScheme: 'viewer',
    defaultColourScheme: 'light',
    layout: {
      home: {
        hero: { heading: '研究', questions: ['What changed?'] },
        sections: [{ kind: 'topics' }],
      },
    },
  },
  languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['ja', 'en'] },
  searchPlaceholder: '研究を検索',
  topics: [{ id: 'topic-1', label: '研究', description: 'Synthetic research' }],
  suggestedQuestions: [{ id: 'question-1', text: 'What changed?' }],
  entityTypes: [],
  relationTypes: [],
  timezone: 'Asia/Tokyo',
  extraction: { default: 'default', rules: [] },
})

Deno.test('logo controls are bounded opt-in settings in both branding and operator imports', () => {
  const base = portalConfigurationExport(config)
  expect(base.branding.logoMaxWidth).toBeUndefined()
  expect(base.branding.showPortalSwitcher).toBeUndefined()
  for (const width of [80, 300, 640]) {
    const branding = { ...base.branding, logoMaxWidth: width, showPortalSwitcher: false }
    expect(BrandingSchema.parse(branding).logoMaxWidth).toBe(width)
    const imported = PortalConfigurationImportSchema.parse({ ...base, branding })
    expect(imported.branding.showPortalSwitcher).toBe(false)
    expect(portalConfigurationExport({ ...config, branding }).branding.logoMaxWidth).toBe(width)
  }
  for (const width of [79, 641, 100.5, '300', null]) {
    expect(BrandingSchema.safeParse({ ...base.branding, logoMaxWidth: width }).success).toBe(false)
  }
  for (const value of ['false', 0, null]) {
    expect(BrandingSchema.safeParse({ ...base.branding, showPortalSwitcher: value }).success).toBe(
      false,
    )
  }
})

Deno.test('configuration export is a complete importable presentation without access or hosting policy', () => {
  const exported = portalConfigurationExport(config)
  expect(PortalConfigurationImportSchema.parse(exported)).toEqual(exported)
  expect(exported.branding.defaultColourScheme).toBe('light')
  expect(exported.languagePolicy?.defaultLanguage).toBe('ja')
  expect(exported).not.toHaveProperty('accessMode')
  expect(exported).not.toHaveProperty('hostname')
  expect(exported).not.toHaveProperty('extraction')
})

Deno.test('the accessibility statement travels with the configuration and takes only safe contacts', () => {
  const accessibility = {
    sections: [{ heading: 'What has been tested', paragraphs: ['Every page.', 'Both themes.'] }],
    contact: {
      name: 'the portal team',
      email: 'access@example.org',
      phone: '1800 000 000',
      url: 'https://example.org/accessibility',
      note: 'We reply within five working days.',
    },
  }
  const exported = portalConfigurationExport({ ...config, accessibility })
  expect(exported.accessibility).toEqual(accessibility)
  expect(PortalConfigurationImportSchema.parse(exported).accessibility).toEqual(accessibility)
  expect(portalConfigurationExport(config)).not.toHaveProperty('accessibility')
  // A contact alone, and an empty statement, are both fine: the page leaves out what is absent.
  expect(
    TenantConfigSchema.parse({ ...config, accessibility: { contact: { email: 'a@b.co' } } })
      .accessibility,
  ).toEqual({ contact: { email: 'a@b.co' } })
  expect(TenantConfigSchema.parse({ ...config, accessibility: {} }).accessibility).toEqual({})
  for (
    const invalid of [
      { contact: { email: 'not an address' } },
      { contact: { url: 'http://example.org/accessibility' } },
      { contact: { url: 'javascript:alert(1)' } },
      { contact: { phone: '12' } },
      { contact: { fax: '1800 000 000' } },
      { sections: [] },
      { sections: [{ heading: 'No body', paragraphs: [] }] },
      { sections: [{ heading: '', paragraphs: ['Body.'] }] },
      { sections: [{ heading: 'Markup', body: '<p>Body</p>' }] },
      { conformance: 'AA' },
    ]
  ) {
    expect(TenantConfigSchema.safeParse({ ...config, accessibility: invalid }).success).toBe(false)
    expect(
      PortalConfigurationImportSchema.safeParse({ ...exported, accessibility: invalid }).success,
    ).toBe(false)
  }
})

Deno.test('interface wording survives configuration import and export without changing policy', () => {
  const copy = { interfaceMessages: { en: { Graph: 'Knowledge map' }, ja: { Graph: '地図' } } }
  const exported = portalConfigurationExport({ ...config, copy })
  expect(PortalConfigurationImportSchema.parse(exported).copy).toEqual(copy)
  expect(TenantConfigSchema.parse({ ...config, copy }).accessMode).toBe('restricted')
  expect(
    PortalConfigurationImportSchema.safeParse({
      ...exported,
      copy: { interfaceMessages: { en: { Graph: '' } } },
    }).success,
  ).toBe(false)
})

Deno.test('configuration import rejects protected or unknown fields at every nested level', () => {
  const valid = portalConfigurationExport(config)
  for (
    const key of [
      'accessMode',
      'hostname',
      'binding',
      'kbId',
      'baseUrl',
      'token',
      'inferenceModel',
      'prompts',
      'intents',
      'searchExclude',
      'extraction',
      'disabled',
      'lifecycle',
      'roles',
    ]
  ) {
    expect(PortalConfigurationImportSchema.safeParse({ ...valid, [key]: 'refused' }).success, key)
      .toBe(false)
  }
  for (
    const invalid of [
      { ...valid, branding: { ...valid.branding, token: 'refused' } },
      {
        ...valid,
        branding: { ...valid.branding, fonts: { sans: 'Arial', display: 'Arial', key: 'x' } },
      },
      { ...valid, topics: [{ id: 'topic-1', label: 'Research', slug: 'other' }] },
      { ...valid, suggestedQuestions: [{ id: 'q', text: 'Question', resourceId: 'other' }] },
      { ...valid, languagePolicy: { defaultLanguage: 'ja', availableLanguages: ['en'] } },
      { ...valid, branding: { ...valid.branding, defaultColourScheme: 'system' } },
      { ...valid, timezone: 'not/a-timezone' },
      { ...valid, topics: 'invalid' },
      { ...valid, branding: {} },
      null,
    ]
  ) expect(PortalConfigurationImportSchema.safeParse(invalid).success).toBe(false)
})
