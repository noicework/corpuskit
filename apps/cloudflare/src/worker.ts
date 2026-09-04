/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { DurableObject } from 'cloudflare:workers'
import { buildApp } from '../../api/src/app.ts'
import { runAutoEnrichments, runAutoSyncs, runWatches } from '../../api/src/scheduler.ts'
import { AragProvider } from '@research-portal/retrieval'
import {
  type AuthConfig,
  authConfigured,
  type AuthUser,
  authUser,
  handleAuthRequest,
} from './auth.ts'
import { DurableState, type DurableStores, durableStores, stringEnv } from './state.ts'
import { tenantAliasLocation } from '../../api/src/tenant-aliases.ts'
import {
  createCloudflareDomainProvisioner,
  portalHostnameForSlug,
} from '../../api/src/cloudflare-domains.ts'

const PORTAL_OBJECT_NAME = 'production'
const SSO_ADMIN_HEADER = 'x-corpuskit-sso-admin'
const SSO_USER_ID_HEADER = 'x-corpuskit-sso-user-id'
const PLATFORM_DOMAIN = 'corpuskit.org'
const SECURITY_HEADERS: Record<string, string> = {
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

/**
 * CorpusKit's Hono application currently depends on synchronous stores. A
 * single SQLite-backed Durable Object preserves those contracts and serialises
 * writes without smuggling filesystem assumptions into the Worker runtime.
 */
export class PortalDurableObject extends DurableObject<Env> {
  private readonly app: ReturnType<typeof buildApp>
  private readonly provider: AragProvider
  private readonly stores: DurableStores

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const state = new DurableState(ctx.storage.sql)
    state.migrate()
    const bindings = stringEnv(env)
    this.stores = durableStores(state, bindings)
    this.provider = new AragProvider({
      resolveBinding: (slug) => this.stores.bindings.get(slug),
    })
    this.app = buildApp({
      provider: this.provider,
      management: this.provider,
      bindings: this.stores.bindings,
      tenants: this.stores.tenants,
      insights: this.stores.insights,
      sessions: this.stores.sessions,
      watches: this.stores.watches,
      sources: this.stores.sources,
      investigations: this.stores.investigations,
      suggestions: this.stores.suggestions,
      enrichments: this.stores.enrichments,
      domainProvisioner: createCloudflareDomainProvisioner(bindings),
      kgProposals: this.stores.kgProposals,
      branding: this.stores.branding,
      mcpKeys: this.stores.mcpKeys,
      zone: bindings.ARAG_ZONE,
      adminPasscode: bindings.ADMIN_PASSCODE,
      trustedAdmin: (request) => request.headers.get(SSO_ADMIN_HEADER) === '1',
      trustedUser: (request) => {
        const id = request.headers.get(SSO_USER_ID_HEADER)
        return id ? { id, isAdmin: request.headers.get(SSO_ADMIN_HEADER) === '1' } : null
      },
      invalidate: (slug) => this.provider.invalidate(slug),
      webAvailable: true,
      buildSha: env.CF_VERSION_METADATA?.id ?? 'cloudflare',
      rateLimitAskPerMin: numberBinding(bindings.RATE_LIMIT_ASK_PER_MIN, 20),
      rateLimitEstatePerMin: numberBinding(bindings.RATE_LIMIT_ESTATE_PER_MIN, 6),
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__corpuskit/maintenance') {
      await this.maintenance()
      return new Response(null, { status: 204 })
    }
    return await this.app.fetch(request)
  }

  async maintenance(): Promise<void> {
    await runAutoSyncs(this.provider, this.stores.tenants, this.stores.sources)
    await runWatches(this.provider, this.stores.tenants, this.stores.watches)
    await runAutoEnrichments(this.provider, this.stores.tenants, this.stores.enrichments)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const hostnameLocation = platformHostnameLocation(request)
    if (hostnameLocation) {
      return new Response(null, { status: 308, headers: { location: hostnameLocation } })
    }

    const auth = authConfig(env, url.hostname)

    if (url.pathname.startsWith('/auth/')) {
      if (!authConfigured(auth)) {
        return json({ error: 'microsoft_sign_in_not_configured' }, 503)
      }
      return (await handleAuthRequest(request, auth)) ?? json({ error: 'not_found' }, 404)
    }

    const aliasLocation = tenantAliasLocation(request)
    if (aliasLocation) {
      return new Response(null, { status: 308, headers: { location: aliasLocation } })
    }

    if (url.pathname.startsWith('/api/')) {
      const user = authConfigured(auth) ? await authUser(request, auth) : null
      const forwarded = forwardPortalRequest(request, user)
      return env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' }).fetch(forwarded)
    }

    return secureAssetResponse(await env.ASSETS.fetch(marketingHomeRequest(request)))
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' })
        .fetch(new Request('https://corpuskit.internal/__corpuskit/maintenance'))
        .then((response) => {
          if (!response.ok) throw new Error(`Maintenance HTTP ${response.status}`)
        })
        .catch((error: unknown) =>
          console.error(JSON.stringify({ message: 'maintenance failed', error: String(error) }))
        ),
    )
  },
} satisfies ExportedHandler<Env>

