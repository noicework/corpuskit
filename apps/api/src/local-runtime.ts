import { join } from 'node:path'

/** Invalid timing settings fail startup rather than creating unbounded waits. */
export function secondsSetting(raw: string | undefined, fallback: number, name: string): number {
  const seconds = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
    throw new Error(`${name} must be a number of seconds between 0 and 86400`)
  }
  return seconds
}

/** Keep the same inode for the deployment's lifetime. Never unlink a lock file on release. */
export async function acquireWriterLock(dataDir: string, waitSeconds = 60): Promise<() => void> {
  Deno.mkdirSync(dataDir, { recursive: true })
  // Open read/write: exclusive locks on NFS need a writable descriptor.
  const file = Deno.openSync(join(dataDir, '.writer.lock'), {
    read: true,
    write: true,
    create: true,
  })
  const deadline = performance.now() + waitSeconds * 1000
  try {
    while (!file.tryLockSync(true)) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw new Error(`DATA_DIR writer lock is still held after ${waitSeconds} seconds`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
    }
  } catch (error) {
    file.close()
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      file.unlockSync()
    } finally {
      file.close()
    }
  }
}

/** A bounded shutdown, shared by SIGTERM and SIGINT; repeated signals cannot race cleanup. */
export function installShutdown(options: {
  graceSeconds: number
  stopScheduler(): Promise<void>
  abort(): void
  shutdownServer(): Promise<void>
  closeDatabase(): void
  releaseLock(): void
  log?: (line: string) => void
  exit?: (code: number) => void
}): (signal: string) => Promise<void> {
  const log = options.log ?? console.log
  const exit = options.exit ?? Deno.exit
  let closing: Promise<void> | undefined
  const phase = (phase: string, outcome = 'success') =>
    log(JSON.stringify({ event: 'server.shutdown', phase, outcome }))
  const shutdown = (signal: string) =>
    closing ??= (async () => {
      log(JSON.stringify({ event: 'server.shutdown', phase: 'received', signal }))
      const deadline = setTimeout(() => {
        phase('deadline', 'timeout')
        // Exit closes the SQLite connection and OS lock together. Never release the fence while
        // an uncooperative producer can still write; the next process must wait for our exit.
        exit(1)
      }, options.graceSeconds * 1000)
      try {
        const stopped = options.stopScheduler()
        phase('scheduler_stopped')
        options.abort()
        phase('units_aborted')
        // Stop admitting connections immediately, while active units save their checkpoints.
        await Promise.all([stopped, options.shutdownServer()])
        phase('http_drained')
        options.closeDatabase()
        phase('database_closed')
        options.releaseLock()
        phase('writer_released')
        clearTimeout(deadline)
        phase('complete')
        exit(0)
      } catch {
        clearTimeout(deadline)
        phase('cleanup', 'failure')
        exit(1)
      }
    })()
  Deno.addSignalListener('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  Deno.addSignalListener('SIGINT', () => {
    void shutdown('SIGINT')
  })
  return shutdown
}
