import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export class UnsafeUrlError extends Error {
  constructor() {
    super('The address is not a public HTTP or HTTPS URL.')
  }
}

/** Reject non-global addresses, including mapped IPv4 and transition IPv6 ranges. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19))
  }
  // Global unicast only. This also refuses mapped, compatible, NAT64 and local addresses.
  const [prefix, subnet] = ip.split(':')
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/.test(ip) &&
    !(prefix === '2001' && (parseInt(subnet || '0', 16) < 0x200 || subnet === 'db8')) &&
    !ip.startsWith('2002:')
}

export function publicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError()
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    !host || host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host) ||
    (isIP(host.replace(/^\[|\]$/g, '')) ? !isPublicAddress(host) : !host.includes('.'))
  ) throw new UnsafeUrlError()
  url.hash = ''
  return url
}

export type HostResolver = (host: string) => Promise<string[]>
export const resolvePublicHost: HostResolver = async (host) => {
  const results = await Promise.allSettled([resolve4(host), resolve6(host)])
  const addresses: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') addresses.push(...result.value)
    else if (!['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) throw new UnsafeUrlError()
  }
  return addresses
}

export interface PublicHttpOptions {
  resolve?: HostResolver
  fetch?: typeof fetch
  intervalMs?: number
  timeoutMs?: number
}

/** One shared host limiter per runtime, including redirects and HEAD fallback requests. */
export class PublicHttpClient {
  private readonly next = new Map<string, number>()
  constructor(private readonly options: PublicHttpOptions = {}) {}

  async request(raw: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    ])
    let url = publicHttpUrl(raw)
    for (let redirects = 0;; redirects++) {
      signal.throwIfAborted()
      const host = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '')
      const lookup = isIP(host)
        ? Promise.resolve([host])
        : (this.options.resolve ?? resolvePublicHost)(host)
      // DNS and rate waiting belong to the same deadline as the HTTP request.
      const addresses = await new Promise<string[]>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        lookup.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
      if (!addresses.length || addresses.some((ip) => !isPublicAddress(ip))) {
        throw new UnsafeUrlError()
      }
      const now = Date.now()
      const at = Math.max(now, this.next.get(host) ?? 0)
      this.next.set(host, at + (this.options.intervalMs ?? 500))
      if (this.next.size > 2048) {
        for (const [key, until] of this.next) if (until < now) this.next.delete(key)
      }
      if (at > now) await delay(at - now, undefined, { signal })
      const response = await (this.options.fetch ?? globalThis.fetch)(url.href, {
        ...init,
        signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'user-agent': 'research-portal-link-health/1.0', ...init.headers },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || redirects >= 3) throw new UnsafeUrlError()
      url = publicHttpUrl(new URL(location, url).href)
    }
  }
}

export const publicHttp = new PublicHttpClient()
