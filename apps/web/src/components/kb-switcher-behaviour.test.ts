import { expect } from '@std/expect'
import { showsPortalSwitcher } from './kb-switcher-behaviour.ts'

const kbSwitcherSource = await Deno.readTextFile(new URL('./KbSwitcher.tsx', import.meta.url))

Deno.test('the portal switcher is hidden when the directory holds only the current portal', () => {
  expect(showsPortalSwitcher([{ slug: 'marine' }], 'marine', false)).toBe(false)
  expect(showsPortalSwitcher([], 'marine', false)).toBe(false)
  // Hidden while the directory loads too, so the chevron never flashes before the list arrives.
  expect(showsPortalSwitcher(undefined, 'marine', false)).toBe(false)
})

Deno.test('the portal switcher shows with another portal to go to, or to someone who can create portals', () => {
  expect(showsPortalSwitcher([{ slug: 'marine' }, { slug: 'grains' }], 'marine', false)).toBe(
    true,
  )
  expect(showsPortalSwitcher([{ slug: 'grains' }], 'marine', false)).toBe(true)
  expect(showsPortalSwitcher([{ slug: 'marine' }], 'marine', true)).toBe(true)
  expect(showsPortalSwitcher(undefined, 'marine', true)).toBe(true)
})

Deno.test('KbSwitcher renders nothing, neither chevron nor menu, when the switcher is hidden', () => {
  const guard = kbSwitcherSource.indexOf(
    'if (!showsPortalSwitcher(tenants, config.slug, canCreate)) return null',
  )
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeLessThan(kbSwitcherSource.indexOf('<IconButton'))
  expect(guard).toBeLessThan(kbSwitcherSource.indexOf("role='menu'"))
})
