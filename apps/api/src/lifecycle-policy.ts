import type { TenantConfig } from '@research-portal/core'
import { evaluateOperation, type RequestAuthority } from './authorisation.ts'
import { PortalLifecycleError } from './lifecycle-error.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'

/** Platform administrators and owners manage hosting state and are never paused out. */
export function isPlatformAuthority(authority: RequestAuthority): boolean {
  return evaluateOperation(authority, 'portal.create', { kind: 'platform' })
}

/** The safe sign-in projection plus status, so a paused screen can draw the portal's brand. */
export function safePortalMetadata(config: TenantConfig, status: string) {
  const { productName, organisation, logoUrl, colours, paletteId } = config.branding
  return {
    slug: config.slug,
    status,
    accessMode: config.accessMode,
    branding: {
      productName,
      organisation,
      logoUrl: logoUrl ?? null,
      colours,
      paletteId: paletteId ?? null,
    },
  }
}

/**
 * Applied by the route guard once credentials are verified and before authorisation: a
 * suspended portal answers every non-platform caller with 423, whatever their portal role.
 */
export function enforceSuspension(
  store: PortalLifecycleStore,
  config: TenantConfig,
  authority: RequestAuthority,
  options: { safeMetadata?: boolean } = {},
): void {
  const { status } = store.get(config.slug)
  if (status !== 'suspended' || isPlatformAuthority(authority)) return
  throw new PortalLifecycleError(423, {
    error: 'portal_suspended',
    ...(options.safeMetadata ? safePortalMetadata(config, status) : {}),
  })
}

/** Applied after authorisation, so a caller without the permission still sees 401 or 403. */
export function enforceReadOnly(store: PortalLifecycleStore, slug: string): void {
  if (store.get(slug).status === 'read_only') {
    throw new PortalLifecycleError(423, { error: 'portal_read_only' })
  }
}

/**
 * Compound operations that would start an agent call this before their first write, so a
 * refused start never leaves a half-replaced strategy or labeller behind.
 */
export function assertAgentsEnabled(store: PortalLifecycleStore, slug: string): void {
  if (store.get(slug).limits?.agentsEnabled === false) {
    throw new PortalLifecycleError(403, { error: 'agents_disabled' })
  }
}

export function admitPortalAsk(
  store: PortalLifecycleStore,
  config: TenantConfig,
  now?: number,
): void {
  const denied = store.consumeAsk(config.slug, config.timezone ?? 'UTC', now)
  if (denied) throw new PortalLifecycleError(429, { error: 'ask_quota_exceeded', ...denied })
}
