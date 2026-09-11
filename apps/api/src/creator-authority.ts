import type { PortalRole } from '@research-portal/core'
import { resolveRoleGrants, type RoleResolutionStores } from './assignments.ts'
import type { RbacState } from './rbac-state.ts'

export interface CreatorAuthority {
  proven: boolean
  role: PortalRole | null
  reason: 'active' | 'unproven_creator' | 'creator_no_access'
}
export interface CreatorAuthorityStores {
  rbac: RoleResolutionStores['rbac'] & Pick<RbacState, 'creatorEvidence'>
  audience: string
  logUnknownRole?: RoleResolutionStores['logUnknownRole']
}

/** Re-evaluate authority for one portal from persisted identity and current assignments. */
export async function resolveCreatorAuthority(
  creator: { tenantId: string; oid: string; slug: string },
  stores: CreatorAuthorityStores,
  configuredTenantId: string,
  now = Date.now(),
): Promise<CreatorAuthority> {
  const unproven: CreatorAuthority = { proven: false, role: null, reason: 'unproven_creator' }
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(value)
  if (
    !identifier(configuredTenantId) || creator.tenantId !== configuredTenantId ||
    !identifier(creator.oid) || !identifier(creator.slug) || !Number.isSafeInteger(now) || now < 0
  ) return unproven
  const evidence = stores.rbac.creatorEvidence(creator.tenantId, creator.oid)
  if (!evidence || evidence.observedAt > now || evidence.claimIssuedAt > now + 30_000) {
    return unproven
  }
  const fresh = Math.min(evidence.expiresAt, evidence.claimIssuedAt + 28_800_000) > now
  const grants = await resolveRoleGrants(evidence, fresh ? evidence : null, stores)
  const role = grants.effectiveRoles.platformRole
    ? 'portal-admin'
    : grants.effectiveRoles.portalRoles.find((grant) => grant.slug === creator.slug)?.role ?? null
  return { proven: true, role, reason: role ? 'active' : 'creator_no_access' }
}
