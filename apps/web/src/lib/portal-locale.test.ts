import { expect } from '@std/expect'
import { TenantConfigSchema } from '@research-portal/core'
import { createPortalLocale, localisePortalConfig } from './portal-locale.tsx'

Deno.test('interface wording stays within the configured portal and language', () => {
  const copy = {
    interfaceMessages: {
      en: { Graph: 'Knowledge map', 'Open {name}': 'Read {name}' },
      ja: { Graph: 'ナレッジマップ' },
    },
  }
  const english = createPortalLocale('en', undefined, copy)
  const japanese = createPortalLocale('ja', undefined, copy)
  expect(english.ui('Graph')).toBe('Knowledge map')
  expect(japanese.ui('Graph')).toBe('ナレッジマップ')
  expect(english.ui('Open {name}', { name: 'Source {count}' })).toBe('Read Source {count}')
  expect(japanese.ui('Save')).toBe('保存')
  expect(createPortalLocale('en').ui('Graph')).toBe('Graph')
  expect(english.ui('Authored evidence')).toBe('Authored evidence')
})

Deno.test('portal translations change visible copy without translating identity, routes or policy', () => {
  const config = TenantConfigSchema.parse({
    slug: 'original',
    accessMode: 'restricted',
    hostname: 'original.example.org',
    branding: {
      productName: '研究',
      organisation: '研究',
      tagline: '研究',
      colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
      logoUrl: '/original/logo.svg',
      fonts: { sans: 'original', display: 'original' },
      layout: {
        nav: { links: [{ label: '研究', href: '/original' }] },
        home: {
          hero: { heading: '研究', questions: ['研究'] },
          sections: [{ kind: 'resources', heading: '研究', resourceIds: ['original'] }],
        },
      },
    },
    searchPlaceholder: '研究',
    topics: [{ id: 'original', label: '研究', description: '研究' }],
    suggestedQuestions: [{ id: 'original', text: '研究' }],
    copy: {
      defaultResourceLabel: '研究',
      interfaceMessages: { ja: { Graph: '研究' } },
    },
    entityTypes: [{ id: 'original', label: 'original', colour: '#123456' }],
    relationTypes: ['original'],
    accessibility: {
      sections: [{ heading: '研究', paragraphs: ['研究'] }],
      contact: {
        name: '研究',
        email: 'original@example.org',
        url: 'https://original.example.org',
        note: '研究',
      },
    },
    languagePolicy: {
      defaultLanguage: 'ja',
      availableLanguages: ['ja', 'en'],
      translations: {
        en: {
          '研究': 'Research',
          original: 'redirected',
          restricted: 'public',
          'original.example.org': 'other.example.org',
          '/original': '/other',
          '/original/logo.svg': '/other/logo.svg',
          '#123456': '#abcdef',
          'original@example.org': 'other@example.org',
          'https://original.example.org': 'https://other.example.org',
        },
      },
    },
  })
  const translated = localisePortalConfig(config, 'en')
  expect(translated.branding.productName).toBe('Research')
  expect(translated.branding.layout?.nav?.links?.[0]).toEqual({
    label: 'Research',
    href: '/original',
  })
  expect(translated.branding.layout?.home?.hero?.questions).toEqual(['Research'])
  expect(translated.topics[0]).toEqual({
    id: 'original',
    label: 'Research',
    description: 'Research',
  })
  expect(translated.suggestedQuestions[0]).toEqual({ id: 'original', text: 'Research' })
  expect(translated.slug).toBe(config.slug)
  expect(translated.accessMode).toBe(config.accessMode)
  expect(translated.hostname).toBe(config.hostname)
  expect(translated.branding.logoUrl).toBe(config.branding.logoUrl)
  expect(translated.branding.fonts).toEqual(config.branding.fonts)
  expect(translated.branding.colours).toEqual(config.branding.colours)
  expect(translated.entityTypes).toEqual(config.entityTypes)
  expect(translated.relationTypes).toEqual(config.relationTypes)
  expect(translated.branding.layout?.home?.sections?.[0]).toMatchObject({
    resourceIds: ['original'],
  })
  expect(translated.languagePolicy).toEqual(config.languagePolicy)
  // The statement's words translate; where it points readers does not.
  expect(translated.accessibility).toEqual({
    sections: [{ heading: 'Research', paragraphs: ['Research'] }],
    contact: {
      name: 'Research',
      email: 'original@example.org',
      url: 'https://original.example.org',
      note: 'Research',
    },
  })
  expect(translated.copy?.defaultResourceLabel).toBe('Research')
  expect(translated.copy?.interfaceMessages).toEqual(config.copy?.interfaceMessages)
  expect(localisePortalConfig(config, 'ja')).toBe(config)
})
