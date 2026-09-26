import { expect } from '@std/expect'
import type { TenantStoreApi } from './tenants.ts'

type AliasRegistry = Pick<
  TenantStoreApi,
  | 'get'
  | 'list'
  | 'add'
  | 'remove'
  | 'patch'
  | 'assignedHostname'
  | 'portalAliases'
  | 'aliasPortal'
  | 'setAlias'
  | 'removeAlias'
>

/**
 * One behaviour check for every portal registry: `open` returns a store over the same persisted
 * state each time it is called, so a second call observes exactly what was committed.
 */
export function checkAliasRegistry(open: () => AliasRegistry): void {
  let store = open()
  const acme = store.add({ name: 'Acme' }).slug
  // Hostname automation stores the portal's own hostname.
  store.patch(acme, { hostname: 'acme.corpuskit.org' })
  const set = (slug: string, hostname: string, primary?: boolean, limit = 2) =>
    store.setAlias(slug, hostname, primary, limit)

  const first = set(acme, 'research.example.org')
  expect(first).toEqual({
    ok: true,
    aliases: [{ hostname: 'research.example.org', primary: false, createdAt: expect.any(String) }],
  })
  expect(store.get(acme)?.hostname).toBe('acme.corpuskit.org')
  expect(store.aliasPortal('research.example.org')).toBe(acme)

  // A primary alias becomes the canonical hostname everywhere the portal is read.
  expect(set(acme, 'research.example.org', true).ok).toBe(true)
  expect(store.get(acme)?.hostname).toBe('research.example.org')
  expect(store.list(true).find((row) => row.slug === acme)?.hostname).toBe('research.example.org')
  expect(store.assignedHostname(acme)).toBe('acme.corpuskit.org')

  store = open()
  expect(store.get(acme)?.hostname).toBe('research.example.org')
  const created = store.portalAliases(acme)[0]!.createdAt
  // Registering again changes nothing, including the creation time.
  expect(set(acme, 'research.example.org')).toEqual({
    ok: true,
    aliases: [{ hostname: 'research.example.org', primary: true, createdAt: created }],
  })

  // Another portal can neither take the alias nor the portal's own hostname.
  expect(set('marine', 'research.example.org')).toEqual({ ok: false, error: 'hostname_taken' })
  expect(set('marine', 'acme.corpuskit.org')).toEqual({ ok: false, error: 'hostname_taken' })
  expect(set('missing', 'free.example.org')).toEqual({ ok: false, error: 'unknown_tenant' })
  expect(store.aliasPortal('free.example.org')).toBeUndefined()

  expect(set(acme, 'two.example.org').ok).toBe(true)
  expect(set(acme, 'three.example.org')).toEqual({ ok: false, error: 'alias_limit' })
  expect(set(acme, 'two.example.org', true).ok).toBe(true)
  expect(store.portalAliases(acme).filter((alias) => alias.primary).map((a) => a.hostname))
    .toEqual(['two.example.org'])
  // Clearing the primary flag reverts the canonical hostname to the portal's own.
  expect(set(acme, 'two.example.org', false).ok).toBe(true)
  expect(store.get(acme)?.hostname).toBe('acme.corpuskit.org')
  expect(set(acme, 'two.example.org', true).ok).toBe(true)

  // Removing another portal's name, or one it does not have, changes nothing.
  expect(store.removeAlias('marine', 'two.example.org')).toEqual([])
  expect(store.removeAlias(acme, 'absent.example.org').length).toBe(2)
  // Removing the primary alias reverts to the portal's own hostname.
  expect(store.removeAlias(acme, 'two.example.org').map((alias) => alias.hostname))
    .toEqual(['research.example.org'])
  expect(set(acme, 'research.example.org', false).ok).toBe(true)
  expect(store.get(acme)?.hostname).toBe('acme.corpuskit.org')

  // Without a hostname of its own, a portal has none once its primary alias goes.
  const bare = store.add({ name: 'Bare' }).slug
  expect(set(bare, 'bare.example.org', true).ok).toBe(true)
  expect(store.get(bare)?.hostname).toBe('bare.example.org')
  store.removeAlias(bare, 'bare.example.org')
  expect(store.get(bare)?.hostname).toBeUndefined()

  // Removing a portal removes its aliases in the same write.
  expect(set(acme, 'two.example.org', true).ok).toBe(true)
  expect(store.remove(acme)).toBe(true)
  for (const current of [store, open()]) {
    expect(current.aliasPortal('research.example.org')).toBeUndefined()
    expect(current.aliasPortal('two.example.org')).toBeUndefined()
    expect(current.portalAliases(acme)).toEqual([])
  }
  store = open()
  expect(set('marine', 'research.example.org').ok).toBe(true)
  expect(store.aliasPortal('research.example.org')).toBe('marine')
}
