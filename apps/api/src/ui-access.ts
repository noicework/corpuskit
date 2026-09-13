import {
  AccessModeSchema,
  authorize,
  EffectiveRolesSchema,
  normalisePrincipal,
  type Permission,
  PERMISSIONS,
  PortalPolicySchema,
  type PortalRole,
} from '@research-portal/core'
import { z } from 'zod'
import { UNCONFIGURED_TENANT_ID } from './authorisation.ts'
import { declarationFor } from './permissions.ts'
import { type TrustedSessionFacts, validSessionFacts } from './principal.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'

const selectedTenantSchema = z.object({
  slug: KeyPortalSlugSchema,
  accessMode: AccessModeSchema,
  disabled: z.boolean(),
})

export interface UiAccessSnapshot {
  platformPermissions: Permission[]
  portalAccess: {
    slug: string
    permissions: Permission[]
    effectiveRole: PortalRole | null
    available: boolean
    canEnable: boolean
  } | null
}

/** Display and gating data from trusted ingress only, never an authority credential. */
export function buildUiAccessSnapshot(input: {
  session: TrustedSessionFacts | null
  effectiveRoles: unknown
  configuredTenantId: string
  selectedSlug?: unknown
  /** Current store policy plus the separately stored disabled flag. */
  tenant: unknown
}): UiAccessSnapshot {
  const slug = KeyPortalSlugSchema.safeParse(input.selectedSlug)
  const result: UiAccessSnapshot = {
    platformPermissions: [],
    portalAccess: slug.success
      ? {
        slug: slug.data,
        permissions: [],
        effectiveRole: null,
        available: false,
        canEnable: false,
      }
      : null,
  }
  if (input.session !== null && !validSessionFacts(input.session)) return result
  const resolved = EffectiveRolesSchema.safeParse(input.effectiveRoles)
  if (!resolved.success) return result
  const identity = input.session
    ? { kind: 'user', tenantId: input.session.tenantId, oid: input.session.oid }
    : { kind: 'anonymous' }
  // Foreign identities cannot carry configured-tenant assignments, even from a bad adapter.
  const effectiveRoles = !!input.configuredTenantId &&
      input.session?.tenantId === input.configuredTenantId
    ? resolved.data
    : { portalRoles: [] }
  const platformPrincipal = normalisePrincipal(identity, effectiveRoles)
  result.platformPermissions = PERMISSIONS.filter((permission) =>
    authorize(platformPrincipal, permission, { kind: 'platform' })
  )
  if (!slug.success || !result.portalAccess) return result
  const tenant = selectedTenantSchema.safeParse(input.tenant)
  if (!tenant.success || tenant.data.slug !== slug.data) return result
  const policy = PortalPolicySchema.safeParse({
    slug: tenant.data.slug,
    accessMode: tenant.data.accessMode,
    configuredTenantId: input.configuredTenantId || UNCONFIGURED_TENANT_ID,
  })
  if (!policy.success) return result
  const principal = normalisePrincipal(identity, effectiveRoles, policy.data)
  const scope = { kind: 'portal' as const, slug: slug.data }
  if (tenant.data.disabled) {
    // currentPolicy's exact POST enable exception ignores disabled only for this operation.
    // Read its declaration so this capability cannot acquire an independent grant rule.
    const enable = declarationFor('POST', '/api/admin/t/:slug/enable')
    result.portalAccess.canEnable = input.session !== null && enable.scope === 'portal' &&
      authorize(principal, enable.permission, scope)
    return result
  }
  const permissions = PERMISSIONS.filter((permission) => authorize(principal, permission, scope))
  if (!permissions.includes('portal.read')) return result
  result.portalAccess.permissions = permissions
  result.portalAccess.available = true
  result.portalAccess.effectiveRole = principal?.effectiveRoles.platformRole
    ? 'portal-admin'
    : principal?.effectiveRoles.portalRoles.find((grant) => grant.slug === slug.data)?.role ?? null
  return result
}
