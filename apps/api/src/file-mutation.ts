import { readFileSync, rmSync, statSync, truncateSync } from 'node:fs'
import { AuditWriteError } from './audit.ts'
import type { OwnedMutationBoundary } from './stores.ts'
import { reportRestoreFailure, writeFileAtomic } from './persist.ts'

/** Synchronous file adapters: restore exact bytes if their required audit cannot commit. */
export function fileMutation<T>(
  paths: readonly string[],
  boundary: OwnedMutationBoundary,
  work: () => T,
  restoreCache?: () => void,
  mode: 'replace' | 'append' = 'replace',
): T {
  const before = paths.map((path) => {
    try {
      // Only append-only adapters may use a byte-length checkpoint. Erasure and replacement
      // still need the exact bytes, since truncation cannot restore overwritten content.
      return mode === 'append' ? statSync(path).size : readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  })
  let completed = false
  try {
    return boundary.database.transactionSync(() => {
      const result = work()
      boundary.complete()
      completed = true
      return result
    })
  } catch (error) {
    for (const [index, path] of paths.entries()) {
      try {
        const bytes = before[index]
        if (bytes === undefined) rmSync(path, { force: true })
        else if (typeof bytes === 'number') truncateSync(path, bytes)
        else writeFileAtomic(path, bytes)
      } catch (restoreError) {
        reportRestoreFailure(path, restoreError)
      }
    }
    restoreCache?.()
    throw completed ? new AuditWriteError() : error
  }
}
