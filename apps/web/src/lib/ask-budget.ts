/**
 * What the browser knows about its ask budget, read off the last ask-class
 * response. The server limits asks per client per minute and says how much of
 * the window is left (`X-RateLimit-Remaining`) and, on a 429, how long to
 * wait (`Retry-After`). Surfaces that fire an answer automatically - the
 * Search page's summary above the results - consult this before spending a
 * call, so a reader who is close to the limit gets their results instead of a
 * red card, and the Ask page can count down to a retry rather than dead-end.
 *
 * Pure module state with an injectable clock: no React, so it is trivially
 * testable and shared by every caller.
 */

/** With this many asks or fewer left in the window, automatic summaries stand down. */
export const NEAR_LIMIT = 2

type Budget = {
  /** Asks left in the current window, when the server last said. */
  remaining: number | null
  /** Wall-clock ms until which the server has asked us not to retry. */
  blockedUntil: number
}

const STORAGE_KEY = 'rp-ask-budget'

/** Carried across page loads in this tab, so a fresh Search page still knows about a recent 429. */
function restore(): Budget {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY)
    if (!raw) return { remaining: null, blockedUntil: 0 }
    const parsed = JSON.parse(raw) as Partial<Budget>
    return {
      remaining: typeof parsed.remaining === 'number' ? parsed.remaining : null,
      blockedUntil: typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : 0,
    }
  } catch {
    return { remaining: null, blockedUntil: 0 }
  }
}

function store(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage blocked or full: the in-memory state still works for this page.
  }
}

const state: Budget = restore()

/** Record what an ask-class response said about the budget. */
export function noteAskBudget(
  res: { status: number; headers: { get(name: string): string | null } },
  now: () => number = Date.now,
): void {
  const remaining = res.headers.get('x-ratelimit-remaining')
  if (remaining !== null && Number.isFinite(Number(remaining))) {
    state.remaining = Number(remaining)
  }
  if (res.status === 429) {
    const raw = res.headers.get('retry-after')
    const seconds = raw !== null && Number.isFinite(Number(raw)) ? Math.max(1, Number(raw)) : 15
    state.blockedUntil = now() + seconds * 1000
    state.remaining = 0
  } else if (res.status < 400) {
    state.blockedUntil = 0
  }
  store()
}

/** Seconds until the server will take another ask, 0 when it will now. */
export function secondsUntilRetry(now: () => number = Date.now): number {
  return Math.max(0, Math.ceil((state.blockedUntil - now()) / 1000))
}

/**
 * True when an automatic (not reader-initiated) answer should stand down:
 * the server has said to wait, or the window is nearly spent and the next
 * automatic call would be the one that trips it for the reader's own ask.
 */
export function shouldDeferAutomaticAsk(now: () => number = Date.now): boolean {
  if (secondsUntilRetry(now) > 0) return true
  return state.remaining !== null && state.remaining <= NEAR_LIMIT
}

/** Tests only: forget everything. */
export function resetAskBudget(): void {
  state.remaining = null
  state.blockedUntil = 0
  store()
}
