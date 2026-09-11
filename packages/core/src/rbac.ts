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
