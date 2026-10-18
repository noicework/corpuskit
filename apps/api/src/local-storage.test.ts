import { join, parse } from 'node:path'
import { expect } from '@std/expect'
import { acquireStorageLocks, localStoragePaths, sweepAtomicTemps } from './local-storage.ts'
import { acquireLockFile, acquireWriterLock } from './local-runtime.ts'

Deno.test('fresh storage fences legacy defaults even with a separate DATA_DIR', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({ DATA_DIR: 'private' }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    expect(paths.TENANTS_PATH).toBe(`${root}/data/tenants.json`)
    expect(paths.BINDINGS_PATH).toBe(`${root}/data/bindings.json`)
    expect(paths.KG_PROPOSALS_PATH).toBe(`${root}/private/kg-proposals.json`)
    expect(paths.BRANDING_PATH).toBe(`${root}/private/branding`)
    await expect(acquireStorageLocks(localStoragePaths({ DATA_DIR: 'aaa-other' }, root), 0))
      .rejects.toThrow(`${root}/data/bindings.json.writer.lock`)
    // A failed multi-lock acquisition releases everything it acquired.
    const unlock = await acquireWriterLock(`${root}/aaa-other`, 0)
    unlock()
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('existing legacy storage stays in place and is fenced without changing its bytes', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  Deno.mkdirSync(`${root}/data`)
  const previous = '{"custom":{},"overrides":{}}'
  Deno.writeTextFileSync(`${root}/data/tenants.json`, previous)
  const paths = localStoragePaths({ DATA_DIR: 'private' }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    expect(Deno.readTextFileSync(paths.TENANTS_PATH)).toBe(previous)
    await expect(acquireLockFile(`${paths.TENANTS_PATH}.writer.lock`, 0))
      .rejects.toThrow(`${paths.TENANTS_PATH}.writer.lock`)
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('explicit storage overrides keep their paths and fence each owned file or directory', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
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
    for (const path of [paths.TENANTS_PATH, paths.BINDINGS_PATH, paths.KG_PROPOSALS_PATH]) {
      await expect(acquireLockFile(`${path}.writer.lock`, 0)).rejects.toThrow(`${path}.writer.lock`)
    }
    for (const directory of [paths.DATA_DIR, paths.BRANDING_PATH]) {
      await expect(acquireWriterLock(directory, 0)).rejects.toThrow(`${directory}/.writer.lock`)
    }
  } finally {
    release()
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('stores under DATA_DIR need only its directory writer lock', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({
    DATA_DIR: 'private',
    TENANTS_PATH: 'private/tenants.json',
    BINDINGS_PATH: 'private/nested/bindings.json',
    KG_PROPOSALS_PATH: 'private/nested/kg.json',
    BRANDING_PATH: 'private/branding',
  }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    await expect(acquireWriterLock(paths.DATA_DIR, 0)).rejects.toThrow(
      `${paths.DATA_DIR}/.writer.lock`,
    )
    for (const path of [paths.TENANTS_PATH, paths.BINDINGS_PATH, paths.KG_PROPOSALS_PATH]) {
      expect(() => Deno.statSync(`${path}.writer.lock`)).toThrow(Deno.errors.NotFound)
    }
    expect(() => Deno.statSync(`${paths.BRANDING_PATH}/.writer.lock`)).toThrow(Deno.errors.NotFound)
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('file and directory writer locks are acquired in sorted canonical path order', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({
    DATA_DIR: 'middle',
    TENANTS_PATH: 'shared/z-tenants.json',
    BINDINGS_PATH: 'shared/a-bindings.json',
    // A matching string prefix is not a descendant of DATA_DIR.
    KG_PROPOSALS_PATH: 'middle-neighbour/kg.json',
    BRANDING_PATH: 'first/branding',
  }, root)
  const open = Deno.openSync
  const opened: string[] = []
  let release = () => {}
  Deno.openSync = (path, options) => {
    opened.push(String(path))
    return open(path, options)
  }
  try {
    release = await acquireStorageLocks(paths, 0)
    expect(opened).toEqual([
      `${paths.DATA_DIR}/.writer.lock`,
      `${paths.TENANTS_PATH}.writer.lock`,
      `${paths.BINDINGS_PATH}.writer.lock`,
      `${paths.KG_PROPOSALS_PATH}.writer.lock`,
      `${paths.BRANDING_PATH}/.writer.lock`,
    ].sort())
  } finally {
    Deno.openSync = open
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('boot sweep removes only atomic temp files in owned directories or named override siblings', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({
    DATA_DIR: 'private',
    TENANTS_PATH: 'external/tenants.json',
    BINDINGS_PATH: 'external/bindings.json',
    KG_PROPOSALS_PATH: 'external/kg.json',
    BRANDING_PATH: 'branding',
  }, root)
  const release = await acquireStorageLocks(paths, 0)
  const suffix = '.tmp-01234567-abc'
  const removed = [
    `private/checkpoint.json${suffix}`,
    `private/sources/portal.json${suffix}`,
    `branding/assets/portal/logo.json${suffix}`,
    ...['tenants.json', 'bindings.json', 'kg.json'].map((name) => `external/${name}${suffix}`),
  ]
  const kept = [
    'private/checkpoint.json',
    'private/notes.tmp-keep',
    'private/notes.tmp-01234567-abcd',
    'private/notes.tmp-01234567-ABC',
    `outside/portal.json${suffix}`,
    `external/unrelated.json${suffix}`,
    `external/nested/tenants.json${suffix}`,
  ]
  try {
    for (const name of [...removed, ...kept]) {
      const file = `${root}/${name}`
      Deno.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
      Deno.writeTextFileSync(file, 'preserved bytes')
    }
    Deno.mkdirSync(`${paths.DATA_DIR}/directory${suffix}`)
    if (Deno.build.os !== 'windows') {
      Deno.symlinkSync(`${root}/outside`, `${paths.DATA_DIR}/linked-directory`)
      Deno.symlinkSync(`${root}/${kept[4]}`, `${paths.DATA_DIR}/linked-file${suffix}`)
    }
    sweepAtomicTemps(paths)
    sweepAtomicTemps(paths)
    for (const name of removed) {
      expect(() => Deno.statSync(`${root}/${name}`)).toThrow(Deno.errors.NotFound)
    }
    for (const name of kept) {
      expect(Deno.readTextFileSync(`${root}/${name}`)).toBe('preserved bytes')
    }
    expect(Deno.statSync(`${paths.DATA_DIR}/directory${suffix}`).isDirectory).toBe(true)
    if (Deno.build.os !== 'windows') {
      expect(Deno.lstatSync(`${paths.DATA_DIR}/linked-file${suffix}`).isSymlink).toBe(true)
    }
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('boot sweep recognises named store overrides directly in a filesystem root', () => {
  const root = parse(Deno.cwd()).root
  const suffix = '.tmp-01234567-abc'
  const names = ['tenants.json', 'bindings.json', 'kg-proposals.json']
  const paths = localStoragePaths({
    DATA_DIR: join(root, 'private'),
    TENANTS_PATH: join(root, names[0]!),
    BINDINGS_PATH: join(root, names[1]!),
    KG_PROPOSALS_PATH: join(root, names[2]!),
    BRANDING_PATH: join(root, 'branding'),
  })
  const readDir = Deno.readDirSync
  const remove = Deno.removeSync
  const removed: string[] = []
  // Model a volume root without requiring permission to create files in the host's root.
  Deno.readDirSync = function* (directory) {
    if (directory === root) {
      for (const name of [...names, 'unrelated.json']) {
        yield { name: `${name}${suffix}`, isFile: true, isDirectory: false, isSymlink: false }
      }
    }
  }
  Deno.removeSync = (path) => {
    removed.push(String(path))
  }
  try {
    sweepAtomicTemps(paths)
    expect(removed.sort()).toEqual(names.map((name) => join(root, `${name}${suffix}`)).sort())
  } finally {
    Deno.readDirSync = readDir
    Deno.removeSync = remove
  }
})
