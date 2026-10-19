import { expect } from '@std/expect'
import {
  nextMaintenanceAt,
  type SchedulerClock,
  startMaintenanceTimers,
} from './local-scheduler.ts'
import { writeJsonAtomic } from './persist.ts'
import { MAX_TIMER_DELAY_MS, scheduleAt } from './local-timers.ts'
import { autoEnrichmentCadenceMs, MaintenanceError } from './scheduler.ts'

class Clock implements SchedulerClock {
  private id = 0
  private wallOffset = 0
  readonly delays: number[] = []
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  constructor(
    private time = Date.parse('2026-10-18T14:00:00Z'),
    private readonly reverseTies = false,
  ) {}
  now = () => this.time + this.wallOffset
  stepWall(ms: number) {
    this.wallOffset += ms
  }
  setTimeout = (callback: () => void, delay: number) => {
    expect(Number.isFinite(delay) && delay >= 0 && delay <= MAX_TIMER_DELAY_MS).toBe(true)
    this.delays.push(delay)
    this.timers.set(++this.id, { at: this.time + delay, callback })
    return this.id
  }
  clearTimeout = (id: number) => {
    this.timers.delete(id)
  }
  async advance(ms: number) {
    const target = this.time + ms
    while (true) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || (this.reverseTies ? b[0] - a[0] : a[0] - b[0]))[0]
      if (!due) break
      this.time = due[1].at
      this.timers.delete(due[0])
      due[1].callback()
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }
    this.time = target
  }
}

function fixture() {
  return Deno.makeTempDirSync()
}

Deno.test('boot daily is enqueued before enrichment regardless of timer tie order', async (t) => {
  for (const reverseTies of [false, true]) {
    await t.step(reverseTies ? 'newest timer first' : 'oldest timer first', async () => {
      const directory = fixture()
      const clock = new Clock(undefined, reverseTies)
      const calls: string[] = []
      const stop = startMaintenanceTimers({
        dataDir: directory,
        clock,
        cadenceMs: 3600_000,
        log: () => {},
        runDaily: async () => {
          calls.push('daily')
        },
        runEnrichments: async () => {
          calls.push('enrichment')
        },
      })
      try {
        await clock.advance(90_000)
        expect(calls).toEqual(['daily', 'enrichment'])
      } finally {
        await stop()
        Deno.removeSync(directory, { recursive: true })
      }
    })
  }
})

