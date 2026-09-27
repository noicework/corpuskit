import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  addressKey,
  admitAll,
  clientKey,
  forwardedClientAddress,
  RATE_LIMIT_MESSAGE,
  rateLimit,
  SlidingWindowLimiter,
  trustProxyHops,
  trustProxyHopsWarning,
} from './rate-limit.ts'
import { Hono } from 'hono'

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

describe('client addresses', () => {
  it('keys a request on the address the runtime reported, never a header', () => {
    expect(addressKey('203.0.113.9')).toBe('ip:203.0.113.9')
    // No reported address is one shared bucket, not a free pass.
    expect(addressKey(undefined)).toBe('ip:unknown')
    expect(addressKey('  ')).toBe('ip:unknown')
  })

  it('reads x-forwarded-for only behind declared proxies, taking the hop they vouch for', () => {
    // No proxies declared: the TCP peer, whatever the header says.
    expect(forwardedClientAddress('10.0.0.1', '198.51.100.7', 0)).toBe('10.0.0.1')
    // One proxy appends the address it saw, so a client-written prefix is never read.
    expect(forwardedClientAddress('10.0.0.1', 'spoofed, 198.51.100.7', 1)).toBe('198.51.100.7')
    // Two proxies: the second from the right is the client.
    expect(forwardedClientAddress('10.0.0.2', 'spoofed, 198.51.100.7, 10.0.0.1', 2))
      .toBe('198.51.100.7')
    // A request that skipped a proxy: the nearest address a proxy recorded.
    expect(forwardedClientAddress('10.0.0.2', '198.51.100.7', 2)).toBe('198.51.100.7')
    // No header behind a proxy: the peer.
    expect(forwardedClientAddress('10.0.0.1', null, 1)).toBe('10.0.0.1')
    expect(forwardedClientAddress('10.0.0.1', ' , ', 1)).toBe('10.0.0.1')
  })

  it('accepts TRUST_PROXY_HOPS only as a whole number from 0 to 10', () => {
    expect(trustProxyHops(undefined)).toBe(0)
    expect(trustProxyHops('')).toBe(0)
    expect(trustProxyHops('1')).toBe(1)
    expect(trustProxyHops(' 2 ')).toBe(2)
    expect(trustProxyHops('10')).toBe(10)
    for (const invalid of ['11', '-1', '1.5', 'one', 'true', '1e1']) {
      expect(trustProxyHops(invalid)).toBe(0)
      expect(trustProxyHopsWarning({ TRUST_PROXY_HOPS: invalid })).toContain('TRUST_PROXY_HOPS')
      expect(trustProxyHopsWarning({ TRUST_PROXY_HOPS: invalid })).not.toContain(invalid)
    }
    expect(trustProxyHopsWarning({})).toBeNull()
    expect(trustProxyHopsWarning({ TRUST_PROXY_HOPS: '1' })).toBeNull()
  })
})

describe('weighted admission', () => {
  it('admits a request against every bucket at once, or against none', () => {
    const clock = fakeClock()
    const perClient = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now })
    const perPortal = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: clock.now })
    const fanOut = (weight: number, portals: string[]) =>
      admitAll([
        { limiter: perClient, key: 'ip:a', weight },
        ...portals.map((slug) => ({ limiter: perPortal, key: slug })),
      ])
    expect(fanOut(2, ['one', 'two']).allowed).toBe(true)
    // Room for the client, none for portal one: nothing is recorded anywhere.
    expect(fanOut(1, ['one', 'one'])).toMatchObject({ allowed: false })
    expect(perClient.peek('ip:a').remaining).toBe(1)
    expect(fanOut(1, ['three']).allowed).toBe(true)
    expect(fanOut(1, ['four'])).toMatchObject({ allowed: false })
    clock.advance(60_001)
    // A weight above the limit costs the whole window, once it is empty.
    expect(fanOut(10, []).allowed).toBe(true)
    expect(fanOut(1, [])).toMatchObject({ allowed: false })
  })

  it('says how long until enough room frees up for the weight asked', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now })
    limiter.take('k')
    clock.advance(10_000)
    limiter.take('k', 2)
    // Two more need the first two hits gone: the second left at 70 s, 60 s from now.
    expect(limiter.peek('k', 2)).toMatchObject({ allowed: false, retryAfterSec: 60 })
    expect(limiter.peek('k', 1)).toMatchObject({ allowed: false, retryAfterSec: 50 })
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
  it('splits an address bucket by a well-formed x-rp-client id, never replacing the address', () => {
    expect(clientKey('10.0.0.1', 'abcdef0123456789')).toBe('ip:10.0.0.1|client:abcdef0123456789')
    // The same id from another address is another bucket.
    expect(clientKey('10.0.0.2', 'abcdef0123456789')).not.toBe(
      clientKey('10.0.0.1', 'abcdef0123456789'),
    )
  })

  it('falls back to the address when the id is missing or malformed', () => {
    expect(clientKey('10.0.0.1', undefined)).toBe('ip:10.0.0.1')
    expect(clientKey('10.0.0.1', 'x y')).toBe('ip:10.0.0.1')
    expect(clientKey('10.0.0.1', 'short')).toBe('ip:10.0.0.1')
    expect(clientKey(undefined, 'abcdef0123456789')).toBe('ip:unknown|client:abcdef0123456789')
  })
})
