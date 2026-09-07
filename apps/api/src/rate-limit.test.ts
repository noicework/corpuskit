import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  clientIp,
  clientKey,
  RATE_LIMIT_MESSAGE,
  rateLimit,
  SlidingWindowLimiter,
} from './rate-limit.ts'
import { type Context, Hono } from 'hono'

/** A controllable clock so tests never depend on real elapsed time. */
function fakeClock(start = 0) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('SlidingWindowLimiter', () => {
  it('allows requests under the limit', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now })

    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('rejects once over the limit, with a positive Retry-After in seconds', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: clock.now })

    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
    const third = limiter.check('a')
    expect(third.allowed).toBe(false)
    expect(third.retryAfterSec).toBeGreaterThan(0)
    expect(third.retryAfterSec).toBeLessThanOrEqual(60)
  })

  it('slides the window: the oldest hit expiring frees up a slot', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: clock.now })

    expect(limiter.check('a').allowed).toBe(true) // t=0
    clock.advance(30_000)
    expect(limiter.check('a').allowed).toBe(true) // t=30s
    expect(limiter.check('a').allowed).toBe(false) // t=30s, still 2 hits in window -> blocked

    clock.advance(31_000) // t=61s: the t=0 hit has aged out, the t=30s hit hasn't
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('0 disables the limiter entirely, and it never tracks hits while disabled', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 0, windowMs: 60_000, now: clock.now })

    for (let i = 0; i < 50; i++) {
      expect(limiter.check('a').allowed).toBe(true)
    }
    expect(limiter.size).toBe(0)
  })

  it('a negative limit also disables the limiter (env misconfiguration is safe)', () => {
    const limiter = new SlidingWindowLimiter({ limit: -1, windowMs: 60_000 })
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('isolates callers by key: one IP hitting its limit does not affect another', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: clock.now })

    expect(limiter.check('ip-1').allowed).toBe(true)
    expect(limiter.check('ip-1').allowed).toBe(false)
    expect(limiter.check('ip-2').allowed).toBe(true)
  })

  it('prunes stale entries so the map does not grow unboundedly', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 5, windowMs: 60_000, now: clock.now })

    for (let i = 0; i < 200; i++) {
      limiter.check(`ip-${i}`)
    }
    expect(limiter.size).toBe(200)

    // Move well past the window, then make one more call - the periodic
    // sweep triggered by that call should drop every stale bucket,
    // including ones other than the key just checked.
    clock.advance(120_000)
    limiter.check('ip-fresh')
    expect(limiter.size).toBe(1)
  })
})

describe('clientIp', () => {
  const testApp = () => {
    const app = new Hono()
    app.get('/', (c) => c.text(clientIp(c)))
    return app
  }

  it('prefers fly-client-ip', async () => {
    const app = testApp()
    const res = await app.request('/', {
      headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1' },
    })
    expect(await res.text()).toBe('203.0.113.9')
  })

  it('falls back to the first hop of x-forwarded-for', async () => {
    const app = testApp()
    const res = await app.request('/', {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    })
    expect(await res.text()).toBe('198.51.100.7')
  })

  it('falls back to "unknown" with neither header', async () => {
    const app = testApp()
    const res = await app.request('/')
    expect(await res.text()).toBe('unknown')
  })
})

describe('rateLimit middleware', () => {
  it('429s with a Retry-After header and the documented body once over limit', async () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: clock.now })
    const app = new Hono()
    app.get('/', rateLimit(limiter, () => 'same-ip'), (c) => c.json({ ok: true }))

    const first = await app.request('/')
    expect(first.status).toBe(200)

    const second = await app.request('/')
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({ error: 'rate_limited' })
    expect(second.headers.get('retry-after')).not.toBeNull()
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('has a defined Australian-English, em-dash-free user-facing message available', () => {
    expect(RATE_LIMIT_MESSAGE).toContain('You are asking faster')
    expect(RATE_LIMIT_MESSAGE).not.toContain('—')
  })
})

describe('X-RateLimit-Remaining', () => {
  it('reports how much of the window is left on an allowed request', async () => {
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000 })
    const app = new Hono()
    app.use('*', rateLimit(limiter, () => 'k'))
    app.get('/', (c) => c.text('ok'))
    expect((await app.request('/')).headers.get('x-ratelimit-remaining')).toBe('2')
    expect((await app.request('/')).headers.get('x-ratelimit-remaining')).toBe('1')
    expect((await app.request('/')).headers.get('x-ratelimit-remaining')).toBe('0')
    const over = await app.request('/')
    expect(over.status).toBe(429)
    expect(over.headers.get('x-ratelimit-remaining')).toBeNull()
  })
  it('is absent when the limiter is disabled', async () => {
    const app = new Hono()
    app.use('*', rateLimit(new SlidingWindowLimiter({ limit: 0, windowMs: 60_000 }), () => 'k'))
    app.get('/', (c) => c.text('ok'))
    expect((await app.request('/')).headers.get('x-ratelimit-remaining')).toBeNull()
  })
})

describe('clientKey', () => {
  const ctx = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Context

  it('keys on a well-formed x-rp-client id ahead of the address', () => {
    expect(clientKey(ctx({ 'x-rp-client': 'abcdef0123456789', 'fly-client-ip': '10.0.0.1' })))
      .toBe('client:abcdef0123456789')
  })

  it('falls back to the address when the id is missing or malformed', () => {
    expect(clientKey(ctx({ 'fly-client-ip': '10.0.0.1' }))).toBe('ip:10.0.0.1')
    expect(clientKey(ctx({ 'x-rp-client': 'x y', 'fly-client-ip': '10.0.0.1' }))).toBe(
      'ip:10.0.0.1',
    )
    expect(clientKey(ctx({ 'x-rp-client': 'short', 'fly-client-ip': '10.0.0.1' }))).toBe(
      'ip:10.0.0.1',
    )
  })
})
