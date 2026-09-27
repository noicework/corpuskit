import type { Context, MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// A small in-memory sliding-window rate limiter for the anonymous, paid-LLM
// routes (ask, generate, summarize, subqueries, verdicts, synthesise,
// ask-estate). No external deps: the limiter lives in the one process (the
// local server) or the one Durable Object (Cloudflare) that serves every
// request, so per-process memory is enough and a restart resetting counters
// is fine.
//
// Publishing this source open publishes the recipe for draining the
// connected ARAG account unless every LLM-spend route is throttled per
// caller. Admin routes are passcode-gated already and are deliberately NOT
// wrapped by this limiter.
//
// Every key starts from the client address the runtime itself reported
// (`PortalRequestContext.clientIp`): Cloudflare's `cf-connecting-ip` on the
// Worker, and the TCP peer on the local server, or the address a trusted
// reverse proxy recorded when `TRUST_PROXY_HOPS` says there is one. No
// header a caller can set chooses its own bucket.
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
  check(key: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const verdict = this.peek(key)
    if (verdict.allowed) this.take(key)
    return verdict.allowed ? { ...verdict, remaining: Math.max(0, verdict.remaining - 1) } : verdict
  }

  /**
   * Whether `weight` more hits for `key` fit in the window, without recording them. A weight
   * above the limit is counted as the limit, so a request that costs a whole window's worth
   * can still be made once the window is empty. `remaining` is what is left before these hits.
   */
  peek(key: string, weight = 1): { allowed: boolean; retryAfterSec: number; remaining: number } {
    if (this.limit <= 0) return { allowed: true, retryAfterSec: 0, remaining: Infinity }
    const now = this.now()
    const hits = this.fresh(key, now)
    const needed = Math.min(Math.max(1, weight), this.limit)
    const excess = hits.length + needed - this.limit
    if (excess <= 0) {
      return { allowed: true, retryAfterSec: 0, remaining: this.limit - hits.length }
    }
    // Wait until enough of the oldest hits have left the window.
    const freedAt = (hits[excess - 1] ?? now) + this.windowMs
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((freedAt - now) / 1000)),
      remaining: Math.max(0, this.limit - hits.length),
    }
  }

  /** Record `weight` hits for `key` (clamped as in `peek`). */
  take(key: string, weight = 1): void {
    if (this.limit <= 0) return
    const now = this.now()
    const hits = this.fresh(key, now)
    const needed = Math.min(Math.max(1, weight), this.limit)
    for (let i = 0; i < needed; i++) hits.push(now)
    this.buckets.set(key, hits)
  }

  /** The key's hits still inside the window, pruning the rest (and, now and then, every key). */
  private fresh(key: string, now: number): number[] {
    const cutoff = now - this.windowMs
    const hits = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff)
    if (hits.length === 0) this.buckets.delete(key)
    else this.buckets.set(key, hits)
    // Periodic full sweep (at most once per window) rather than on every
    // call, so an active key isn't paying an O(all keys) cost per request.
    if (now - this.lastSweep >= this.windowMs) {
      this.sweep(cutoff)
      this.lastSweep = now
    }
    return hits
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

/** The bucket for a request whose client address the runtime did not report. */
export const UNKNOWN_CLIENT_ADDRESS = 'unknown'

/** The longest address kept as a key; anything longer is cut, never trusted for more. */
const MAX_ADDRESS_LENGTH = 64

/** Reverse proxies a deployment may declare in front of the local server. */
export const MAX_TRUST_PROXY_HOPS = 10

/**
 * `TRUST_PROXY_HOPS`: how many reverse proxies in front of the local server each add the address
 * they received the request from to `x-forwarded-for`. A whole number from 0 to 10; unset, empty
 * or anything else is 0, which ignores `x-forwarded-for` altogether.
 */
export function trustProxyHops(raw: string | undefined): number {
  const value = raw?.trim() ?? ''
  if (!/^\d{1,2}$/.test(value)) return 0
  const hops = Number(value)
  return hops <= MAX_TRUST_PROXY_HOPS ? hops : 0
}

/** A start-up warning for a `TRUST_PROXY_HOPS` that was set but not understood. Never its value. */
export function trustProxyHopsWarning(env: Record<string, string | undefined>): string | null {
  const raw = env.TRUST_PROXY_HOPS
  if (raw === undefined || raw.trim() === '' || String(trustProxyHops(raw)) === raw.trim()) {
    return null
  }
  return `TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUST_PROXY_HOPS}; ` +
    'x-forwarded-for is ignored and each client is keyed on its TCP peer address.'
}

