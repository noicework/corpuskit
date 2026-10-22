import type { TenantSummary } from '@research-portal/core'

/**
 * Whether the portal switcher beside the logo shows at all. It is there to go somewhere else:
 * another portal in the caller's directory, or the portal management someone who can create
 * portals may open. With only the current portal listed, or before the list has loaded, there is
 * nowhere to go, so neither the chevron nor the menu renders.
 */
export function showsPortalSwitcher(
  tenants: readonly Pick<TenantSummary, 'slug'>[] | undefined,
  currentSlug: string,
  canCreate: boolean,
): boolean {
  return canCreate || (tenants ?? []).some((tenant) => tenant.slug !== currentSlug)
}
