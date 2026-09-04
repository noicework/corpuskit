import type { Context, MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// A small in-memory sliding-window rate limiter for the anonymous, paid-LLM
// routes (ask, generate, summarize, subqueries, verdicts, synthesise,
// ask-estate). No external deps - this is a demo portal on a single Fly
// machine, not a distributed system, so per-process memory is enough and a
// restart resetting counters is fine.
//
// Publishing this source open (the plan for this repo) publishes the recipe
// for draining the connected ARAG account unless every LLM-spend route is
// throttled per caller. Admin routes are passcode-gated already and are
// deliberately NOT wrapped by this limiter.
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Max requests allowed per window per key. 0 (or negative) disables limiting entirely. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
}

/**
 * Sliding-window limiter keyed by an arbitrary caller-supplied string
 * (typically client IP). Each key's recent hit timestamps are kept in a
 * Map; a hit older than the window no longer counts against the caller, and
 * buckets with no fresh hits are dropped so the map cannot grow unbounded
 * from IPs that stop calling.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private lastSweep: number

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.now = options.now ?? Date.now
    this.lastSweep = this.now()
  }

  /** Number of distinct keys currently tracked - exposed for tests. */
  get size(): number {
    return this.buckets.size
  }

  /**
   * Records a hit for `key` (unless already over limit) and reports whether
   * it is allowed. A disabled limiter (limit <= 0) always allows and never
   * tracks anything.
   */
  check(key: string): { allowed: boolean; retryAfterSec: number } {
    if (this.limit <= 0) return { allowed: true, retryAfterSec: 0 }

    const now = this.now()
    const cutoff = now - this.windowMs
    const hits = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff)

    let allowed: boolean
    let retryAfterSec = 0
    if (hits.length >= this.limit) {
      allowed = false
      const oldest = hits[0] ?? now
      retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
    } else {
      hits.push(now)
      allowed = true
    }

    if (hits.length === 0) this.buckets.delete(key)
    else this.buckets.set(key, hits)

    // Periodic full sweep (at most once per window) rather than on every
    // call, so an active key isn't paying an O(all keys) cost per request.
    if (now - this.lastSweep >= this.windowMs) {
      this.sweep(cutoff)
      this.lastSweep = now
    }

    return { allowed, retryAfterSec }
  }

  /** Drop buckets whose entries are all stale, and shrink the rest. */
  private sweep(cutoff: number): void {
    for (const [key, hits] of this.buckets) {
      const fresh = hits.filter((ts) => ts > cutoff)
      if (fresh.length === 0) this.buckets.delete(key)
      else if (fresh.length !== hits.length) this.buckets.set(key, fresh)
    }
  }
}

/**
 * The caller's IP, in priority order: Fly's `fly-client-ip` (set by the Fly
 * edge on every request, not spoofable by the caller), then the first hop
 * of `x-forwarded-for` (useful behind a plain reverse proxy in other
 * environments), then 'unknown' - which still rate-limits, just as one
 * shared bucket for every caller that presents neither header.
 */
export function clientIp(c: Context): string {
  const fly = c.req.header('fly-client-ip')
  if (fly) return fly
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return 'unknown'
}

/**
 * User-facing copy for a 429, for the frontend to show when it sees
 * `error: 'rate_limited'` - Australian English, no em dashes. Not sent in
 * the API response body itself (which stays the minimal `{error}` shape),
 * so it lives here as the one source of truth for the frontend to import.
 */
export const RATE_LIMIT_MESSAGE =
  'You are asking faster than the portal can answer - please wait a moment and try again.'

/**
 * Hono middleware that rejects requests over `limiter`'s window with a 429,
 * a Retry-After header (seconds), and a `{"error":"rate_limited"}` body.
 * Keyed by `keyFn` (client IP for every current use).
 */
export function rateLimit(
  limiter: SlidingWindowLimiter,
  keyFn: (c: Context) => string = clientIp,
): MiddlewareHandler {
  return async (c, next) => {
    const { allowed, retryAfterSec } = limiter.check(keyFn(c))
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSec))
      return c.json({ error: 'rate_limited' }, 429)
    }
    await next()
  }
}
