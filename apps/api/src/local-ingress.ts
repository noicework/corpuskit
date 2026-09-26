import {
  type AuthConfig,
  authConfigured,
  authUser,
  handleAuthRequest,
  sessionAuthConfigured,
} from '../../cloudflare/src/auth.ts'
import {
  ExternalFailureAudit,
  externalHostWarning,
  externalLoginConfig,
  externalLoginConfigured,
  externalLoginPresentation,
  type ExternalLoginReplayStore,
} from './external-login.ts'
import type { PortalRequestContext } from './app.ts'
import {
  coarseAdminEligibility,
  resolveEffectiveRoles,
  type RoleResolution,
} from './assignments.ts'
import { appendAudit, type AuditActor, createAuditEvent } from './audit.ts'
import { type BreakGlassService } from './break-glass.ts'
import {
  PRINCIPAL_HEADER,
  type SessionEnvelope,
  signPrincipal,
  stripIdentityHeaders,
  type TrustedSessionFacts,
  validSessionFacts,
  verifyPrincipal,
} from './principal.ts'
import type { RbacState } from './rbac-state.ts'
import type { TenantStoreApi } from './tenants.ts'
import { buildUiAccessSnapshot } from './ui-access.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'
import {
  aliasHostRoute,
  aliasStartupWarnings,
  classifyHost,
  type HostKind,
  hostPortalFor,
  narrowRolesToPortal,
  normaliseHostname,
  reservedHostnames,
  unknownHostsMode,
} from './portal-aliases.ts'
import { getPlatformDomain } from '../../../packages/core/src/platform-domain.ts'
import {
  authenticateOperator,
  configuredOperatorId,
  operatorConfigurationWarning,
  operatorEnvelope,
  operatorFailureLimiter,
  operatorRequestContext,
} from './operator.ts'

interface LocalIngressOptions {
  rbac: RbacState
  tenants:
    & { list(): { slug: string }[] }
    & Partial<Pick<TenantStoreApi, 'get' | 'isDisabled' | 'aliasPortal' | 'aliasHostnames'>>
  externalReplays?: ExternalLoginReplayStore
  env: Record<string, string | undefined>
}
type PeerInfo = Pick<Deno.ServeHandlerInfo<Deno.NetAddr>, 'remoteAddr'>
/** The TCP peer, which keys the per-address failure limits. */
const peerAddress = (info?: PeerInfo) =>
  info?.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : 'unknown'
class InvalidLocalPrincipal extends Error {}
class InvalidOperatorCredential extends Error {}

/** Trusted local adapter. Session fixtures are in-process arguments, never HTTP input. */
export class LocalIngress {
  private readonly contexts = new WeakMap<Request, PortalRequestContext>()
  private readonly secret: string
  private readonly audience: string
  private readonly tenantId: string
  private readonly auth: AuthConfig
  private readonly externalEnabled: boolean
  readonly breakGlassEnabled: boolean
  readonly breakGlass: BreakGlassService
  private readonly operatorFailures = operatorFailureLimiter()
  private readonly externalFailures: ExternalFailureAudit

  constructor(private readonly options: LocalIngressOptions) {
    const { env, rbac } = options
    this.externalFailures = new ExternalFailureAudit(rbac.audit)
    const operatorWarning = operatorConfigurationWarning(env)
    if (operatorWarning) console.warn(operatorWarning)
    const hostWarning = externalHostWarning(env)
    if (hostWarning) console.warn(hostWarning)
    try {
      const registered = options.tenants.aliasHostnames?.() ?? []
      for (const warning of aliasStartupWarnings(env, registered)) console.warn(warning)
    } catch {
      // An unreadable registry fails its own requests; it never stops the server starting.
    }
    const configuredSecret = env.SESSION_SECRET
    if (
      env.ENVIRONMENT === 'production' &&
      (!configuredSecret || new TextEncoder().encode(configuredSecret).length < 32)
    ) {
      throw new Error('Production local ingress requires SESSION_SECRET of at least 32 bytes')
    }
    // Ephemeral local key, shared by signing and verification for this process only.
    this.secret = configuredSecret ??
      Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
    this.audience = env.WORKER_NAME ?? 'corpuskit'
    this.externalEnabled = externalLoginConfigured(externalLoginConfig(env))
    this.tenantId = env.ENTRA_TENANT_ID || (this.externalEnabled ? 'external' : '')
    this.auth = {
      clientId: env.ENTRA_CLIENT_ID ?? '',
      clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
      tenantId: env.ENTRA_TENANT_ID ?? '',
      sessionSecret: this.secret,
      redirectUri: env.ENTRA_REDIRECT_URI,
      adminEmails: env.ENTRA_ADMIN_EMAILS,
      externalLogin: { ...externalLoginConfig(env), audience: this.audience },
    }
    this.breakGlass = rbac.breakGlassService({
      passcode: env.ADMIN_PASSCODE,
      environment: env.ENVIRONMENT,
      explicitFlag: env.ADMIN_BREAK_GLASS,
    })
    this.breakGlassEnabled = this.breakGlass.enabled
    if (env.ENTRA_TENANT_ID) {
      rbac.assignmentService(this.tenantId, this.audience)
        .bootstrapAdminEmails(env.ENTRA_ADMIN_EMAILS ?? '')
    }
  }

