import {
  type AuthConfig,
  authConfigured,
  authUser,
  handleAuthRequest,
  sessionAuthConfigured,
} from '../../cloudflare/src/auth.ts'
import {
  auditExternalLoginFailure,
  externalLoginConfig,
  externalLoginConfigured,
  externalLoginPresentation,
  type ExternalLoginReplayStore,
} from './external-login.ts'
import type { PortalRequestContext } from './app.ts'
import { coarseAdminEligibility, resolveEffectiveRoles } from './assignments.ts'
import { appendAudit, createAuditEvent } from './audit.ts'
import { type BreakGlassService } from './break-glass.ts'
import {
  PRINCIPAL_HEADER,
  type PrincipalEnvelope,
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

interface LocalIngressOptions {
  rbac: RbacState
  tenants: { list(): { slug: string }[] } & Partial<Pick<TenantStoreApi, 'get' | 'isDisabled'>>
  externalReplays?: ExternalLoginReplayStore
  env: Record<string, string | undefined>
}
type PeerInfo = Pick<Deno.ServeHandlerInfo<Deno.NetAddr>, 'remoteAddr'>
class InvalidLocalPrincipal extends Error {}

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

  constructor(private readonly options: LocalIngressOptions) {
    const { env, rbac } = options
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

  async handle(
    request: Request,
    dispatch: (request: Request) => Response | Promise<Response>,
    info?: PeerInfo,
    session: TrustedSessionFacts | null = null,
  ): Promise<Response> {
    const requestId = crypto.randomUUID()
    const { rbac } = this.options
    const denial = (status: 401 | 403) =>
      appendAudit(
        rbac.audit,
        createAuditEvent({
          requestId,
          actor: { kind: 'anonymous' },
          action: 'request.denied',
          scope: { kind: 'platform' },
          target: { kind: 'request' },
          outcome: 'denied',
          detail: { code: status === 401 ? 'unauthorised' : 'forbidden', method: request.method },
        }),
      )
    try {
      const path = new URL(request.url).pathname
      // Only the external handoff and sign-out are served locally; the Entra flow is unchanged.
      if (path === '/auth/external' || path === '/auth/logout') {
        return (await handleAuthRequest(request, this.auth, {
          consume: (key, expiresAt) => {
            if (!this.options.externalReplays) throw new Error('Replay store unavailable')
            return this.options.externalReplays.consume(key, expiresAt)
          },
          auditFailure: (reason) => auditExternalLoginFailure(rbac.audit, reason),
        })) ?? Response.json({ error: 'not_found' }, { status: 404 })
      }
      // The local server reads only the sessions it can issue: external handoff cookies.
      if (!session && this.externalEnabled && sessionAuthConfigured(this.auth)) {
        const user = await authUser(request, this.auth)
        if (user?.sessionFacts.provenance === 'external') session = user.sessionFacts
      }
      const headers = stripIdentityHeaders(request.headers)
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
              aud: this.audience as PrincipalEnvelope['aud'],
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
      const resolution = await resolveEffectiveRoles(session, {
        rbac,
        tenants: this.options.tenants,
        audience: this.audience,
        externalLoginEnabled: this.externalEnabled,
      }, this.tenantId)
      const principal: PortalRequestContext = {
        requestId,
        session,
        ...resolution,
        clientIp: info?.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : undefined,
        coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
        user: verified.kind === 'verified'
          ? {
            id: verified.envelope.oid,
            tenantId: verified.envelope.tid,
            email: verified.envelope.email,
            name: verified.envelope.name,
            roles: verified.envelope.roles,
          }
          : null,
      }
      if (path.startsWith('/__corpuskit/')) {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (path === '/auth/me' && request.method === 'GET') {
        const selections = new URL(request.url).searchParams.getAll('portal')
        const selectedSlug = selections.length === 1 ? selections[0] : undefined
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
        return Response.json({
          ...buildUiAccessSnapshot({
            externalLoginEnabled: this.externalEnabled,
            session,
            effectiveRoles: resolution.effectiveRoles,
            configuredTenantId: this.tenantId,
            selectedSlug,
            tenant,
          }),
          enabled: sessionAuthConfigured(this.auth),
          entraEnabled: authConfigured(this.auth),
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
          effectiveRoles: resolution.effectiveRoles,
          provenance: resolution.provenance,
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
      this.contexts.set(forwarded, principal)
      try {
        const response = await dispatch(forwarded)
        if ((response.status === 401 || response.status === 403) && !principal.denialAudited) {
          appendAudit(
            rbac.audit,
            createAuditEvent({
              requestId,
              actor: session ? { kind: 'user', id: session.oid } : { kind: 'anonymous' },
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
      if (error instanceof InvalidLocalPrincipal) {
        try {
          denial(401)
        } catch {
          console.error('Local ingress audit write failed')
          return Response.json({ error: 'audit_write_failed' }, { status: 500 })
        }
        return Response.json({ error: 'invalid_principal' }, { status: 401 })
      }
      console.error('Local trusted request failed')
      return Response.json({ error: 'internal_error' }, { status: 500 })
    }
  }
}
