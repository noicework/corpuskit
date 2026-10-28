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
  it('puts nothing on the page of its own, whatever the setting', () => {
    for (const demoTour of ['off', 'request', 'auto'] as const) {
      const html = render({ ...base, demoTour })
      expect(html).not.toContain('data-demo-tour')
      expect(html).not.toContain('Take the tour')
      expect(html).not.toContain('Welcome to Example Portal')
    }
  })
})
