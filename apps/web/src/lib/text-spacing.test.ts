import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { readerSpacing } from './text-spacing.ts'

describe('reader text spacing (WCAG 1.4.12)', () => {
  it('reads the pinned probe as the portal default', () => {
    expect(readerSpacing({ fontSize: '16px', letterSpacing: '0px', wordSpacing: '0px' })).toBe(
      false,
    )
    expect(readerSpacing({ fontSize: '16px', letterSpacing: 'normal', wordSpacing: 'normal' }))
      .toBe(false)
    // Sub-pixel rounding is not a setting.
    expect(readerSpacing({ fontSize: '16px', letterSpacing: '0.2px', wordSpacing: '0.3px' }))
      .toBe(false)
  })

  it('sees the WCAG spacing, and either property alone', () => {
    // 0.12em letter and 0.16em word spacing on the probe's 16px.
    expect(readerSpacing({ fontSize: '16px', letterSpacing: '1.92px', wordSpacing: '2.56px' }))
      .toBe(true)
    expect(readerSpacing({ fontSize: '16px', letterSpacing: '1.92px', wordSpacing: '0px' }))
      .toBe(true)
    expect(readerSpacing({ fontSize: '16px', letterSpacing: 'normal', wordSpacing: '2.56px' }))
      .toBe(true)
  })

  it('ignores tighter spacing, which fits more words into a clamped line', () => {
    expect(readerSpacing({ fontSize: '16px', letterSpacing: '-1px', wordSpacing: '-2px' })).toBe(
      false,
    )
  })

  it('lets every clamp go while the reader spacing applies, and pins the probe', async () => {
    const styles = await Deno.readTextFile(new URL('../styles.css', import.meta.url))
    expect(styles).toContain(
      `:root[data-text-spacing='custom'] :is(.rp-clamp-2, .rp-clamp-3, .rp-clamp-4) {
  display: block;
  -webkit-line-clamp: none;
  overflow: visible;
}`,
    )
    const probe = /\.rp-spacing-probe \{([^}]*)\}/.exec(styles)?.[1] ?? ''
    for (
      const rule of [
        'visibility: hidden;',
        'white-space: nowrap;',
        'letter-spacing: 0;',
        'word-spacing: 0;',
      ]
    ) expect(probe).toContain(rule)
    // Every clamp the stylesheet defines is one the rule above releases.
    const clamps = [...styles.matchAll(/^\.(rp-clamp-\d) \{/gm)].map((match) => match[1])
    expect(clamps).toEqual(['rp-clamp-2', 'rp-clamp-3', 'rp-clamp-4'])
  })
})
