const DEFAULT_PLATFORM_DOMAIN = 'corpuskit.org'
/** Placeholder in served HTML that the server replaces with the configured platform domain. */
export const PLATFORM_DOMAIN_MARKER = '__CORPUSKIT_PLATFORM_DOMAIN__'
/**
 * Placeholder the server replaces with the slug of the portal whose alias host served the page,
 * or with nothing on every other host.
 */
export const HOST_PORTAL_MARKER = '__CORPUSKIT_HOST_PORTAL__'
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Validate a hostname before using it in URLs, cookies or HTML configuration. */
export function validPlatformDomain(value: string): boolean {
  return value.length <= 253 && value.includes('.') &&
    !/^[\d.]+$/.test(value) && value.split('.').every((label) => DNS_LABEL.test(label))
}

/** Only an absent setting uses the default; malformed explicit settings fail closed. */
export function getPlatformDomain(value?: string): string {
  const domain = value === undefined ? DEFAULT_PLATFORM_DOMAIN : value.trim().toLowerCase()
  if (!validPlatformDomain(domain)) throw new Error('Invalid PLATFORM_DOMAIN')
  return domain
}

export function isPlatformHostname(hostname: string, domain: string): boolean {
  return validPlatformDomain(domain) &&
    (hostname === domain || hostname.endsWith(`.${domain}`))
}
