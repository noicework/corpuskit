import {
  authorize,
  EffectiveRolesSchema,
  normalisePrincipal,
  PermissionSchema,
  PlatformRoleSchema,
  PortalRoleSchema,
  RoleSchema,
  ScopeSchema,
} from '@research-portal/core'
import { z } from 'zod'

export interface AuthUser {
  id: string
  tenantId: string
  name: string
  email: string
  roles: string[]
  isAdmin: boolean
  provenance?: 'entra' | 'external'
}

const enabledCapability = z.unknown().transform((value) => value === true)
const snapshotSchema = z.object({
  entraEnabled: z.boolean().optional(),
  externalLogin: z.object({
    name: z.string().trim().min(1).default('Continue with your organisation account'),
    startUrl: z.string().url().refine((value) => {
      try {
        const url = new URL(value)
        return !url.username && !url.password &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch {
        return false
      }
    }),
  }).strict().nullable().default(null),
  externalLoginEnabled: z.boolean().optional(),
  sessionProvenance: z.enum(['entra', 'external']).nullable().optional(),
  authenticated: z.boolean(),
  user: z.object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    name: z.string(),
    email: z.string(),
    roles: z.array(z.string()),
    isAdmin: z.boolean(),
    provenance: z.enum(['entra', 'external']).optional(),
  }).nullable(),
  effectiveRoles: EffectiveRolesSchema,
  provenance: z.array(
    z.object({
      source: z.enum(['app-role', 'group', 'local']),
      scope: ScopeSchema,
      role: RoleSchema,
    }).strict(),
  ),
  claimAgeSeconds: z.number().finite().nonnegative().nullable(),
  groupMappings: z.enum([
    'enabled',
    'disabled',
    'complete',
    'absent',
    'malformed',
    'overage',
    'unverified',
  ]).catch('disabled'),
  groupStatus: z.enum(['complete', 'absent', 'malformed', 'overage', 'unverified']).optional(),
  coarseAdminEligible: enabledCapability,
  breakGlassEnabled: enabledCapability,
  platformPermissions: z.array(PermissionSchema),
  portalAccess: z.object({
    slug: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    permissions: z.array(PermissionSchema),
    effectiveRole: PortalRoleSchema.nullable(),
    available: z.boolean(),
    canEnable: enabledCapability,
  }).nullable(),
}).superRefine((session, context) => {
  const portal = session.portalAccess
  const identity = session.user
    ? { kind: 'user', tenantId: session.user.tenantId, oid: session.user.id }
    : { kind: 'anonymous' }
  // A validation ceiling only. Public policy adds at most the implicit viewer floor;
  // the returned permission lists remain the sole source of displayed authority.
  const principal = normalisePrincipal(
    identity,
    session.effectiveRoles,
    portal
      ? {
        slug: portal.slug,
        accessMode: 'public',
        configuredTenantId: session.user?.tenantId ?? 'anonymous',
      }
      : undefined,
  )
  const inconsistentPermissions = session.platformPermissions.some((permission) =>
    !authorize(principal, permission, { kind: 'platform' })
  ) ||
    portal?.permissions.some((permission) =>
      !authorize(principal, permission, { kind: 'portal', slug: portal.slug })
    )
  const inconsistentProvenance = session.provenance.some((entry) =>
    !(entry.scope.kind === 'platform' ? PlatformRoleSchema : PortalRoleSchema).safeParse(entry.role)
      .success
  )
  if (
    portal?.canEnable &&
    (portal.available ||
      !authorize(principal, 'behaviour.write', { kind: 'portal', slug: portal.slug }))
  ) {
    portal.canEnable = false
  }
  if (
    inconsistentPermissions || inconsistentProvenance ||
    session.authenticated !== (session.user !== null) ||
    (!session.authenticated &&
      (session.platformPermissions.length > 0 || session.effectiveRoles.platformRole ||
        session.effectiveRoles.portalRoles.length > 0 || session.provenance.length > 0 ||
        session.coarseAdminEligible || session.claimAgeSeconds !== null || portal?.canEnable)) ||
    (portal && !portal.available &&
      (portal.permissions.length > 0 || portal.effectiveRole !== null)) ||
    (portal?.available &&
      (!portal.permissions.includes('portal.read') || portal.effectiveRole === null))
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent access snapshot' })
  }
})

export type AuthSession = z.infer<typeof snapshotSchema> & { status: 'ready' }

/** A failed access check is never a successful anonymous session. */
export class AuthSessionError extends Error {
  readonly status = 'unavailable'
  readonly platformPermissions = Object.freeze([])
  readonly portalAccess = null
  readonly breakGlassEnabled = false
  readonly coarseAdminEligible = false
  constructor(
    readonly reason: 'network' | 'malformed' | 'aborted' | 'http',
    readonly httpStatus = 0,
  ) {
    super('Access could not be checked')
    this.name = 'AuthSessionError'
  }
}

export function parseAuthSession(value: unknown, slug?: string): AuthSession {
  const parsed = snapshotSchema.safeParse(value)
  if (
    !parsed.success || (slug !== undefined && parsed.data.portalAccess?.slug !== slug) ||
    (slug === undefined && parsed.data.portalAccess !== null)
  ) throw new AuthSessionError('malformed')
  return freezeSnapshot({ ...parsed.data, status: 'ready' })
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

export async function getAuthSession(
  options: { slug?: string; signal?: AbortSignal } = {},
): Promise<AuthSession> {
  const { slug, signal } = options
  try {
    signal?.throwIfAborted()
    const response = await fetch(
      `/auth/me${slug === undefined ? '' : `?portal=${encodeURIComponent(slug)}`}`,
      {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      },
    )
    signal?.throwIfAborted()
    if (!response.ok) throw new AuthSessionError('http', response.status)
    const value: unknown = await response.json()
    signal?.throwIfAborted()
    return parseAuthSession(value, slug)
  } catch (error) {
    if (signal?.aborted) throw new AuthSessionError('aborted')
    if (error instanceof AuthSessionError) throw error
    throw new AuthSessionError(error instanceof SyntaxError ? 'malformed' : 'network')
  }
}

export function microsoftLoginUrl(returnTo = `${location.pathname}${location.search}`): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
}
