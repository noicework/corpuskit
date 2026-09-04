const PLATFORM_DOMAIN = 'corpuskit.org'

function isPlatformHostname(hostname: string): boolean {
  return hostname === PLATFORM_DOMAIN || hostname === `www.${PLATFORM_DOMAIN}` ||
    hostname.endsWith(`.${PLATFORM_DOMAIN}`)
}

/**
 * Production portal navigation crosses origins only when the tenant declares
 * a working hostname. Tenants without one, plus local and preview environments,
 * retain relative routes so every portal remains reachable.
 */
export function portalHref(
  slug: string,
  options: {
    hostname?: string
    suffix?: string
    currentHostname?: string
  } = {},
): string {
  const suffix = options.suffix ?? ''
  const route = `/t/${encodeURIComponent(slug)}${suffix}`
  const currentHostname = options.currentHostname ?? globalThis.location?.hostname ?? ''
  const portalHostname = options.hostname?.toLowerCase()
  if (!portalHostname || !isPlatformHostname(currentHostname.toLowerCase())) return route
  return portalHostname === currentHostname.toLowerCase()
    ? route
    : `https://${portalHostname}${route}`
}
