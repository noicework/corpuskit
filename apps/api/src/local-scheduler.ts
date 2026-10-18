import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'
import { scheduleAt, type TimerClock } from './local-timers.ts'

export interface MaintenanceState {
  lastStart: string | null
  lastSuccess: string | null
  /** Last attempted enrichment pass; absent in state written by older binaries. */
  lastEnrichmentRun?: string | null
  consecutiveFailures: number
}

export type SchedulerClock = TimerClock

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

/** Serialised, cancellable local timers with daily success and enrichment cadence checkpoints. */
export function startMaintenanceTimers(options: {
  dataDir: string
  atUtc?: string
  cadenceMs: number
  runDaily(signal: AbortSignal): Promise<void>
  runEnrichments(signal: AbortSignal): Promise<void>
  clock?: SchedulerClock
  log?: (line: string) => void
  /** Only safe maintenance summaries, never raw provider error messages. */
  failureMessage?: (error: unknown) => string | undefined
}): () => Promise<void> {
  const clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout }
  const log = options.log ?? console.log
  // Validate before registering any timer.
  if (!Number.isFinite(options.cadenceMs) || options.cadenceMs <= 0) {
    throw new Error('AUTO_ENRICH_CADENCE_HOURS must be finite and positive')
  }
  nextMaintenanceAt(clock.now(), options.atUtc)
  const path = join(options.dataDir, 'maintenance-state.json')
  const state = readJsonSafe<MaintenanceState>(path, {
    lastStart: null,
    lastSuccess: null,
    lastEnrichmentRun: null,
    consecutiveFailures: 0,
  })
  const controller = new AbortController()
  let stopped = false
  let queue = Promise.resolve()
  const enqueue = (
    kind: 'daily' | 'enrichment',
    work: (signal: AbortSignal) => Promise<void>,
    skip?: () => boolean,
  ) => {
    queue = queue.then(async () => {
      if (stopped || skip?.()) return
      const start = clock.now()
      let outcome = 'success'
      let diagnostic: string | undefined
      try {
        if (kind === 'daily') {
          state.lastStart = new Date(start).toISOString()
        } else state.lastEnrichmentRun = new Date(start).toISOString()
        // Record attempts before dispatch, so even a failed or interrupted run keeps its cadence.
        writeJsonAtomic(path, state)
        await work(controller.signal)
        controller.signal.throwIfAborted()
      } catch (error) {
        diagnostic = options.failureMessage?.(error)
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
          ...(diagnostic === undefined ? {} : { error: diagnostic }),
        }))
      }
    })
    return queue
  }
  // Attempts spend the UTC day's page budget even if interrupted or failed part-way.
  const dailyAttemptedToday = () =>
    Math.floor(Date.parse(state.lastStart ?? '') / 86400_000) ===
      Math.floor(clock.now() / 86400_000)
  let dailyDueAt = nextMaintenanceAt(clock.now(), options.atUtc)
  let cancelDaily: () => void
  const scheduleDaily = () => {
    cancelDaily = scheduleAt(clock, dailyDueAt, () => {
      if (stopped) return
      enqueue('daily', options.runDaily, dailyAttemptedToday)
      // Never repeat the previous target if the wall clock moves backwards during a pass.
      dailyDueAt = nextMaintenanceAt(Math.max(dailyDueAt, clock.now()), options.atUtc)
      scheduleDaily()
    }, 60_000)
  }
  const bootReadyAt = clock.now() + 90_000
  let enrichmentBlockedUntil = 0
  let cancelEnrichment = () => {}
  const scheduleEnrichment = () => {
    if (stopped) return
    const lastRun = Date.parse(state.lastEnrichmentRun ?? '')
    const dueAt = Math.max(
      bootReadyAt,
      enrichmentBlockedUntil,
      Number.isFinite(lastRun) && lastRun <= clock.now()
        ? lastRun + options.cadenceMs
        : clock.now(),
    )
    cancelEnrichment = scheduleAt(clock, dueAt, () => {
      if (stopped) return
      // Re-arm only after the queued attempt has checkpointed, rather than stacking overdue work.
      void enqueue('enrichment', options.runEnrichments, () => clock.now() < enrichmentBlockedUntil)
        .then(scheduleEnrichment)
    })
  }
  // Check recency when the queued boot work starts: a daily pass ahead of it may still be running.
  const recentSuccess = () => {
    const age = clock.now() - Date.parse(state.lastSuccess ?? '')
    return age >= 0 && age < 20 * 3600 * 1000
  }
  const cancelBoot = scheduleAt(clock, bootReadyAt, () => {
    enqueue('daily', async (signal) => {
      try {
        await options.runDaily(signal)
      } catch (error) {
        // Account back-pressure suppresses the companion boot enrichment on the shared account.
        if (error && typeof error === 'object' && 'halted' in error && error.halted) {
          enrichmentBlockedUntil = clock.now() + options.cadenceMs
        }
        throw error
      }
    }, () => dailyAttemptedToday() || recentSuccess())
    scheduleEnrichment()
  })
  scheduleDaily()
  return () => {
    stopped = true
    cancelBoot()
    cancelDaily()
    cancelEnrichment()
    controller.abort(new DOMException('Server shutting down', 'AbortError'))
    return queue
  }
}
