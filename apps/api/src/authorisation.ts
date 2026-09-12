import {
  authorize,
  type EffectiveRoles,
  EffectiveRolesSchema,
  normalisePrincipal,
  PermissionSchema,
  type PortalPolicy,
  PortalPolicySchema,
  type Scope,
  ScopeSchema,
} from '@research-portal/core'
import type { PortalRequestContext } from './app.ts'
import {
  appendAudit,
  type AuditActor,
  type AuditStore,
  AuditWriteError,
  createAuditEvent,
} from './audit.ts'
import type { BreakGlassService } from './break-glass.ts'
import type { SubAction } from './permissions.ts'
import { type TrustedSessionFacts, validSessionFacts } from './principal.ts'
import { type ResearchOwner, researchOwnerValue } from './research-owner.ts'
import {
  type ScopedKeyDependencies,
  type VerifiedScopedKey,
  verifyScopedKey,
} from './scoped-keys.ts'
import type { TenantStoreApi } from './tenants.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'

export type RequestAuthority =
  | { kind: 'anonymous'; actor: AuditActor; provenanceSession: null }
  | {
    kind: 'session'
    actor: AuditActor
    session: TrustedSessionFacts
    effectiveRoles: EffectiveRoles
    provenanceSession: TrustedSessionFacts
  }
  | (VerifiedScopedKey & { provenanceSession: TrustedSessionFacts | null })
  | { kind: 'break-glass'; actor: AuditActor; provenanceSession: TrustedSessionFacts | null }

export interface AuthorityDependencies extends ScopedKeyDependencies {
  tenants: Pick<TenantStoreApi, 'get' | 'isDisabled'>
  breakGlass: Pick<BreakGlassService, 'authorise'>
  audit: Pick<AuditStore, 'append'>
}
export class AuthorisationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code = status === 401 ? 'unauthorised' : 'forbidden',
    readonly retryAfter?: number,
  ) {
    super(code)
    this.name = 'AuthorisationError'
  }
}
interface AuthorityState {
  context: Pick<PortalRequestContext, 'requestId' | 'denialAudited'>
  deps: AuthorityDependencies
  request: Request
  failure?: Error
}
const states = new WeakMap<RequestAuthority, AuthorityState>()
const selections = new WeakMap<Request, Promise<RequestAuthority>>()
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(value)

function refuse(
  state: AuthorityState,
  actor: AuditActor,
  scope: Scope,
  permission?: unknown,
  status: 401 | 403 = actor.kind === 'anonymous' ? 401 : 403,
  retryAfter?: number,
): never {
  if (state.failure) throw state.failure
  try {
    if (!state.context.denialAudited) {
      appendAudit(
        state.deps.audit,
        createAuditEvent({
          requestId: state.context.requestId,
          actor,
          action: 'request.denied',
          scope,
          target: { kind: 'request' },
          outcome: 'denied',
          detail: {
            code: status === 401 ? 'unauthorised' : 'forbidden',
            ...(PermissionSchema.safeParse(permission).success ? { permission } : {}),
            ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
                state.request.method,
              )
              ? { method: state.request.method }
              : {}),
          },
        }, state.deps.now),
      )
      state.context.denialAudited = true
    }
    state.failure = new AuthorisationError(status, undefined, retryAfter)
  } catch {
    state.failure = new AuditWriteError()
  }
  throw state.failure
}

