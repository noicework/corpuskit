/** Deno timers coerce larger delays to roughly one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface TimerClock {
  now(): number
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(timer: number): void
}

/** Wait for an absolute target using only platform-safe timer chunks. Returns cancellation. */
export function scheduleAt(
  clock: TimerClock,
  dueAt: number,
  callback: () => void,
): () => void {
  if (!Number.isFinite(dueAt)) throw new Error('Timer target must be finite')
  let timer: number
  let cancelled = false
  const arm = () => {
    const remaining = dueAt - clock.now()
    timer = clock.setTimeout(() => {
      if (cancelled) return
      // Recheck the wall clock as well as long waits, so a clock step cannot fire early.
      if (clock.now() < dueAt) arm()
      else callback()
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remaining)))
  }
  arm()
  return () => {
    cancelled = true
    clock.clearTimeout(timer)
  }
}

/** Runtime deadlines use a monotonic clock; a wall-clock adjustment cannot extend shutdown. */
export function scheduleAfter(delayMs: number, callback: () => void): () => void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('Timer delay must be finite and non-negative')
  }
  return scheduleAt(
    { now: () => performance.now(), setTimeout, clearTimeout },
    performance.now() + delayMs,
    callback,
  )
}
