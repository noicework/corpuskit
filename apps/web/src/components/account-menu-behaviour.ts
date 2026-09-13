export type AccountMenuTabDirection = 'forward' | 'backward'

type MenuTriggerAttributes = {
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
}

type StandardTriggerAttributes = {
  'aria-haspopup': 'dialog'
}

/**
 * Keeps the direct-profile contract explicit: there is no disclosure state or menu
 * relationship for people whose account control still opens the identity
 * dialog directly.
 */
export function accountTriggerAttributes(
  hasEntries: boolean,
  open: boolean,
  menuId: string,
): MenuTriggerAttributes | StandardTriggerAttributes {
  return hasEntries
    ? {
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': menuId,
    }
    : { 'aria-haspopup': 'dialog' }
}

/** The wrapped focus index for a two-way vertical menu. */
export function nextAccountMenuIndex(
  current: number,
  length: number,
  direction: 'next' | 'previous' | 'first' | 'last',
): number {
  if (length <= 0) return -1
  if (direction === 'first') return 0
  if (direction === 'last') return length - 1
  if (direction === 'next') return (current + 1 + length) % length
  return (current <= 0 ? length : current) - 1
}
import type { Permission, Role, Scope } from '@research-portal/core'

export type AccountEntry = { label: string; href: string }
export type CanAccess = (permission: Permission, scope: Scope) => boolean

/** Destination requirements, not a role-to-permission table. */
export const MANAGEMENT_PERMISSIONS: readonly Permission[] = [
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
  'audit.read',
]

export function accountEntries(slug: string, can: CanAccess): AccountEntry[] {
  const portal = { kind: 'portal' as const, slug }
  const platform = { kind: 'platform' as const }
  return [
    ...(MANAGEMENT_PERMISSIONS.some((permission) => can(permission, portal))
      ? [{ label: 'Manage', href: `/t/${slug}/manage` }]
      : []),
    ...(can('portal.create', platform) ? [{ label: 'Connections', href: '/admin' }] : []),
    ...(can('platform.members.manage', platform)
      ? [{ label: 'People', href: '/admin/people' }]
      : []),
    ...(can('audit.read', platform) ? [{ label: 'Platform audit', href: '/admin/audit' }] : []),
  ]
}

/** Labels never grant authority. */
export function roleLabel(role: Role | null | undefined): string | null {
  if (!role) return null
  return {
    viewer: 'Viewer',
    analyst: 'Analyst',
    curator: 'Curator',
    'portal-admin': 'Portal administrator',
    'platform-admin': 'Platform administrator',
    owner: 'Owner',
  }[role]
}
