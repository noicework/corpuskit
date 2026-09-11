/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { DurableObject } from 'cloudflare:workers'
import { initialiseDemo } from './demo.ts'
import { buildApp, type PortalRequestContext } from '../../api/src/app.ts'
import {
  PRINCIPAL_HEADER,
  type PrincipalEnvelope,
  signPrincipal,
  stripIdentityHeaders,
  type TrustedSessionFacts,
  validSessionFacts,
  verifyPrincipal,
} from '../../api/src/principal.ts'
import { coarseAdminEligibility, resolveEffectiveRoles } from '../../api/src/assignments.ts'
import { appendAudit, createAuditEvent } from '../../api/src/audit.ts'
import type { BreakGlassService } from '../../api/src/break-glass.ts'
import { runSystemMaintenance } from '../../api/src/scheduler.ts'
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

export interface TrustedRequestContext {
  session?: TrustedSessionFacts | null
  clientIp?: string
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
  private readonly bindings: Record<string, string | undefined>
  private readonly contexts = new WeakMap<Request, PortalRequestContext>()
  private readonly breakGlass: BreakGlassService

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const state = new DurableState(ctx.storage.sql, ctx.storage)
    state.migrate()
    const bindings = stringEnv(env)
    this.bindings = bindings
    this.stores = durableStores(state, bindings)
    this.breakGlass = this.stores.rbac.breakGlassService({
      passcode: bindings.ADMIN_PASSCODE,
      environment: bindings.ENVIRONMENT,
      explicitFlag: bindings.ADMIN_BREAK_GLASS,
    })
    if (bindings.ENTRA_TENANT_ID) {
      this.stores.rbac.assignmentService(bindings.ENTRA_TENANT_ID, bindings.WORKER_NAME)
        .bootstrapAdminEmails(bindings.ENTRA_ADMIN_EMAILS ?? '')
    }
    initialiseDemo(this.stores.tenants, bindings.ENVIRONMENT)
    this.provider = new AragProvider({
      resolveBinding: (slug) => this.stores.bindings.get(slug),
      augmentationModel: bindings.ARAG_DA_AGENT_MODEL,
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
      routing: this.stores.routing,
      zone: bindings.ARAG_ZONE,
      audit: this.stores.audit,
      localMutations: this.stores.localMutations,
      breakGlass: this.breakGlass,
      requestContext: (request) => this.contexts.get(request),
      invalidate: (slug) => this.provider.invalidate(slug),
      webAvailable: true,
      buildSha: env.CF_VERSION_METADATA?.id ?? 'cloudflare',
      rateLimitAskPerMin: numberBinding(bindings.RATE_LIMIT_ASK_PER_MIN, 20),
      rateLimitEstatePerMin: numberBinding(bindings.RATE_LIMIT_ESTATE_PER_MIN, 6),
    })
  }

  override async fetch(request: Request): Promise<Response> {
    return this.handleTrustedRequest(request, {})
  }

  /** RPC only. No route converts HTTP headers or JSON into these trusted facts. */
  async requestPrincipal(
    request: Request,
    context: TrustedRequestContext,
  ): Promise<PortalRequestContext> {
    const result = await verifyPrincipal(request.headers.get(PRINCIPAL_HEADER), {
      sessionSecret: this.bindings.SESSION_SECRET ?? '',
      audience: this.bindings.WORKER_NAME ?? '',
      tenantId: this.bindings.ENTRA_TENANT_ID ?? '',
    })
    if (result.kind === 'rejected') throw new InvalidPrincipal()
    const session = context.session ?? null
    if (
      result.kind === 'anonymous' ? session !== null : !validSessionFacts(session) ||
        session.tenantId !== result.envelope.tid || session.oid !== result.envelope.oid ||
        (session.email ?? '') !== result.envelope.email ||
        JSON.stringify(session.roles) !== JSON.stringify(result.envelope.roles) ||
        JSON.stringify(session.groups) !== JSON.stringify(result.envelope.groups)
    ) throw new InvalidPrincipal()
    const requestId = crypto.randomUUID()
    if (session) {
      const activation = this.stores.rbac.assignmentService(
        session.tenantId,
        this.bindings.WORKER_NAME,
      ).activate(session, { requestId, actor: { kind: 'user', id: session.oid } })
      if (!activation.ok && activation.code === 'invalid_principal') throw new InvalidPrincipal()
    }
    const resolution = await resolveEffectiveRoles(session, {
      rbac: this.stores.rbac,
      tenants: this.stores.tenants,
      audience: this.bindings.WORKER_NAME ?? '',
    }, this.bindings.ENTRA_TENANT_ID ?? '')
    return {
      requestId,
      session,
      clientIp: context.clientIp,
      ...resolution,
      coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
      user: result.kind === 'verified'
        ? {
          id: result.envelope.oid,
          tenantId: result.envelope.tid,
          email: result.envelope.email,
          name: result.envelope.name,
          roles: result.envelope.roles,
        }
        : null,
    }
  }

  async handleTrustedRequest(request: Request, context: TrustedRequestContext): Promise<Response> {
    try {
      const principal = await this.requestPrincipal(request, context)
      if (new URL(request.url).pathname.startsWith('/__corpuskit/')) {
        return json({ error: 'not_found' }, 404)
      }
      if (new URL(request.url).pathname === '/auth/me' && request.method === 'GET') {
        return json({
          authenticated: principal.session !== null,
          user: principal.user
            ? { ...principal.user, isAdmin: principal.coarseAdminEligible }
            : null,
          effectiveRoles: principal.effectiveRoles,
          provenance: principal.provenance,
          claimAgeSeconds: principal.session
            ? Math.max(0, Math.floor((Date.now() - principal.session.claimIssuedAt) / 1000))
            : null,
          groupStatus: principal.session?.groupStatus ?? 'unverified',
          groupMappings: principal.groupCapability,
          coarseAdminEligible: principal.coarseAdminEligible,
          breakGlassEnabled: this.breakGlass.enabled,
        }, 200)
      }
      const forwarded = new Request(request, { headers: stripIdentityHeaders(request.headers) })
      this.contexts.set(forwarded, principal)
      try {
        const response = await this.app.fetch(forwarded)
        if ((response.status === 401 || response.status === 403) && !principal.denialAudited) {
          await this.auditDenial(request, response.status, principal)
        }
        return response
      } finally {
        this.contexts.delete(forwarded)
      }
    } catch (error) {
      if (error instanceof InvalidPrincipal) {
        try {
          await this.auditDenial(request, 401)
        } catch {
          return json({ error: 'audit_write_failed' }, 500)
        }
        return json({ error: 'invalid_principal' }, 401)
      }
      console.error('Trusted request failed')
      return json({ error: 'internal_error' }, 500)
    }
  }

  /** Internal audit entry for Worker denials that never enter Hono. */
  async auditDenial(
    request: Request,
    status: 401 | 403,
    principal?: PortalRequestContext,
  ): Promise<void> {
    appendAudit(
      this.stores.audit,
      createAuditEvent({
        requestId: principal?.requestId ?? crypto.randomUUID(),
        actor: principal?.session
          ? { kind: 'user', id: principal.session.oid }
          : { kind: 'anonymous' },
        action: 'request.denied',
        scope: { kind: 'platform' },
        target: { kind: 'request' },
        outcome: 'denied',
        detail: { code: status === 401 ? 'unauthorised' : 'forbidden', method: request.method },
      }),
    )
  }

  async maintenance(): Promise<void> {
    await runSystemMaintenance(this.provider, this.stores, this.bindings.AUDIT_RETENTION_DAYS)
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

    if (url.pathname === '/auth/me' && request.method === 'GET') {
      return forwardTrusted(request, env, auth)
    }

    if (url.pathname.startsWith('/auth/')) {
      if (!authConfigured(auth)) {
        return json({ error: 'microsoft_sign_in_not_configured' }, 503)
      }
      const response = (await handleAuthRequest(request, auth)) ?? json({ error: 'not_found' }, 404)
      if (response.status === 401 || response.status === 403) {
        try {
          await env.PORTAL.getByName(PORTAL_OBJECT_NAME).auditDenial(request, response.status)
        } catch {
          return json({ error: 'audit_write_failed' }, 500)
        }
      }
      return response
    }

    const aliasLocation = tenantAliasLocation(request)
    if (aliasLocation) {
      return new Response(null, { status: 308, headers: { location: aliasLocation } })
    }

    if (url.pathname.startsWith('/api/')) {
      return forwardTrusted(request, env, auth)
    }

    return secureAssetResponse(await env.ASSETS.fetch(marketingHomeRequest(request)))
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' })
        .maintenance()
        .catch((error: unknown) => {
          console.error('Scheduled maintenance failed')
          throw error
        }),
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
export async function forwardPortalRequest(
  request: Request,
  user: AuthUser | null,
  env: Env,
): Promise<Request> {
  const headers = stripIdentityHeaders(request.headers)
  if (user) {
    const bindings = stringEnv(env)
    if (!validSessionFacts(user.sessionFacts)) throw new InvalidPrincipal()
    headers.set(
      PRINCIPAL_HEADER,
      await signPrincipal({
        v: 1,
        aud: bindings.WORKER_NAME as PrincipalEnvelope['aud'],
        tid: user.tenantId,
        oid: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        groups: user.sessionFacts.groups,
        iat: Math.floor(Date.now() / 1000),
      }, bindings.SESSION_SECRET ?? ''),
    )
    headers.set(SSO_USER_ID_HEADER, user.id)
    // Legacy transport is emitted only for verified platform claims. The DO resolves current stores.
    if (
      user.roles.some((role) =>
        ['CorpusKit.Owner', 'CorpusKit.PlatformAdmin', 'CorpusKit.Admin'].includes(role)
      )
    ) headers.set(SSO_ADMIN_HEADER, '1')
  }
  return new Request(request, { headers })
}

class InvalidPrincipal extends Error {}

async function forwardTrusted(
  request: Request,
  env: Env,
  auth: Partial<AuthConfig>,
): Promise<Response> {
  const stub = env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' })
  const user = authConfigured(auth) ? await authUser(request, auth) : null
  let forwarded: Request
  try {
    forwarded = await forwardPortalRequest(request, user, env)
  } catch {
    try {
      await stub.auditDenial(request, 401)
    } catch {
      return json({ error: 'audit_write_failed' }, 500)
    }
    return json({ error: 'invalid_principal' }, 401)
  }
  try {
    return await stub.handleTrustedRequest(forwarded, {
      session: user?.sessionFacts ?? null,
      clientIp: request.headers.get('cf-connecting-ip') ?? undefined,
    })
  } catch {
    return json({ error: 'internal_error' }, 500)
  }
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
