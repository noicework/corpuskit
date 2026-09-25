import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { showsRegionalDiscovery } from '@research-portal/core'
import { tenantConfig, TenantStore } from './tenants.ts'

const storeAt = (path: string) => new TenantStore({ TENANTS_PATH: path })
const tempPath = () => `${Deno.makeTempDirSync()}/tenants.json`

describe('regional discovery on the file store', () => {
  it('seeds the two showcase portals with the band, which are organised by Australian state', () => {
    for (const slug of ['grains', 'marine']) {
      expect(tenantConfig(slug)?.regionalDiscovery).toBe(true)
      expect(showsRegionalDiscovery(storeAt(tempPath()).get(slug)!)).toBe(true)
    }
  })

  it('shows the band on the showcase portals of a store written before the field existed', () => {
    const path = tempPath()
    const stale = { ...tenantConfig('grains')!, searchPlaceholder: 'Stored copy' }
    delete stale.regionalDiscovery
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        // A stored copy under a seeded slug never shadows the seed.
        custom: { grains: stale },
        overrides: {
          grains: { searchPlaceholder: 'Search the stored grains portal' },
          marine: { topics: [{ id: 'stock-assessment', label: 'Stock assessment' }] },
        },
        disabled: [],
        retired: [],
      }),
    )
    const store = storeAt(path)
    expect(store.get('grains')?.regionalDiscovery).toBe(true)
    expect(store.get('grains')?.searchPlaceholder).toBe('Search the stored grains portal')
    expect(store.get('marine')?.regionalDiscovery).toBe(true)
    expect(store.get('marine')?.topics).toHaveLength(1)
  })

  it('keeps an explicit false on a showcase portal across a reload', () => {
    const path = tempPath()
    storeAt(path).patch('grains', { regionalDiscovery: false })
    const reloaded = storeAt(path)
    expect(reloaded.get('grains')?.regionalDiscovery).toBe(false)
    expect(showsRegionalDiscovery(reloaded.get('grains')!)).toBe(false)
    expect(reloaded.get('marine')?.regionalDiscovery).toBe(true)
  })

  it('hides the band on a new portal until an administrator turns it on', () => {
    const path = tempPath()
    const store = storeAt(path)
    const created = store.add({ name: 'Estuary notes' })
    expect(created.regionalDiscovery).toBeUndefined()
    expect(showsRegionalDiscovery(store.get(created.slug)!)).toBe(false)
    store.patch(created.slug, { regionalDiscovery: true })
    expect(showsRegionalDiscovery(storeAt(path).get(created.slug)!)).toBe(true)
  })

  it('hides the band on a portal stored without the field', () => {
    const path = tempPath()
    const legacy = { ...tenantConfig('marine')!, slug: 'legacy' }
    delete legacy.regionalDiscovery
    Deno.writeTextFileSync(path, JSON.stringify({ custom: { legacy } }))
    expect(showsRegionalDiscovery(storeAt(path).get('legacy')!)).toBe(false)
  })
})
