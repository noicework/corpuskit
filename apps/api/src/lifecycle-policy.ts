import type { PortalLifecycle, TenantConfig } from '@research-portal/core'
import { evaluateOperation, type RequestAuthority } from './authorisation.ts'
import { PortalLifecycleError } from './lifecycle-error.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import {
  type AskUse,
  askUse,
  type Declaration,
  isAccessTightening,
  mutatesPortal,
} from './permissions.ts'

/** Platform administrators and owners manage hosting state and are never paused out. */
export function isPlatformAuthority(authority: RequestAuthority): boolean {
  return evaluateOperation(authority, 'portal.create', { kind: 'platform' })
}

/**
 * A portal's lifecycle, or undefined when its record cannot be read. Callers that act on many
 * portals use this so one unreadable record fails that portal alone, never the whole list.
 */
export function readLifecycle(
  store: PortalLifecycleStore,
  slug: string,
): PortalLifecycle | undefined {
  try {
    return store.get(slug)
  } catch {
    console.error('Portal lifecycle could not be read')
    return undefined
  }
}

/**
 * The safe sign-in projection (D9): what anyone may learn about a portal before access is
 * decided. `logoUrl` is the portal's resolved logo, so both uses show the same image.
 */
export function safePortalProjection(config: TenantConfig, logoUrl: string | null) {
  const { productName, organisation, colours, paletteId } = config.branding
  return {
    slug: config.slug,
    branding: { productName, organisation, logoUrl, colours, paletteId: paletteId ?? null },
    accessMode: config.accessMode,
  }
}

/**
 * Applied by the route guard once credentials are verified and before authorisation: a
 * suspended portal answers every non-platform caller with 423, whatever their portal role.
 * `metadata` adds the safe projection and status, so a paused screen can draw the portal's
 * brand; `asset` lets through the portal's logo, the one asset that projection names.
 */
export function enforceSuspension(
  store: PortalLifecycleStore,
  config: TenantConfig,
  authority: RequestAuthority,
  options: { metadata?: () => Record<string, unknown>; asset?: boolean } = {},
): void {
  const { status } = store.get(config.slug)
  if (status !== 'suspended' || isPlatformAuthority(authority) || options.asset) return
  throw new PortalLifecycleError(423, {
    error: 'portal_suspended',
    ...(options.metadata ? { ...options.metadata(), status } : {}),
  })
}

/** Applied after authorisation, so a caller without the permission still sees 401 or 403. */
export function enforceReadOnly(store: PortalLifecycleStore, slug: string): void {
  if (store.get(slug).status === 'read_only') {
    throw new PortalLifecycleError(423, { error: 'portal_read_only' })
  }
}

/** A read-only portal's access mode can be tightened, never loosened. */
export function enforceAccessChange(
  store: PortalLifecycleStore,
  slug: string,
  from: TenantConfig['accessMode'],
  to: TenantConfig['accessMode'],
): void {
  if (!isAccessTightening(from, to)) enforceReadOnly(store, slug)
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

/** The asks one request counted: returned if the request is refused before it is answered. */
export interface AskReceipt {
  slugs: string[]
  at: number
}

/**
 * Admit one request against the daily ask limit of every portal it reaches, on all of them or
 * none. `count` spends one ask on each; `gate` only refuses when a portal's asks are spent.
 * Nothing here awaits, so no other request can spend a portal's last ask between the check and
 * the count.
 */
export function admitAsks(
  store: PortalLifecycleStore,
  use: AskUse,
  targets: readonly TenantConfig[],
  at: number,
): AskReceipt | null {
  for (const config of targets) {
    const denied = store.askQuota(config.slug, config.timezone ?? 'UTC', at)
    if (denied) throw new PortalLifecycleError(429, { error: 'ask_quota_exceeded', ...denied })
  }
  if (use === 'gate') return null
  for (const config of targets) {
    const denied = store.consumeAsk(config.slug, config.timezone ?? 'UTC', at)
    if (denied) throw new PortalLifecycleError(429, { error: 'ask_quota_exceeded', ...denied })
  }
  return { slugs: targets.map((config) => config.slug), at }
}

/** Return the asks of a request that was refused after it was counted. Never fails the request. */
export function refundAsks(store: PortalLifecycleStore, receipt: AskReceipt): void {
  for (const slug of receipt.slugs) {
    try {
      store.refundAsk(slug, receipt.at)
    } catch {
      console.error('Portal ask could not be returned')
    }
  }
}

/**
 * The per-tool check for MCP calls: the transport route is already guarded, and each tool is
 * checked again on its own for suspension, read-only mode and the daily ask limit.
 */
export function lifecycleToolGuard(store: PortalLifecycleStore, now: () => number) {
  return (declaration: Declaration, config: TenantConfig, authority: RequestAuthority) => {
    enforceSuspension(store, config, authority)
    if (mutatesPortal(declaration)) enforceReadOnly(store, config.slug)
    const use = askUse(declaration)
    if (use) admitAsks(store, use, [config], now())
  }
}
