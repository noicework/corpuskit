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
 * `PORTAL_INDEXING`: `allow` (the default) lets search engines index portal pages as before;
 * `deny` keeps every portal out of search while the platform apex (home, About, documentation)
 * stays indexable. Only an absent, empty or `allow` value (any case) allows it, so a mistyped
 * value keeps portals out.
 */
export function portalIndexingMode(value: string | undefined): 'allow' | 'deny' {
  const setting = value?.trim().toLowerCase()
  return setting === undefined || setting === '' || setting === 'allow' ? 'allow' : 'deny'
}

/** A portal's page: anything on a host other than the platform apex, or `/t/...` on the apex. */
export function isPortalPage(domain: string, hostname: string, pathname: string): boolean {
  return hostname.toLowerCase() !== getPlatformDomain(domain) || pathname.startsWith('/t/')
}

/**
 * The `X-Robots-Tag` a page response carries: `noindex` on a portal's page when
 * `PORTAL_INDEXING=deny`, and none otherwise.
 */
export function robotsTag(
  domain: string,
  hostname: string,
  pathname: string,
  indexing: string | undefined,
): string | null {
  return portalIndexingMode(indexing) === 'deny' && isPortalPage(domain, hostname, pathname)
    ? 'noindex'
    : null
}

/**
 * robots.txt. Research content is open to crawlers; the API, sign-in and administration are not
 * pages. Only the platform apex names the sitemap, since only the apex serves it. With
 * `PORTAL_INDEXING=deny`, every other host (a portal's subdomain or its own hostname) asks
 * crawlers to stay out altogether.
 */
export function robotsTxt(domain: string, hostname: string, indexing?: string): string {
  const platform = getPlatformDomain(domain)
  if (hostname.toLowerCase() !== platform && portalIndexingMode(indexing) === 'deny') {
    return '# CorpusKit portal. This deployment keeps its portals out of search.\n' +
      'User-agent: *\nDisallow: /\n'
  }
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
