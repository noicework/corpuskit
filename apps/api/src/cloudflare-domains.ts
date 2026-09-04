const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const PORTAL_ZONE = 'corpuskit.org'
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
export function portalHostnameForSlug(slug: string): string | null {
  if (!DNS_LABEL.test(slug) || slug.length > 63) return null
  if (slug.startsWith('xn--') || RESERVED_PORTAL_SLUGS.has(slug)) return null
  return `${slug}.${PORTAL_ZONE}`
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
 */
export function createCloudflareDomainProvisioner(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = globalThis.fetch,
): PortalDomainProvisioner | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_DOMAINS_TOKEN?.trim()
  if (!accountId || !apiToken) return null
  return new CloudflareDomainProvisioner({ accountId, apiToken }, fetcher)
}

export class CloudflareDomainProvisioner implements PortalDomainProvisioner {
  private readonly zoneName: string
  private readonly service: string

  constructor(
    private readonly config: CloudflareDomainConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.zoneName = config.zoneName ?? PORTAL_ZONE
    this.service = config.service ?? WORKER_SERVICE
  }

  async attach(hostname: string): Promise<{ hostname: string; created: boolean }> {
    const existing = await this.find(hostname)
    if (existing) {
      this.assertOwnedByService(existing)
      return { hostname: existing.hostname, created: false }
    }

    const domain = await this.request<CloudflareDomain>('/workers/domains', {
      method: 'PUT',
      body: JSON.stringify({
        hostname,
        service: this.service,
        zone_name: this.zoneName,
      }),
    })
    if (domain.hostname.toLowerCase() !== hostname.toLowerCase()) {
      throw new CloudflareDomainApiError('Cloudflare attached an unexpected hostname', 502)
    }
    this.assertOwnedByService(domain)
    return { hostname: domain.hostname.toLowerCase(), created: true }
  }

  async detach(hostname: string): Promise<{ hostname: string; removed: boolean }> {
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
      zone_name: this.zoneName,
    })
    const domains = await this.request<CloudflareDomain[]>(`/workers/domains?${query}`)
    return domains.find((domain) => domain.hostname.toLowerCase() === hostname.toLowerCase()) ??
      null
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
    const response = await this.fetcher(
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