/**
 * The client address of a request that reached the local server through `hops` trusted reverse
 * proxies. Each proxy appends the address it received the request from, so the client is the
 * `hops`-th entry from the right: the right-most one no trusted proxy vouches for. Entries to its
 * left were written by the client and are never read. With no proxies, or no header, the TCP
 * peer is the client. A header shorter than `hops` means the request skipped a proxy; its
 * left-most entry is then the nearest address a proxy recorded.
 */
export function forwardedClientAddress(
  peer: string | undefined,
  forwardedFor: string | null | undefined,
  hops: number,
): string | undefined {
  if (hops <= 0 || !forwardedFor) return peer
  const entries = forwardedFor.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (entries.length === 0) return peer
  const entry = entries[Math.max(0, entries.length - hops)]!
  return entry.slice(0, MAX_ADDRESS_LENGTH)
}

/** The rate-limit bucket for a client address, one shared bucket when it is unknown. */
export function addressKey(address: string | undefined): string {
  const trimmed = address?.trim().slice(0, MAX_ADDRESS_LENGTH)
  return `ip:${trimmed || UNKNOWN_CLIENT_ADDRESS}`
}

/** Shape of the anonymous per-browser id the web app sends as `x-rp-client`. */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * The caller's per-browser rate-limit key: the address bucket, split by the web app's
 * `x-rp-client` id when it presents a well-formed one. Ten clinicians behind one hospital NAT
 * then each get their own budget, but only inside their address's bucket: the id can divide an
 * address's allowance, never escape it or reach another address's. Pair with an address-keyed
 * limiter at a higher limit so minting ids cannot multiply what one address may spend.
 */
export function clientKey(address: string | undefined, clientId: string | undefined): string {
  const id = clientId?.trim()
  return id && CLIENT_ID.test(id) ? `${addressKey(address)}|client:${id}` : addressKey(address)
}

/** One limiter and key a request must fit, with how many hits it costs. */
export interface RateLimitEntry {
  limiter: SlidingWindowLimiter
  key: string
  weight?: number
}

/**
 * Admit a request against several limiters at once: either every entry has room and all are
 * recorded, or none is. Entries for the same limiter and key are added together first.
 */
export function admitAll(
  entries: readonly RateLimitEntry[],
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const merged = new Map<SlidingWindowLimiter, Map<string, number>>()
  for (const { limiter, key, weight = 1 } of entries) {
    const keys = merged.get(limiter) ?? new Map<string, number>()
    keys.set(key, (keys.get(key) ?? 0) + weight)
    merged.set(limiter, keys)
  }
  let retryAfterSec = 0
  for (const [limiter, keys] of merged) {
    for (const [key, weight] of keys) {
      const verdict = limiter.peek(key, weight)
      if (!verdict.allowed) retryAfterSec = Math.max(retryAfterSec, verdict.retryAfterSec)
    }
  }
  if (retryAfterSec > 0) return { allowed: false, retryAfterSec }
  for (const [limiter, keys] of merged) {
    for (const [key, weight] of keys) limiter.take(key, weight)
  }
  return { allowed: true }
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
 * a Retry-After header (seconds), and a `{"error":"rate_limited"}` body,
 * keyed by `keyFn`.
 */
export function rateLimit(
  limiter: SlidingWindowLimiter,
  keyFn: (c: Context) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const { allowed, retryAfterSec, remaining } = limiter.check(keyFn(c))
    if (!allowed) return rateLimited(c, retryAfterSec)
    // How much of the window is left, so the Search page can fall back to
    // results-only before its automatic summary would be the call that trips
    // the limit. Absent when the limiter is disabled.
    if (Number.isFinite(remaining)) c.header('X-RateLimit-Remaining', String(remaining))
    await next()
  }
}

/**
 * Middleware admitting each request against every entry `entriesFor` names (see `admitAll`), so
 * the first bucket without room answers with the 429.
 */
export function rateLimitAll(
  entriesFor: (c: Context) => readonly RateLimitEntry[],
): MiddlewareHandler {
  return async (c, next) => {
    const verdict = admitAll(entriesFor(c))
    if (!verdict.allowed) return rateLimited(c, verdict.retryAfterSec)
    await next()
  }
}

/** The 429 every limiter answers with. */
export function rateLimited(c: Context, retryAfterSec: number): Response {
  c.header('Retry-After', String(retryAfterSec))
  return c.json({ error: 'rate_limited' }, 429)
}
