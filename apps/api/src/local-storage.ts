import { dirname, resolve } from 'node:path'
import { acquireWriterLock } from './local-runtime.ts'

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

/** Fence every store directory before opening stores. Sort locks to avoid lock-order cycles. */
export async function acquireStorageLocks(
  paths: ReturnType<typeof localStoragePaths>,
  waitSeconds: number,
): Promise<() => void> {
  const directories = [
    paths.DATA_DIR,
    dirname(paths.TENANTS_PATH),
    dirname(paths.BINDINGS_PATH),
    dirname(paths.KG_PROPOSALS_PATH),
    paths.BRANDING_PATH,
  ]
  const canonical = new Set<string>()
  for (const directory of directories) {
    Deno.mkdirSync(directory, { recursive: true })
    canonical.add(Deno.realPathSync(directory))
  }
  const releases: (() => void)[] = []
  const release = () => {
    for (const unlock of releases.splice(0).reverse()) unlock()
  }
  const deadline = performance.now() + waitSeconds * 1000
  try {
    for (const directory of [...canonical].sort()) {
      releases.push(
        await acquireWriterLock(directory, Math.max(0, deadline - performance.now()) / 1000),
      )
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}
