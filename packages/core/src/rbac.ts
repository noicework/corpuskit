import { z } from 'zod'

export const PORTAL_ROLES = Object.freeze(['viewer', 'analyst', 'curator', 'portal-admin'] as const)
export const PLATFORM_ROLES = Object.freeze(['platform-admin', 'owner'] as const)
export const ROLES = Object.freeze([...PORTAL_ROLES, ...PLATFORM_ROLES] as const)
export const ACCESS_MODES = Object.freeze(['public', 'authenticated', 'restricted'] as const)
export const PERMISSIONS = Object.freeze(
  [
    'portal.read',
    'portal.ask',
    'portal.generate',
    'portal.investigate',
    'portal.export',
    'portal.watch',
    'content.write',
    'taxonomy.write',
    'enrichments.write',
    'graph.write',
    'behaviour.write',
    'appearance.write',
    'bindings.write',
    'domains.write',
    'keys.manage',
    'members.manage',
    'portal.create',
    'portal.delete',
    'platform.members.manage',
    'platform.settings.write',
    'audit.read',
    'audit.export',
  ] as const,
)

export const PortalRoleSchema = z.enum(PORTAL_ROLES)
export type PortalRole = z.infer<typeof PortalRoleSchema>
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES)
export type PlatformRole = z.infer<typeof PlatformRoleSchema>
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>
export const PermissionSchema = z.enum(PERMISSIONS)
export type Permission = z.infer<typeof PermissionSchema>
export const AccessModeSchema = z.enum(ACCESS_MODES)
export type AccessMode = z.infer<typeof AccessModeSchema>

export const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z.object({ kind: z.literal('portal'), slug: z.string().min(1) }).strict(),
])
export type Scope = z.infer<typeof ScopeSchema>

/** Shape validation only. Trusted adapters must verify the identity before using this core. */
export const PrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anonymous') }).strict(),
  z.object({
    kind: z.literal('user'),
    tenantId: z.string().min(1),
    oid: z.string().min(1),
  }).strict(),
])
export type Principal = z.infer<typeof PrincipalSchema>

/** Already effective roles, with source resolution owned by the trusted caller. */
export const EffectiveRolesSchema = z.object({
  platformRole: PlatformRoleSchema.optional(),
  portalRoles: z.array(
    z.object({
      slug: z.string().min(1),
      role: PortalRoleSchema,
    }).strict(),
  ),
}).strict().superRefine((roles, context) => {
  const slugs = new Set<string>()
  for (const [index, assignment] of roles.portalRoles.entries()) {
    if (slugs.has(assignment.slug)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['portalRoles', index, 'slug'],
        message: 'Duplicate portal role scope',
      })
    }
    slugs.add(assignment.slug)
  }
})
export type EffectiveRoles = z.infer<typeof EffectiveRolesSchema>

export const PortalPolicySchema = z.object({
  slug: z.string().min(1),
  accessMode: AccessModeSchema,
  configuredTenantId: z.string().min(1),
}).strict()
export type PortalPolicy = z.infer<typeof PortalPolicySchema>

/** Context supplied by trusted integration, never proof of cryptographic authenticity. */
export const AuthorisationPrincipalSchema = z.object({
  identity: PrincipalSchema,
  effectiveRoles: EffectiveRolesSchema,
  portalPolicy: PortalPolicySchema.optional(),
}).strict().superRefine((principal, context) => {
  if (principal.identity.kind !== 'anonymous') return
  const { platformRole, portalRoles } = principal.effectiveRoles
  const grant = portalRoles[0]
  const validAnonymousRoles = platformRole === undefined &&
    (portalRoles.length === 0 ||
      (portalRoles.length === 1 && grant?.role === 'viewer' &&
        principal.portalPolicy?.accessMode === 'public' &&
        grant.slug === principal.portalPolicy.slug))
  if (!validAnonymousRoles) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effectiveRoles'],
      message: 'Anonymous authority requires an explicitly public matching portal',
    })
  }
})
export type AuthorisationPrincipal = z.infer<typeof AuthorisationPrincipalSchema>

/**
 * Apply an explicit trusted portal policy to already resolved authority.
 * Missing policy grants nothing implicitly. This does not verify sessions or resolve assignments.
 */
