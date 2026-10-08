import { expect } from '@std/expect'
import {
  DEVELOPER_DOCS,
  DOC_PAGES,
  RELEASE_NOTES_PAGE_ID,
} from '../../../packages/core/src/docs.ts'
import {
  isPortalPage,
  llmsTxt,
  portalIndexingMode,
  publicPagePaths,
  robotsTag,
  robotsTxt,
  sitemapXml,
} from './search-files.ts'

Deno.test('the sitemap lists the home page, About and every public documentation page, once', () => {
  const xml = sitemapXml('research.example.org')
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
  const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc!)
  expect(new Set(listed).size).toBe(listed.length)
  expect(listed).toEqual([
    'https://research.example.org/',
    'https://research.example.org/about',
    'https://research.example.org/docs',
    ...DOC_PAGES.map((page) => `https://research.example.org/docs/${page.id}`),
    ...DEVELOPER_DOCS.map((doc) => `https://research.example.org/docs/${doc.id}`),
    `https://research.example.org/docs/${RELEASE_NOTES_PAGE_ID}`,
  ])
  expect(publicPagePaths()).toEqual(listed.map((url) => new URL(url).pathname))
})

Deno.test('llms.txt describes the project and links every page the sitemap lists', () => {
  const text = llmsTxt('research.example.org')
  const lines = text.split('\n')
  expect(lines[0]).toBe('# CorpusKit')
  expect(lines[2]).toMatch(
    /^> CorpusKit, the open source research portal for Progress Agentic RAG\. /,
  )
  expect(text.endsWith('\n')).toBe(true)
  // Every link line is `- [title](absolute URL): summary`.
  const links = lines.filter((line) => line.startsWith('- '))
  for (const line of links) expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\): \S/)
  const urls = links.map((line) => line.match(/\]\(([^)]+)\)/)![1]!)
  expect(new Set(urls).size).toBe(urls.length)
  // The sitemap's pages, except the documentation index, which the guides stand in for.
  for (const path of publicPagePaths().filter((path) => path !== '/docs')) {
    expect(urls).toContain(`https://research.example.org${path}`)
  }
  expect(urls).toContain('https://github.com/noicework/corpuskit')
  for (const doc of DEVELOPER_DOCS) {
    expect(text).toContain(
      `- [${doc.title}](https://research.example.org/docs/${doc.id}): ${doc.summary}`,
    )
  }
  expect(text).toContain('\n## Developer guides\n')
  expect(text).toContain('\n## User guides\n')
  expect(text).not.toMatch(/[\u2013\u2014]/)
})

Deno.test('robots.txt keeps crawlers to pages, and only the apex names the sitemap', () => {
  const apex = robotsTxt('research.example.org', 'research.example.org')
  for (const rule of ['User-agent: *', 'Disallow: /api/', 'Disallow: /auth/', 'Disallow: /admin']) {
    expect(apex).toContain(`${rule}\n`)
  }
  expect(apex).toContain('\nSitemap: https://research.example.org/sitemap.xml\n')
  for (const host of ['marine.research.example.org', 'research.partner.example']) {
    const portal = robotsTxt('research.example.org', host)
    expect(portal).toContain('User-agent: *\n')
    expect(portal).not.toContain('Sitemap:')
  }
  // No rule closes a page the sitemap lists.
  const closed = [...apex.matchAll(/^Disallow: (\S+)$/gm)].map(([, path]) => path!)
  for (const path of publicPagePaths()) {
    for (const prefix of closed) expect(path.startsWith(prefix)).toBe(false)
  }
})

Deno.test('PORTAL_INDEXING allows portal indexing by default, and a mistyped value denies it', () => {
  for (const value of [undefined, '', ' ', 'allow', 'ALLOW', ' Allow ']) {
    expect([value, portalIndexingMode(value)]).toEqual([value, 'allow'])
  }
  for (const value of ['deny', 'DENY', ' deny ', 'no', 'false', 'denied']) {
    expect([value, portalIndexingMode(value)]).toEqual([value, 'deny'])
  }
})

Deno.test('a portal page is anything off the platform apex, or a /t/ page on it', () => {
  const domain = 'research.example.org'
  expect(isPortalPage(domain, 'marine.research.example.org', '/')).toBe(true)
  expect(isPortalPage(domain, 'research.partner.example', '/t/marine')).toBe(true)
  expect(isPortalPage(domain, 'research.example.org', '/t/marine/library')).toBe(true)
  expect(isPortalPage(domain, 'Research.Example.org', '/t/marine')).toBe(true)
  for (const path of ['/', '/about', '/docs', '/docs/search', '/robots.txt', '/og/corpuskit.png']) {
    expect([path, isPortalPage(domain, 'research.example.org', path)]).toEqual([path, false])
  }
})

Deno.test('with PORTAL_INDEXING=deny, portal hosts disallow everything and portal pages are noindex', () => {
  const domain = 'research.example.org'
  for (const host of ['marine.research.example.org', 'research.partner.example']) {
    expect(robotsTxt(domain, host, 'deny')).toBe(
      '# CorpusKit portal. This deployment keeps its portals out of search.\n' +
        'User-agent: *\nDisallow: /\n',
    )
    expect(robotTagOf(host, '/t/marine', 'deny')).toBe('noindex')
    // The default keeps today's rules and no tag.
    expect(robotsTxt(domain, host)).toContain('Disallow: /api/\n')
    expect(robotsTxt(domain, host)).not.toContain('Disallow: /\n')
    expect(robotTagOf(host, '/t/marine', undefined)).toBeNull()
  }
  // The apex keeps its rules and sitemap, and its own pages stay indexable; its portal pages do not.
  expect(robotsTxt(domain, domain, 'deny')).toBe(robotsTxt(domain, domain))
  expect(robotsTxt(domain, domain, 'deny')).toContain(
    'Sitemap: https://research.example.org/sitemap.xml',
  )
  for (const path of ['/', '/about', '/docs', '/docs/search']) {
    expect([path, robotTagOf(domain, path, 'deny')]).toEqual([path, null])
  }
  expect(robotTagOf(domain, '/t/marine', 'deny')).toBe('noindex')

  function robotTagOf(host: string, path: string, indexing: string | undefined) {
    return robotsTag(domain, host, path, indexing)
  }
})
