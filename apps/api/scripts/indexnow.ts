/**
 * Tells Bing and the other IndexNow search engines (https://www.indexnow.org) which pages a
 * deployment's platform apex serves, so new and changed pages are crawled within days. Run it after
 * a deploy that adds or changes the home page, About or the documentation:
 *
 *   INDEXNOW_KEY=<key> deno task indexnow [platform domain] [--dry-run]
 *
 * The domain defaults to corpuskit.org. It reads the live sitemap, so it sends only what the
 * deployment serves, and first checks the apex answers the key file (`INDEXNOW_KEY` set on the
 * Worker, docs/HOSTING.md "Search engines"), since the search engines fetch it to confirm the list.
 * A 200 or 202 means the list was received.
 */
import { indexNowKey } from '../src/search-files.ts'

export const ENDPOINT = 'https://api.indexnow.org/indexnow'

/** The page URLs a sitemap lists, in its order. */
export const sitemapUrls = (xml: string) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc!.trim())

/** The JSON body IndexNow takes for a list of URLs on one host. */
export function submission(domain: string, key: string, urls: readonly string[]) {
  const foreign = urls.filter((url) => new URL(url).host !== domain)
  if (foreign.length) throw new Error(`Not on ${domain}: ${foreign.join(', ')}`)
  return { host: domain, key, keyLocation: `https://${domain}/${key}.txt`, urlList: [...urls] }
}

if (import.meta.main) {
  const dryRun = Deno.args.includes('--dry-run')
  const domain = Deno.args.find((arg) => !arg.startsWith('--')) ?? 'corpuskit.org'
  const key = indexNowKey(Deno.env.get('INDEXNOW_KEY'))
  if (!key) throw new Error('Set INDEXNOW_KEY to the key the deployment serves.')
  const sitemap = await fetch(`https://${domain}/sitemap.xml`)
  if (!sitemap.ok) throw new Error(`sitemap.xml answered ${sitemap.status}`)
  const body = submission(domain, key, sitemapUrls(await sitemap.text()))
  const keyFile = await fetch(body.keyLocation)
  if (!keyFile.ok || (await keyFile.text()).trim() !== key) {
    throw new Error(`${body.keyLocation} does not serve the key: set INDEXNOW_KEY on the Worker`)
  }
  if (dryRun) {
    console.log(JSON.stringify({ ...body, key: '(set)' }, null, 2))
  } else {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    await response.body?.cancel()
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`IndexNow answered ${response.status}`)
    }
    console.log(`IndexNow received ${body.urlList.length} pages (${response.status}).`)
  }
}
