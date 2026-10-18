import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { acquireLockFile } from './local-runtime.ts'

/** Preserve existing paths, including the legacy defaults outside a custom DATA_DIR. */
export function localStoragePaths(env: Record<string, string | undefined>, cwd = Deno.cwd()) {
  const dataDir = resolve(cwd, env.DATA_DIR ?? './data')
  return {
    DATA_DIR: dataDir,
    TENANTS_PATH: resolve(cwd, env.TENANTS_PATH ?? './data/tenants.json'),
    BINDINGS_PATH: resolve(cwd, env.BINDINGS_PATH ?? './data/bindings.json'),
    KG_PROPOSALS_PATH: resolve(cwd, env.KG_PROPOSALS_PATH ?? `${dataDir}/kg-proposals.json`),
    BRANDING_PATH: resolve(cwd, env.BRANDING_PATH ?? `${dataDir}/branding`),
  }
}

/** Fence owned directories and external files. Sort canonical locks to avoid lock-order cycles. */
export async function acquireStorageLocks(
  paths: ReturnType<typeof localStoragePaths>,
  waitSeconds: number,
): Promise<() => void> {
  const canonicalDirectory = (directory: string) => {
    Deno.mkdirSync(directory, { recursive: true })
    return Deno.realPathSync(directory)
  }
  const dataDir = canonicalDirectory(paths.DATA_DIR)
  const covered = (path: string) => {
    const fromData = relative(dataDir, path)
    return !isAbsolute(fromData) && fromData !== '..' && !fromData.startsWith(`..${sep}`)
  }
  const locks = new Set([join(dataDir, '.writer.lock')])
  for (const path of [paths.TENANTS_PATH, paths.BINDINGS_PATH, paths.KG_PROPOSALS_PATH]) {
    const canonical = join(canonicalDirectory(dirname(path)), basename(path))
    if (!covered(canonical)) locks.add(`${canonical}.writer.lock`)
  }
  const branding = canonicalDirectory(paths.BRANDING_PATH)
  if (!covered(branding)) locks.add(join(branding, '.writer.lock'))
  const releases: (() => void)[] = []
  const release = () => {
    for (const unlock of releases.splice(0).reverse()) unlock()
  }
  const deadline = performance.now() + waitSeconds * 1000
  try {
    for (const path of [...locks].sort()) {
      releases.push(
        await acquireLockFile(path, Math.max(0, deadline - performance.now()) / 1000),
      )
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}

/** Remove only this atomic writer's orphan files, after all storage locks have been acquired. */
export function sweepAtomicTemps(paths: ReturnType<typeof localStoragePaths>): void {
  // crypto.randomUUID().slice(0, 12) is eight hex digits, a hyphen and three hex digits.
  const suffix = /\.tmp-[0-9a-f]{8}-[0-9a-f]{3}$/
  const visit = (directory: string, target?: string) => {
    let entries: Deno.DirEntry[]
    try {
      entries = [...Deno.readDirSync(directory)]
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return
      throw error
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (
        entry.isFile && suffix.test(entry.name) && entry.name.replace(suffix, '') &&
        (target === undefined || entry.name.replace(suffix, '') === target)
      ) {
        Deno.removeSync(path)
      } else if (entry.isDirectory && target === undefined) {
        visit(path)
      }
      // Never follow symlinks into directories or files outside this deployment's ownership.
    }
  }
  visit(paths.DATA_DIR)
  visit(paths.BRANDING_PATH)
  // An external file override owns its named siblings, not everything in its parent directory.
  for (const path of [paths.TENANTS_PATH, paths.BINDINGS_PATH, paths.KG_PROPOSALS_PATH]) {
    visit(dirname(path), basename(path))
  }
}
