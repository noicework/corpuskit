import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import {
  customFontCss,
  DENSITY_DIALS,
  densityVars,
  DESKTOP_TEXT_SCALE_FACTOR,
  fontStack,
  googleFontsUrl,
  PAIRING_IDS,
  paletteMode,
  paletteVars,
  shapeVars,
  tenantThemeVars,
  TEXT_SCALES,
  textScaleVars,
  typographyVars,
} from './theme.ts'

const styles = await Deno.readTextFile(new URL('../styles.css', import.meta.url))

const branding = (over: Partial<TenantConfig['branding']> = {}): TenantConfig['branding'] => ({
  productName: 'Test Portal',
  organisation: 'Test Org',
  tagline: 'Testing',
  colours: { primary: '#111111', accent: '#222222', heroFrom: '#333333', heroTo: '#444444' },
  ...over,
})

describe('shapeVars', () => {
  it('defaults to square (all dials 0)', () => {
    expect(shapeVars(undefined)).toEqual({
      '--rp-radius': '0px',
      '--rp-radius-btn': '0px',
      '--rp-radius-chip': '0px',
      '--rp-radius-input': '0px',
      '--rp-btn-px': '0.875rem',
    })
  })

  it('rounds everything slightly for rounded', () => {
    const vars = shapeVars('rounded')
    expect(vars['--rp-radius']).toBe('10px')
    expect(vars['--rp-radius-btn']).toBe('8px')
    expect(vars['--rp-radius-chip']).toBe('8px')
  })

  it('pills buttons and chips for soft, but keeps inputs moderate', () => {
    const vars = shapeVars('soft')
    expect(vars['--rp-radius']).toBe('16px')
    expect(vars['--rp-radius-btn']).toBe('9999px')
    expect(vars['--rp-radius-chip']).toBe('9999px')
    expect(vars['--rp-radius-input']).not.toBe('9999px')
  })
})

describe('typographyVars', () => {
  it('sets nothing for the default choice, so the house faces stay', () => {
    expect(typographyVars(branding())).toEqual({})
    expect(typographyVars(branding({ typography: 'default' }))).toEqual({})
  })

  it('uses the seeded brand faces as the portal default, and a pairing overrides them', () => {
    const fonts = { sans: "'Montserrat', sans-serif", display: "'Montserrat', sans-serif" }
    const seeded = typographyVars(branding({ fonts }))
    expect(seeded['--rp-font-body']).toBe(fonts.sans)
    expect(seeded['--rp-font-display']).toBe(fonts.display)
    expect(typographyVars(branding({ fonts, typography: 'default' }))).toEqual(seeded)
    const paired = typographyVars(branding({ fonts, typography: 'lexend-zilla' }))
    expect(paired['--rp-font-display']).toContain("'Lexend'")
  })

  it('sets both faces and their metrics for a pairing', () => {
    const vars = typographyVars(branding({ typography: 'bebas-heebo' }))
    expect(vars['--rp-font-display']).toContain("'Bebas Neue'")
    expect(vars['--rp-font-body']).toContain("'Heebo'")
    // Heebo Light: the pairing carries a 300 base body weight.
    expect(vars['--rp-font-body-weight']).toBe('300')
    expect(vars['--rp-font-display-weight']).toBe('400')
  })

  it('every pairing carries a full metric set and a fallback stack', () => {
    for (const id of PAIRING_IDS) {
      const vars = typographyVars(branding({ typography: id }))
      for (
        const key of [
          '--rp-font-display',
          '--rp-font-display-weight',
          '--rp-font-display-bold-weight',
          '--rp-font-display-tracking',
          '--rp-font-display-leading',
          '--rp-font-body',
          '--rp-font-body-weight',
        ]
      ) {
        expect(vars[key]).toBeTruthy()
      }
      expect(vars['--rp-font-display']).toContain('sans-serif')
      expect(vars['--rp-font-body']).toContain('sans-serif')
    }
  })

  it('only overrides the faces that have uploaded files for custom', () => {
    expect(typographyVars(branding({ typography: 'custom' }))).toEqual({})
    const headingOnly = typographyVars(
      branding({ typography: 'custom', headingFontUrl: '/api/t/x/branding/font-heading?v=1' }),
    )
    expect(headingOnly['--rp-font-display']).toContain('RP Custom Heading')
    expect(headingOnly['--rp-font-body']).toBeUndefined()
  })
})

