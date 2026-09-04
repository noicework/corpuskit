/**
 * Site discovery for the crawl ingestion flow (app-side; the platform has no
 * crawl API). Given a URL: if it is an XML sitemap, extract <loc> entries
 * (expanding one level of sitemap index); otherwise extract same-origin links
 * from the page, filtering assets, queries and common non-content paths. The
 * admin reviews the discovered list before anything is ingested.
 */

const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|rss|pdf|zip|gz|mp4|mp3|woff2?|ttf|eot)(\?|$)/i
const SKIP_PATHS = /\/(wp-json|cdn-cgi|wp-admin|feed|tag|author)\/|[?#]|(Special|Talk|File):/i

/**
 * One user agent for every outbound page fetch - discovery AND ingestion.
 * These used to differ ('research-portal-crawler/1.0' for discovery, a
 * Mozilla string for ingestion), so a site that allowed one and blocked the
 * other let discovery succeed and then failed every page of the sync, with
 * nothing on screen to explain the contradiction.
 */
export const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; research-portal-ingest/1.0)'

/**
 * A site refusing an automated fetch is the single most common reason a
 * website source cannot be ingested (many public research sites sit behind
 * a bot challenge that answers every server-side request with a 403
 * interstitial). Say so in terms a librarian can act on, rather
 * than leaking a bare status code.
 */
export function describeFetchFailure(status: number, body = ''): string {
  if (status === 401 || status === 403 || looksLikeChallengePage(body)) {
    return `The site refused an automated request (HTTP ${status}). It sits behind a bot ` +
      'challenge, so a server cannot read its pages. Try its sitemap or feed URL, or upload ' +
      'the documents directly.'
  }
  if (status === 404) return 'That address was not found on the site (HTTP 404).'
  if (status === 429) return 'The site is rate-limiting automated requests - try again shortly.'
  if (status >= 500) return `The site is having trouble of its own (HTTP ${status}).`
  return `The site responded with ${status}.`
}

/** A transport-level failure (DNS, TLS, reset, timeout) explained the same way. */
export function describeNetworkFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/timed? ?out|timeout/i.test(message)) {
    return 'The site did not respond in time - it may be slow or blocking automated requests.'
  }
  return 'The site could not be reached. It may be offline, or it may be rejecting ' +
    'automated requests outright.'
}

function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http(s) URLs can be crawled')
  }
  const host = url.hostname
  if (
    host === 'localhost' ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1'
  ) {
    throw new Error('Private and local addresses cannot be crawled')
  }
  return url
}

async function fetchText(url: string): Promise<{ body: string; contentType: string }> {
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': CRAWLER_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    // Deno surfaces a reset/DNS/TLS failure as a bare "fetch failed", which
    // tells an administrator nothing about what to do next.
    throw new Error(describeNetworkFailure(err))
  }
  // A public URL may redirect anywhere - re-validate where we actually landed.
  if (res.url) assertPublicHttpUrl(res.url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(describeFetchFailure(res.status, body))
  }
  return { body: await res.text(), contentType: res.headers.get('content-type') ?? '' }
}

const extractLocs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] ?? '').filter(Boolean)

export async function discoverLinks(
  target: string,
  cap: number,
): Promise<{ source: string; count: number; links: string[] }> {
  const origin = assertPublicHttpUrl(target)
  const { body, contentType } = await fetchText(origin.href)
  const seen = new Set<string>()
  const links: string[] = []
  const push = (raw: string) => {
    if (links.length >= cap) return
    try {
      const url = new URL(raw, origin.href)
      if (url.origin !== origin.origin) return
      if (ASSET_EXT.test(url.pathname) || SKIP_PATHS.test(url.href)) return
      const clean = `${url.origin}${url.pathname}`
      if (seen.has(clean)) return
      seen.add(clean)
      links.push(clean)
    } catch {
      // unparseable href - skip
    }
  }

  const isXml = contentType.includes('xml') || /<(urlset|sitemapindex)[\s>]/i.test(body)
  if (isXml) {
    const locs = extractLocs(body)
    const childSitemaps = locs.filter((l) => /sitemap[^/]*\.xml(\?|$)/i.test(l)).slice(0, 12)
    const pages = locs.filter((l) => !/\.xml(\?|$)/i.test(l))
    pages.forEach(push)
    for (const child of childSitemaps) {
      if (links.length >= cap) break
      try {
        // Child sitemap URLs come from remote content - hold them to the same
        // public-host, same-origin standard as the entry URL.
        const childUrl = assertPublicHttpUrl(child)
        if (childUrl.origin !== origin.origin) continue
        const { body: childBody } = await fetchText(childUrl.href)
        extractLocs(childBody)
          .filter((l) => !/\.xml(\?|$)/i.test(l))
          .forEach(push)
      } catch {
        // unreachable child sitemap - continue with what we have
      }
    }
  } else {
    for (const match of body.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
      push(match[1] ?? '')
    }
  }
  return { source: isXml ? 'sitemap' : 'page', count: links.length, links }
}

// ---------------------------------------------------------------------------
// Main-content extraction and ingestion quality gate. Web pages carry nav,
// footer and cookie chrome that pollutes passage matching, and bot-challenge
// pages must never enter the corpus at all.
// ---------------------------------------------------------------------------

const CHALLENGE_SIGNATURES =
  /(cloudflare|enable javascript and cookies|just a moment|performing security verification|ray id|checking your browser|access denied|error 40[34]|attention required)/i

/** True when extracted text looks like a bot wall or error page, not content. */
export function looksLikeChallengePage(text: string): boolean {
  return CHALLENGE_SIGNATURES.test(text.slice(0, 2500))
}

const STRIP_TAGS =
  /<(script|style|nav|header|footer|aside|form|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi
const STRIP_BY_ROLE =
  /<[^>]+(?:role=["'](?:navigation|banner|contentinfo|search)["']|class=["'][^"']*(?:cookie|breadcrumb|menu|nav-|footer|header|sidebar|social|share|subscribe)[^"']*["'])[^>]*>[\s\S]*?<\/[^>]+>/gi

/**
 * Readability-style main-content extraction: prefer <main>/<article>, strip
 * chrome elements, convert headings and paragraphs to markdown-ish text.
 * Returns null when no meaningful body content survives.
 */
export function extractMainContent(html: string): { title: string; body: string } | null {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const rawTitle = (titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const title = rawTitle.split(/\s*[|\u2013\u2014-]\s+/)[0]?.trim() || rawTitle

  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  let scope = mainMatch?.[1] ?? html
  scope = scope.replace(STRIP_TAGS, ' ')
  scope = scope.replace(STRIP_BY_ROLE, ' ')

  const blocks: string[] = []
  const blockRe = /<(h1|h2|h3|h4|p|li|td|th|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(scope)) !== null) {
    const tag = (match[1] ?? '').toLowerCase()
    const text = (match[2] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 3) continue
    if (tag.startsWith('h')) blocks.push(`\n${'#'.repeat(Number(tag[1]))} ${text}\n`)
    else if (tag === 'li') blocks.push(`- ${text}`)
    else blocks.push(text)
  }
  // Collapse duplicate blocks (repeated nav items that escaped stripping).
  const seen = new Set<string>()
  const unique = blocks.filter((b) => {
    const key = b.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const body = unique.join('\n\n').trim()
  const words = body.split(/\s+/).length
  if (words < 80 || looksLikeChallengePage(body)) return null
  return { title: title || 'Untitled page', body }
}
