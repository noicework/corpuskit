import { expect } from '@std/expect'
import {
  BrandingSchema,
  describeLayoutIssues,
  isLayoutHref,
  LAYOUT_LIMITS,
  layoutHrefTarget,
  layoutImageNames,
  mapLayoutImages,
  type PortalLayout,
  PortalLayoutSchema,
} from './index.ts'

const link = (label: string, href = '/library') => ({ label, href })

const full: PortalLayout = {
  nav: { links: [link('Events', 'https://example.org/events')], hide: ['graph', 'tools'] },
  footer: {
    columns: [{ heading: 'Community', links: [link('Meetups', 'https://example.org/meetups')] }],
    note: 'Example User Group is an independent community.',
    credits: [link('Powered by Example Platform', 'https://example.org/platform')],
    poweredBy: true,
  },
  home: {
    hero: {
      heading: 'Talks and slides from the community',
      body: 'Every recorded session in one place.',
      image: { asset: 'hero-photo', alt: '' },
      questions: ['Which talks cover upgrades?'],
    },
    sections: [
      {
        kind: 'cards',
        heading: 'Start here',
        cards: [
          { title: 'Library', href: '/library', image: { asset: 'card-a', alt: 'A stage' } },
          { title: 'Events', body: 'What is on next.', href: 'https://example.org/events' },
        ],
      },
      { kind: 'resources', heading: 'Featured', resourceIds: ['res-1'], moreHref: '/library' },
      { kind: 'recent', heading: 'Just added', limit: 6 },
      { kind: 'questions', heading: 'Ask about', questions: ['What changed in the last release?'] },
      {
        kind: 'about',
        heading: 'About the group',
        body: 'We meet monthly.\n\nAnyone can join.',
        image: { asset: 'group', alt: 'Members at a meetup' },
        links: [link('Join', 'https://example.org/join')],
      },
      { kind: 'topics' },
    ],
    cardArrows: false,
  },
}

Deno.test('a complete layout validates and round-trips unchanged', () => {
  expect(PortalLayoutSchema.parse(full)).toEqual(full)
})

Deno.test('a layout is optional on branding, and absent changes nothing', () => {
  const branding = {
    productName: 'Example portal',
    organisation: 'Example User Group',
    tagline: 'Research from the community',
    colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
  }
  expect(BrandingSchema.parse(branding)).toEqual(branding)
  expect(BrandingSchema.parse({ ...branding, layout: full }).layout).toEqual(full)
  expect(BrandingSchema.safeParse({ ...branding, layout: { nav: { links: 'x' } } }).success)
    .toBe(false)
})

Deno.test('links accept https addresses and portal paths only', () => {
  for (
    const href of [
      '/',
      '/library',
      '/search?q=soil%20health',
      '/entity/Example',
      '/ask',
      '/library#top',
      'https://example.org',
      'https://example.org/events?year=2026',
      'HTTPS://example.org/',
    ]
  ) expect([href, isLayoutHref(href)]).toEqual([href, true])
  for (
    const href of [
      '',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'http://example.org',
      '//example.org',
      '/\\example.org',
      '\\\\example.org',
      'https://user:secret@example.org',
      'https://',
      'mailto:hello@example.org',
      'library',
      '#top',
      '/../admin',
      '/%2e%2e/admin',
      '/library/../../admin',
      '/ library',
      '/library\n',
      ' https://example.org',
      `/${'a'.repeat(LAYOUT_LIMITS.href)}`,
    ]
  ) expect([href, isLayoutHref(href)]).toEqual([href, false])
})

Deno.test('a link resolves under the portal, or is marked external', () => {
  expect(layoutHrefTarget('/library', 'example')).toEqual({
    external: false,
    to: '/t/example/library',
  })
  expect(layoutHrefTarget('/', 'example')).toEqual({ external: false, to: '/t/example' })
  expect(layoutHrefTarget('/search?q=x', 'example')).toEqual({
    external: false,
    to: '/t/example/search?q=x',
  })
  expect(layoutHrefTarget('https://example.org/a', 'example')).toEqual({
    external: true,
    url: 'https://example.org/a',
  })
  expect(layoutHrefTarget('javascript:alert(1)', 'example')).toBeNull()
})

