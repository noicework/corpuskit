/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />

import { DurableObject } from 'cloudflare:workers'
import {
  ExternalFailureAudit,
  externalHostWarning,
  externalLoginConfig,
  externalLoginConfigured,
  type ExternalLoginFailure,
  externalLoginPresentation,
  ExternalLoginReplayStore,
} from '../../api/src/external-login.ts'
import { docPageById } from '../../../packages/core/src/docs.ts'
import {
  getPlatformDomain,
  isPlatformHostname,
} from '../../../packages/core/src/platform-domain.ts'
import { platformShellResponse } from '../../api/src/platform-shell.ts'
import { bindingKeyState } from '../../api/src/binding-crypto.ts'
import { initialiseDemo } from './demo.ts'
import { initialiseAcmdDemo } from './acmd-demo.ts'
import { buildApp, type PortalRequestContext } from '../../api/src/app.ts'
import {
  PRINCIPAL_HEADER,
  type SessionEnvelope,
  signPrincipal,
  stripIdentityHeaders,
  type TrustedSessionFacts,
  validSessionFacts,
  verifyPrincipal,
} from '../../api/src/principal.ts'
import { coarseAdminEligibility, resolveEffectiveRoles } from '../../api/src/assignments.ts'
import { buildUiAccessSnapshot } from '../../api/src/ui-access.ts'
import { KeyPortalSlugSchema } from '../../api/src/scoped-key-record.ts'
import {
  authenticateOperator,
  configuredOperatorId,
  hasOperatorScheme,
  type OperatorAuthentication,
  operatorConfigurationWarning,
  operatorEnvelope,
  operatorFailureLimiter,
  operatorRequestContext,
} from '../../api/src/operator.ts'
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
  sessionAuthConfigured,
} from './auth.ts'
import { DurableState, type DurableStores, durableStores, stringEnv } from './state.ts'
import { tenantAliasLocation } from '../../api/src/tenant-aliases.ts'
import {
  aliasCacheSeconds,
  aliasHostRoute,
  aliasStartupWarnings,
  classifyHost,
  HostPortalCache,
  hostPortalFor,
  maxPortalAliases,
  narrowRolesToPortal,
  normaliseHostname,
  OFF_PLATFORM_TRANSPORT_SECURITY,
  reservedHostnames,
  SESSION_HOST_MISMATCH,
  SESSION_HOST_MISMATCH_AUDITS_PER_MIN,
  transportSecurityFor,
  unknownHostsMode,
} from '../../api/src/portal-aliases.ts'
import { SlidingWindowLimiter } from '../../api/src/rate-limit.ts'
import { documentPath, probePath } from '../../api/src/public-paths.ts'
import {
  createCloudflareDomainProvisioner,
  portalHostnameForSlug,
} from '../../api/src/cloudflare-domains.ts'

const PORTAL_OBJECT_NAME = 'production'
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

