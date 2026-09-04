import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

const source = await Deno.readTextFile(new URL('LibraryPage.tsx', import.meta.url))

describe('library grid tracks', () => {
  it('only declares the sidebar column when the filter rail renders', () => {
    // A portal whose corpus has no topics renders no aside. An unconditional
    // `230px 1fr` put the single child in the 230px track, squeezing a
    // full-width page of cards into a narrow strip (seen live on OPAX).
    expect(source).toContain(
      "`mt-6 grid grid-cols-1 gap-6 ${showFilterRail ? 'lg:grid-cols-[230px_1fr]' : ''}`",
    )
    expect(source).not.toContain("'mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[230px_1fr]'")
  })

  it('gates the rail, its toggle and the grid track on one shared flag', () => {
    const flag = (source.match(/showFilterRail/g) ?? []).length
    // Declaration plus the three places that must agree: track, aside, toggle.
    expect(flag).toBeGreaterThanOrEqual(4)
  })
})
