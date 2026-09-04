import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Shared crash-safe persistence for the volume-backed stores (stores.ts,
// bindings.ts, tenants.ts, kg.ts). All of this app's durable state is plain
// JSON on a Fly volume, which a bare writeFileSync leaves exposed to two
// failure modes:
//   - a crash or OOM mid-write truncates the file (partial JSON on disk)
//   - a read of that truncated file throws, and a silent catch-and-fallback
//     makes the whole store quietly revert to empty/demo state
// The helpers below close both: writes land atomically or not at all, and a
// read that fails to parse is treated as corruption - logged loudly and
// quarantined - rather than silently swallowed.
// ---------------------------------------------------------------------------

/**
 * Write `data` to `path` atomically: write to `<path>.tmp` in the same
 * directory, then renameSync over the target. A rename within one
 * filesystem is atomic, so a reader never observes a partially-written
 * file - either the old content is still there, or the new content is
 * there in full. fsync is deliberately not performed (not required for
 * this app's durability bar; the volume survives ordinary process crashes).
 */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, path)
}

/** JSON-serialise `value` and write it atomically to `path`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2))
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Move a corrupt file aside to `<path>.corrupt-<epoch-ms>` so an operator
 * can recover or inspect it later, and so the next write to `path` starts
 * clean instead of silently burying the evidence.
 */
function quarantine(path: string): void {
  const dest = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, dest)
    console.error(`[persist] quarantined corrupt file: ${path} -> ${dest}`)
  } catch (renameErr) {
    console.error(`[persist] failed to quarantine corrupt file ${path}:`, renameErr)
  }
}

/**
 * Read and JSON.parse `path`, returning `fallback` when the file does not
 * exist yet (the ordinary first-run case - not logged). A read or parse
 * failure on a file that DOES exist is treated as corruption: it is logged
 * with console.error naming the file and the underlying error, the file is
 * quarantined via `quarantine`, and `fallback` is returned so the caller
 * degrades to an empty/default store instead of throwing - loudly, not
 * silently.
 */
export function readJsonSafe<T>(path: string, fallback: T): T {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (!isEnoent(err)) {
      console.error(`[persist] failed to read ${path}, falling back:`, err)
    }
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    console.error(`[persist] corrupt JSON in ${path}, falling back:`, err)
    quarantine(path)
    return fallback
  }
}