export interface TrustedRequestContext {
  session?: TrustedSessionFacts | null
  clientIp?: string
  /**
   * The Worker's cached view of the portal whose alias the request host is. It only ever narrows
   * a request: the object's own record decides first, and this applies when that record has no
   * alias for the host (a lookup made just before the alias was removed).
   */
  hostPortal?: string
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
  private readonly operatorFailures = operatorFailureLimiter()
  private readonly hostMismatches = new SlidingWindowLimiter({
    limit: SESSION_HOST_MISMATCH_AUDITS_PER_MIN,
    windowMs: 60_000,
  })
  private readonly externalReplays: ExternalLoginReplayStore
  private readonly externalFailures: ExternalFailureAudit

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const state = new DurableState(ctx.storage.sql, ctx.storage)
    state.migrate()
    this.externalReplays = new ExternalLoginReplayStore(state.rbacDatabase)
    const bindings = stringEnv(env)
    this.bindings = bindings
    const operatorWarning = operatorConfigurationWarning(bindings)
    if (operatorWarning) console.warn(operatorWarning)
    const hostWarning = externalHostWarning(bindings)
    if (hostWarning) console.warn(hostWarning)
    this.stores = durableStores(state, bindings)
    this.externalFailures = new ExternalFailureAudit(this.stores.audit)
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
    ctx.blockConcurrencyWhile(async () => {
      // A rejection here would reset the object on every request. Binding start-up withholds
      // records it cannot open instead of failing, so only the optional demo seed can throw.
      await this.stores.bindings.initialize()
      try {
        await initialiseAcmdDemo(this.stores.tenants, this.stores.bindings, bindings.ENVIRONMENT)
      } catch {
        console.error('Demo portal seeding failed')
      }
    })
    try {
      for (const warning of aliasStartupWarnings(bindings, this.stores.tenants.aliasHostnames())) {
        console.warn(warning)
      }
    } catch {
      // An unreadable registry fails its own requests; it never stops the object starting.
    }
    this.provider = new AragProvider({
      resolveBinding: (slug) => this.stores.bindings.get(slug),
      augmentationModel: bindings.ARAG_DA_AGENT_MODEL,
    })
    this.app = buildApp({
      rbac: this.stores.rbac,
      configuredTenantId: bindings.ENTRA_TENANT_ID ||
        (externalLoginConfigured(externalLoginConfig(bindings)) ? 'external' : undefined),
      externalLoginEnabled: externalLoginConfigured(externalLoginConfig(bindings)),
      audience: bindings.WORKER_NAME,
      provider: this.provider,
      management: this.provider,
      bindings: this.stores.bindings,
      platformDomain: bindings.PLATFORM_DOMAIN,
      tenants: this.stores.tenants,
      lifecycle: this.stores.lifecycle,
      insights: this.stores.insights,
      sessions: this.stores.sessions,
      watches: this.stores.watches,
      sources: this.stores.sources,
      investigations: this.stores.investigations,
      suggestions: this.stores.suggestions,
      enrichments: this.stores.enrichments,
      domainProvisioner: createCloudflareDomainProvisioner(bindings),
      maxPortalAliases: maxPortalAliases(bindings.MAX_PORTAL_ALIASES),
      reservedHostnames: reservedHostnames(bindings),
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
      operatorId: configuredOperatorId(this.bindings),
      externalLoginEnabled: externalLoginConfigured(externalLoginConfig(this.bindings)),
    })
    if (result.kind === 'rejected') throw new InvalidPrincipal()
    const session = context.session ?? null
    const envelope = result.kind === 'verified' ? result.envelope : null
    if (envelope?.kind === 'operator') {
      if (
        session || request.headers.has('authorization') || request.headers.has('x-admin-passcode')
      ) {
        throw new InvalidPrincipal()
      }
      return operatorRequestContext(envelope.id, crypto.randomUUID(), context.clientIp)
    }
    if (
      envelope === null ? session !== null : !validSessionFacts(session) ||
        session.tenantId !== envelope.tid || session.oid !== envelope.oid ||
        (session.email ?? '') !== envelope.email ||
        JSON.stringify(session.roles) !== JSON.stringify(envelope.roles) ||
        JSON.stringify(session.groups) !== JSON.stringify(envelope.groups)
    ) throw new InvalidPrincipal()
    const requestId = crypto.randomUUID()
    if (session) {
      const activation = this.stores.rbac.assignmentService(
        this.bindings.ENTRA_TENANT_ID || 'external',
        this.bindings.WORKER_NAME,
        externalLoginConfigured(externalLoginConfig(this.bindings)),
      ).activate(session, { requestId, actor: { kind: 'user', id: session.oid } })
      if (!activation.ok && activation.code === 'invalid_principal') throw new InvalidPrincipal()
    }
    const resolution = await resolveEffectiveRoles(session, {
      rbac: this.stores.rbac,
      tenants: this.stores.tenants,
      audience: this.bindings.WORKER_NAME ?? '',
      externalLoginEnabled: externalLoginConfigured(externalLoginConfig(this.bindings)),
    }, this.bindings.ENTRA_TENANT_ID || 'external')
    return {
      requestId,
      session,
      clientIp: context.clientIp,
      ...resolution,
      coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
      user: envelope
        ? {
          id: envelope.oid,
          tenantId: envelope.tid,
          email: envelope.email,
          name: envelope.name,
          roles: envelope.roles,
        }
        : null,
    }
  }

  async handleTrustedRequest(request: Request, context: TrustedRequestContext): Promise<Response> {
    try {
      const hostPortal = this.hostPortal(request, context.hostPortal)
      if (hostPortal === undefined && this.deniedHost(request)) {
        return json({ error: 'not_found' }, 404)
      }
      const principal = await this.requestPrincipal(request, context)
      if (
        principal.operator &&
        (hostPortal !== undefined || !new URL(request.url).pathname.startsWith('/api/'))
      ) {
        await this.auditDenial(request, 403, principal, 'operator_not_allowed')
        return json({ error: 'operator_not_allowed' }, 403)
      }
      if (hostPortal !== undefined) {
        principal.hostPortal = hostPortal
        // Nothing legitimate needs platform authority on an alias host, where a third party may
        // hold a harvested session: only the caller's own grants in this portal count here.
        const narrowed = narrowRolesToPortal(
          principal.effectiveRoles,
          principal.provenance,
          hostPortal,
        )
        principal.effectiveRoles = narrowed.effectiveRoles
        principal.provenance = narrowed.provenance
        principal.coarseAdminEligible = false
      }
      if (new URL(request.url).pathname.startsWith('/__corpuskit/')) {
        return json({ error: 'not_found' }, 404)
      }
      if (new URL(request.url).pathname === '/auth/me' && request.method === 'GET') {
        const selections = new URL(request.url).searchParams.getAll('portal')
        // An alias host answers for its own portal only.
        const selectedSlug = selections.length === 1 &&
            (hostPortal === undefined || selections[0] === hostPortal)
          ? selections[0]
          : undefined
        const slug = KeyPortalSlugSchema.safeParse(selectedSlug)
        let tenant: unknown
        try {
          if (slug.success) {
            const current = this.stores.tenants.get(slug.data)
            if (current) {
              tenant = { ...current, disabled: this.stores.tenants.isDisabled(slug.data) }
            }
          }
        } catch {
          // Unavailable policy has the same safe projection as a missing portal.
        }
        // Deployment-wide sign-in availability, except that Entra is never offered on a portal's
        // alias host: the redirect URI's host is reserved, so it can never be one.
        const entra = hostPortal === undefined
        const signIn = {
          clientId: entra ? this.bindings.ENTRA_CLIENT_ID : undefined,
          clientSecret: entra ? this.bindings.ENTRA_CLIENT_SECRET : undefined,
          tenantId: entra ? this.bindings.ENTRA_TENANT_ID : undefined,
          sessionSecret: this.bindings.SESSION_SECRET,
          externalLogin: externalLoginConfig(this.bindings),
        }
        return json({
          ...buildUiAccessSnapshot({
            externalLoginEnabled: externalLoginConfigured(externalLoginConfig(this.bindings)),
            session: principal.session,
            effectiveRoles: principal.effectiveRoles,
            configuredTenantId: this.bindings.ENTRA_TENANT_ID ?? '',
            selectedSlug,
            tenant,
          }),
          enabled: sessionAuthConfigured(signIn),
          entraEnabled: authConfigured(signIn),
          externalLogin: externalLoginPresentation(externalLoginConfig(this.bindings)),
          externalLoginEnabled: externalLoginConfigured(externalLoginConfig(this.bindings)),
          sessionProvenance: principal.session ? principal.session.provenance ?? 'entra' : null,
          authenticated: principal.session !== null,
          user: principal.user
            ? {
              ...principal.user,
              provenance: principal.session?.provenance ?? 'entra',
              isAdmin: principal.coarseAdminEligible,
            }
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
      const headers = stripIdentityHeaders(request.headers)
      // The break-glass passcode is platform authority, which an alias host never grants.
      if (hostPortal !== undefined) headers.delete('x-admin-passcode')
      const forwarded = new Request(request, { headers })
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

  /**
   * The portal whose registered alias the request host is: this object's own record, or else the
   * Worker's cached view. Platform hosts are never aliases.
   */
  private hostPortal(request: Request, workerView?: string): string | undefined {
    // Narrowed by the object's own alias record even on a reserved host, which the edge never
    // looks up: a record written before the hostname was reserved still binds it to its portal.
    const recorded = hostPortalFor(
      this.stores.tenants,
      new URL(request.url).hostname,
      getPlatformDomain(this.bindings.PLATFORM_DOMAIN),
    )
    if (recorded !== null) return recorded
    return workerView !== undefined && KeyPortalSlugSchema.safeParse(workerView).success
      ? workerView
      : undefined
  }

  /** Worker RPC: the portal a normalised host is a registered alias of, or null. */
  async resolveHostPortal(hostname: string): Promise<string | null> {
    return hostPortalFor(
      this.stores.tenants,
      hostname,
      getPlatformDomain(this.bindings.PLATFORM_DOMAIN),
    )
  }

  /** With `UNKNOWN_HOSTS=deny`, a host that is neither a platform nor a reserved host. */
  private deniedHost(request: Request): boolean {
    if (unknownHostsMode(this.bindings.UNKNOWN_HOSTS) !== 'deny') return false
    const host = classifyHost(
      new URL(request.url).hostname,
      getPlatformDomain(this.bindings.PLATFORM_DOMAIN),
      reservedHostnames(this.bindings),
    )
    return host.kind === 'candidate' || host.kind === 'other'
  }

  /** Internal audit entry for Worker denials that never enter Hono. */
  async auditDenial(
    request: Request,
    status: 401 | 403,
    principal?: PortalRequestContext,
    code?: 'operator_not_allowed',
  ): Promise<void> {
    appendAudit(
      this.stores.audit,
      createAuditEvent({
        requestId: principal?.requestId ?? crypto.randomUUID(),
        actor: principal?.operator
          ? { kind: 'operator', id: `operator:${principal.operator.id}` }
          : principal?.session
          ? { kind: 'user', id: principal.session.oid }
          : { kind: 'anonymous' },
        action: 'request.denied',
        scope: { kind: 'platform' },
        target: { kind: 'request' },
        outcome: 'denied',
        detail: {
          code: code ?? (status === 401 ? 'unauthorised' : 'forbidden'),
          method: request.method,
        },
      }),
    )
  }

  /**
   * Worker RPC for an operator credential the Worker refused. The Worker sends only the method
   * and URL. Past the per-address limit the refusal is answered with 429 and not audited again.
   */
  async auditOperatorFailure(
    request: Request,
    clientIp?: string,
  ): Promise<{ limited: false } | { limited: true; retryAfterSec: number }> {
    const { allowed, retryAfterSec } = this.operatorFailures.check(clientIp ?? 'unknown')
    if (!allowed) return { limited: true, retryAfterSec }
    await this.auditDenial(request, 401)
    return { limited: false }
  }

  /**
   * Worker RPC for a session refused because it was sealed to another host: recorded as
   * `session_host_mismatch` under the session's own identity, at most a few times a minute per
   * client address, so a looping replay cannot grow the audit log without bound.
   */
  async auditSessionHostMismatch(request: Request, oid: string, clientIp?: string): Promise<void> {
    if (!this.hostMismatches.check(clientIp ?? 'unknown').allowed) return
    appendAudit(
      this.stores.audit,
      createAuditEvent({
        requestId: crypto.randomUUID(),
        actor: { kind: 'user', id: oid },
        action: 'request.denied',
        scope: { kind: 'platform' },
        target: { kind: 'request' },
        outcome: 'denied',
        detail: { code: SESSION_HOST_MISMATCH, method: request.method },
      }),
    )
  }

  async consumeExternalAssertion(key: string, expiresAt: number): Promise<boolean> {
    return this.externalReplays.consume(key, expiresAt)
  }

  /**
   * Worker RPC for a refused external sign-in. At most one record per client address a minute;
   * the rest are counted onto the next record (see `ExternalFailureAudit`).
   */
  async auditExternalFailure(reason: ExternalLoginFailure, clientIp?: string): Promise<void> {
    this.externalFailures.record(reason, clientIp ?? 'unknown')
  }

  async maintenance(): Promise<void> {
    await runSystemMaintenance(this.provider, this.stores, this.bindings.AUDIT_RETENTION_DAYS)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(hostTransportSecurity(request, env, await route(request, env)))
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  let platformDomain: string
  try {
    platformDomain = getPlatformDomain(stringEnv(env).PLATFORM_DOMAIN)
  } catch {
    return json({ error: 'platform_domain_invalid' }, 503)
  }
  // The request host decides everything else. Platform and reserved hosts are never looked up; a
  // host that could be a registered alias is, and a failed lookup never falls back to treating
  // it as unregistered.
  const values = stringEnv(env)
  const host = classifyHost(url.hostname, platformDomain, reservedHostnames(values))
  let hostPortal: string | null = null
  if (host.kind === 'candidate') {
    const found = await cachedHostPortal(host.hostname, env)
    if (found === undefined) {
      return json({ error: 'host_lookup_failed' }, 503, { 'retry-after': '5' })
    }
    hostPortal = found
  }
  if (
    hostPortal === null && (host.kind === 'candidate' || host.kind === 'other') &&
    unknownHostsMode(values.UNKNOWN_HOSTS) === 'deny'
  ) return json({ error: 'not_found' }, 404)
  const auth = authConfig(env, url.hostname, platformDomain, {
    aliasHost: hostPortal !== null,
    sealHost: host.kind === 'candidate',
    reservedHost: host.kind === 'reserved',
  })
  // Explicit hosting credentials are handled before redirects, sessions or static assets.
  const operator = await authenticateOperator(request, values)
  if (hostPortal !== null) {
    return operator.kind === 'absent'
      ? routeAliasHost(request, env, auth, platformDomain, hostPortal)
      : forwardTrusted(request, env, auth, operator, hostPortal)
  }
  if (operator.kind !== 'absent') return forwardTrusted(request, env, auth, operator)
  const hostnameLocation = platformHostnameLocation(request, platformDomain)
  if (hostnameLocation) {
    return new Response(null, { status: 308, headers: { location: hostnameLocation } })
  }

  if (url.pathname.startsWith('/auth/')) {
    // A reserved hostname can still carry an alias record written before it was reserved, and
    // its DNS may then be a third party's. Only the routes that issue a session look that up, so
    // pages and session reads there never wait on it; with a record, sign-in is as on an alias
    // host: sealed to the host, with the host claim required and no Entra.
    if (host.kind === 'reserved' && SESSION_ISSUING_PATHS.has(url.pathname)) {
      const recorded = await cachedHostPortal(normaliseHostname(url.hostname), env, false)
      if (recorded === undefined) {
        return json({ error: 'host_lookup_failed' }, 503, { 'retry-after': '5' })
      }
      if (recorded !== null) {
        return authRoute(
          request,
          env,
          authConfig(env, url.hostname, platformDomain, { aliasHost: true, sealHost: true }),
          operator,
        )
      }
    }
    return authRoute(request, env, auth, operator)
  }

  const aliasLocation = tenantAliasLocation(request)
  if (aliasLocation) {
    return new Response(null, { status: 308, headers: { location: aliasLocation } })
  }

  if (url.pathname.startsWith('/api/')) {
    return forwardTrusted(request, env, auth, operator)
  }

  return pageRoute(request, env, platformDomain)
}

/**
 * A request on a portal's registered alias host. Only that portal is served: its pages and API,
 * sign-in with a host-only session cookie, the SPA shell and static assets. The root redirects to
 * the portal's home; other portals, platform-scope API routes and platform pages are not found.
 * The Durable Object checks each API route again against its own record of the alias.
 */
async function routeAliasHost(
  request: Request,
  env: Env,
  auth: Partial<AuthConfig>,
  platformDomain: string,
  slug: string,
): Promise<Response> {
  const decision = aliasHostRoute(request.method, new URL(request.url), slug)
  switch (decision.kind) {
    case 'redirect':
      return new Response(null, { status: 308, headers: { location: decision.location } })
    case 'not_found':
      return decision.api ? json({ error: 'not_found' }, 404) : plain('Not found', 404)
    case 'auth':
      return authRoute(request, env, auth, { kind: 'absent' }, slug)
    case 'api':
      return forwardTrusted(request, env, auth, { kind: 'absent' }, slug)
  }
  const aliasLocation = tenantAliasLocation(request)
  if (aliasLocation) {
    return new Response(null, { status: 308, headers: { location: aliasLocation } })
  }
  return pageRoute(request, env, platformDomain, slug)
}

async function authRoute(
  request: Request,
  env: Env,
  auth: Partial<AuthConfig>,
  operator: OperatorAuthentication,
  hostPortal: string | null = null,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/auth/me' && request.method === 'GET') {
    return forwardTrusted(request, env, auth, operator, hostPortal)
  }
  if (!sessionAuthConfigured(auth) && url.pathname !== '/auth/external') {
    return json({ error: 'microsoft_sign_in_not_configured' }, 503)
  }
  const stub = env.PORTAL.getByName(PORTAL_OBJECT_NAME)
  const response = (await handleAuthRequest(request, auth, {
    consume: (key, expiresAt) => stub.consumeExternalAssertion(key, expiresAt),
    auditFailure: (reason) =>
      stub.auditExternalFailure(reason, request.headers.get('cf-connecting-ip') ?? undefined),
  })) ?? json({ error: 'not_found' }, 404)
  if (url.pathname !== '/auth/external' && (response.status === 401 || response.status === 403)) {
    try {
      await env.PORTAL.getByName(PORTAL_OBJECT_NAME).auditDenial(request, response.status)
    } catch {
      return json({ error: 'audit_write_failed' }, 500)
    }
  }
  return response
}

/** Pages, the SPA shell and static assets. */
async function pageRoute(
  request: Request,
  env: Env,
  platformDomain: string,
  hostPortal?: string,
): Promise<Response> {
  const url = new URL(request.url)
  // The shared asset bundle is also bound to tenant hosts. Keep the marketing
  // documents (including raw asset aliases) on the platform apex only.
  if (
    (['/about', '/about/', '/about.html'].includes(url.pathname) ||
      isPublicDocsPath(url.pathname)) &&
    url.hostname !== platformDomain
  ) {
    return plain('Not found', 404)
  }

  // Pages and assets are read-only; nothing here accepts a body.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return plain('Method not allowed', 405, { allow: 'GET, HEAD' })
  }

  // The internet's routine search for secrets and server-side scripts is
  // refused before any asset lookup. The router's own paths are exempt.
  if (!documentPath(url.pathname) && probePath(url.pathname)) {
    return plain('Not found', 404)
  }

  const asset = platformShellResponse(
    await env.ASSETS.fetch(marketingHomeRequest(request, platformDomain)),
    platformDomain,
    hostPortal,
  )
  // Assets answers every unknown path with the app shell and a 200. Keep
  // the shell, so a person still sees the app's own not-found page, but say
  // 404: a scanner learns nothing and a crawler does not index the typo.
  const unknownShell = asset.status === 200 && !documentPath(url.pathname) &&
    (asset.headers.get('content-type') ?? '').includes('text/html')
  return secureAssetResponse(asset, unknownShell ? 404 : asset.status)
}

/**
 * `includeSubDomains` only inside the platform domain. Every other host (an alias, a reserved or
 * unknown host, or one whose lookup failed) may be a customer's apex domain, so its answers never
 * force HTTPS on every subdomain of it.
 */
function hostTransportSecurity(request: Request, env: Env, response: Response): Response {
  let value = OFF_PLATFORM_TRANSPORT_SECURITY
  try {
    value = transportSecurityFor(
      new URL(request.url).hostname,
      getPlatformDomain(stringEnv(env).PLATFORM_DOMAIN),
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

/** The sign-in routes that issue a session cookie. */
const SESSION_ISSUING_PATHS: ReadonlySet<string> = new Set([
  '/auth/external',
  '/auth/callback',
  '/auth/login',
])

/** Per-isolate host lookups, positive and negative, each kept for `ALIAS_CACHE_SECONDS`. */
const hostPortals = new HostPortalCache()
/** A lookup slower than this fails: the request is answered with 503 and nothing is cached. */
const HOST_LOOKUP_TIMEOUT_MS = 1000

/**
 * The portal a candidate host (a normalised hostname that could be an alias) is registered to,
 * null when it is not registered, or undefined when the lookup failed or timed out. A failure is
 * never cached and never treated as an unregistered host.
 */
async function cachedHostPortal(
  candidate: string,
  env: Env,
  warnIfUnregistered = true,
): Promise<string | null | undefined> {
  const now = Date.now()
  const cached = hostPortals.get(candidate, now)
  if (cached !== undefined) return cached
  let slug: string | null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const found = await Promise.race([
      env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' })
        .resolveHostPortal(candidate),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), HOST_LOOKUP_TIMEOUT_MS)
      }),
    ])
    slug = typeof found === 'string' && KeyPortalSlugSchema.safeParse(found).success ? found : null
  } catch {
    console.error('Portal host lookup failed')
    return undefined
  } finally {
    clearTimeout(timer)
  }
  hostPortals.set(candidate, slug, aliasCacheSeconds(stringEnv(env).ALIAS_CACHE_SECONDS), now)
  if (slug === null && warnIfUnregistered) warnUnregistered(candidate)
  return slug
}

/** Hosts already reported by `warnUnregistered` in this isolate, a bounded few. */
const reportedHosts = new Set<string>()
/**
 * Say once per isolate when a hostname routes here without being a registered alias or reserved:
 * it is usually one of the deployment's own custom domains missing from RESERVED_HOSTNAMES.
 */
function warnUnregistered(hostname: string): void {
  if (reportedHosts.has(hostname) || reportedHosts.size >= 100) return
  reportedHosts.add(hostname)
  console.warn(
    `[portal-aliases] ${hostname} reached this deployment but is neither a registered alias nor ` +
      "reserved. List the deployment's own custom domains in RESERVED_HOSTNAMES.",
  )
}

function isPublicDocsPath(pathname: string): boolean {
  return pathname === '/docs' || pathname.startsWith('/docs/')
}

/** Select marketing documents without leaking the Assets pretty-URL redirects. */
export function marketingHomeRequest(request: Request, domain: string): Request {
  const platformDomain = getPlatformDomain(domain)
  const url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return request
  }

  if (
    url.hostname === platformDomain &&
    ['/about', '/about/', '/about.html'].includes(url.pathname)
  ) {
    url.pathname = '/about'
  } else if (url.hostname === platformDomain && isPublicDocsPath(url.pathname)) {
    const id = /^\/docs\/([a-z0-9-]+)(?:\.html)?\/?$/.exec(url.pathname)?.[1]
    // Unknown paths deliberately serve the overview. Ask Assets for its
    // canonical directory/extensionless URL to avoid pretty-URL redirects.
    url.pathname = id && docPageById(id) ? `/docs/${id}` : '/docs/'
  } else if (url.pathname === '/') {
    // Ask Assets for its extensionless route. Requesting `home.html` directly
    // invokes pretty-URL handling and would leak a `/home` redirect to visitors.
    url.pathname = '/home'
  } else {
    return request
  }
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
  credential?: OperatorAuthentication,
): Promise<Request> {
  const headers = stripIdentityHeaders(request.headers)
  const bindings = stringEnv(env)
  const operator = credential ?? await authenticateOperator(request, bindings)
  if (operator.kind === 'rejected') throw new InvalidOperator()
  if (operator.kind === 'verified') {
    headers.delete('authorization')
    headers.delete('cookie')
    headers.set(
      PRINCIPAL_HEADER,
      await signPrincipal(
        operatorEnvelope(operator.id, bindings.WORKER_NAME ?? ''),
        bindings.SESSION_SECRET ?? '',
      ),
    )
  } else if (user) {
    if (!validSessionFacts(user.sessionFacts)) throw new InvalidPrincipal()
    headers.set(
      PRINCIPAL_HEADER,
      await signPrincipal({
        v: 1,
        aud: bindings.WORKER_NAME as SessionEnvelope['aud'],
        tid: user.tenantId,
        oid: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        groups: user.sessionFacts.groups,
        iat: Math.floor(Date.now() / 1000),
      }, bindings.SESSION_SECRET ?? ''),
    )
  }
  return new Request(request, { headers })
}