/** Trusted request context only. No header, cookie or explicit credential can contribute session roles. */
export function selectRequestAuthority(
  request: Request,
  context: PortalRequestContext,
  deps: AuthorityDependencies,
): Promise<RequestAuthority> {
  const prior = selections.get(request)
  if (prior) return prior
  const result = select(request, context, deps)
  selections.set(request, result)
  return result
}
async function select(
  request: Request,
  context: PortalRequestContext,
  deps: AuthorityDependencies,
): Promise<RequestAuthority> {
  const state: AuthorityState = { request, context, deps }
  const path = new URL(request.url).pathname
  const slug = /^\/api\/t\/([A-Za-z0-9_-]{1,64})\//.exec(path)?.[1]
  const scope: Scope = slug ? { kind: 'portal', slug } : { kind: 'platform' }
  const session = context.session
  const sessionValid = session !== null && validSessionFacts(session, (deps.now ?? Date.now)()) &&
    identifier(session.tenantId) && identifier(session.oid)
  if (!identifier(deps.configuredTenantId) || (session !== null && !sessionValid)) {
    refuse(state, { kind: 'anonymous' }, scope)
  }
  const provenanceSession = sessionValid ? structuredClone(session) : null
  const actor: AuditActor = provenanceSession
    ? { kind: 'user', id: provenanceSession.oid }
    : { kind: 'anonymous' }
  const hasBearer = request.headers.has('authorization')
  const hasPasscode = request.headers.has('x-admin-passcode')
  if (hasBearer && hasPasscode) refuse(state, actor, scope)
  let authority: RequestAuthority
  if (hasBearer) {
    const header = request.headers.get('authorization')!
    const token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header)?.[1]
    if (!token || !slug) refuse(state, actor, scope)
    // Registry availability and policy corruption cannot make a key public.
    try {
      const tenant = deps.tenants.get(slug)
      if (
        !tenant || deps.tenants.isDisabled(slug) ||
        !PortalPolicySchema.safeParse({
          slug: tenant.slug,
          accessMode: tenant.accessMode,
          configuredTenantId: deps.configuredTenantId,
        }).success
      ) refuse(state, actor, scope)
    } catch (error) {
      if (error instanceof AuditWriteError || error instanceof AuthorisationError) throw error
      refuse(state, actor, scope)
    }
    let key: VerifiedScopedKey | null
    try {
      key = await verifyScopedKey(token, slug, deps)
    } catch {
      refuse(state, actor, scope)
    }
    if (!key) refuse(state, actor, scope)
    authority = { ...key, provenanceSession }
  } else if (hasPasscode) {
    const result = await deps.breakGlass.authorise(request, {
      requestId: context.requestId,
      clientIp: context.clientIp,
      session: provenanceSession,
    })
    if (!result.ok) {
      // The service records break-glass failure; record the request denial once as well.
      refuse(
        state,
        actor,
        scope,
        undefined,
        result.code === 'invalid_passcode' ? 401 : 403,
        result.retryAfter,
      )
    }
    authority = { kind: 'break-glass', actor: result.actor, provenanceSession }
  } else if (provenanceSession) {
    const roles = EffectiveRolesSchema.safeParse(context.effectiveRoles)
    if (!roles.success) refuse(state, actor, scope)
    // Foreign signed identities may browse public portals, but never carry configured-tenant grants.
    authority = {
      kind: 'session',
      session: provenanceSession,
      provenanceSession,
      actor,
      effectiveRoles: provenanceSession.tenantId === deps.configuredTenantId
        ? roles.data
        : { portalRoles: [] },
    }
  } else authority = { kind: 'anonymous', actor, provenanceSession: null }
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
    Object.freeze(value)
  }
  freeze(authority)
  states.set(authority, state)
  return authority
}

function stateFor(authority: RequestAuthority): AuthorityState {
  const state = states.get(authority)
  if (!state) throw new AuthorisationError(403)
  if (state.failure) throw state.failure
  return state
}
function policyFor(authority: RequestAuthority, input: unknown): PortalPolicy {
  const state = stateFor(authority)
  const parsed = PortalPolicySchema.safeParse(input)
  if (!parsed.success || parsed.data.configuredTenantId !== state.deps.configuredTenantId) {
    refuse(state, authority.actor, { kind: 'platform' })
  }
  const policy = parsed.data
  try {
    const current = state.deps.tenants.get(policy.slug)
    const enabling = state.request.method === 'POST' &&
      new URL(state.request.url).pathname === `/api/admin/t/${policy.slug}/enable`
    if (
      !current || current.slug !== policy.slug || current.accessMode !== policy.accessMode ||
      (!enabling && state.deps.tenants.isDisabled(policy.slug))
    ) refuse(state, authority.actor, { kind: 'portal', slug: policy.slug })
  } catch (error) {
    if (error instanceof AuditWriteError || error instanceof AuthorisationError) throw error
    refuse(state, authority.actor, { kind: 'portal', slug: policy.slug })
  }
  return policy
}

