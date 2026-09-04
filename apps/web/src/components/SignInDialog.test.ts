import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const source = await Deno.readTextFile(new URL('SignInDialog.tsx', import.meta.url))

describe('SignInDialog', () => {
  it('presents signed-in identity details as a profile while preserving signed-out copy', () => {
    expect(source).toContain("const title = user ? 'Profile' : 'Sign in'")
    expect(source).toContain(
      "const summary = user ? 'Your organisation account.' : 'Use your organisation account.'",
    )
  })
})
