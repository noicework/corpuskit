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
 * The portal whose alias host served this page, or '' on every other host. The server fills the
 * shell's marker for each response; an unfilled marker is not a portal slug and reads as ''.
 */
export function runtimeHostPortal(): string {
  const value = globalThis.document?.querySelector<HTMLMetaElement>(
    'meta[name="corpuskit-host-portal"]',
  )?.content ?? ''
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : ''
}

/**
 * Production portal navigation crosses origins only when the tenant declares
 * a working hostname inside this deployment's platform domain. Tenants without
 * one, hostnames belonging to another deployment, plus local and preview
 * environments, retain relative routes so every portal remains reachable.
 *
 * A portal's alias host serves that portal alone, so there its own links stay on
 * the host and a link to any other portal goes to that portal's canonical
 * hostname, or to the platform domain when it has none.
 */
export function portalHref(
  slug: string,
  options: {
    hostname?: string
    suffix?: string
    currentHostname?: string
    platformDomain?: string
    hostPortal?: string
  } = {},
): string {
  const suffix = options.suffix ?? ''
  const route = `/t/${encodeURIComponent(slug)}${suffix}`
  const currentHostname = options.currentHostname ?? globalThis.location?.hostname ?? ''
  const portalHostname = options.hostname?.toLowerCase()
  const platformDomain = options.platformDomain ?? runtimePlatformDomain()
  const hostPortal = options.hostPortal ?? runtimeHostPortal()
  if (hostPortal) {
    if (slug === hostPortal) return route
    const target = portalHostname && validPlatformDomain(portalHostname)
      ? portalHostname
      : validPlatformDomain(platformDomain)
      ? platformDomain
      : ''
    return target ? `https://${target}${route}` : route
  }
  if (
    !portalHostname || !validPlatformDomain(portalHostname) ||
    !isPlatformHostname(portalHostname, platformDomain) ||
    !isPlatformHostname(currentHostname.toLowerCase(), platformDomain)
  ) return route
  return portalHostname === currentHostname.toLowerCase()
    ? route
    : `https://${portalHostname}${route}`
}