/** Serve the dedicated marketing document at the apex without changing its canonical URL. */
export function marketingHomeRequest(request: Request): Request {
  const url = new URL(request.url)
  if ((request.method !== 'GET' && request.method !== 'HEAD') || url.pathname !== '/') {
    return request
  }

  // Ask Assets for its extensionless route. Requesting `home.html` directly
  // invokes pretty-URL handling and would leak a `/home` redirect to visitors.
  url.pathname = '/home'
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
  })
}

/**
 * Forward only identity markers derived from a validated encrypted session.
 * Caller-supplied copies are always removed before the Durable Object sees the
 * request, so its role and issuer checks can trust these headers.
 */
export function forwardPortalRequest(request: Request, user: AuthUser | null): Request {
  const headers = new Headers(request.headers)
  headers.delete(SSO_ADMIN_HEADER)
  headers.delete(SSO_USER_ID_HEADER)
  if (user) {
    headers.set(SSO_USER_ID_HEADER, user.id)
    if (user.isAdmin) headers.set(SSO_ADMIN_HEADER, '1')
  }
  return new Request(request, { headers })
}

function authConfig(env: Env, hostname: string): Partial<AuthConfig> {
  const values = stringEnv(env)
  const onPlatformDomain = hostname === PLATFORM_DOMAIN || hostname.endsWith(`.${PLATFORM_DOMAIN}`)
  return {
    clientId: values.ENTRA_CLIENT_ID,
    clientSecret: values.ENTRA_CLIENT_SECRET,
    tenantId: values.ENTRA_TENANT_ID,
    sessionSecret: values.SESSION_SECRET,
    redirectUri: onPlatformDomain
      ? values.ENTRA_REDIRECT_URI
      : hostname === 'corpuskit.noice.net.au'
      ? `https://${hostname}/auth/callback`
      : values.ENTRA_REDIRECT_URI,
    adminEmails: values.ENTRA_ADMIN_EMAILS,
    cookieDomain: onPlatformDomain ? PLATFORM_DOMAIN : undefined,
  }
}

/**
 * Give every safely provisioned portal hostname a stable root redirect while
 * the SPA retains its existing tenant-prefixed routes. A hostname can only
 * reach this Worker after Cloudflare has attached its exact Custom Domain.
 */
export function platformHostnameLocation(
  request: Pick<Request, 'method' | 'url'>,
): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const hostname = url.hostname.toLowerCase()

  if (hostname === `www.${PLATFORM_DOMAIN}`) {
    return `https://${PLATFORM_DOMAIN}${url.pathname}${url.search}`
  }

  const suffix = `.${PLATFORM_DOMAIN}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  if (portalHostnameForSlug(slug) !== hostname || url.pathname !== '/') return null
  return `/t/${slug}${url.search}`
}

function numberBinding(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function secureAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  const type = headers.get('content-type') ?? ''
  headers.set('cache-control', type.includes('text/html') ? 'no-store' : 'public, max-age=300')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
