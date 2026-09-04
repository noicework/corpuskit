const TENANT_ROUTE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['assistant', 'ask'],
])

/**
 * Resolve the permanent redirect for a renamed public tenant route.
 *
 * Cloudflare applies every configured route alias at the edge; the API server
 * applies the same table so a development server behaves identically.
 */
export function tenantAliasLocation(request: Pick<Request, 'method' | 'url'>): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null

  const url = new URL(request.url)
  const route = /^\/t\/[^/]+\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1]
  const canonicalRoute = route ? TENANT_ROUTE_ALIASES.get(route) : undefined
  if (!canonicalRoute) return null

  url.pathname = url.pathname.replace(/^\/t\/([^/]+)\/[^/]+/, `/t/$1/${canonicalRoute}`)
  return `${url.pathname}${url.search}`
}