/** Throw before dispatch on refusal; successful privileged completion remains caller-owned. */
export function authoriseOperation(
  authority: RequestAuthority,
  permission: unknown,
  scopeInput: unknown,
  policyInput?: unknown,
): true {
  const state = stateFor(authority)
  const parsed = ScopeSchema.safeParse(scopeInput)
  if (!parsed.success) refuse(state, authority.actor, { kind: 'platform' }, permission)
  const scope = parsed.data
  const policy = scope.kind === 'portal' ? policyFor(authority, policyInput) : undefined
  if (scope.kind === 'portal' && policy?.slug !== scope.slug) {
    refuse(state, authority.actor, scope, permission)
  }
  let principal
  if (authority.kind === 'key') {
    if (scope.kind !== 'portal' || scope.slug !== authority.slug) {
      refuse(state, authority.actor, scope, permission)
    }
    principal = normalisePrincipal({
      kind: 'user',
      tenantId: state.deps.configuredTenantId,
      oid: authority.id,
    }, { portalRoles: [{ slug: authority.slug, role: authority.role }] })
  } else if (authority.kind === 'break-glass') {
    principal = normalisePrincipal({
      kind: 'user',
      tenantId: state.deps.configuredTenantId,
      oid: 'break-glass',
    }, { platformRole: 'owner', portalRoles: [] })
  } else {
    principal = normalisePrincipal(
      authority.kind === 'session'
        ? { kind: 'user', tenantId: authority.session.tenantId, oid: authority.session.oid }
        : { kind: 'anonymous' },
      authority.kind === 'session' ? authority.effectiveRoles : { portalRoles: [] },
      policy,
    )
  }
  if (!authorize(principal, permission, scope)) refuse(state, authority.actor, scope, permission)
  return true
}

/** D1 platform implication for the validated new portal before it can exist in the store. */
export function authoriseNewPortalDomain(authority: RequestAuthority, slugInput: unknown): true {
  const state = stateFor(authority)
  const slug = KeyPortalSlugSchema.safeParse(slugInput)
  if (
    !slug.success || state.request.method !== 'POST' ||
    new URL(state.request.url).pathname !== '/api/admin/tenants'
  ) {
    return refuse(state, authority.actor, { kind: 'platform' }, 'domains.write')
  }
  authoriseOperation(authority, 'portal.create', { kind: 'platform' })
  const scope: Scope = { kind: 'portal', slug: slug.data }
  try {
    if (state.deps.tenants.get(slug.data)) {
      return refuse(state, authority.actor, scope, 'domains.write')
    }
  } catch (error) {
    if (error instanceof AuditWriteError || error instanceof AuthorisationError) throw error
    return refuse(state, authority.actor, scope, 'domains.write')
  }
  const principal = authority.kind === 'session'
    ? normalisePrincipal({
      kind: 'user',
      tenantId: authority.session.tenantId,
      oid: authority.session.oid,
    }, authority.effectiveRoles)
    : authority.kind === 'break-glass'
    ? normalisePrincipal({
      kind: 'user',
      tenantId: state.deps.configuredTenantId,
      oid: 'break-glass',
    }, { platformRole: 'owner', portalRoles: [] })
    : normalisePrincipal({ kind: 'anonymous' }, { portalRoles: [] })
  if (!authorize(principal, 'domains.write', scope)) {
    return refuse(state, authority.actor, scope, 'domains.write')
  }
  return true
}

export function authoriseSubActions(
  authority: RequestAuthority,
  declarations: readonly Pick<SubAction, 'permission' | 'scope'>[],
  scope: Scope,
  policy?: unknown,
): true {
  const state = stateFor(authority)
  if (!Array.isArray(declarations) || declarations.length === 0) {
    refuse(state, authority.actor, scope)
  }
  for (const declaration of declarations) {
    if (!declaration || declaration.scope !== scope.kind) refuse(state, authority.actor, scope)
    authoriseOperation(authority, declaration.permission, scope, policy)
  }
  return true
}

export function researchOwner(
  authority: RequestAuthority,
  policyInput: unknown,
  clientId: unknown,
): ResearchOwner {
  const state = stateFor(authority)
  const policy = policyFor(authority, policyInput)
  const scope: Scope = { kind: 'portal', slug: policy.slug }
  if (authority.kind === 'key') refuse(state, authority.actor, scope)
  const session = authority.provenanceSession
  if (session?.tenantId === state.deps.configuredTenantId) {
    try {
      return researchOwnerValue({ kind: 'user', tenantId: session.tenantId, oid: session.oid })
    } catch {
      return refuse(state, authority.actor, scope)
    }
  }
  if (
    authority.kind === 'anonymous' && policy.accessMode === 'public' && identifier(clientId) &&
    clientId !== 'anonymous'
  ) {
    try {
      return researchOwnerValue({ kind: 'anonymous', clientId })
    } catch {
      return refuse(state, authority.actor, scope)
    }
  }
  return refuse(state, authority.actor, scope)
}