describe('paletteVars', () => {
  it('derives the legacy identity exactly when no library palette is chosen', () => {
    const marineColours = {
      primary: '#143669',
      accent: '#00b8a5',
      heroFrom: '#0b2247',
      heroTo: '#0e5f6b',
    }
    for (
      const b of [
        branding({ colours: marineColours }),
        branding({ colours: marineColours, paletteId: 'default' }),
      ]
    ) {
      const vars = paletteVars(b)
      expect(vars['--rp-primary']).toBe('#143669')
      expect(vars['--rp-accent']).toBe('#00b8a5')
      expect(vars['--rp-hero-from']).toBe('#0b2247')
      expect(vars['--rp-hero-to']).toBe('#0e5f6b')
      // The roles the code used to hardcode, reproduced so nothing shifts.
      expect(vars['--rp-on-primary']).toBe('#ffffff')
      expect(vars['--rp-brand-fg']).toBe('#143669')
      expect(vars['--rp-on-accent']).toBe('#ffffff')
      expect(vars['--rp-accent-fg']).toBe('#00b8a5')
      expect(vars['--rp-focus']).toBe('#00b8a5')
      expect(vars['--rp-on-hero']).toBe('#ffffff')
      // The grey suite must NOT be touched - house defaults stay in charge.
      expect(vars['--rp-ink']).toBeUndefined()
      expect(vars['--rp-surface']).toBeUndefined()
      expect(vars['--rp-paper']).toBeUndefined()
    }
  })

  it('maps a library palette onto every token including the grey suite', () => {
    const vars = paletteVars(branding({ paletteId: 'fathom' }))
    expect(vars['--rp-primary']).toBe('#0a3a57')
    expect(vars['--rp-accent-fg']).toBe('#0b628f')
    expect(vars['--rp-wash']).toBe('#e3f2fb')
    expect(vars['--rp-paper']).toBe('#f8fafb')
    expect(vars['--rp-ink-3']).toBe('#587082')
    expect(vars['--rp-line']).toBe('#d8e1e8')
    // Light palette leaves the semantic statuses on the stylesheet defaults.
    expect(vars['--rp-ok-bg']).toBeUndefined()
  })

  it('the dark palette flips the statuses and glass with the suite', () => {
    const vars = paletteVars(branding({ paletteId: 'observatory' }))
    expect(vars['--rp-paper']).toBe('#131119')
    expect(vars['--rp-ok-bg']).toBe('#0e2f24')
    expect(vars['--rp-bad-ink']).toBe('#fb7d90')
    expect(vars['--rp-glass-bg']).toContain('#1a1826')
    expect(paletteMode(branding({ paletteId: 'observatory' }))).toBe('dark')
    expect(paletteMode(branding({ paletteId: 'fathom' }))).toBe('light')
    expect(paletteMode(branding())).toBe('light')
  })
})

describe('tenantThemeVars', () => {
  it('always carries the four tenant colours plus the shape dials', () => {
    const vars = tenantThemeVars(branding()) as Record<string, string>
    expect(vars['--rp-primary']).toBe('#111111')
    expect(vars['--rp-accent']).toBe('#222222')
    expect(vars['--rp-hero-from']).toBe('#333333')
    expect(vars['--rp-hero-to']).toBe('#444444')
    expect(vars['--rp-radius']).toBe('0px')
  })
})

describe('googleFontsUrl', () => {
  it('builds a css2 URL with display=swap for every pairing', () => {
    for (const id of PAIRING_IDS) {
      const url = googleFontsUrl(id)
      expect(url.startsWith('https://fonts.googleapis.com/css2?family=')).toBe(true)
      expect(url.endsWith('&display=swap')).toBe(true)
    }
  })
})

describe('customFontCss', () => {
  it('emits a @font-face per uploaded file only', () => {
    expect(customFontCss(undefined, undefined)).toBe('')
    const both = customFontCss('/h.woff2', '/b.woff2')
    expect(both).toContain("font-family:'RP Custom Heading'")
    expect(both).toContain("font-family:'RP Custom Body'")
    expect(both).toContain("src:url('/h.woff2')")
    expect(customFontCss('/h.woff2', undefined)).not.toContain('RP Custom Body')
  })
})

describe('densityVars', () => {
  it('is the identity at default, so untouched portals keep todays rhythm', () => {
    expect(densityVars(undefined)).toEqual({ '--rp-density': '1', '--rp-density-ctl': '1' })
    expect(densityVars('default')).toEqual({ '--rp-density': '1', '--rp-density-ctl': '1' })
  })

  it('damps the control dial relative to the rhythm dial at every level', () => {
    for (const dials of Object.values(DENSITY_DIALS)) {
      expect(Math.abs(dials.ctl - 1)).toBeLessThanOrEqual(Math.abs(dials.rhythm - 1))
    }
  })

  it('orders the levels compact < default < comfortable < spacious', () => {
    expect(DENSITY_DIALS.compact.rhythm).toBeLessThan(DENSITY_DIALS.default.rhythm)
    expect(DENSITY_DIALS.default.rhythm).toBeLessThan(DENSITY_DIALS.comfortable.rhythm)
    expect(DENSITY_DIALS.comfortable.rhythm).toBeLessThan(DENSITY_DIALS.spacious.rhythm)
  })
})

describe('TEXT_SCALES', () => {
  it('leaves the root alone for default and nudges it either side otherwise', () => {
    expect(TEXT_SCALES.default).toBeNull()
    expect(TEXT_SCALES.smaller).toBe('93.75%')
    expect(TEXT_SCALES.larger).toBe('106.25%')
  })

  it('composes each tenant choice with the desktop uplift', () => {
    expect(DESKTOP_TEXT_SCALE_FACTOR).toBe(1.0625)
    expect(textScaleVars('default')).toEqual({})
    expect(textScaleVars('smaller')).toEqual({
      '--rp-text-scale': '93.75%',
      '--rp-text-scale-desktop': '99.609375%',
    })
    expect(textScaleVars('larger')).toEqual({
      '--rp-text-scale': '106.25%',
      '--rp-text-scale-desktop': '112.890625%',
    })
  })

  it('lets the desktop media query choose the precomposed tenant value', () => {
    expect(styles).toContain('font-size: var(--rp-text-scale, 100%);')
    expect(styles).toContain('@media (min-width: 1024px)')
    expect(styles).toContain('font-size: var(--rp-text-scale-desktop, 106.25%);')
  })
})

describe('fontStack', () => {
  it('quotes the family and keeps a system fallback', () => {
    expect(fontStack('Zilla Slab')).toBe(
      "'Zilla Slab', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    )
  })
})
