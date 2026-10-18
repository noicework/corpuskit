import { expect } from '@std/expect'
import { acquireStorageLocks, localStoragePaths } from './local-storage.ts'
import { acquireWriterLock } from './local-runtime.ts'

Deno.test('fresh storage fences legacy defaults even with a separate DATA_DIR', async () => {
  const root = Deno.makeTempDirSync()
  const paths = localStoragePaths({ DATA_DIR: 'private' }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    expect(paths.TENANTS_PATH).toBe(`${root}/data/tenants.json`)
    expect(paths.BINDINGS_PATH).toBe(`${root}/data/bindings.json`)
    expect(paths.KG_PROPOSALS_PATH).toBe(`${root}/private/kg-proposals.json`)
    expect(paths.BRANDING_PATH).toBe(`${root}/private/branding`)
    await expect(acquireStorageLocks(localStoragePaths({ DATA_DIR: 'aaa-other' }, root), 0))
      .rejects.toThrow('writer lock is still held')
    // A failed multi-lock acquisition releases everything it acquired.
    const unlock = await acquireWriterLock(`${root}/aaa-other`, 0)
    unlock()
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('existing legacy storage stays in place and is fenced without changing its bytes', async () => {
  const root = Deno.makeTempDirSync()
  Deno.mkdirSync(`${root}/data`)
  const previous = '{"custom":{},"overrides":{}}'
  Deno.writeTextFileSync(`${root}/data/tenants.json`, previous)
  const paths = localStoragePaths({ DATA_DIR: 'private' }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    expect(Deno.readTextFileSync(paths.TENANTS_PATH)).toBe(previous)
    await expect(acquireWriterLock(`${root}/data`, 0)).rejects.toThrow('writer lock is still held')
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('explicit storage overrides keep their paths and each directory is fenced', async () => {
  const root = Deno.makeTempDirSync()
  const env = {
    DATA_DIR: 'private',
    TENANTS_PATH: 'tenants/custom.json',
    BINDINGS_PATH: 'bindings/custom.json',
    KG_PROPOSALS_PATH: 'proposals/custom.json',
    BRANDING_PATH: 'assets',
  }
  const paths = localStoragePaths(env, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    for (const [name, value] of Object.entries(env)) {
      expect(paths[name as keyof typeof paths]).toBe(`${root}/${value}`)
    }
    for (const name of ['private', 'tenants', 'bindings', 'proposals', 'assets']) {
      await expect(acquireWriterLock(`${root}/${name}`, 0)).rejects.toThrow(
        'writer lock is still held',
      )
    }
  } finally {
    release()
    release()
    Deno.removeSync(root, { recursive: true })
  }
})
