import { expect } from '@std/expect'
import {
  DOC_CATEGORIES,
  DOC_PAGES,
  docPagesByCategory,
  isPublicDocPageId,
  RELEASE_NOTES_PAGE_ID,
} from '../../../packages/core/src/docs.ts'
import { buildDocs, docGroups, releaseNotesPage, renderDocsPage } from './build-docs.ts'
import { parseChangelog, UNRELEASED } from './changelog.ts'
import { escapeHtml } from './docs-markdown.ts'

const template = await Deno.readTextFile(new URL('../public/about.html', import.meta.url))
const home = await Deno.readTextFile(new URL('../public/home.html', import.meta.url))
const changelog = await Deno.readTextFile(new URL('../../../CHANGELOG.md', import.meta.url))
const publicPages = docGroups.flatMap((group) => group.pages)

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
  const ordered = publicPages
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
    expect(await buildDocs(output)).toBe(DOC_PAGES.length + 2)
    const files = []
    for await (const entry of Deno.readDir(output)) files.push(entry.name)
    expect(files.sort()).toEqual(
      ['index.html', `${RELEASE_NOTES_PAGE_ID}.html`, ...DOC_PAGES.map((p) => `${p.id}.html`)]
        .sort(),
    )
    for (const page of publicPages) {
      expect(await Deno.readTextFile(new URL(`${page.id}.html`, output))).toBe(
        renderDocsPage(template, page),
      )
    }
  } finally {
    await Deno.remove(output, { recursive: true })
  }
})

Deno.test('release notes render every dated release, newest first, and link from the docs nav', () => {
  const page = releaseNotesPage(changelog)
  const dated = parseChangelog(changelog).releases.filter((r) => r.version !== UNRELEASED)
  expect(page.id).toBe(RELEASE_NOTES_PAGE_ID)
  expect(publicPages.at(-1)).toEqual(page)
  expect(page.sections.slice(1).map((section) => section.heading)).toEqual(
    dated.map((release) => release.version),
  )
  const html = renderDocsPage(template, page)
  let position = 0
  for (const release of dated) {
    const next = html.indexOf(`id="${release.version.replaceAll('.', '-')}"`)
    expect(next).toBeGreaterThan(position)
    position = next
  }
  expect(html).toContain('Released 27 September 2026.')
  expect(html).toContain('href="https://github.com/noicework/corpuskit/releases"')
  expect(html).toContain('<h3 id="upgrade-notes">Upgrade notes</h3>')
  // Unreleased work stays in the repository.
  expect(html).not.toMatch(/>Unreleased<|pending merge/)
  // Every public page links to it from the navigation, and the Worker routes it.
  for (const other of [undefined, ...DOC_PAGES]) {
    expect(renderDocsPage(template, other)).toContain(`href="/docs/${RELEASE_NOTES_PAGE_ID}"`)
  }
  expect(isPublicDocPageId(RELEASE_NOTES_PAGE_ID)).toBe(true)
  expect(isPublicDocPageId('unknown')).toBe(false)
  expect(docPagesByCategory().flatMap((g) => g.pages)).not.toContainEqual(page)
})
