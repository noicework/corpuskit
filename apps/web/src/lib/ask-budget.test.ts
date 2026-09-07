import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  noteAskBudget,
  resetAskBudget,
  secondsUntilRetry,
  shouldDeferAutomaticAsk,
} from './ask-budget.ts'

const res = (status: number, headers: Record<string, string>) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
})

describe('ask budget', () => {
  it('defers automatic asks once the window is nearly spent', () => {
    resetAskBudget()
    const now = () => 1_000_000
    expect(shouldDeferAutomaticAsk(now)).toBe(false)
    noteAskBudget(res(200, { 'x-ratelimit-remaining': '5' }), now)
    expect(shouldDeferAutomaticAsk(now)).toBe(false)
    noteAskBudget(res(200, { 'x-ratelimit-remaining': '2' }), now)
    expect(shouldDeferAutomaticAsk(now)).toBe(true)
  })

  it('counts down a 429 Retry-After and clears it on the next success', () => {
    resetAskBudget()
    let clock = 1_000_000
    const now = () => clock
    noteAskBudget(res(429, { 'retry-after': '4' }), now)
    expect(secondsUntilRetry(now)).toBe(4)
    expect(shouldDeferAutomaticAsk(now)).toBe(true)
    clock += 2_500
    expect(secondsUntilRetry(now)).toBe(2)
    clock += 2_000
    expect(secondsUntilRetry(now)).toBe(0)
    // Still near the limit until the server reports headroom again.
    expect(shouldDeferAutomaticAsk(now)).toBe(true)
    noteAskBudget(res(200, { 'x-ratelimit-remaining': '9' }), now)
    expect(shouldDeferAutomaticAsk(now)).toBe(false)
  })

  it('assumes a short wait when a 429 carries no Retry-After', () => {
    resetAskBudget()
    const now = () => 5_000
    noteAskBudget(res(429, {}), now)
    expect(secondsUntilRetry(now)).toBe(15)
  })
})
