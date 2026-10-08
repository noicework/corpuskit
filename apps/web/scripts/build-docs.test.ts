import { expect } from '@std/expect'
import {
  DEVELOPER_DOCS,
  DOC_CATEGORIES,
  DOC_PAGES,
  docPagesByCategory,
  isPublicDocPageId,
  RELEASE_NOTES_PAGE_ID,
} from '../../../packages/core/src/docs.ts'
import {
  buildDocs,
  developerDocPage,
  docGroups,
  DOCS_SHARE_IMAGE,
  releaseNotesPage,
  renderDocsPage,
  repositoryLink,
} from './build-docs.ts'
import { publicPagePaths } from '../../api/src/search-files.ts'
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
    expect(await buildDocs(output)).toBe(DOC_PAGES.length + DEVELOPER_DOCS.length + 2)
    const files = []
    for await (const entry of Deno.readDir(output)) files.push(entry.name)
    expect(files.sort()).toEqual(
      [
        'index.html',
        `${RELEASE_NOTES_PAGE_ID}.html`,
        ...DOC_PAGES.map((p) => `${p.id}.html`),
        ...DEVELOPER_DOCS.map((doc) => `${doc.id}.html`),
      ].sort(),
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

const decode = (value: string) =>
  value.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&')

Deno.test('every documentation page has its own title, description and canonical URL', () => {
  const seen = { title: new Set<string>(), description: new Set<string>(), canonical: new Set() }
  for (const page of [undefined, ...publicPages]) {
    const html = renderDocsPage(template, page)
    const title = decode(html.match(/<title>([^<]*)<\/title>/)![1]!)
    const description = decode(html.match(/<meta name="description" content="([^"]*)">/)![1]!)
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)![1]!
    expect(title).toBe(page ? `${page.title} - CorpusKit documentation` : 'CorpusKit documentation')
    expect(html).toContain(`<meta property="og:title" content="${escapeHtml(title)}">`)
    for (
      const [key, value] of [['title', title], ['description', description], [
        'canonical',
        canonical,
      ]] as const
    ) {
      expect([key, seen[key].has(value)]).toEqual([key, false])
      seen[key].add(value)
    }
    // Every page shares the documentation card, not About's.
    expect(html).toContain(`<meta property="og:image" content="${DOCS_SHARE_IMAGE}">`)
    expect(html).toContain(`<meta name="twitter:image" content="${DOCS_SHARE_IMAGE}">`)
    expect(html).not.toContain('corpuskit-about.png')
  }
})

Deno.test('documentation JSON-LD parses, describes the page and traces it from the site', () => {
  for (const page of [undefined, ...publicPages]) {
    const html = renderDocsPage(template, page)
    const blocks = [
      ...html.matchAll(
        /<script type="application\/ld\+json" id="structured-data">([\s\S]*?)<\/script>/g,
      ),
    ]
    expect(blocks).toHaveLength(1)
    const data = JSON.parse(blocks[0]![1]!)
    expect(data['@context']).toBe('https://schema.org')
    const graph = data['@graph'] as Record<string, unknown>[]
    const byType = (type: string) => graph.filter((node) => node['@type'] === type)
    const url = `https://__CORPUSKIT_PLATFORM_DOMAIN__/docs${page ? `/${page.id}` : ''}`
    const [main] = byType(page ? 'TechArticle' : 'CollectionPage')
    expect(main!.url).toBe(url)
    if (page) expect([main!.headline, main!.description]).toEqual([page.title, page.summary])
    const [trail] = byType('BreadcrumbList')
    const items = trail!.itemListElement as { position: number; name: string; item: string }[]
    expect(items.map((item) => [item.position, item.name, item.item])).toEqual([
      [1, 'CorpusKit', 'https://__CORPUSKIT_PLATFORM_DOMAIN__/'],
      [2, 'Documentation', 'https://__CORPUSKIT_PLATFORM_DOMAIN__/docs'],
      ...(page ? [[3, page.title, url]] : []),
    ])
    // Every reference inside the graph points at a node in it, and About's FAQ is not repeated.
    const ids = new Set(graph.map((node) => node['@id']))
    for (const [, ref] of JSON.stringify(graph).matchAll(/\{"@id":"([^"]+)"\}/g)) {
      expect(ids.has(ref)).toBe(true)
    }
    expect(byType('FAQPage')).toHaveLength(0)
  }
})

