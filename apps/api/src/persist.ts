import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { platform } from 'node:os'

// ---------------------------------------------------------------------------
// Shared crash-safe persistence for the volume-backed stores (stores.ts,
// bindings.ts, tenants.ts, kg.ts). All of this app's durable state is plain
// files in single-process deployments, which a bare writeFileSync exposes to two
// failure modes:
//   - a crash or OOM mid-write truncates the file (partial JSON on disk)
//   - a read of that truncated file throws, and a silent catch-and-fallback
//     makes the whole store quietly revert to empty/demo state
// The helpers below close both: writes land atomically or not at all, and a
// read that fails to parse is treated as corruption - logged loudly and
// quarantined - rather than silently swallowed.
// ---------------------------------------------------------------------------

/**
 * Flush a unique sibling file before replacing the target, then flush the directory entry.
 * A reader sees either the previous complete file or the new complete file, including binary
 * assets. A process killed before rename may leave an unused temporary file.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  // Keep the suffix below the 24 bytes reserved by checkedOwnedPath.
  const tmpPath = `${path}.tmp-${crypto.randomUUID().slice(0, 12)}`
  const file = openSync(tmpPath, 'wx', 0o600)
  try {
    try {
      writeFileSync(file, data)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(tmpPath, path)
    syncDirectory(directory)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

/** Some filesystems do not support directory fsync; real I/O failures still fail the write. */
export function syncDirectory(path: string, io = {
  open: openSync,
  sync: fsyncSync,
  close: closeSync,
  windows: platform() === 'win32',
}): void {
  let file: number | undefined
  try {
    file = io.open(path, 'r')
    io.sync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Windows can refuse opening/flushing a directory even when file replacement succeeded.
    const unsupported = ['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']
    if (io.windows) unsupported.push('EPERM', 'EACCES')
    if (!unsupported.includes(code ?? '')) throw error
  } finally {
    if (file !== undefined) io.close(file)
  }
}

/** JSON-serialise `value` and write it atomically to `path`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2))
}

/** Commit a branding slot before removing older formats, so interruption never empties it. */
export function writeAssetAtomic(
  base: string,
  extension: string,
  extensions: readonly string[],
  bytes: Uint8Array,
): void {
  writeFileAtomic(`${base}.${extension}`, bytes)
  for (const old of extensions) {
    if (old !== extension) rmSync(`${base}.${old}`, { force: true })
  }
  syncDirectory(dirname(base))
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