class InvalidPrincipal extends Error {}
class InvalidOperator extends Error {}

/** Refusals reach the Durable Object's audit without headers, so no credential can travel. */
function refusalRecord(request: Request): Request {
  try {
    return new Request(request.url, { method: request.method })
  } catch {
    // A method the constructor refuses to set directly is kept by a header-free copy.
    return new Request(request, { headers: new Headers() })
  }
}

async function forwardTrusted(
  request: Request,
  env: Env,
  auth: Partial<AuthConfig>,
  operator: OperatorAuthentication,
  hostPortal: string | null = null,
): Promise<Response> {
  // A malformed key is a deployment fault, not a data fault: say so on every portal request,
  // health included, rather than letting stored credentials look lost or be replaced.
  if (bindingKeyState(stringEnv(env).BINDING_KEY) === 'invalid') {
    return json({ error: 'binding_key_invalid' }, 503)
  }
  const stub = env.PORTAL.getByName(PORTAL_OBJECT_NAME, { locationHint: 'oc' })
  // An operator credential is the whole authority: no session cookie is read beside it.
  const clientIp = request.headers.get('cf-connecting-ip') ?? undefined
  let user: AuthUser | null = null
  if (!hasOperatorScheme(request) && sessionAuthConfigured(auth)) {
    try {
      // A session carried off the host it was sealed to is refused, and recorded.
      user = await authUser(
        request,
        auth,
        (oid) => stub.auditSessionHostMismatch(refusalRecord(request), oid, clientIp),
      )
    } catch {
      return json({ error: 'audit_write_failed' }, 500)
    }
  }
  let forwarded: Request
  try {
    forwarded = await forwardPortalRequest(request, user, env, operator)
  } catch (error) {
    const refused = refusalRecord(request)
    try {
      if (error instanceof InvalidOperator) {
        const outcome = await stub.auditOperatorFailure(refused, clientIp)
        if (outcome.limited) {
          return json({ error: 'rate_limited' }, 429, {
            'retry-after': String(outcome.retryAfterSec),
          })
        }
      } else {
        await stub.auditDenial(refused, 401)
      }
    } catch {
      return json({ error: 'audit_write_failed' }, 500)
    }
    return json({
      error: error instanceof InvalidOperator ? 'invalid_operator' : 'invalid_principal',
    }, 401)
  }
  try {
    return await stub.handleTrustedRequest(forwarded, {
      session: user?.sessionFacts ?? null,
      clientIp,
      ...(hostPortal === null ? {} : { hostPortal }),
    })
  } catch {
    return json({ error: 'internal_error' }, 500)
  }
}

