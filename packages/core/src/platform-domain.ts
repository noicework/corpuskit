const DEFAULT_PLATFORM_DOMAIN = 'corpuskit.org'
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
