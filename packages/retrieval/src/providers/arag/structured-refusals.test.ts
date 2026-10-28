import { expect } from '@std/expect'
import { STRUCTURED_REFUSAL_TTL_MS, StructuredRefusals } from './structured-refusals.ts'

Deno.test('structured refusal hints expire, are bounded, and isolate portals and models', () => {
  let now = 0
  const hints = new StructuredRefusals(() => now)
  hints.remember('a', 'fast')
  expect(hints.refused('a', 'fast')).toBe(true)
  expect(hints.refused('a', 'other')).toBe(false)
  expect(hints.refused('b', 'fast')).toBe(false)
  now = STRUCTURED_REFUSAL_TTL_MS - 1
  expect(hints.refused('a', 'fast')).toBe(true)
  now++
  expect(hints.refused('a', 'fast')).toBe(false)
  hints.remember('a', 'fast')
  hints.forget('a')
  expect(hints.refused('a', 'fast')).toBe(false)
  for (let i = 0; i < 257; i++) hints.remember(`portal-${i}`, 'fast')
  expect(hints.refused('portal-0', 'fast')).toBe(false)
  expect(hints.refused('portal-256', 'fast')).toBe(true)
})
