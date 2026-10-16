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
