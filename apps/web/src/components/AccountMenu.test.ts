import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  accountEntries,
  accountTriggerAttributes,
  nextAccountMenuIndex,
  roleLabel,
} from './account-menu-behaviour.ts'

const tenantLayoutSource = await Deno.readTextFile(
  new URL('../pages/TenantLayout.tsx', import.meta.url),
)

describe('AccountMenu', () => {
  it('supplies explicit entries to both desktop and mobile controls', () => {
    expect(tenantLayoutSource.match(/entries=\{menuEntries\}/g)?.length).toBe(2)
    expect(tenantLayoutSource).not.toContain('accountIsAdmin')
  })

  it('uses permissions at their exact scope, never display roles or emergency availability', () => {
    expect(accountEntries('marine', () => false)).toEqual([])
    const portal = accountEntries(
      'marine',
      (permission, scope) =>
        scope.kind === 'portal' && scope.slug === 'marine' && permission === 'members.manage',
    )
    expect(portal).toEqual([{ label: 'Manage', href: '/t/marine/manage' }])
    const platform = accountEntries(
      'marine',
      (permission, scope) => scope.kind === 'platform' && permission === 'portal.create',
    )
    expect(platform).toEqual([{ label: 'Connections', href: '/admin' }])
    expect(
      accountEntries(
        'marine',
        (permission, scope) =>
          scope.kind === 'platform' && permission === 'platform.members.manage',
      ),
    ).toEqual([{ label: 'People', href: '/admin/people' }])
    expect(roleLabel('portal-admin')).toBe('Portal administrator')
    expect(roleLabel(null)).toBe(null)
  })

  it('keeps non-admin and anonymous controls as dialog buttons without disclosure state', () => {
    for (const isAdmin of [false, Boolean(undefined)]) {
      const attributes = accountTriggerAttributes(isAdmin, false, 'account-menu')
      expect(attributes).toEqual({ 'aria-haspopup': 'dialog' })
      expect('aria-expanded' in attributes).toBe(false)
      expect('aria-controls' in attributes).toBe(false)
    }
  })

  it('announces the menu and its open state only for administrators', () => {
    expect(accountTriggerAttributes(true, false, 'account-menu')).toEqual({
      'aria-haspopup': 'menu',
      'aria-expanded': false,
      'aria-controls': 'account-menu',
    })
    expect(accountTriggerAttributes(true, true, 'account-menu')).toEqual({
      'aria-haspopup': 'menu',
      'aria-expanded': true,
      'aria-controls': 'account-menu',
    })
  })

  it('wraps arrow-key focus across both menu items', () => {
    expect(nextAccountMenuIndex(-1, 2, 'next')).toBe(0)
    expect(nextAccountMenuIndex(0, 2, 'next')).toBe(1)
    expect(nextAccountMenuIndex(1, 2, 'next')).toBe(0)
    expect(nextAccountMenuIndex(0, 2, 'previous')).toBe(1)
    expect(nextAccountMenuIndex(1, 2, 'previous')).toBe(0)
    expect(nextAccountMenuIndex(1, 2, 'first')).toBe(0)
    expect(nextAccountMenuIndex(0, 2, 'last')).toBe(1)
  })
})
