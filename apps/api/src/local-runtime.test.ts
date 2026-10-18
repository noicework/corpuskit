import { expect } from '@std/expect'
import { installShutdown, secondsSetting } from './local-runtime.ts'

Deno.test('runtime timing settings are finite, bounded seconds with explicit defaults', () => {
  expect(secondsSetting(undefined, 60, 'WAIT')).toBe(60)
  expect(secondsSetting('', 100, 'GRACE')).toBe(100)
  expect(secondsSetting('0', 60, 'WAIT')).toBe(0)
  expect(secondsSetting('0.2', 60, 'WAIT')).toBe(0.2)
  for (const value of ['NaN', '-1', 'Infinity', '86401', 'typo']) {
    expect(() => secondsSetting(value, 100, 'GRACE')).toThrow('GRACE')
  }
})

function shutdownFixture(graceSeconds = 100) {
  const calls: string[] = []
  const request = Promise.withResolvers<void>()
  const timers = new Map<number, () => void>()
  const signals = new Map<Deno.Signal, () => void>()
  const shutdown = installShutdown({
    graceSeconds,
    stopScheduler: async () => {
      calls.push('scheduler')
    },
    shutdownServer: () => {
      calls.push('stop-admission')
      return request.promise
    },
    abort: () => {
      calls.push('abort')
      request.resolve()
    },
    closeDatabase: () => {
      calls.push('close')
    },
    releaseLock: () => {
      calls.push('unlock')
    },
    log: () => {},
    exit: (code) => {
      calls.push(`exit:${code}`)
    },
    schedule: (ms, callback) => {
      timers.set(ms, callback)
      return () => {
        timers.delete(ms)
      }
    },
    listen: (signal, listener) => {
      signals.set(signal, listener)
    },
  })
  const fire = (ms: number) => {
    const callback = timers.get(ms)!
    timers.delete(ms)
    callback()
  }
  return { calls, request, timers, signals, shutdown, fire }
}

Deno.test('shutdown stops admission immediately and lets an in-flight request finish before abort', async () => {
  const f = shutdownFixture()
  const closing = f.shutdown('SIGTERM')
  expect(f.calls).toEqual(['scheduler', 'stop-admission'])
  f.request.resolve()
  await closing
  expect(f.calls).toEqual(['scheduler', 'stop-admission', 'abort', 'close', 'unlock', 'exit:0'])
  expect(f.timers.size).toBe(0)
})

Deno.test('shutdown aborts remaining HTTP work after a three-second drain inside its grace budget', async () => {
  const f = shutdownFixture()
  const closing = f.shutdown('SIGINT')
  expect([...f.timers.keys()]).toEqual([100_000, 3000])
  expect(f.calls).not.toContain('abort')
  f.fire(3000)
  await closing
  expect(f.calls).toEqual(['scheduler', 'stop-admission', 'abort', 'close', 'unlock', 'exit:0'])
  expect(f.timers.size).toBe(0)
})

Deno.test('a second SIGINT forces immediate exit during drain without releasing the writer fence', async () => {
  const f = shutdownFixture()
  const closing = f.shutdown('SIGINT')
  f.signals.get('SIGINT')!()
  expect(f.calls).toEqual(['scheduler', 'stop-admission', 'exit:130'])
  expect(f.timers.size).toBe(0)
  f.request.resolve()
  await closing
  expect(f.calls).not.toContain('unlock')
})

Deno.test('shutdown deadline exits without releasing the fence under an uncooperative request', async () => {
  const f = shutdownFixture()
  const closing = f.shutdown('SIGTERM')
  f.fire(100_000)
  expect(f.calls).toEqual(['scheduler', 'stop-admission', 'exit:1'])
  f.request.resolve()
  await closing
  expect(f.calls).not.toContain('unlock')
  expect(f.timers.size).toBe(0)
})

Deno.test('a short shutdown budget reserves half its time after the HTTP drain', async () => {
  const f = shutdownFixture(2)
  const closing = f.shutdown('SIGTERM')
  expect([...f.timers.keys()]).toEqual([2000, 1000])
  f.fire(1000)
  await closing
  expect(f.calls.at(-1)).toBe('exit:0')
  expect(f.timers.size).toBe(0)
})
