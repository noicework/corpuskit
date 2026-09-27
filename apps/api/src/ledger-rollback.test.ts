/**
 * Rolling back to the build before document delete (756fed6, live on hosted portals) must keep
 * working on a portal whose ledger this build wrote with deletes pending. That build parses the
 * capacity ledger strictly and refuses every add on a portal whose ledger it cannot parse, so
 * the ledger keeps exactly the shape it parses, and the deletes live under their own key, which
 * it never reads. Based on the rollback reproduction from the review of this change.
 */
import { expect } from '@std/expect'
import { PortalLifecycleStore } from './lifecycle-store.ts'
import { parseCapacityAt756fed6 } from './fixtures/capacity-ledger-756fed6.ts'

/** A portal with a pending delete and a release kept for an add still in flight. */
function portalWithDeletesPending() {
  const store = new PortalLifecycleStore()
  store.set('a', { status: 'active', limits: { maxBytes: 1_000 } })
  // One resource from before the ledger began, which the ledger cannot size.
  const first = store.reserveAdd('a', { observed: 1, bytes: 10 })
  expect(first).toEqual({ unavailable: true })
  store.set('a', { status: 'active', limits: null })
  const add = store.reserveAdd('a', { observed: 1, bytes: 10 }) as { admitted: string }
  store.settleAdd('a', add.admitted, { created: true, id: 'doc-1' })
  // A delete sent whose release was never recorded (its request ended in flight).
  store.beginDelete('a', 'doc-1')
  // An untracked document deleted while an add is in flight.
  store.reserveAdd('a', { observed: 2, bytes: 5 })
  store.beginDelete('a', 'legacy-1')
  store.forgetResource('a', 'legacy-1')
  return store
}

Deno.test('a ledger written with deletes pending still parses under the build before delete', () => {
  const store = portalWithDeletesPending()
  // The deletes are there, beside the ledger.
  expect(store.pendingDeletes('a')).toEqual(['doc-1'])
  expect(store.state.has('portal-deletes:a')).toBe(true)
  // The ledger itself parses exactly as 756fed6 parses it, so that build keeps admitting adds.
  const ledger = store.state.get<unknown>('portal-capacity:a', undefined)
  expect(() => parseCapacityAt756fed6(ledger)).not.toThrow()
  expect(Object.keys(ledger as object)).not.toContain('deleting')
})

Deno.test('the frozen parser refuses what an unreleased build of this change wrote into the ledger', () => {
  // The shape that made 756fed6 refuse every add: delete records inside the ledger itself.
  const ledger = {
    v: 1,
    observed: 1,
    inflight: [],
    added: [],
    removed: [],
    sized: { 'doc-1': 10 },
    unsized: 0,
    deleting: { 'legacy-1': { at: 1, released: true, unsized: true } },
  }
  expect(() => parseCapacityAt756fed6(ledger)).toThrow('Invalid persisted portal capacity')
  const { deleting: _deleting, ...parsable } = ledger
  expect(() => parseCapacityAt756fed6(parsable)).not.toThrow()
  // This build reads that shape too, leaving the stray field out, so nothing refuses adds.
  const store = new PortalLifecycleStore()
  store.state.put('portal-capacity:a', ledger)
  expect(store.bytesUsed('a', 1)).toBe(10)
  expect(store.pendingDeletes('a')).toEqual([])
})

Deno.test('the deletes go with the ledger when a box is changed, a portal removed or erased', () => {
  for (const clear of ['reset', 'remove', 'erase'] as const) {
    const store = portalWithDeletesPending()
    if (clear === 'reset') store.resetCapacity('a')
    else if (clear === 'remove') store.remove('a')
    else expect(store.erase('a')).toBeGreaterThanOrEqual(3)
    expect(store.state.has('portal-capacity:a'), clear).toBe(false)
    expect(store.state.has('portal-deletes:a'), clear).toBe(false)
    expect(store.pendingDeletes('a'), clear).toEqual([])
  }
  // A new ledger never picks up deletes a reset left behind (a build that did not know them
  // could have reset the ledger): starting it clears them.
  const store = portalWithDeletesPending()
  store.state.delete('portal-capacity:a')
  expect(store.state.has('portal-deletes:a')).toBe(true)
  store.reserveAdd('a', { observed: 2, bytes: 5 })
  expect(store.state.has('portal-deletes:a')).toBe(false)
  expect(store.pendingDeletes('a')).toEqual([])
})