/**
 * Sign-in settings for a request host. On a portal's alias host Entra is never offered (the
 * redirect URI's host is reserved, so it is never an alias). On an alias or any other candidate
 * host, a hostname a third party may control, a session is sealed to the host and an assertion
 * must name it. Platform, reserved and other hosts (such as `workers.dev`) keep the
 * deployment-wide rules.
 */
function authConfig(
  env: Env,
  hostname: string,
  platformDomain: string,
  host: { aliasHost?: boolean; sealHost?: boolean; reservedHost?: boolean } = {},
): Partial<AuthConfig> {
  const values = stringEnv(env)
  const onPlatformDomain = isPlatformHostname(hostname, platformDomain)
  const entra = !host.aliasHost
  return {
    clientId: entra ? values.ENTRA_CLIENT_ID : undefined,
    clientSecret: entra ? values.ENTRA_CLIENT_SECRET : undefined,
    tenantId: entra ? values.ENTRA_TENANT_ID : undefined,
    sessionSecret: values.SESSION_SECRET,
    redirectUri: onPlatformDomain
      ? values.ENTRA_REDIRECT_URI
      : hostname === 'corpuskit.noice.net.au'
      ? `https://${hostname}/auth/callback`
      : values.ENTRA_REDIRECT_URI,
    adminEmails: values.ENTRA_ADMIN_EMAILS,
    externalLogin: externalLoginConfig(values),
    cookieDomain: onPlatformDomain ? platformDomain : undefined,
    // On a candidate host, whether or not the edge knows it as an alias, a session is sealed to
    // the host it was issued on and read nowhere else.
    ...(host.sealHost ? { sessionHost: normaliseHostname(hostname) } : {}),
    // A reserved host reads the sessions sign-in sealed to it while it carried an alias record.
    ...(host.reservedHost ? { alsoReadSealedTo: normaliseHostname(hostname) } : {}),
  }
}

/**
 * Give every safely provisioned portal hostname a stable root redirect while
 * the SPA retains its existing tenant-prefixed routes. A hostname can only
 * reach this Worker after Cloudflare has attached its exact Custom Domain.
 */
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

function numberBinding(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function secureAssetResponse(response: Response, status = response.status): Response {
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

/** A short text answer with the asset headers, for refusals the Worker makes itself. */
function plain(body: string, status: number, extra: Record<string, string> = {}): Response {
  return secureAssetResponse(
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...extra },
    }),
  )
}

/**
 * Every response leaves with the baseline headers. API responses already
 * carry the ones the Hono middleware sets; redirects, auth answers and the
 * Worker's own JSON gain them here without disturbing a streamed body.
 */
function withSecurityHeaders(response: Response): Response {
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

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}
