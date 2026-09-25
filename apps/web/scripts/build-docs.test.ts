import { expect } from '@std/expect'
import { DOC_CATEGORIES, DOC_PAGES, docPagesByCategory } from '../../../packages/core/src/docs.ts'
import { buildDocs, renderDocsPage } from './build-docs.ts'
import { escapeHtml } from './docs-markdown.ts'

const template = await Deno.readTextFile(new URL('../public/about.html', import.meta.url))
const home = await Deno.readTextFile(new URL('../public/home.html', import.meta.url))

Deno.test('About and documentation match every homepage container width and gutter', () => {
  const widths = (html: string) => [...html.matchAll(/--page:\s*([^;]+);/g)].map((m) => m[1])
  expect(widths(template)).toEqual(widths(home))
  expect(widths(renderDocsPage(template))).toEqual(widths(home))
})

Deno.test('documentation overview follows the shared category and page order', () => {
  const html = renderDocsPage(template)
  const overview = html.slice(html.indexOf('<div class="docs-categories">'))
  let position = 0
  for (const group of docPagesByCategory()) {
    expect(DOC_CATEGORIES).toContain(group.category)
    const next = overview.indexOf(`<h2>${group.category}</h2>`)
    expect(next).toBeGreaterThan(position)
    position = next
    for (const page of group.pages) {
      const next = overview.indexOf(`href="/docs/${page.id}"`, position)
      expect(next).toBeGreaterThan(position)
      position = next
      expect(overview).toContain(escapeHtml(page.summary))
    }
  }
})

Deno.test('every public page has complete content, metadata, anchors, navigation and safe copy', () => {
  const ordered = docPagesByCategory().flatMap((group) => group.pages)
  for (const page of [undefined, ...ordered]) {
    const html = renderDocsPage(template, page)
    expect(html).toContain('<html lang="en-AU">')
    expect(html).toContain('href="https://demo.corpuskit.org"')
    expect(html).toContain('href="/docs" aria-current="page">Docs</a>')
    expect(html).not.toContain('href="/about" aria-current')
    expect(html).toContain(
      `<meta property="og:url" content="https://__CORPUSKIT_PLATFORM_DOMAIN__/docs${
        page ? `/${page.id}` : ''
      }">`,
    )
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).not.toMatch(
      /\u2014|\b(?:CSIRO|GRDC|AIMS|FRDC)\b|(?:marine|grains|opax)\.corpuskit\.org/i,
    )
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const match of html.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(match[1])
    if (!page) continue
    expect(html).toContain(`<meta name="description" content="${escapeHtml(page.summary)}">`)
    expect(html).toContain(`<meta property="og:description" content="${escapeHtml(page.summary)}">`)
    expect(html).toContain(
      `<meta name="twitter:description" content="${escapeHtml(page.summary)}">`,
    )
    expect(html).toContain(`href="/docs/${page.id}" aria-current="page"`)
    expect(html.includes('aria-label="On this page"')).toBe(page.sections.length >= 3)
    for (const section of page.sections) expect(html).toContain(escapeHtml(section.heading))
    const index = ordered.indexOf(page)
    const pagination = html.slice(html.indexOf('<nav class="docs-pagination"'))
    for (const adjacent of [ordered[index - 1], ordered[index + 1]]) {
      expect(pagination).toContain(`href="/docs${adjacent ? `/${adjacent.id}` : ''}"`)
    }
  }
})

Deno.test('build writes exactly the source pages plus landing page and removes stale HTML', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'corpuskit-docs-build-' })
  const output = new URL(`file://${directory}/`)
  try {
    await Deno.writeTextFile(new URL('stale.html', output), 'old')
    expect(await buildDocs(output)).toBe(DOC_PAGES.length + 1)
    const files = []
    for await (const entry of Deno.readDir(output)) files.push(entry.name)
    expect(files.sort()).toEqual(['index.html', ...DOC_PAGES.map((p) => `${p.id}.html`)].sort())
    for (const page of DOC_PAGES) {
      expect(await Deno.readTextFile(new URL(`${page.id}.html`, output))).toBe(
        renderDocsPage(template, page),
      )
    }
  } finally {
    await Deno.remove(output, { recursive: true })
  }
})
