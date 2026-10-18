import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

export interface MaintenanceState {
  lastStart: string | null
  lastSuccess: string | null
  consecutiveFailures: number
}

export interface SchedulerClock {
  now(): number
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(timer: number): void
}

/** The next strictly future occurrence of HH:MM UTC, independent of the process start time. */
export function nextMaintenanceAt(now: number, atUtc = '15:17'): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(atUtc)) {
    throw new Error('MAINTENANCE_AT_UTC must be HH:MM in UTC')
  }
  const [hour, minute] = atUtc.split(':').map(Number)
  const next = new Date(now)
  next.setUTCHours(hour!, minute!, 0, 0)
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime()
}

/** Serialised, cancellable local timers. State describes daily upkeep, not enrichment-only runs. */
export function startMaintenanceTimers(options: {
  dataDir: string
  atUtc?: string
  cadenceMs: number
  runDaily(signal: AbortSignal): Promise<void>
  runEnrichments(signal: AbortSignal): Promise<void>
  clock?: SchedulerClock
  log?: (line: string) => void
}): () => Promise<void> {
  const clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout }
  const log = options.log ?? console.log
  // Validate before registering any timer.
  nextMaintenanceAt(clock.now(), options.atUtc)
  const path = join(options.dataDir, 'maintenance-state.json')
  const state = readJsonSafe<MaintenanceState>(path, {
    lastStart: null,
    lastSuccess: null,
    consecutiveFailures: 0,
  })
  const controller = new AbortController()
  let stopped = false
  let queue = Promise.resolve()
  const enqueue = (kind: 'daily' | 'enrichment', work: (signal: AbortSignal) => Promise<void>) => {
    queue = queue.then(async () => {
      if (stopped) return
      const start = clock.now()
      let outcome = 'success'
      try {
        if (kind === 'daily') {
          state.lastStart = new Date(start).toISOString()
          writeJsonAtomic(path, state)
        }
        await work(controller.signal)
        controller.signal.throwIfAborted()
      } catch {
        outcome = controller.signal.aborted ? 'aborted' : 'failure'
      } finally {
        try {
          if (kind === 'daily') {
            if (outcome === 'success') {
              state.lastSuccess = new Date(clock.now()).toISOString()
              state.consecutiveFailures = 0
            } else state.consecutiveFailures++
            writeJsonAtomic(path, state)
          }
        } catch {
          outcome = 'failure'
        }
        log(JSON.stringify({
          event: 'maintenance.heartbeat',
          kind,
          outcome,
          durationMs: clock.now() - start,
        }))
      }
    })
  }
  let daily: number
  const scheduleDaily = () => {
    daily = clock.setTimeout(() => {
      if (stopped) return
      enqueue('daily', options.runDaily)
      scheduleDaily()
    }, nextMaintenanceAt(clock.now(), options.atUtc) - clock.now())
  }
  let enrichment: number
  const scheduleEnrichment = () => {
    enrichment = clock.setTimeout(() => {
      if (stopped) return
      enqueue('enrichment', options.runEnrichments)
      scheduleEnrichment()
    }, options.cadenceMs)
  }
  // A recent successful daily pass survives a restart. A future timestamp is not recent.
  const boot = clock.setTimeout(() => {
    const age = clock.now() - Date.parse(state.lastSuccess ?? '')
    if (age >= 0 && age < 20 * 3600 * 1000) return
    enqueue('daily', async (signal) => {
      let failure: unknown
      try {
        await options.runDaily(signal)
      } catch (error) {
        failure = error
      }
      signal.throwIfAborted()
      // Account back-pressure suppresses additional work on the shared account.
      if (!(failure && typeof failure === 'object' && 'halted' in failure && failure.halted)) {
        await options.runEnrichments(signal)
      }
      if (failure) throw failure
    })
  }, 90_000)
  scheduleDaily()
  scheduleEnrichment()
  return () => {
    stopped = true
    clock.clearTimeout(boot)
    clock.clearTimeout(daily)
    clock.clearTimeout(enrichment)
    controller.abort(new DOMException('Server shutting down', 'AbortError'))
    return queue
  }
}
