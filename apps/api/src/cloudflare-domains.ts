import {
  getPlatformDomain,
  validPlatformDomain,
} from '../../../packages/core/src/platform-domain.ts'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const WORKER_SERVICE = 'corpuskit'

const RESERVED_PORTAL_SLUGS = new Set([
  'account',
  'accounts',
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'cdn',
  'dashboard',
  'dns',
  'ftp',
  'help',
  'imap',
  'internal',
  'login',
  'mail',
  'mta',
  'mx',
  'ns1',
  'ns2',
  'portal',
  'smtp',
  'static',
  'status',
  'support',
  'www',
])

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Return the platform hostname only when the slug is safe to publish as DNS. */
export function portalHostnameForSlug(slug: string, platformDomain: string): string | null {
  const domain = getPlatformDomain(platformDomain)
  if (!DNS_LABEL.test(slug) || slug.length > 63) return null
  if (slug.startsWith('xn--') || RESERVED_PORTAL_SLUGS.has(slug)) return null
  const hostname = `${slug}.${domain}`
  return hostname.length <= 253 ? hostname : null
}

/** Normalise a hostname before it reaches the Cloudflare API or a stored tenant. */
function validHostname(hostname: string): string {
  const normalised = hostname.trim().toLowerCase()
  if (!validPlatformDomain(normalised)) {
    throw new CloudflareDomainApiError('Invalid portal hostname', 400)
  }
  return normalised
}

export interface PortalDomainProvisioner {
  attach(hostname: string): Promise<{ hostname: string; created: boolean }>
  detach(hostname: string): Promise<{ hostname: string; removed: boolean }>
}

interface CloudflareDomain {
  id: string
  hostname: string
  service: string
  zone_id: string
  zone_name: string
  environment?: string
}

interface CloudflareError {
  code?: number
  message?: string
}

interface CloudflareEnvelope<T> {
  result?: T
  success?: boolean
  errors?: CloudflareError[]
}

interface CloudflareDomainConfig {
  accountId: string
  apiToken: string
  zoneName?: string
  service?: string
}

export class CloudflareDomainApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'CloudflareDomainApiError'
  }
}

/**
 * Create the optional runtime domain adapter. Missing credentials deliberately
 * disable provisioning so portal creation can fall back to its relative URL.
 * Hostnames attach to the Worker script named by `WORKER_NAME`, so that value
 * must equal the deployment's Worker script name (it is also the signing audience).
 */
export function createCloudflareDomainProvisioner(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = globalThis.fetch,
): PortalDomainProvisioner | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_DOMAINS_TOKEN?.trim()
  if (!accountId || !apiToken) return null
  getPlatformDomain(env.PLATFORM_DOMAIN)
  return new CloudflareDomainProvisioner({
    accountId,
    apiToken,
    service: env.WORKER_NAME,
  }, fetcher)
}

export class CloudflareDomainProvisioner implements PortalDomainProvisioner {
  private readonly zoneName?: string
  private readonly service: string

  constructor(
    private readonly config: CloudflareDomainConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.zoneName = config.zoneName === undefined ? undefined : validHostname(config.zoneName)
    this.service = config.service ?? WORKER_SERVICE
  }

  async attach(hostname: string): Promise<{ hostname: string; created: boolean }> {
    hostname = validHostname(hostname)
    const existing = await this.find(hostname)
    if (existing) {
      this.assertOwnedByService(existing)
      return { hostname: existing.hostname, created: false }
    }

    // Without an explicit zone, Cloudflare attaches the hostname to the account zone that
    // contains it, so a platform domain may be a zone apex or a subdomain of one.
    const domain = await this.request<CloudflareDomain>('/workers/domains', {
      method: 'PUT',
      body: JSON.stringify({
        hostname,
        service: this.service,
        ...(this.zoneName ? { zone_name: this.zoneName } : {}),
      }),
    })
    if (domain.hostname.toLowerCase() !== hostname) {
      throw new CloudflareDomainApiError('Cloudflare attached an unexpected hostname', 502)
    }
    const zone = typeof domain.zone_name === 'string' ? domain.zone_name.toLowerCase() : ''
    if (
      !zone || (hostname !== zone && !hostname.endsWith(`.${zone}`)) ||
      (this.zoneName !== undefined && zone !== this.zoneName)
    ) {
      throw new CloudflareDomainApiError('Cloudflare attached an unexpected zone', 502)
    }
    this.assertOwnedByService(domain)
    return { hostname: domain.hostname.toLowerCase(), created: true }
  }

  async detach(hostname: string): Promise<{ hostname: string; removed: boolean }> {
    hostname = validHostname(hostname)
    const existing = await this.find(hostname)
    if (!existing) return { hostname, removed: false }
    this.assertOwnedByService(existing)
    await this.request<undefined>(
      `/workers/domains/${encodeURIComponent(existing.id)}`,
      { method: 'DELETE' },
      false,
    )
    return { hostname: existing.hostname, removed: true }
  }

  private async find(hostname: string): Promise<CloudflareDomain | null> {
    const query = new URLSearchParams({
      hostname,
      ...(this.zoneName ? { zone_name: this.zoneName } : {}),
    })
    const domains = await this.request<CloudflareDomain[]>(`/workers/domains?${query}`)
    return domains.find((domain) => domain.hostname.toLowerCase() === hostname) ?? null
  }

  private assertOwnedByService(domain: CloudflareDomain): void {
    if (domain.service === this.service) return
    throw new CloudflareDomainApiError(
      `${domain.hostname} is already attached to another Worker`,
      409,
    )
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    expectResult = true,
  ): Promise<T> {
    // Detach before calling: the Workers runtime rejects fetch invoked as a method of another
    // object ("Illegal invocation"), so `this.fetcher(...)` fails there even though it works
    // under Deno and in tests.
    const fetcher = this.fetcher
    const response = await fetcher(
      `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(this.config.accountId)}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      },
    )
    const envelope = await response.json().catch(() => null) as CloudflareEnvelope<T> | null
    // Deleting a Workers custom domain answers 200 with an empty body, not an envelope. A call
    // that expects no result succeeds on any 2xx without a body; an envelope that reports a
    // failure still fails.
    if (!expectResult && response.ok && envelope === null) return undefined as T
    if (!response.ok || !envelope?.success) {
      const detail = envelope?.errors?.find((error) => error.message)?.message
      throw new CloudflareDomainApiError(
        detail ?? `Cloudflare domain API returned HTTP ${response.status}`,
        response.status,
      )
    }
    if (expectResult && envelope.result === undefined) {
      throw new CloudflareDomainApiError('Cloudflare domain API returned no result', 502)
    }
    return envelope.result as T
  }
}
