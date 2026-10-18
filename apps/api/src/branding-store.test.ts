import { expect } from '@std/expect'
import { FileBrandingStore } from './branding-store.ts'
import { LocalRbacDatabase } from './rbac-local.ts'

Deno.test('file branding keeps legacy slots readable and replaces or removes every representation', () => {
  const directory = Deno.makeTempDirSync()
  try {
    Deno.mkdirSync(`${directory}/images/marine`, { recursive: true })
    Deno.writeFileSync(`${directory}/marine-logo.svg`, new TextEncoder().encode('<svg/>'))
    Deno.writeFileSync(`${directory}/images/marine/hero.jpg`, new Uint8Array([1, 2]))
    const store = new FileBrandingStore(directory)
    expect(store.get('marine', 'logo')?.contentType).toBe('image/svg+xml')
    expect(store.images('marine').map((image) => image.name)).toEqual(['hero'])
    const asset = { bytes: new Uint8Array([3, 4, 5]), contentType: 'image/webp', version: 'v2' }
    store.put('marine', 'image-hero', asset)
    expect(new FileBrandingStore(directory).get('marine', 'image-hero')).toEqual(asset)
    expect(() => Deno.statSync(`${directory}/images/marine/hero.jpg`)).toThrow()
    expect(store.remove('marine', 'image-hero')).toBe(true)
    expect(store.get('marine', 'image-hero')).toBeNull()
    expect(store.images('marine')).toEqual([])
    expect(store.erase('marine')).toBe(1)
    expect(store.get('marine', 'logo')).toBeNull()
    expect(store.erase('marine')).toBe(0)
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('file branding restores legacy binary bytes when the required completion fails', () => {
  const directory = Deno.makeTempDirSync()
  const database = new LocalRbacDatabase(':memory:')
  try {
    const bytes = new Uint8Array([0, 255, 17])
    Deno.writeFileSync(`${directory}/marine-logo.png`, bytes)
    let completions = 0
    const store = new FileBrandingStore(directory, {
      database,
      complete: () => {
        completions++
        throw new Error('fixture completion failure')
      },
    })
    expect(() =>
      store.put('marine', 'logo', {
        bytes: new Uint8Array([9]),
        contentType: 'image/webp',
        version: 'v2',
      })
    ).toThrow('fixture completion failure')
    expect(completions).toBe(1)
    expect(Deno.readFileSync(`${directory}/marine-logo.png`)).toEqual(bytes)
    expect(store.get('marine', 'logo')?.bytes).toEqual(bytes)
    expect(new FileBrandingStore(directory).get('marine', 'logo')?.contentType).toBe('image/png')
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
