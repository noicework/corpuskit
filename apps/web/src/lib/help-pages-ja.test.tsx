import { expect } from '@std/expect'
import { DOC_PAGES } from '@research-portal/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { HELP_PAGES_JA, localiseHelpPage } from './help-pages-ja.ts'
import { createPortalLocale, PortalLocaleContext } from './portal-locale.tsx'
import { HelpArticle } from '../pages/DocsPage.tsx'
import { FLOW_STEPS, FlowDiagram, wrapWords } from '../pages/HowItWorksPage.tsx'

Deno.test('all published app help pages and sections have Japanese copy matching the current source revision', async () => {
  expect(Object.keys(HELP_PAGES_JA).sort()).toEqual(DOC_PAGES.map((page) => page.id).sort())
  for (const page of DOC_PAGES) {
    const translated = HELP_PAGES_JA[page.id]!
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(page)),
    )
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    )
    expect(translated.sourceSha256, `${page.id}: source changed; update the Japanese guide`).toBe(
      hash,
    )
    expect(translated.sections.length).toBe(page.sections.length)
    for (
      const text of [
        translated.title,
        translated.summary,
        ...translated.sections.flatMap((section) => [section.heading, section.body]),
      ]
    ) {
      expect(text).toMatch(/[ぁ-んァ-ン一-龯]/u)
    }
    expect(localiseHelpPage(page, 'en')).toBe(page)
    expect(localiseHelpPage(page, 'ja').id).toBe(page.id)
    expect(localiseHelpPage(page, 'ja').category).toBe(page.category)
  }
})

Deno.test('Japanese help articles retain original links and section anchors while translating actual bodies', () => {
  for (const page of DOC_PAGES) {
    const markup = renderToStaticMarkup(
      <PortalLocaleContext.Provider value={createPortalLocale('ja')}>
        <MemoryRouter>
          <HelpArticle page={page} slug='original' />
        </MemoryRouter>
      </PortalLocaleContext.Provider>,
    )
    for (const section of page.sections) {
      const anchor = section.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      expect(markup).toContain(`id="${anchor}"`)
    }
    expect(markup).toContain(HELP_PAGES_JA[page.id]!.summary)
    expect(markup).not.toContain(page.summary)
  }
  const unknown = {
    id: 'future-guide',
    category: 'Administration',
    title: 'Future original',
    summary: 'Future source',
    sections: [],
  }
  expect(localiseHelpPage(unknown, 'ja')).toBe(unknown)
})

Deno.test('Japanese diagram labels wrap by glyph width without changing English word wrapping', () => {
  const locale = createPortalLocale('ja')
  for (const step of FLOW_STEPS) {
    const text = locale.ui(step.detail)
    expect(text).not.toBe(step.detail)
    for (const [width, maximumLines] of [[22, 4], [34, 3]]) {
      const lines = wrapWords(text, width!)
      expect(lines.length).toBeLessThanOrEqual(maximumLines!)
      expect(lines.join('')).toBe(text)
      for (const line of lines) {
        const units = [...line].reduce(
          (sum, char) => sum + (/[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(char) ? 2 : 1),
          0,
        )
        expect(units).toBeLessThanOrEqual(width!)
      }
    }
  }
  expect(wrapWords('one two three', 7)).toEqual(['one two', 'three'])
  const html = renderToStaticMarkup(
    <PortalLocaleContext.Provider value={locale}>
      <FlowDiagram />
    </PortalLocaleContext.Provider>,
  )
  expect(html).toContain('資料群')
  expect(html).toContain('確認済みの回答')
  expect(html).not.toContain('The collection')
  expect(html).toContain('data-orientation="row"')
  expect(html).toContain('data-orientation="column"')
})

Deno.test('both guide languages retain live counters, configured intent data and navigation actions', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { Outlet, Route, Routes } = await import('react-router-dom')
  const { TenantConfigSchema } = await import('@research-portal/core')
  const { HowItWorksPage } = await import('../pages/HowItWorksPage.tsx')
  const config = TenantConfigSchema.parse({
    slug: 'original',
    branding: {
      productName: 'Original portal',
      organisation: 'Original organisation',
      tagline: 'Original tagline',
      colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
    },
    searchPlaceholder: '',
    topics: [],
    suggestedQuestions: [],
    entityTypes: [],
    relationTypes: [],
    intents: [{
      id: 'original-live-intent',
      label: 'Authored Live Configuration',
      description: 'Authored live configuration description.',
      retrieval: { features: ['keyword'], topK: 4, reranker: 'noop' },
      answer: { surfaces: ['search'], strategy: 'none', promptVariant: 'default' },
    }],
  })
  for (const language of ['ja', 'en'] as const) {
    const client = new QueryClient()
    client.setQueryData(['counters', config.slug], {
      resources: 1234,
      paragraphs: 5678,
      sentences: 9012,
      indexMb: 1,
    })
    const html = renderToStaticMarkup(
      <PortalLocaleContext.Provider value={createPortalLocale(language)}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/t/original/how-it-works']}>
            <Routes>
              <Route element={<Outlet context={{ config }} />}>
                <Route path='/t/:slug/how-it-works' element={<HowItWorksPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </PortalLocaleContext.Provider>,
    )
    for (
      const text of [
        'Authored Live Configuration',
        'Authored live configuration description.',
        '1,234',
        '5,678',
        '9,012',
      ]
    ) expect(html).toContain(text)
    expect(html).toContain('href="/t/original/library"')
    expect(html).toContain('href="/t/original/help/trust-and-citations"')
    expect(html).toContain(
      language === 'ja' ? 'このポータルの検索設定' : 'The configurations on this portal',
    )
    client.clear()
  }
})