export function normalisePrincipal(
  identity: unknown,
  effectiveRoles: unknown,
  portalPolicy?: unknown,
): AuthorisationPrincipal | null {
  const parsedIdentity = PrincipalSchema.safeParse(identity)
  const parsedRoles = EffectiveRolesSchema.safeParse(effectiveRoles)
  const parsedPolicy = PortalPolicySchema.optional().safeParse(portalPolicy)
  if (!parsedIdentity.success || !parsedRoles.success || !parsedPolicy.success) return null

  const rawIdentity = parsedIdentity.data
  const roles = parsedRoles.data
  const policy = parsedPolicy.data
  if (
    rawIdentity.kind === 'anonymous' &&
    (roles.platformRole !== undefined || roles.portalRoles.length !== 0)
  ) return null

  const implicitViewer = policy !== undefined &&
    (policy.accessMode === 'public' ||
      (policy.accessMode === 'authenticated' && rawIdentity.kind === 'user' &&
        rawIdentity.tenantId === policy.configuredTenantId))

  // Zod parsing has made fresh objects. Existing valid portal roles already meet the viewer floor.
  if (implicitViewer && !roles.portalRoles.some((grant) => grant.slug === policy.slug)) {
    roles.portalRoles.push({ slug: policy.slug, role: 'viewer' })
  }

  const principal = AuthorisationPrincipalSchema.safeParse({
    identity: rawIdentity,
    effectiveRoles: roles,
    ...(policy === undefined ? {} : { portalPolicy: policy }),
  })
  return principal.success ? principal.data : null
}

// D1 minimum roles are explicit by scope. Audit belongs to both domains; names do not imply scope.
const portalMinimumRoles: Readonly<Partial<Record<Permission, PortalRole>>> = Object.freeze({
  'portal.read': 'viewer',
  'portal.ask': 'viewer',
  'portal.generate': 'analyst',
  'portal.investigate': 'analyst',
  'portal.export': 'analyst',
  'portal.watch': 'analyst',
  'content.write': 'curator',
  'taxonomy.write': 'curator',
  'enrichments.write': 'curator',
  'graph.write': 'curator',
  'behaviour.write': 'portal-admin',
  'appearance.write': 'portal-admin',
  'bindings.write': 'portal-admin',
  'domains.write': 'portal-admin',
  'keys.manage': 'portal-admin',
  'members.manage': 'portal-admin',
  'audit.read': 'portal-admin',
  'audit.export': 'portal-admin',
})

const platformMinimumRoles: Readonly<Partial<Record<Permission, PlatformRole>>> = Object.freeze({
  'portal.create': 'platform-admin',
  'audit.read': 'platform-admin',
  'audit.export': 'platform-admin',
  'portal.delete': 'owner',
  'platform.members.manage': 'owner',
  'platform.settings.write': 'owner',
})

/**
 * Evaluate a complete AuthorisationPrincipal supplied by trusted integration.
 * Deny malformed input as a whole, including scope-domain mismatches for owners.
 */
export function authorize(principal: unknown, permission: unknown, scope: unknown): boolean {
  const parsedPrincipal = AuthorisationPrincipalSchema.safeParse(principal)
  const parsedPermission = PermissionSchema.safeParse(permission)
  const parsedScope = ScopeSchema.safeParse(scope)
  if (!parsedPrincipal.success || !parsedPermission.success || !parsedScope.success) return false

  const { platformRole, portalRoles } = parsedPrincipal.data.effectiveRoles
  const target = parsedScope.data
  if (target.kind === 'platform') {
    if (!Object.hasOwn(platformMinimumRoles, parsedPermission.data)) return false
    const minimum = platformMinimumRoles[parsedPermission.data]
    return minimum !== undefined && platformRole !== undefined &&
      PLATFORM_ROLES.indexOf(platformRole) >= PLATFORM_ROLES.indexOf(minimum)
  }

  if (!Object.hasOwn(portalMinimumRoles, parsedPermission.data)) return false
  const minimum = portalMinimumRoles[parsedPermission.data]
  if (minimum === undefined) return false
  if (platformRole !== undefined) return true
  const role = portalRoles.find((grant) => grant.slug === target.slug)?.role
  return role !== undefined && PORTAL_ROLES.indexOf(role) >= PORTAL_ROLES.indexOf(minimum)
}
