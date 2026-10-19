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
    expect(paths.RBAC_PATH).toBe(`${root}/private/rbac.sqlite`)
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
    RBAC_PATH: 'rbac/custom.sqlite',
  }
  const paths = localStoragePaths(env, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    for (const [name, value] of Object.entries(env)) {
      expect(paths[name as keyof typeof paths]).toBe(`${root}/${value}`)
    }
    for (
      const path of [
        paths.TENANTS_PATH,
        paths.BINDINGS_PATH,
        paths.KG_PROPOSALS_PATH,
        paths.RBAC_PATH,
      ]
    ) {
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

Deno.test('stores under DATA_DIR also hold their own file and branding writer locks', async () => {
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
    for (
      const path of [
        paths.TENANTS_PATH,
        paths.BINDINGS_PATH,
        paths.KG_PROPOSALS_PATH,
        paths.RBAC_PATH,
      ]
    ) {
      await expect(acquireLockFile(`${path}.writer.lock`, 0)).rejects.toThrow(`${path}.writer.lock`)
    }
    await expect(acquireWriterLock(paths.BRANDING_PATH, 0))
      .rejects.toThrow(`${paths.BRANDING_PATH}/.writer.lock`)
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
    KG_PROPOSALS_PATH: 'middle-neighbour/kg.json',
    BRANDING_PATH: 'first/branding',
    RBAC_PATH: 'shared/b-rbac.sqlite',
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
      `${paths.RBAC_PATH}.writer.lock`,
    ].sort())
  } finally {
    Deno.openSync = open
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('branding at DATA_DIR deduplicates the canonical directory lock', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({
    DATA_DIR: 'private',
    TENANTS_PATH: 'private/tenants.json',
    BINDINGS_PATH: 'private/bindings.json',
    BRANDING_PATH: 'private/.',
  }, root)
  const release = await acquireStorageLocks(paths, 0)
  try {
    await expect(acquireWriterLock(paths.DATA_DIR, 0)).rejects.toThrow(
      `${paths.DATA_DIR}/.writer.lock`,
    )
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('external RBAC overrides fence a shared database while distinct files share a folder', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const pathsFor = (name: string, database: string) =>
    localStoragePaths({
      DATA_DIR: name,
      TENANTS_PATH: `${name}/tenants.json`,
      BINDINGS_PATH: `${name}/bindings.json`,
      RBAC_PATH: `shared/${database}.sqlite`,
    }, root)
  const first = pathsFor('a', 'shared')
  const release = await acquireStorageLocks(first, 0)
  try {
    await expect(acquireStorageLocks(pathsFor('b', 'shared'), 0))
      .rejects.toThrow(`${first.RBAC_PATH}.writer.lock writer lock is still held`)
    const releaseDistinct = await acquireStorageLocks(pathsFor('b', 'distinct'), 0)
    releaseDistinct()
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('SQLite memory and temporary database overrides keep their meaning without file locks', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  try {
    for (const override of [':memory:', '']) {
      const paths = localStoragePaths({ DATA_DIR: 'private', RBAC_PATH: override }, root)
      const release = await acquireStorageLocks(paths, 0)
      try {
        expect(paths.RBAC_PATH).toBe(override)
        expect([...release.paths].some((path) => path.endsWith('rbac.sqlite.writer.lock'))).toBe(
          false,
        )
        expect([...Deno.readDirSync(root)].some((entry) => entry.name.includes(':memory:'))).toBe(
          false,
        )
      } finally {
        release()
      }
    }
  } finally {
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
    sweepAtomicTemps(paths, release.paths)
    sweepAtomicTemps(paths, release.paths)
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

Deno.test('boot sweep logs unreadable directories and undeletable orphans and continues cleanup', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths({ DATA_DIR: 'private' }, root)
  const release = await acquireStorageLocks(paths, 0)
  const blockedDirectory = `${paths.DATA_DIR}/lost+found`
  const blockedFile = `${paths.DATA_DIR}/busy.json.tmp-01234567-abc`
  const healthy = [
    `${paths.DATA_DIR}/sources/portal.json.tmp-01234567-abc`,
    `${paths.BRANDING_PATH}/logo.json.tmp-01234567-abc`,
    `${paths.TENANTS_PATH}.tmp-01234567-abc`,
  ]
  Deno.mkdirSync(blockedDirectory)
  for (const path of [blockedFile, ...healthy]) {
    Deno.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    Deno.writeTextFileSync(path, 'private contents')
  }
  const readDir = Deno.readDirSync
  const remove = Deno.removeSync
  const log = console.error
  const lines: string[] = []
  Deno.readDirSync = (path) => {
    if (path === blockedDirectory) throw new Deno.errors.PermissionDenied(`private ${root}`)
    return readDir(path)
  }
  Deno.removeSync = (path, options) => {
    if (path === blockedFile) throw new Deno.errors.Busy(`private ${root}`)
    remove(path, options)
  }
  console.error = (line: string) => void lines.push(line)
  try {
    sweepAtomicTemps(paths, release.paths)
    expect(lines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      { event: 'storage.sweep_failed', file: 'lost+found', code: 'EACCES' },
      { event: 'storage.sweep_failed', file: 'busy.json.tmp-01234567-abc', code: 'EBUSY' },
    ]))
    expect(lines).toHaveLength(2)
    expect(lines.join()).not.toContain(root)
    expect(lines.join()).not.toContain('private contents')
    expect(Deno.readTextFileSync(blockedFile)).toBe('private contents')
    for (const path of healthy) {
      expect(() => Deno.statSync(path)).toThrow(Deno.errors.NotFound)
    }
  } finally {
    Deno.readDirSync = readDir
    Deno.removeSync = remove
    console.error = log
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('boot sweep still continues when its diagnostic sink throws', () => {
  const root = Deno.makeTempDirSync()
  const readDir = Deno.readDirSync
  const log = console.error
  Deno.readDirSync = () => {
    throw new Deno.errors.PermissionDenied('private path and contents')
  }
  console.error = () => {
    throw new Error('log sink unavailable')
  }
  try {
    expect(() => sweepAtomicTemps(localStoragePaths({ DATA_DIR: root }, root))).not.toThrow()
  } finally {
    Deno.readDirSync = readDir
    console.error = log
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test('boot sweep respects foreign directory and sibling locks even when their files are idle', async () => {
  const root = Deno.realPathSync(Deno.makeTempDirSync())
  const paths = localStoragePaths(
    { DATA_DIR: 'private', TENANTS_PATH: 'external/tenants.json' },
    root,
  )
  const release = await acquireStorageLocks(paths, 0)
  const suffix = '.tmp-01234567-abc'
  const kept = [
    `${paths.DATA_DIR}/nested/sources/portal.json${suffix}`,
    `${paths.DATA_DIR}/other.json${suffix}`,
    `${paths.TENANTS_PATH}${suffix}`,
  ]
  const removed = `${paths.DATA_DIR}/own.json${suffix}`
  try {
    for (const path of [...kept, removed]) {
      Deno.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      Deno.writeTextFileSync(path, 'complete bytes')
    }
    Deno.writeTextFileSync(`${paths.DATA_DIR}/nested/.writer.lock`, '')
    Deno.writeTextFileSync(`${paths.DATA_DIR}/other.json.writer.lock`, '')
    Deno.writeTextFileSync(`${root}/external/.writer.lock`, '')
    sweepAtomicTemps(paths, release.paths)
    for (const path of kept) expect(Deno.readTextFileSync(path)).toBe('complete bytes')
    expect(() => Deno.statSync(removed)).toThrow(Deno.errors.NotFound)
  } finally {
    release()
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test({
  name: 'boot sweep recognises owned locks through canonical directory aliases',
  ignore: Deno.build.os === 'windows',
  async fn() {
    const root = Deno.realPathSync(Deno.makeTempDirSync())
    Deno.mkdirSync(`${root}/actual`)
    Deno.symlinkSync(`${root}/actual`, `${root}/alias`)
    const paths = localStoragePaths({ DATA_DIR: 'alias' }, root)
    const release = await acquireStorageLocks(paths, 0)
    const orphan = `${paths.BRANDING_PATH}/logo.json.tmp-01234567-abc`
    try {
      Deno.writeTextFileSync(orphan, 'orphan')
      sweepAtomicTemps(paths, release.paths)
      expect(() => Deno.statSync(orphan)).toThrow(Deno.errors.NotFound)
    } finally {
      release()
      Deno.removeSync(root, { recursive: true })
    }
  },
})
