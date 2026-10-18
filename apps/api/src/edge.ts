import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'
import { portalHostnameForSlug } from './cloudflare-domains.ts'
import { OFF_PLATFORM_TRANSPORT_SECURITY, transportSecurityFor } from './portal-aliases.ts'

// The same set the API's own middleware sends; here it reaches the app shell,
// static assets and every response the Worker composes itself.
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

export function platformHostnameLocation(
  request: Pick<Request, 'method' | 'url'>,
  domain: string,
): string | null {
  const platformDomain = getPlatformDomain(domain)
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const hostname = url.hostname.toLowerCase()

  if (hostname === `www.${platformDomain}`) {
    return `https://${platformDomain}${url.pathname}${url.search}`
  }

  const suffix = `.${platformDomain}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  if (portalHostnameForSlug(slug, platformDomain) !== hostname || url.pathname !== '/') return null
  return `/t/${slug}${url.search}`
}

export function secureAssetResponse(response: Response, status = response.status): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  const type = headers.get('content-type') ?? ''
  headers.set('cache-control', type.includes('text/html') ? 'no-store' : 'public, max-age=300')
  return new Response(response.body, {
    status,
    statusText: status === response.status ? response.statusText : '',
    headers,
  })
}

export function withSecurityHeaders(response: Response): Response {
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name))
  if (missing.length === 0) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of missing) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function hostTransportSecurity(
  request: Request,
  domain: string | undefined,
  response: Response,
): Response {
  let value = OFF_PLATFORM_TRANSPORT_SECURITY
  try {
    value = transportSecurityFor(
      new URL(request.url).hostname,
      getPlatformDomain(domain),
    )
  } catch {
    // Without a valid platform domain no host is inside it.
  }
  if (response.headers.get('strict-transport-security') === value) return response
  const headers = new Headers(response.headers)
  headers.set('strict-transport-security', value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Marketing About documents are served only on the platform apex, including raw asset URLs. */
export function apexOnlyAbout(url: URL, platformDomain: string): boolean {
  return ['/about', '/about/', '/about.html'].includes(url.pathname) &&
    url.hostname !== platformDomain
}
