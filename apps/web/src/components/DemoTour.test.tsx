import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type TenantConfig, TenantConfigSchema } from '@research-portal/core'
import { HomePage } from '../pages/PortalHome.tsx'

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
  suggestedQuestions: [{ id: 'q1', text: 'Which talks cover upgrades?' }],
  entityTypes: [],
  relationTypes: [],
})

function render(config: TenantConfig): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['demo-tour-pdf', 'example'], { total: 0, items: [] })
  // Explore's topic rows need a document, or their empty state asks for the access context.
  client.setQueryData(['topic-facets', 'example'], { topic: { upgrades: 1 } })
  client.setQueryData(['topic-resources', 'example', 'upgrades'], [{
    id: 'topic-1',
    title: 'A talk on upgrades',
    summary: 'In brief.',
    type: 'document',
    topicIds: ['upgrades'],
    keyFacts: [],
  }])
  client.setQueryData(['recent-documents', 'example'], { total: 0, items: [] })
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

describe('the guided tour on the home page', () => {
  it('is offered only where the portal opts in, on Explore and on a composed home alike', () => {
    expect(render(base)).not.toContain('data-demo-tour-entry')
    expect(render({ ...base, demoTour: 'off' })).not.toContain('data-demo-tour-entry')
    for (const demoTour of ['request', 'auto'] as const) {
      const html = render({ ...base, demoTour })
      expect(html).toContain('data-demo-tour-entry')
      expect(html).toContain('See what this platform does')
      expect(html).toContain('Take the tour')
      // The dialog itself is not on the page until it is opened.
      expect(html).not.toContain('data-demo-tour=')
    }
    const composed: TenantConfig = {
      ...base,
      demoTour: 'request',
      branding: {
        ...base.branding,
        layout: { home: { sections: [{ kind: 'about', heading: 'About', body: 'Us.' }] } },
      },
    }
    const html = render(composed)
    expect(html).toContain('data-demo-tour-entry')
    expect(html.indexOf('data-demo-tour-entry')).toBeLessThan(html.indexOf('About'))
  })

  it("takes the portal's own heading and intro", () => {
    const html = render({
      ...base,
      demoTour: 'request',
      copy: { demoTour: { heading: 'Take the tour of the talks', intro: 'Three scenes.' } },
    })
    expect(html).toContain('Take the tour of the talks')
    expect(html).toContain('Three scenes.')
    expect(html).not.toContain('See what this platform does')
  })
})