Deno.test('every list has a maximum count', () => {
  const many = <T>(n: number, item: (i: number) => T) =>
    Array.from({ length: n }, (_, i) => item(i))
  const cases: [string, unknown][] = [
    ['nav.links', { nav: { links: many(LAYOUT_LIMITS.navLinks + 1, (i) => link(`L${i}`)) } }],
    [
      'footer.credits',
      {
        footer: {
          credits: many(LAYOUT_LIMITS.footerCredits + 1, (i) => link(`Credit ${i}`)),
        },
      },
    ],
    [
      'footer.columns',
      {
        footer: {
          columns: many(LAYOUT_LIMITS.footerColumns + 1, (i) => ({
            heading: `C${i}`,
            links: [link('A')],
          })),
        },
      },
    ],
    [
      'footer.columns[0].links',
      {
        footer: {
          columns: [{
            heading: 'C',
            links: many(LAYOUT_LIMITS.footerColumnLinks + 1, (i) => link(`L${i}`)),
          }],
        },
      },
    ],
    [
      'home.hero.questions',
      {
        home: {
          hero: { questions: many(LAYOUT_LIMITS.heroQuestions + 1, (i) => `Q${i}?`) },
          sections: [],
        },
      },
    ],
    ['home.sections', {
      home: { sections: many(LAYOUT_LIMITS.sections + 1, () => ({ kind: 'topics' })) },
    }],
    [
      'home.sections[0].cards',
      {
        home: {
          sections: [{
            kind: 'cards',
            heading: 'Cards',
            cards: many(LAYOUT_LIMITS.cards + 1, (i) => ({ title: `T${i}`, href: '/library' })),
          }],
        },
      },
    ],
    [
      'home.sections[0].resourceIds',
      {
        home: {
          sections: [{
            kind: 'resources',
            heading: 'Featured',
            resourceIds: many(LAYOUT_LIMITS.resources + 1, (i) => `res-${i}`),
          }],
        },
      },
    ],
    [
      'home.sections[0].questions',
      {
        home: {
          sections: [{
            kind: 'questions',
            heading: 'Ask',
            questions: many(LAYOUT_LIMITS.questions + 1, (i) => `Q${i}?`),
          }],
        },
      },
    ],
    [
      'home.sections[0].links',
      {
        home: {
          sections: [{
            kind: 'about',
            heading: 'About',
            body: 'Body',
            links: many(LAYOUT_LIMITS.aboutLinks + 1, (i) => link(`L${i}`)),
          }],
        },
      },
    ],
    [
      'home.sections[0].limit',
      { home: { sections: [{ kind: 'recent', heading: 'New', limit: LAYOUT_LIMITS.recent + 1 }] } },
    ],
  ]
  for (const [path, layout] of cases) {
    const result = PortalLayoutSchema.safeParse(layout)
    expect([path, result.success]).toEqual([path, false])
    if (!result.success) expect(describeLayoutIssues(result.error)).toContain(`layout.${path}:`)
  }
})

Deno.test('strings have maximum lengths and are plain text', () => {
  const tooLong = (n: number) => 'x'.repeat(n + 1)
  for (
    const layout of [
      { nav: { links: [link(tooLong(LAYOUT_LIMITS.linkLabel))] } },
      { nav: { links: [link('   ')] } },
      { nav: { links: [link('Two\nlines')] } },
      { footer: { note: tooLong(LAYOUT_LIMITS.footerNote) } },
      { footer: { note: 'a\u0007bell' } },
      { home: { hero: { heading: tooLong(LAYOUT_LIMITS.heading) }, sections: [] } },
      { home: { hero: { body: tooLong(LAYOUT_LIMITS.heroBody) }, sections: [] } },
      {
        home: {
          sections: [{ kind: 'about', heading: 'About', body: tooLong(LAYOUT_LIMITS.aboutBody) }],
        },
      },
      { home: { hero: { image: { asset: 'Banner', alt: '' } }, sections: [] } },
      {
        home: {
          hero: { image: { asset: 'banner', alt: tooLong(LAYOUT_LIMITS.alt) } },
          sections: [],
        },
      },
      { home: { hero: { image: { asset: 'banner' } }, sections: [] } },
    ]
  ) expect([layout, PortalLayoutSchema.safeParse(layout).success]).toEqual([layout, false])
  // A blank line in a body starts a paragraph, so line breaks are allowed there.
  expect(
    PortalLayoutSchema.safeParse({
      home: { sections: [{ kind: 'about', heading: 'About', body: 'One.\r\n\r\nTwo.' }] },
    }).success,
  ).toBe(true)
})

Deno.test('unknown fields, kinds and built-in items are refused with a readable message', () => {
  const unknownField = PortalLayoutSchema.safeParse({ footer: { colums: [] } })
  expect(unknownField.success).toBe(false)
  if (!unknownField.success) {
    expect(describeLayoutIssues(unknownField.error)).toBe('layout.footer: unknown field "colums".')
  }
  expect(PortalLayoutSchema.safeParse({ home: { sections: [{ kind: 'video' }] } }).success)
    .toBe(false)
  expect(PortalLayoutSchema.safeParse({ nav: { hide: ['library'] } }).success).toBe(false)
  expect(PortalLayoutSchema.safeParse({ nav: { hide: ['ask'] } }).success).toBe(false)
  expect(PortalLayoutSchema.safeParse({ home: {} }).success).toBe(false)
  const badHref = PortalLayoutSchema.safeParse({ nav: { links: [link('Bad', 'javascript:x')] } })
  expect(badHref.success).toBe(false)
  if (!badHref.success) {
    expect(describeLayoutIssues(badHref.error)).toContain('layout.nav.links[0].href: must be an')
  }
})

Deno.test('image references can be listed, replaced and removed', () => {
  expect(layoutImageNames(full).sort()).toEqual(['card-a', 'group', 'hero-photo'])
  const resolved = mapLayoutImages(
    full,
    (image) => image.asset === 'group' ? undefined : { ...image, url: `/x/${image.asset}?v=1` },
  )
  expect(resolved.home?.hero?.image?.url).toBe('/x/hero-photo?v=1')
  const cards = resolved.home?.sections[0]
  expect(cards?.kind === 'cards' && cards.cards[0]?.image?.url).toBe('/x/card-a?v=1')
  const about = resolved.home?.sections[4]
  expect(about?.kind === 'about' && 'image' in about).toBe(false)
  // The original is untouched.
  expect(full.home?.hero?.image?.url).toBeUndefined()
  expect(mapLayoutImages({}, () => undefined)).toEqual({})
})
