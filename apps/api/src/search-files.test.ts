import { expect } from '@std/expect'
import { DOC_PAGES, RELEASE_NOTES_PAGE_ID } from '../../../packages/core/src/docs.ts'
import { publicPagePaths, robotsTxt, sitemapXml } from './search-files.ts'

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
    `https://research.example.org/docs/${RELEASE_NOTES_PAGE_ID}`,
  ])
  expect(publicPagePaths()).toEqual(listed.map((url) => new URL(url).pathname))
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