Deno.test('shutdown before boot cancels maintenance without running either pass', async () => {
  const directory = fixture()
  const clock = new Clock()
  const calls: string[] = []
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 3600_000,
    log: () => {},
    runDaily: async () => {
      calls.push('daily')
    },
    runEnrichments: async () => {
      calls.push('enrichment')
    },
  })
  try {
    await stop()
    expect(clock.timers.size).toBe(0)
    await clock.advance(86400_000)
    expect(calls).toEqual([])
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('daily restarts preserve enrichment cadence even when the boot daily pass is skipped', async () => {
  const directory = fixture()
  const clock = new Clock(Date.parse('2026-10-18T10:00:00Z'))
  const enrichmentStarts: number[] = []
  let dailyRuns = 0
  let stop = async () => {}
  try {
    for (let day = 0; day < 14; day++) {
      stop = startMaintenanceTimers({
        dataDir: directory,
        clock,
        cadenceMs: 86400_000,
        log: () => {},
        runDaily: async () => {
          dailyRuns++
        },
        runEnrichments: async () => {
          enrichmentStarts.push(clock.now())
        },
      })
      await clock.advance(86400_000 - 1)
      await stop()
      expect(clock.timers.size).toBe(0)
      await clock.advance(1)
    }
    expect(dailyRuns).toBe(14)
    expect(enrichmentStarts).toEqual(Array.from(
      { length: 14 },
      (_, day) => Date.parse('2026-10-18T10:01:30Z') + day * 86400_000,
    ))
    const state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
    expect(state.lastEnrichmentRun).toBe('2026-10-31T10:01:30.000Z')
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a future enrichment timestamp runs after boot and then keeps its cadence', async () => {
  const directory = fixture()
  const clock = new Clock()
  const start = clock.now()
  const attempts: number[] = []
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: null,
    lastSuccess: new Date(start).toISOString(),
    lastEnrichmentRun: new Date(start + 7 * 86400_000).toISOString(),
    consecutiveFailures: 0,
  })
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 3600_000,
    log: () => {},
    runDaily: async () => {},
    runEnrichments: async () => {
      attempts.push(clock.now())
    },
  })
  try {
    await clock.advance(90_000 - 1)
    expect(attempts).toEqual([])
    await clock.advance(1)
    expect(attempts).toEqual([start + 90_000])
    await clock.advance(3600_000 - 1)
    expect(attempts).toHaveLength(1)
    await clock.advance(1)
    expect(attempts).toEqual([start + 90_000, start + 90_000 + 3600_000])
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('an enrichment stamp written here keeps its cadence after a backwards clock step', async () => {
  const directory = fixture()
  const clock = new Clock()
  const start = clock.now()
  const attempts: number[] = []
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 3600_000,
    log: () => {},
    runDaily: async () => {},
    runEnrichments: async () => {
      attempts.push(clock.now())
      if (attempts.length === 1) clock.stepWall(-1000)
    },
  })
  try {
    await clock.advance(90_000)
    expect(attempts).toEqual([start + 90_000])
    await clock.advance(3600_000 + 1000 - 1)
    expect(attempts).toHaveLength(1)
    await clock.advance(1)
    expect(attempts).toEqual([start + 90_000, start + 90_000 + 3600_000])
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('legacy state enriches after boot and a failed attempt keeps its due time after restart', async () => {
  const directory = fixture()
  const clock = new Clock()
  const attempts: number[] = []
  const heartbeats: string[] = []
  let dailyRuns = 0
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: null,
    lastSuccess: new Date(clock.now()).toISOString(),
    consecutiveFailures: 0,
  })
  const start = () =>
    startMaintenanceTimers({
      dataDir: directory,
      clock,
      cadenceMs: 3600_000,
      log: (line) => heartbeats.push(line),
      runDaily: async () => {
        dailyRuns++
      },
      runEnrichments: async () => {
        // The checkpoint must exist before dispatch, including when the attempt fails.
        const state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
        expect(state.lastEnrichmentRun).toBe(new Date(clock.now()).toISOString())
        attempts.push(clock.now())
        if (attempts.length === 1) throw new Error('fixture failure')
      },
    })
  let stop = start()
  try {
    await clock.advance(90_000)
    expect(dailyRuns).toBe(0)
    expect(attempts).toEqual([Date.parse('2026-10-18T14:01:30Z')])
    expect(JSON.parse(heartbeats[0]!)).toMatchObject({ kind: 'enrichment', outcome: 'failure' })
    await stop()
    await clock.advance(5 * 60_000)
    stop = start()
    await clock.advance(3600_000 - 5 * 60_000 - 1)
    expect(attempts).toHaveLength(1)
    await clock.advance(1)
    expect(attempts).toEqual([
      Date.parse('2026-10-18T14:01:30Z'),
      Date.parse('2026-10-18T15:01:30Z'),
    ])
    expect(dailyRuns).toBe(0)
    expect(JSON.parse(heartbeats[1]!)).toMatchObject({ kind: 'enrichment', outcome: 'success' })
  } finally {
    await stop()
    expect(clock.timers.size).toBe(0)
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('shared account back-pressure still defers the companion boot enrichment', async () => {
  const directory = fixture()
  const clock = new Clock()
  let runs = 0
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 3600_000,
    log: () => {},
    runDaily: async () => {
      throw new MaintenanceError([], true)
    },
    runEnrichments: async () => {
      runs++
    },
  })
  try {
    await clock.advance(90_000)
    expect(runs).toBe(0)
    await clock.advance(3600_000 - 1)
    expect(runs).toBe(0)
    await clock.advance(1)
    expect(runs).toBe(1)
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('maintenance UTC time validates HH:MM and crosses midnight and month boundaries', () => {
  expect(new Date(nextMaintenanceAt(Date.parse('2026-10-18T14:00Z'))).toISOString())
    .toBe('2026-10-18T15:17:00.000Z')
  expect(new Date(nextMaintenanceAt(Date.parse('2026-10-31T23:59Z'), '00:01')).toISOString())
    .toBe('2026-11-01T00:01:00.000Z')
  expect(new Date(nextMaintenanceAt(Date.parse('2026-10-18T15:17Z'))).toISOString())
    .toBe('2026-10-19T15:17:00.000Z')
  for (const value of ['24:00', '12:60', '3:15', '', 'invalid']) {
    expect(() => nextMaintenanceAt(0, value)).toThrow('MAINTENANCE_AT_UTC')
  }
})

Deno.test('maintenance uses wall clock, skips a recent boot success and preserves enrichment cadence', async () => {
  const directory = fixture()
  const clock = new Clock()
  const calls: string[] = []
  const logs: string[] = []
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: null,
    lastSuccess: '2026-10-18T13:00:00Z',
    lastEnrichmentRun: '2026-10-18T14:00:00Z',
    consecutiveFailures: 0,
  })
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 3600_000,
    log: (line) => logs.push(line),
    runDaily: async () => {
      calls.push('daily')
    },
    runEnrichments: async () => {
      calls.push('enrichment')
    },
  })
  try {
    await clock.advance(90_000)
    expect(calls).toEqual([])
    await clock.advance(3510_000)
    expect(calls).toEqual(['enrichment'])
    await clock.advance(17 * 60_000)
    expect(calls).toEqual(['enrichment', 'daily'])
    expect(logs.map((line) => JSON.parse(line).event)).toEqual([
      'maintenance.heartbeat',
      'maintenance.heartbeat',
    ])
    expect(JSON.parse(logs[1]!)).toMatchObject({ kind: 'daily', outcome: 'success', durationMs: 0 })
    const state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
    expect(state.lastStart).toBe('2026-10-18T15:17:00.000Z')
    expect(state.lastSuccess).toBe(state.lastStart)
    expect(state.lastEnrichmentRun).toBe('2026-10-18T15:00:00.000Z')
    expect(state.consecutiveFailures).toBe(0)
    await stop()
    await clock.advance(3 * 86400_000)
    expect(calls.length).toBe(2)
    expect(clock.timers.size).toBe(0)
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('maintenance boots with stale state, persists failures, recovers and aborts its active unit', async () => {
  const directory = fixture()
  const clock = new Clock()
  const logs: string[] = []
  let fail = true
  let active: AbortSignal | undefined
  let cancelled = false
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 86400_000,
    log: (line) => logs.push(line),
    runDaily: async (signal) => {
      if (fail) throw new Error('test failure')
      if (active) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            cancelled = true
            resolve()
          }, { once: true })
        )
      } else active = signal
    },
    runEnrichments: async () => {},
  })
  try {
    await clock.advance(90_000)
    let state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
    expect(state.lastSuccess).toBe(null)
    expect(state.consecutiveFailures).toBe(1)
    expect(JSON.parse(logs[0]!).outcome).toBe('failure')
    fail = false
    await clock.advance(75.5 * 60_000)
    expect(JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`)).lastSuccess)
      .toBe(null)
    await clock.advance(86400_000)
    state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
    expect(state.consecutiveFailures).toBe(0)
    expect(state.lastSuccess).toBe('2026-10-19T15:17:00.000Z')
    await clock.advance(86400_000)
    await stop()
    expect(cancelled).toBe(true)
    expect(active?.aborted).toBe(true)
    expect(logs.some((line) => JSON.parse(line).outcome === 'aborted')).toBe(true)
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('boot recency excludes exactly twenty hours, missing success and future timestamps', async () => {
  for (
    const [lastSuccess, expected] of [
      ['2026-10-17T19:00:00Z', 0],
      ['2026-10-17T18:00:01Z', 1],
      ['2026-10-17T18:00:00Z', 1],
      ['2026-10-18T18:00:00Z', 1],
      [null, 1],
    ] as const
  ) {
    const directory = fixture()
    const clock = new Clock()
    let runs = 0
    writeJsonAtomic(`${directory}/maintenance-state.json`, {
      lastStart: null,
      lastSuccess,
      consecutiveFailures: 0,
    })
    const stop = startMaintenanceTimers({
      dataDir: directory,
      clock,
      cadenceMs: 86400_000,
      log: () => {},
      runDaily: async () => {
        runs++
      },
      runEnrichments: async () => {},
    })
    try {
      await clock.advance(90_000)
      expect(runs).toBe(expected)
    } finally {
      await stop()
      Deno.removeSync(directory, { recursive: true })
    }
  }
})

Deno.test('720-hour and 744-hour cadences use bounded chunks and never run early', async () => {
  for (const hours of [720, 744]) {
    const directory = fixture()
    const clock = new Clock()
    let runs = 0
    writeJsonAtomic(`${directory}/maintenance-state.json`, {
      lastStart: null,
      lastSuccess: new Date(clock.now()).toISOString(),
      lastEnrichmentRun: new Date(clock.now()).toISOString(),
      consecutiveFailures: 0,
    })
    const cadenceMs = autoEnrichmentCadenceMs(String(hours))
    const stop = startMaintenanceTimers({
      dataDir: directory,
      clock,
      cadenceMs,
      log: () => {},
      runDaily: async () => {},
      runEnrichments: async () => {
        runs++
      },
    })
    try {
      await clock.advance(86400_000)
      expect(runs).toBe(0)
      await clock.advance(cadenceMs - 86400_000 - 1)
      expect(runs).toBe(0)
      await clock.advance(1)
      expect(runs).toBe(1)
      expect(clock.delays).toContain(MAX_TIMER_DELAY_MS)
      await stop()
      await clock.advance(cadenceMs)
      expect(runs).toBe(1)
      expect(clock.timers.size).toBe(0)
    } finally {
      await stop()
      Deno.removeSync(directory, { recursive: true })
    }
  }
})

Deno.test('timer cap boundaries, cancellation and a backwards wall clock keep absolute targets', async () => {
  for (const delay of [MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS + 1]) {
    const clock = new Clock(0)
    let runs = 0
    const cancel = scheduleAt(clock, delay, () => {
      runs++
    })
    await clock.advance(delay - 1)
    expect(runs).toBe(0)
    await clock.advance(1)
    expect(runs).toBe(1)
    cancel()
  }
  const clock = new Clock(0)
  let runs = 0
  const cancel = scheduleAt(clock, MAX_TIMER_DELAY_MS + 10, () => {
    runs++
  })
  await clock.advance(MAX_TIMER_DELAY_MS - 1)
  clock.stepWall(-3600_000)
  await clock.advance(11)
  expect(runs).toBe(0)
  cancel()
  await clock.advance(2 * MAX_TIMER_DELAY_MS)
  expect(runs).toBe(0)
  expect(clock.timers.size).toBe(0)
})

Deno.test('invalid cadence values fail before any timer is registered', () => {
  for (const cadenceMs of [0, -1, NaN, Infinity, -Infinity]) {
    const clock = new Clock()
    expect(() =>
      startMaintenanceTimers({
        dataDir: '/unused',
        clock,
        cadenceMs,
        runDaily: async () => {},
        runEnrichments: async () => {},
      })
    ).toThrow('AUTO_ENRICH_CADENCE_HOURS')
    expect(clock.timers.size).toBe(0)
  }
})

Deno.test('a boot pass queued behind successful daily work is skipped without a heartbeat', async () => {
  const directory = fixture()
  const clock = new Clock(Date.parse('2026-10-18T15:16:00Z'))
  const pending = Promise.withResolvers<void>()
  let dailyRuns = 0
  let enrichmentRuns = 0
  const logs: string[] = []
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: null,
    lastSuccess: null,
    lastEnrichmentRun: new Date(clock.now()).toISOString(),
    consecutiveFailures: 0,
  })
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 86400_000,
    log: (line) => logs.push(line),
    runDaily: async () => {
      dailyRuns++
      await pending.promise
    },
    runEnrichments: async () => {
      enrichmentRuns++
    },
  })
  try {
    await clock.advance(90_000)
    expect(dailyRuns).toBe(1)
    pending.resolve()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(dailyRuns).toBe(1)
    expect(enrichmentRuns).toBe(0)
    expect(logs.length).toBe(1)
  } finally {
    pending.resolve()
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('daily targets do not repeat when the wall clock steps backwards during a pass', async () => {
  const directory = fixture()
  const clock = new Clock(Date.parse('2026-10-18T15:16:59Z'))
  let runs = 0
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: null,
    lastSuccess: new Date(clock.now()).toISOString(),
    consecutiveFailures: 0,
  })
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 31 * 86400_000,
    log: () => {},
    runDaily: async () => {
      runs++
      if (runs === 1) clock.stepWall(-60_000)
    },
    runEnrichments: async () => {},
  })
  try {
    await clock.advance(1000)
    expect(runs).toBe(1)
    await clock.advance(60_000)
    expect(runs).toBe(1)
    await clock.advance(86400_000)
    expect(runs).toBe(2)
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('failed heartbeat retains a safe maintenance summary and withholds raw upstream detail', async () => {
  for (const safe of [true, false]) {
    const directory = fixture()
    const clock = new Clock()
    const logs: string[] = []
    const failure = safe
      ? new MaintenanceError([{ job: 'sync', slug: 'portal', target: 'source' }])
      : new Error('private upstream detail')
    const stop = startMaintenanceTimers({
      dataDir: directory,
      clock,
      cadenceMs: 86400_000,
      log: (line) => logs.push(line),
      failureMessage: (error) => error instanceof MaintenanceError ? error.message : undefined,
      runDaily: async () => {
        throw failure
      },
      runEnrichments: async () => {},
    })
    try {
      await clock.advance(90_000)
      const heartbeat = JSON.parse(logs[0]!)
      expect(heartbeat.outcome).toBe('failure')
      expect(heartbeat.error).toBe(safe ? failure.message : undefined)
      expect(logs.join()).not.toContain('private upstream detail')
    } finally {
      await stop()
      Deno.removeSync(directory, { recursive: true })
    }
  }
})

Deno.test('a boot attempt spends the UTC daily budget across the scheduled pass and a restart', async () => {
  for (const fail of [false, true]) {
    const directory = fixture()
    const clock = new Clock()
    const starts: string[] = []
    const options = {
      dataDir: directory,
      clock,
      cadenceMs: 86400_000,
      log: () => {},
      runDaily: async () => {
        starts.push(new Date(clock.now()).toISOString())
        if (fail) throw new Error('partial pass')
      },
      runEnrichments: async () => {},
    }
    let stop = startMaintenanceTimers(options)
    try {
      await clock.advance(90_000)
      expect(starts).toEqual(['2026-10-18T14:01:30.000Z'])
      await stop()
      stop = startMaintenanceTimers(options)
      await clock.advance(2 * 3600_000)
      expect(starts.length).toBe(1)
      await clock.advance(24 * 3600_000)
      expect(starts).toEqual(['2026-10-18T14:01:30.000Z', '2026-10-19T15:17:00.000Z'])
    } finally {
      await stop()
      Deno.removeSync(directory, { recursive: true })
    }
  }
})

Deno.test('daily scheduling notices a forward wall-clock step within one minute', async () => {
  const directory = fixture()
  const clock = new Clock()
  const starts: number[] = []
  writeJsonAtomic(`${directory}/maintenance-state.json`, {
    lastStart: '2026-10-17T15:17:00Z',
    lastSuccess: '2026-10-18T13:00:00Z',
    consecutiveFailures: 0,
  })
  const stop = startMaintenanceTimers({
    dataDir: directory,
    clock,
    cadenceMs: 86400_000,
    log: () => {},
    runDaily: async () => {
      starts.push(clock.now())
    },
    runEnrichments: async () => {},
  })
  try {
    await clock.advance(90_000)
    expect(starts.length).toBe(0)
    clock.stepWall(3 * 3600_000)
    await clock.advance(60_000)
    expect(starts.length).toBe(1)
    expect(new Date(starts[0]!).toISOString()).toBe('2026-10-18T17:02:00.000Z')
    await clock.advance(60_000)
    expect(starts.length).toBe(1)
  } finally {
    await stop()
    Deno.removeSync(directory, { recursive: true })
  }
})
