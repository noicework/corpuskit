import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  type PortalLayout,
  type ResourceSummary,
  type TenantConfig,
  TenantConfigSchema,
} from '@research-portal/core'
import { cardColumns, HomePage } from './PortalHome.tsx'
import { EXTERNAL_LINK_NOTE } from '../components/LayoutLink.tsx'

const base: TenantConfig = TenantConfigSchema.parse({
  slug: 'example',
  branding: {
    productName: 'Example Portal',
    organisation: 'Example User Group',
    tagline: 'Talks and slides from the community',
    colours: { primary: '#123456', accent: '#345678', heroFrom: '#123456', heroTo: '#234567' },
  },
  searchPlaceholder: 'Search the portal',
  topics: [{ id: 'upgrades', label: 'Upgrades' }],
  suggestedQuestions: [{ id: 'q1', text: 'A suggested question?' }],
  entityTypes: [],
  relationTypes: [],
})

const resource = (id: string, title: string, extra: Partial<ResourceSummary> = {}) => ({
  id,
  title,
  summary: `${title} in brief.`,
  type: 'document' as const,
  topicIds: [],
  keyFacts: [],
  ...extra,
})

const image = (asset: string, alt = '') => ({
  asset,
  alt,
  url: `/api/t/example/branding/image/${asset}?v=1`,
})

const home: NonNullable<PortalLayout['home']> = {
  hero: {
    heading: 'Every talk from the community',
    body: 'Search the talks, or ask.',
    image: image('hero-photo', 'A full room'),
    questions: ['Which talks cover upgrades?', 'What changed last year?'],
  },
  sections: [
    {
      kind: 'cards',
      heading: 'Start here',
      intro: 'Pick a way in.',
      cards: [
        { title: 'Browse talks', href: '/library', image: image('talks', 'A stage') },
        { title: 'Meetups', body: 'What is on.', href: 'https://example.org/meetups' },
      ],
    },
    {
      kind: 'resources',
      heading: 'Featured',
      resourceIds: ['res-1', 'res-hidden', 'res-gone', 'res-2'],
      moreHref: '/library',
    },
    { kind: 'questions', heading: 'Ask about', questions: ['How do I begin?', 'Who runs it?'] },
    { kind: 'recent', heading: 'Just added', limit: 1 },
    {
      kind: 'about',
      heading: 'About <the> group',
      body: 'We meet monthly.\n\nAnyone can join.',
      image: image('group', 'Members at a meetup'),
      links: [{ label: 'Join', href: 'https://example.org/join' }],
    },
    { kind: 'topics' },
  ],
}

/**
 * The page as the server renders it, over a cache already holding what each query would fetch:
 * no request is made, and `res-gone` has failed the way a deleted or hidden resource does.
 */
