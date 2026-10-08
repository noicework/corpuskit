import {
  DEVELOPER_DOCS,
  DOC_PAGES,
  RELEASE_NOTES_PAGE_ID,
} from '../../../packages/core/src/docs.ts'
import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'

/**
 * The files search engines and AI assistants read first: robots.txt on every host, and on the
 * platform apex a sitemap of the pages there (the home page, About and the public documentation)
 * and llms.txt, a plain-text guide to the same pages. They are built from the platform domain and
 * the documentation's own page lists, so a deployment on any domain lists its own pages, and a new
 * documentation page is listed without anyone editing a file. Portal pages are left out: each
 * portal decides its own audience.
 */

/** The platform apex's indexed pages, in sitemap order. */
export function publicPagePaths(): string[] {
  return [
    '/',
    '/about',
    '/docs',
    ...DOC_PAGES.map((page) => `/docs/${page.id}`),
    ...DEVELOPER_DOCS.map((doc) => `/docs/${doc.id}`),
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

/** The project's one-line description, as the home page and About give it. */
export const PROJECT_DESCRIPTOR =
  'CorpusKit, the open source research portal for Progress Agentic RAG'

const REPOSITORY = 'https://github.com/noicework/corpuskit'

/**
 * llms.txt for the platform apex (https://llmstxt.org): what CorpusKit is, then a link and a
 * one-line summary for each public page, so an AI assistant can find the right page to read.
 */
export function llmsTxt(domain: string): string {
  const site = `https://${getPlatformDomain(domain)}`
  const link = (title: string, url: string, summary: string) => `- [${title}](${url}): ${summary}`
  return [
    '# CorpusKit',
    '',
    `> ${PROJECT_DESCRIPTOR}. It turns a collection of reports, papers and other documents into ` +
    'a portal where people search, ask questions with cited answers checked against their ' +
    'sources, and follow connections between sources. Open source under Apache 2.0, maintained ' +
    'by Noice.',
    '',
    '## Project',
    '',
    link('Home', `${site}/`, 'What CorpusKit is, what a portal looks like and how to run one.'),
    link(
      'About',
      `${site}/about`,
      'Every feature, what a deployment needs, and frequently asked questions.',
    ),
    link('Source code', REPOSITORY, 'The repository, under the Apache 2.0 licence.'),
    link(
      'Release notes',
      `${site}/docs/${RELEASE_NOTES_PAGE_ID}`,
      'What changed in each release, and what to check before upgrading.',
    ),
    '',
    '## Developer guides',
    '',
    ...DEVELOPER_DOCS.map((doc) => link(doc.title, `${site}/docs/${doc.id}`, doc.summary)),
    '',
    '## User guides',
    '',
    ...DOC_PAGES.map((page) => link(page.title, `${site}/docs/${page.id}`, page.summary)),
    '',
    '## Optional',
    '',
    link('CorpusKit Cloud', 'https://corpuskit.cloud/', 'CorpusKit hosted and supported by Noice.'),
    '',
  ].join('\n')
}
