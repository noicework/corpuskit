import { expect } from '@std/expect'
import { TenantConfigSchema } from '@research-portal/core'
import { localisePortalConfig } from './portal-locale.tsx'

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
    entityTypes: [{ id: 'original', label: 'original', colour: '#123456' }],
    relationTypes: ['original'],
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
  expect(localisePortalConfig(config, 'ja')).toBe(config)
})