async function render(config: TenantConfig): Promise<string> {
  const client = new QueryClient()
  await client.prefetchQuery({
    queryKey: ['layout-resource', 'example', 'res-gone'],
    queryFn: () => Promise.reject(new Error('not_found')),
    retry: false,
  })
  client.setQueryData(['layout-resource', 'example', 'res-1'], resource('res-1', 'First talk'))
  client.setQueryData(['layout-resource', 'example', 'res-2'], resource('res-2', 'Second talk'))
  client.setQueryData(
    ['layout-resource', 'example', 'res-hidden'],
    resource('res-hidden', 'A hidden draft', { hidden: true }),
  )
  client.setQueryData(['recent-documents', 'example'], {
    total: 2,
    items: [
      { id: 'new-1', title: 'Newest talk', status: 'processed', topicIds: [] },
      { id: 'new-2', title: 'Older talk', status: 'processed', topicIds: [] },
    ],
  })
  client.setQueryData(['topic-facets', 'example'], { topic: { upgrades: 1 } })
  client.setQueryData(['topic-resources', 'example', 'upgrades'], [
    resource('topic-1', 'A talk on upgrades'),
  ])
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/t/example']}>
        <Routes>
          <Route path='/t/:slug' element={<Outlet context={{ config }} />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const withLayout = (layout: PortalLayout): TenantConfig => ({
  ...base,
  branding: { ...base.branding, layout },
})

describe('portal home', () => {
  it('renders Explore unchanged when the layout sets no home', async () => {
    const plain = await render(base)
    expect(plain).toContain('What would you like to explore?')
    expect(plain).toContain('Browse the library')
    expect(plain).toContain('A suggested question?')
    expect(plain).toContain('A talk on upgrades')
    const withChrome = await render(
      withLayout({ nav: { hide: ['graph'] }, footer: { poweredBy: true } }),
    )
    expect(withChrome).toBe(plain)
  })

  it("renders the layout's hero, then every section in its order", async () => {
    const html = await render(withLayout({ home }))
    expect(html).not.toContain('What would you like to explore?')
    expect(html).not.toContain('Browse the library')
    expect(html.match(/<h1/g)?.length).toBe(1)
    expect(html).toContain('Every talk from the community</h1>')
    expect(html).toContain('Search the talks, or ask.')
    // The layout's chips replace the suggested questions.
    expect(html).toContain('Which talks cover upgrades?')
    expect(html).not.toContain('A suggested question?')
    expect(html).toContain('alt="A full room"')
    const order = [
      'Start here',
      'Featured',
      'Ask about',
      'Just added',
      'About &lt;the&gt; group',
      'Upgrades',
    ].map((heading) => html.indexOf(`>${heading}</h2>`))
    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Each composed section is a region named by its own heading.
    expect(html.match(/<section aria-labelledby="home-section-\d+"/g)?.length).toBe(5)
  })

  it('draws cards with their pictures and links, marking the one that leaves the portal', async () => {
    const html = await render(withLayout({ home }))
    expect(html).toContain('href="/t/example/library"')
    expect(html).toContain('Browse talks</h3>')
    expect(html).toContain('alt="A stage"')
    expect(html).toContain('href="https://example.org/meetups" rel="noopener"')
    expect(html).toContain(EXTERNAL_LINK_NOTE)
    // A card without a picture shares the frame, drawn with the brand artwork.
    expect(html).toContain('rp-layout-art')
  })

  it('shows chosen resources in order and leaves out hidden and missing ones', async () => {
    const html = await render(withLayout({ home }))
    expect(html).toContain('First talk')
    expect(html).toContain('Second talk')
    expect(html.indexOf('First talk')).toBeLessThan(html.indexOf('Second talk'))
    expect(html).not.toContain('A hidden draft')
    expect(html).not.toContain('res-gone')
  })

  it('leaves out a featured section when none of its resources can be shown', async () => {
    const html = await render(withLayout({
      home: {
        sections: [{ kind: 'resources', heading: 'Nothing left', resourceIds: ['res-gone'] }],
      },
    }))
    expect(html).not.toContain('Nothing left')
  })

  it('opens Ask from question cards, and lists the most recent items up to the limit', async () => {
    const html = await render(withLayout({ home }))
    expect(html).toContain('How do I begin?')
    expect(html.match(/<button type="button" class="rp-suggest-card/g)?.length).toBe(2)
    expect(html).toContain('Newest talk')
    expect(html).not.toContain('Older talk')
  })

  it('renders the about passage as plain-text paragraphs with its image and links', async () => {
    const html = await render(withLayout({ home }))
    expect(html).toContain('>We meet monthly.</p>')
    expect(html).toContain('>Anyone can join.</p>')
    expect(html).toContain('alt="Members at a meetup"')
    expect(html).toContain('href="https://example.org/join" rel="noopener"')
    expect(html).not.toContain('<the>')
  })

  it('keeps the topic rows, and no recently added list beside a hero image', async () => {
    const html = await render(withLayout({ home }))
    expect(html).toContain('A talk on upgrades')
    expect(html).not.toContain('Recently added')
  })

  it('leaves out an image the server could not resolve', async () => {
    const html = await render(withLayout({
      home: {
        hero: { image: { asset: 'missing', alt: 'Gone' } },
        sections: [{
          kind: 'cards',
          heading: 'Cards',
          cards: [{ title: 'One', href: '/library', image: { asset: 'missing', alt: 'Gone' } }],
        }],
      },
    }))
    expect(html).not.toContain('alt="Gone"')
    expect(html).not.toContain('rp-layout-art')
    // Without its own heading or image, the hero keeps the built-in heading and recent list.
    expect(html).toContain('What would you like to explore?')
    expect(html).toContain('Recently added')
  })

  it('fills whole rows of cards where the count allows', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(cardColumns))
      .toEqual([2, 2, 3, 4, 3, 3, 4, 4, 3, 4, 4, 3])
  })
})
