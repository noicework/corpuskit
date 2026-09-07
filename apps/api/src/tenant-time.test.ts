import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { tenantToday } from './tenant-time.ts'

describe("a portal's own date (D6-13)", () => {
  it('reads the tenant timezone, not UTC', () => {
    // 23:14 UTC on 5 September is 09:14 on 6 September in Melbourne.
    const at = new Date('2026-09-05T23:14:26.669Z')
    expect(tenantToday('Australia/Melbourne', at)).toBe('2026-09-06')
    expect(tenantToday('UTC', at)).toBe('2026-09-05')
    expect(tenantToday(undefined, at)).toBe('2026-09-05')
  })

  it('falls back to UTC for a zone the runtime does not know', () => {
    const at = new Date('2026-09-05T23:14:26.669Z')
    expect(tenantToday('Mars/Olympus', at)).toBe('2026-09-05')
    expect(tenantToday('', at)).toBe('2026-09-05')
  })
})
