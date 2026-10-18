import { expect } from '@std/expect'
import {
  nextMaintenanceAt,
  type SchedulerClock,
  startMaintenanceTimers,
} from './local-scheduler.ts'
import { writeJsonAtomic } from './persist.ts'

class Clock implements SchedulerClock {
  private id = 0
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  constructor(private time = Date.parse('2026-10-18T14:00:00Z')) {}
  now = () => this.time
  setTimeout = (callback: () => void, delay: number) => {
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
        .sort((a, b) => a[1].at - b[1].at)[0]
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
  Deno.mkdirSync('/tmp/ck-l2a', { recursive: true })
  return Deno.makeTempDirSync({ dir: '/tmp/ck-l2a' })
}

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
    state = JSON.parse(Deno.readTextFileSync(`${directory}/maintenance-state.json`))
    expect(state.consecutiveFailures).toBe(0)
    expect(state.lastSuccess).toBe('2026-10-18T15:17:00.000Z')
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
