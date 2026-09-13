import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const source = await Deno.readTextFile(new URL('SignInDialog.tsx', import.meta.url))

describe('SignInDialog', () => {
  it('uses current validated authority, scoped provenance and focus containment', () => {
    expect(source).toContain('useAccess()')
    expect(source).toContain('Entra access updates when you sign in again.')
    expect(source).toContain('Entra claim age unavailable')
    expect(source).toContain('entry.scope.slug === access.slug')
    expect(source).toContain("event.key !== 'Tab'")
    expect(source).not.toContain('user.isAdmin')
  })
  it('presents signed-in identity details as a profile while preserving signed-out copy', () => {
    expect(source).toContain("const title = user ? 'Profile' : 'Sign in'")
    expect(source).toContain(
      "const summary = user ? 'Your organisation account.' : 'Use your organisation account.'",
    )
  })
})
