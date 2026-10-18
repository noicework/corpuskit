import { expect } from '@std/expect'
import { secondsSetting } from './local-runtime.ts'

Deno.test('runtime timing settings are finite, bounded seconds with explicit defaults', () => {
  expect(secondsSetting(undefined, 60, 'WAIT')).toBe(60)
  expect(secondsSetting('', 100, 'GRACE')).toBe(100)
  expect(secondsSetting('0', 60, 'WAIT')).toBe(0)
  expect(secondsSetting('0.2', 60, 'WAIT')).toBe(0.2)
  for (const value of ['NaN', '-1', 'Infinity', '86401', 'typo']) {
    expect(() => secondsSetting(value, 100, 'GRACE')).toThrow('GRACE')
  }
})
