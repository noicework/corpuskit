import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AuditWriteError } from './audit.ts'
import type { OwnedMutationBoundary } from './stores.ts'

/** Synchronous file adapters: restore exact bytes if their required audit cannot commit. */
export function fileMutation<T>(
  paths: readonly string[],
  boundary: OwnedMutationBoundary,
  work: () => T,
  restoreCache?: () => void,
): T {
  const before = paths.map((path) => {
    try {
      return readFileSync(path)
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
      const bytes = before[index]
      if (bytes === undefined) rmSync(path, { force: true })
      else {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
      }
    }
    restoreCache?.()
    throw completed ? new AuditWriteError() : error
  }
}