  readonly requestContext = (request: Request): PortalRequestContext | undefined =>
    this.contexts.get(request)

  /**
   * The portal whose registered alias the request host is, or undefined. Read from the portal
   * registry on every request, so a change applies at once; platform and local hosts never are.
   */
  hostPortal(request: Request): string | undefined {
    const tenants = this.options.tenants
    const platformDomain = this.platformDomain()
    if (!tenants.aliasPortal || platformDomain === null) return undefined
    const lookup = { aliasPortal: (hostname: string) => tenants.aliasPortal!(hostname) }
    // As in the Durable Object, an alias record narrows even a reserved host.
    return hostPortalFor(lookup, new URL(request.url).hostname, platformDomain) ?? undefined
  }

  private platformDomain(): string | null {
    try {
      return getPlatformDomain(this.options.env.PLATFORM_DOMAIN)
    } catch {
      return null
    }
  }

  private hostKind(request: Request): HostKind {
    const platformDomain = this.platformDomain()
    return platformDomain === null ? { kind: 'other' } : classifyHost(
      new URL(request.url).hostname,
      platformDomain,
      reservedHostnames(this.options.env),
    )
  }

  async handle(
    request: Request,
    dispatch: (request: Request) => Response | Promise<Response>,
    info?: PeerInfo,
    session: TrustedSessionFacts | null = null,
  ): Promise<Response> {
    const requestId = crypto.randomUUID()
    const { rbac } = this.options
    let operator: { id: string } | undefined
    const actor = (): AuditActor =>
      operator ? { kind: 'operator', id: `operator:${operator.id}` } : { kind: 'anonymous' }
    const denial = (status: 401 | 403, code = status === 401 ? 'unauthorised' : 'forbidden') =>
      appendAudit(
        rbac.audit,
        createAuditEvent({
          requestId,
          actor: actor(),
          action: 'request.denied',
          scope: { kind: 'platform' },
          target: { kind: 'request' },
          outcome: 'denied',
          detail: { code, method: request.method },
        }),
      )
    try {
      const path = new URL(request.url).pathname
      const hostPortal = this.hostPortal(request)
      const host = this.hostKind(request)
      // As in the Worker: with UNKNOWN_HOSTS=deny, only platform, reserved and alias hosts answer.
      if (
        hostPortal === undefined && (host.kind === 'candidate' || host.kind === 'other') &&
        unknownHostsMode(this.options.env.UNKNOWN_HOSTS) === 'deny'
      ) {
        return Response.json({ error: 'not_found' }, {
          status: 404,
          headers: { 'cache-control': 'no-store' },
        })
      }
      // As in the Worker, a session issued on an alias or other candidate host is sealed to it
      // and read nowhere else, and an external assertion there must name it.
      const auth: AuthConfig = host.kind === 'candidate' || hostPortal !== undefined
        ? { ...this.auth, sessionHost: normaliseHostname(new URL(request.url).hostname) }
        : this.auth
      const headers = stripIdentityHeaders(request.headers)
      // As in the Worker, an explicit operator credential is decided before sign-in routes or
      // sessions: it is the whole authority, and no session cookie is read beside it.
      const credential = await authenticateOperator(request, this.options.env)
      if (credential.kind === 'rejected') throw new InvalidOperatorCredential()
      if (credential.kind === 'verified') {
        operator = { id: credential.id }
        if (headers.has('x-admin-passcode')) throw new InvalidOperatorCredential()
        session = null
        headers.delete('authorization')
        headers.delete('cookie')
        try {
          headers.set(
            PRINCIPAL_HEADER,
            await signPrincipal(operatorEnvelope(operator.id, this.audience), this.secret),
          )
        } catch {
          throw new InvalidLocalPrincipal()
        }
      } else {
        // A portal's alias host serves that portal alone, as in the Worker.
        if (hostPortal !== undefined) {
          const decision = aliasHostRoute(request.method, new URL(request.url), hostPortal)
          if (decision.kind === 'redirect') {
            return new Response(null, { status: 308, headers: { location: decision.location } })
          }
          if (decision.kind === 'not_found') {
            return decision.api
              ? Response.json({ error: 'not_found' }, { status: 404 })
              : new Response('Not found', {
                status: 404,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              })
          }
        }
        // Only the external handoff and sign-out are served locally; the Entra flow is unchanged.
        if (path === '/auth/external' || path === '/auth/logout') {
          return (await handleAuthRequest(request, auth, {
            consume: (key, expiresAt) => {
              if (!this.options.externalReplays) throw new Error('Replay store unavailable')
              return this.options.externalReplays.consume(key, expiresAt)
            },
            auditFailure: (reason) => this.externalFailures.record(reason, peerAddress(info)),
          })) ?? Response.json({ error: 'not_found' }, { status: 404 })
        }
        // The local server reads only the sessions it can issue: external handoff cookies.
        if (!session && this.externalEnabled && sessionAuthConfigured(auth)) {
          const user = await authUser(request, auth)
          if (user?.sessionFacts.provenance === 'external') session = user.sessionFacts
        }
      }
      if (session) {
        if (
          !validSessionFacts(session) ||
          (session.tenantId === 'external'
            ? !this.externalEnabled
            : session.tenantId !== this.tenantId)
        ) {
          throw new InvalidLocalPrincipal()
        }
        try {
          headers.set(
            PRINCIPAL_HEADER,
            await signPrincipal({
              v: 1,
              aud: this.audience as SessionEnvelope['aud'],
              tid: session.tenantId,
              oid: session.oid,
              email: session.email ?? '',
              name: '',
              roles: session.roles,
              groups: session.groups,
              iat: Math.floor(Date.now() / 1000),
            }, this.secret),
          )
        } catch {
          throw new InvalidLocalPrincipal()
        }
      }
      const verified = await verifyPrincipal(headers.get(PRINCIPAL_HEADER), {
        sessionSecret: this.secret,
        audience: this.audience,
        tenantId: this.tenantId,
        operatorId: configuredOperatorId(this.options.env),
        externalLoginEnabled: this.externalEnabled,
      })
      if (verified.kind === 'rejected') throw new InvalidLocalPrincipal()
      if (session) {
        const result = rbac.assignmentService(this.tenantId, this.audience, this.externalEnabled)
          .activate(session, {
            requestId,
            actor: { kind: 'user', id: session.oid },
          })
        if (!result.ok && result.code === 'invalid_principal') throw new InvalidLocalPrincipal()
      }
      const clientIp = info?.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : undefined
      let principal: PortalRequestContext
      let resolution: RoleResolution | undefined
      if (operator) {
        if (verified.kind !== 'verified' || verified.envelope.kind !== 'operator') {
          throw new InvalidLocalPrincipal()
        }
        principal = operatorRequestContext(verified.envelope.id, requestId, clientIp)
        if (!path.startsWith('/api/') || hostPortal !== undefined) {
          denial(403, 'operator_not_allowed')
          return Response.json({ error: 'operator_not_allowed' }, { status: 403 })
        }
      } else {
        resolution = await resolveEffectiveRoles(session, {
          rbac,
          tenants: this.options.tenants,
          audience: this.audience,
          externalLoginEnabled: this.externalEnabled,
        }, this.tenantId)
        principal = {
          requestId,
          session,
          ...resolution,
          clientIp,
          coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
          user: verified.kind === 'verified' && verified.envelope.kind !== 'operator'
            ? {
              id: verified.envelope.oid,
              tenantId: verified.envelope.tid,
              email: verified.envelope.email,
              name: verified.envelope.name,
              roles: verified.envelope.roles,
            }
            : null,
        }
      }
      if (path.startsWith('/__corpuskit/')) {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (resolution && path === '/auth/me' && request.method === 'GET') {
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
            const current = this.options.tenants.get?.(slug.data)
            if (current) {
              tenant = { ...current, disabled: this.options.tenants.isDisabled?.(slug.data) }
            }
          }
        } catch {
          // Unavailable policy has the same safe projection as a missing portal.
        }
        // An alias host describes the caller's roles in its own portal only, as in the Worker.
        const described = hostPortal === undefined
          ? { effectiveRoles: resolution.effectiveRoles, provenance: resolution.provenance }
          : narrowRolesToPortal(resolution.effectiveRoles, resolution.provenance, hostPortal)
        return Response.json({
          ...buildUiAccessSnapshot({
            externalLoginEnabled: this.externalEnabled,
            session,
            effectiveRoles: resolution.effectiveRoles,
            configuredTenantId: this.tenantId,
            selectedSlug,
            tenant,
          }),
          enabled: sessionAuthConfigured(auth),
          // Never on an alias host, as in the Worker.
          entraEnabled: authConfigured(auth) && hostPortal === undefined,
          externalLogin: externalLoginPresentation(this.auth.externalLogin),
          externalLoginEnabled: this.externalEnabled,
          sessionProvenance: session ? session.provenance ?? 'entra' : null,
          authenticated: session !== null,
          user: principal.user
            ? {
              ...principal.user,
              provenance: session?.provenance ?? 'entra',
              isAdmin: principal.coarseAdminEligible,
            }
            : null,
          effectiveRoles: described.effectiveRoles,
          provenance: described.provenance,
          claimAgeSeconds: session
            ? Math.max(0, Math.floor((Date.now() - session.claimIssuedAt) / 1000))
            : null,
          groupStatus: session?.groupStatus ?? 'unverified',
          groupMappings: resolution.groupCapability,
          coarseAdminEligible: principal.coarseAdminEligible,
          breakGlassEnabled: this.breakGlassEnabled,
        }, { headers: { 'cache-control': 'no-store' } })
      }
      const cleanHeaders = stripIdentityHeaders(headers)
      // Preserve explicit credentials so the shared gate refuses and audits ineligible attempts.
      const forwarded = new Request(request, { headers: cleanHeaders })
      if (hostPortal !== undefined) principal.hostPortal = hostPortal
      this.contexts.set(forwarded, principal)
      try {
        const response = await dispatch(forwarded)
        if ((response.status === 401 || response.status === 403) && !principal.denialAudited) {
          appendAudit(
            rbac.audit,
            createAuditEvent({
              requestId,
              actor: operator ? actor() : session ? { kind: 'user', id: session.oid } : actor(),
              action: 'request.denied',
              scope: { kind: 'platform' },
              target: { kind: 'request' },
              outcome: 'denied',
              detail: {
                method: request.method,
                code: response.status === 401 ? 'unauthorised' : 'forbidden',
              },
            }),
          )
        }
        return response
      } finally {
        this.contexts.delete(forwarded)
      }
    } catch (error) {
      if (error instanceof InvalidLocalPrincipal || error instanceof InvalidOperatorCredential) {
        if (error instanceof InvalidOperatorCredential) {
          const { allowed, retryAfterSec } = this.operatorFailures.check(peerAddress(info))
          if (!allowed) {
            return Response.json({ error: 'rate_limited' }, {
              status: 429,
              headers: { 'retry-after': String(retryAfterSec) },
            })
          }
        }
        try {
          denial(401)
        } catch {
          console.error('Local ingress audit write failed')
          return Response.json({ error: 'audit_write_failed' }, { status: 500 })
        }
        return Response.json({
          error: error instanceof InvalidOperatorCredential
            ? 'invalid_operator'
            : 'invalid_principal',
        }, { status: 401 })
      }
      console.error('Local trusted request failed')
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }
  }
}
