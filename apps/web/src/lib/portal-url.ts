import {
  isPlatformHostname,
  validPlatformDomain,
} from '../../../../packages/core/src/platform-domain.ts'

/** The server supplies this value for each HTML response, before the bundle runs. */
export function runtimePlatformDomain(): string {
  return globalThis.document?.querySelector<HTMLMetaElement>(
    'meta[name="corpuskit-platform-domain"]',
  )?.content ?? ''
}

/**
 * Production portal navigation crosses origins only when the tenant declares
 * a working hostname inside this deployment's platform domain. Tenants without
 * one, hostnames belonging to another deployment, plus local and preview
 * environments, retain relative routes so every portal remains reachable.
 */
export function portalHref(
  slug: string,
  options: {
    hostname?: string
    suffix?: string
    currentHostname?: string
    platformDomain?: string
  } = {},
): string {
  const suffix = options.suffix ?? ''
  const route = `/t/${encodeURIComponent(slug)}${suffix}`
  const currentHostname = options.currentHostname ?? globalThis.location?.hostname ?? ''
  const portalHostname = options.hostname?.toLowerCase()
  const platformDomain = options.platformDomain ?? runtimePlatformDomain()
  if (
    !portalHostname || !validPlatformDomain(portalHostname) ||
    !isPlatformHostname(portalHostname, platformDomain) ||
    !isPlatformHostname(currentHostname.toLowerCase(), platformDomain)
  ) return route
  return portalHostname === currentHostname.toLowerCase()
    ? route
    : `https://${portalHostname}${route}`
}
