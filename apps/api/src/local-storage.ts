import { basename, dirname, join, resolve } from 'node:path'
import { acquireLockFile } from './local-runtime.ts'

type StorageLocks = (() => void) & { readonly paths: ReadonlySet<string> }

/** Preserve existing paths, including the legacy defaults outside a custom DATA_DIR. */
export function localStoragePaths(env: Record<string, string | undefined>, cwd = Deno.cwd()) {
  const dataDir = resolve(cwd, env.DATA_DIR ?? './data')
  const rbac = env.RBAC_PATH ?? `${dataDir}/rbac.sqlite`
  return {
    DATA_DIR: dataDir,
    TENANTS_PATH: resolve(cwd, env.TENANTS_PATH ?? './data/tenants.json'),
    BINDINGS_PATH: resolve(cwd, env.BINDINGS_PATH ?? './data/bindings.json'),
    KG_PROPOSALS_PATH: resolve(cwd, env.KG_PROPOSALS_PATH ?? `${dataDir}/kg-proposals.json`),
    BRANDING_PATH: resolve(cwd, env.BRANDING_PATH ?? `${dataDir}/branding`),
    // SQLite's in-memory and temporary databases have no shared file to fence.
    RBAC_PATH: rbac === ':memory:' || rbac === '' ? rbac : resolve(cwd, rbac),
  }
}

function fileStorePaths(paths: ReturnType<typeof localStoragePaths>) {
  return [paths.TENANTS_PATH, paths.BINDINGS_PATH, paths.KG_PROPOSALS_PATH, paths.RBAC_PATH]
    .filter((path) => path !== ':memory:' && path !== '')
}

/** Fence every store independently of DATA_DIR. Sort canonical locks to avoid lock-order cycles. */
export async function acquireStorageLocks(
  paths: ReturnType<typeof localStoragePaths>,
  waitSeconds: number,
): Promise<StorageLocks> {
  const canonicalDirectory = (directory: string) => {
    Deno.mkdirSync(directory, { recursive: true })
    return Deno.realPathSync(directory)
  }
  const dataDir = canonicalDirectory(paths.DATA_DIR)
  const locks = new Set([join(dataDir, '.writer.lock')])
  for (const path of fileStorePaths(paths)) {
    const canonical = join(canonicalDirectory(dirname(path)), basename(path))
    locks.add(`${canonical}.writer.lock`)
  }
  const branding = canonicalDirectory(paths.BRANDING_PATH)
  locks.add(join(branding, '.writer.lock'))
  const releases: (() => void)[] = []
  const release = () => {
    for (const unlock of releases.splice(0).reverse()) unlock()
    locks.clear()
  }
  const deadline = performance.now() + waitSeconds * 1000
  try {
    for (const path of [...locks].sort()) {
      releases.push(
        await acquireLockFile(path, Math.max(0, deadline - performance.now()) / 1000),
      )
    }
    return Object.assign(release, { paths: locks })
  } catch (error) {
    release()
    throw error
  }
}

/** Remove only this atomic writer's orphan files, after all storage locks have been acquired. */
export function sweepAtomicTemps(
  paths: ReturnType<typeof localStoragePaths>,
  ownedLocks: ReadonlySet<string> = new Set(),
): void {
  // crypto.randomUUID().slice(0, 12) is eight hex digits, a hyphen and three hex digits.
  const suffix = /\.tmp-[0-9a-f]{8}-[0-9a-f]{3}$/
  const foreignLock = (path: string) => {
    if (ownedLocks.has(path)) return false
    try {
      Deno.lstatSync(path)
      return true
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false
      throw error
    }
  }
  const visit = (directory: string, target?: string) => {
    let entries: Deno.DirEntry[]
    let canonical: string
    try {
      canonical = Deno.realPathSync(directory)
      // Even an idle lock file marks another deployment's tree. Do not enter it.
      if (foreignLock(join(canonical, '.writer.lock'))) return
      entries = [...Deno.readDirSync(directory)]
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return
      reportSweepFailure(directory, error)
      return
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      try {
        if (
          entry.isFile && suffix.test(entry.name) && entry.name.replace(suffix, '') &&
          (target === undefined || entry.name.replace(suffix, '') === target)
        ) {
          // A file override can belong to another server even inside this DATA_DIR.
          const file = entry.name.replace(suffix, '')
          if (
            foreignLock(join(canonical, '.writer.lock')) ||
            foreignLock(join(canonical, `${file}.writer.lock`))
          ) continue
          Deno.removeSync(path)
        } else if (entry.isDirectory && target === undefined) {
          visit(path)
        }
      } catch (error) {
        reportSweepFailure(path, error)
      }
      // Never follow symlinks into directories or files outside this deployment's ownership.
    }
  }
  visit(paths.DATA_DIR)
  visit(paths.BRANDING_PATH)
  // An external file override owns its named siblings, not everything in its parent directory.
  for (const path of fileStorePaths(paths)) {
    visit(dirname(path), basename(path))
  }
}

/** Cleanup is best effort, including its diagnostics. Never log paths or error messages. */
function reportSweepFailure(path: string, error: unknown): void {
  try {
    const code = (error as { code?: unknown } | null)?.code
    const fallback = error instanceof Deno.errors.PermissionDenied
      ? 'EACCES'
      : error instanceof Deno.errors.NotCapable
      ? 'ENOTCAPABLE'
      : error instanceof Deno.errors.Busy
      ? 'EBUSY'
      : 'UNKNOWN'
    console.error(JSON.stringify({
      event: 'storage.sweep_failed',
      file: basename(path),
      code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback,
    }))
  } catch {
    // A failed log sink must not turn an orphan cleanup failure into a boot failure.
  }
}
