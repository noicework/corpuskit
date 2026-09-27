import { DOC_PAGES, RELEASE_NOTES_PAGE_ID } from '../../../packages/core/src/docs.ts'
import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'

/**
 * The files search engines read first: robots.txt on every host, and on the platform apex a
 * sitemap of the pages there (the home page, About and the public documentation). They are built
 * from the platform domain and the documentation's own page list, so a deployment on any domain
 * lists its own pages, and a new documentation page is listed without anyone editing a file.
 * Portal pages are left out: each portal decides its own audience.
 */

/** The platform apex's indexed pages, in sitemap order. */
export function publicPagePaths(): string[] {
  return [
    '/',
    '/about',
    '/docs',
    ...DOC_PAGES.map((page) => `/docs/${page.id}`),
    `/docs/${RELEASE_NOTES_PAGE_ID}`,
  ]
}

/**
 * robots.txt. Research content is open to crawlers; the API, sign-in and administration are not
 * pages. Only the platform apex names the sitemap, since only the apex serves it.
 */
export function robotsTxt(domain: string, hostname: string): string {
  const platform = getPlatformDomain(domain)
  const lines = [
    '# CorpusKit. Research content is open to crawlers; the API, sign-in and administration',
    '# surfaces are not pages.',
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /admin',
  ]
  if (hostname.toLowerCase() === platform) {
    lines.push('', `Sitemap: https://${platform}/sitemap.xml`)
  }
  return `${lines.join('\n')}\n`
}

/** sitemap.xml for the platform apex. */
export function sitemapXml(domain: string): string {
  const platform = getPlatformDomain(domain)
  const urls = publicPagePaths().map((path) =>
    `  <url>\n    <loc>https://${platform}${path}</loc>\n  </url>`
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
