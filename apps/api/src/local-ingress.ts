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
  authenticateOperator,
  configuredOperatorId,
  operatorConfigurationWarning,
  operatorEnvelope,
  operatorFailureLimiter,
  operatorRequestContext,
} from './operator.ts'

interface LocalIngressOptions {
  rbac: RbacState
  tenants: { list(): { slug: string }[] } & Partial<Pick<TenantStoreApi, 'get' | 'isDisabled'>>
  env: Record<string, string | undefined>
}
type PeerInfo = Pick<Deno.ServeHandlerInfo<Deno.NetAddr>, 'remoteAddr'>
class InvalidLocalPrincipal extends Error {}
class InvalidOperatorCredential extends Error {}

/** Trusted local adapter. Session fixtures are in-process arguments, never HTTP input. */
export class LocalIngress {
  private readonly contexts = new WeakMap<Request, PortalRequestContext>()
  private readonly secret: string
  private readonly audience: string
  private readonly tenantId: string
  readonly breakGlassEnabled: boolean
  readonly breakGlass: BreakGlassService
  private readonly operatorFailures = operatorFailureLimiter()

  constructor(private readonly options: LocalIngressOptions) {
    const { env, rbac } = options
    const operatorWarning = operatorConfigurationWarning(env)
    if (operatorWarning) console.warn(operatorWarning)
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
    this.tenantId = env.ENTRA_TENANT_ID ?? ''
    this.breakGlass = rbac.breakGlassService({
      passcode: env.ADMIN_PASSCODE,
      environment: env.ENVIRONMENT,
      explicitFlag: env.ADMIN_BREAK_GLASS,
    })
    this.breakGlassEnabled = this.breakGlass.enabled
    if (this.tenantId) {
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
      const headers = stripIdentityHeaders(request.headers)
      const credential = await authenticateOperator(request, this.options.env)
      if (credential.kind === 'rejected') throw new InvalidOperatorCredential()
      if (credential.kind === 'verified') {
        operator = { id: credential.id }
        if (headers.has('x-admin-passcode')) throw new InvalidOperatorCredential()
        session = null
        headers.delete('authorization')
        try {
          headers.set(
            PRINCIPAL_HEADER,
            await signPrincipal(operatorEnvelope(operator.id, this.audience), this.secret),
          )
        } catch {
          throw new InvalidLocalPrincipal()
        }
      } else if (session) {
        if (!validSessionFacts(session) || session.tenantId !== this.tenantId) {
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
      })
      if (verified.kind === 'rejected') throw new InvalidLocalPrincipal()
      if (session) {
        const result = rbac.assignmentService(this.tenantId, this.audience).activate(session, {
          requestId,
          actor: { kind: 'user', id: session.oid },
        })
        if (!result.ok && result.code === 'invalid_principal') throw new InvalidLocalPrincipal()
      }
      const clientIp = info?.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : undefined
      const path = new URL(request.url).pathname
      let principal: PortalRequestContext
      let resolution: RoleResolution | undefined
      if (operator) {
        if (verified.kind !== 'verified' || verified.envelope.kind !== 'operator') {
          throw new InvalidLocalPrincipal()
        }
        principal = operatorRequestContext(verified.envelope.id, requestId, clientIp)
        if (!path.startsWith('/api/')) {
          denial(403, 'operator_not_allowed')
          return Response.json({ error: 'operator_not_allowed' }, { status: 403 })
        }
      } else {
        resolution = await resolveEffectiveRoles(session, {
          rbac,
          tenants: this.options.tenants,
          audience: this.audience,
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
            session,
            effectiveRoles: resolution.effectiveRoles,
            configuredTenantId: this.tenantId,
            selectedSlug,
            tenant,
          }),
          authenticated: session !== null,
          user: principal.user
            ? { ...principal.user, isAdmin: principal.coarseAdminEligible }
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
          const peer = info?.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : 'unknown'
          const { allowed, retryAfterSec } = this.operatorFailures.check(peer)
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