Deno.test('the sitemap lists every page the documentation build writes, once', () => {
  const listed = publicPagePaths().filter((path) => path.startsWith('/docs'))
  const written = ['/docs', ...publicPages.map((page) => `/docs/${page.id}`)]
  expect(listed.length).toBe(new Set(listed).size)
  expect(new Set(listed)).toEqual(new Set(written))
})

Deno.test('developer guides publish the repository docs, between the Help pages and Project', async () => {
  expect(docGroups.map((group) => group.category)).toEqual([
    ...docPagesByCategory().map((group) => group.category),
    'Developers',
    'Project',
  ])
  const developers = docGroups.find((group) => group.category === 'Developers')!.pages
  expect(developers.map((page) => page.id)).toEqual(DEVELOPER_DOCS.map((doc) => doc.id))
  for (const doc of DEVELOPER_DOCS) {
    // Public only: not in-app Help, but routed and listed by the Worker.
    expect(DOC_PAGES.some((page) => page.id === doc.id)).toBe(false)
    expect(isPublicDocPageId(doc.id)).toBe(true)
    const source = await Deno.readTextFile(new URL(`../../../docs/${doc.file}`, import.meta.url))
    const headings = [...source.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading!.trim())
    const page = developers.find((page) => page.id === doc.id)!
    expect(page).toEqual(developerDocPage(doc, source))
    // Every section of the file is on the page, apart from the ones kept in the repository,
    // each of which still exists (so a renamed heading cannot slip onto the public page).
    for (const heading of doc.unpublished ?? []) expect(headings).toContain(heading)
    expect(page.sections.map((section) => section.heading)).toEqual([
      ...(/^# .+\n+(?!## )\S/.test(source) ? ['Overview'] : []),
      ...headings.filter((heading) => !doc.unpublished?.includes(heading)),
    ])
    const html = renderDocsPage(template, page)
    expect(html).toContain(`<h1 id="docs-title">${escapeHtml(doc.title)}</h1>`)
    // Links leave for absolute URLs, site pages or anchors: never a relative repository path.
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      expect([href, /^(?:https:\/\/|mailto:|\/|#)/.test(href!)]).toEqual([href, true])
    }
  }
})

Deno.test('a developer guide links another repository file to its page, or else to GitHub', () => {
  expect(repositoryLink('HOSTING.md#search-engines', 'ARCHITECTURE.md')).toBe(
    '/docs/hosting#search-engines',
  )
  expect(repositoryLink('RBAC.md#break-glass', 'HOSTING.md')).toBe(
    'https://github.com/noicework/corpuskit/blob/main/docs/RBAC.md#break-glass',
  )
  expect(repositoryLink('../CHANGELOG.md', 'HOSTING.md')).toBe(
    'https://github.com/noicework/corpuskit/blob/main/CHANGELOG.md',
  )
  for (const kept of ['#operator-credential', '/docs/search', 'https://llmstxt.org']) {
    expect(repositoryLink(kept, 'HOSTING.md')).toBe(kept)
  }
  const page = developerDocPage(
    { id: 'example', file: 'EXAMPLE.md', title: 'Example', summary: 'An example.' },
    '# Example\n\nIntro with [hosting](HOSTING.md).\n\n## Kept\n\n```\n## not a heading\n```\n',
  )
  expect(page.sections).toEqual([
    { heading: 'Overview', body: 'Intro with [hosting](/docs/hosting).' },
    { heading: 'Kept', body: '```\n## not a heading\n```' },
  ])
})
