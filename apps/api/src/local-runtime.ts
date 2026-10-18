import { dirname, join } from 'node:path'
import { scheduleAfter } from './local-timers.ts'

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
  return await acquireLockFile(join(dataDir, '.writer.lock'), waitSeconds)
}

/** Lock a persistent sibling or directory lock file without replacing its inode. */
export async function acquireLockFile(path: string, waitSeconds = 60): Promise<() => void> {
  Deno.mkdirSync(dirname(path), { recursive: true })
  // Open read/write: exclusive locks on NFS need a writable descriptor.
  const file = Deno.openSync(path, {
    read: true,
    write: true,
    create: true,
  })
  const deadline = performance.now() + waitSeconds * 1000
  try {
    while (!file.tryLockSync(true)) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw new Error(`${path} writer lock is still held after ${waitSeconds} seconds`)
      }
      await new Promise<void>((resolve) => scheduleAfter(Math.min(100, remaining), resolve))
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

/** Stop admission, briefly drain HTTP work, then cancel producers within one shutdown budget. */
export function installShutdown(options: {
  graceSeconds: number
  stopScheduler(): Promise<void>
  abort(): void
  shutdownServer(): Promise<void>
  closeDatabase(): void
  releaseLock(): void
  log?: (line: string) => void
  exit?: (code: number) => void
  schedule?: typeof scheduleAfter
  listen?: (signal: Deno.Signal, listener: () => void) => void
}): (signal: string) => Promise<void> {
  const log = options.log ?? console.log
  const exit = options.exit ?? Deno.exit
  const schedule = options.schedule ?? scheduleAfter
  const listen = options.listen ?? Deno.addSignalListener
  let closing: Promise<void> | undefined
  let interrupts = 0
  let forced = false
  let cancelDeadline = () => {}
  let cancelDrain = () => {}
  const phase = (phase: string, outcome = 'success') =>
    log(JSON.stringify({ event: 'server.shutdown', phase, outcome }))
  const force = (phaseName: string, code: number) => {
    forced = true
    cancelDrain()
    cancelDeadline()
    phase(phaseName, 'timeout')
    // Never release the fence while a producer can still write. Exit closes it with SQLite.
    exit(code)
  }
  const shutdown = (signal: string): Promise<void> => {
    if (signal === 'SIGINT' && ++interrupts > 1) {
      force('forced', 130)
      return closing ?? Promise.resolve()
    }
    return closing ??= (async () => {
      log(JSON.stringify({ event: 'server.shutdown', phase: 'received', signal }))
      cancelDeadline = schedule(options.graceSeconds * 1000, () => force('deadline', 1))
      try {
        const stopped = options.stopScheduler()
        // Observe early failures while HTTP drains; the join below still reports cleanup failure.
        void stopped.catch(() => {})
        phase('scheduler_stopping')
        // shutdown() stops admission immediately, but lets current requests complete.
        const drained = options.shutdownServer()
        phase('http_draining')
        try {
          await Promise.race([
            drained,
            new Promise<void>((resolve) => {
              // Reserve at least half of short test/operator budgets for cancellation/checkpoints.
              cancelDrain = schedule(Math.min(3000, options.graceSeconds * 500), resolve)
            }),
          ])
        } finally {
          cancelDrain()
        }
        if (forced) return
        options.abort()
        phase('units_aborted')
        await Promise.all([
          stopped.then(() => phase('scheduler_stopped')),
          drained,
        ])
        if (forced) return
        phase('http_drained')
        options.closeDatabase()
        phase('database_closed')
        options.releaseLock()
        phase('writer_released')
        cancelDeadline()
        phase('complete')
        exit(0)
      } catch {
        cancelDeadline()
        if (forced) return
        phase('cleanup', 'failure')
        exit(1)
      }
    })()
  }
  if (Deno.build.os !== 'windows') {
    listen('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
  }
  listen('SIGINT', () => {
    void shutdown('SIGINT')
  })
  return shutdown
}
