import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  contrastRatio,
  DEFAULT_PALETTES,
  DEFAULT_PORTAL_COLOURS,
  fieldBorder,
  HOUSE_LIGHT_SUITE,
  mixHex,
  paletteFromColours,
  type TenantConfig,
} from '@research-portal/core'
import {
  accentHeroEdge,
  accentMarkVars,
  customFontCss,
  DENSITY_DIALS,
  densityVars,
  DESKTOP_TEXT_SCALE_FACTOR,
  fontStack,
  googleFontsUrl,
  PAIRING_IDS,
  paletteMode,
  paletteVars,
  secondaryInk,
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
  it("keeps a portal's own colours and draws readable text and focus on them", () => {
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
      // Roles that already read are unchanged.
      expect(vars['--rp-on-primary']).toBe('#ffffff')
      expect(vars['--rp-brand-fg']).toBe('#143669')
      expect(vars['--rp-on-hero']).toBe('#ffffff')
      // The teal accent is 2.5:1 on white: links and citations are deepened to AA, the focus
      // ring to 3:1, and the text on the solid accent is the ink that reads on it.
      expect(vars['--rp-accent-fg']).not.toBe('#00b8a5')
      expect(contrastRatio(vars['--rp-accent-fg']!, HOUSE_LIGHT_SUITE.surface))
        .toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(vars['--rp-accent-fg']!, vars['--rp-wash']!)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(vars['--rp-focus']!, HOUSE_LIGHT_SUITE.surface))
        .toBeGreaterThanOrEqual(3)
      expect(vars['--rp-on-accent']).toBe(HOUSE_LIGHT_SUITE.ink)
      // The washes are the same 12% and 22% accent mixes over the surface as before.
      expect(vars['--rp-wash']).toBe('#e0f6f4')
      expect(vars['--rp-wash-strong']).toBe('#c7efeb')
      // The grey suite must NOT be touched - house defaults stay in charge.
      expect(vars['--rp-ink']).toBeUndefined()
      expect(vars['--rp-surface']).toBeUndefined()
      expect(vars['--rp-paper']).toBeUndefined()
    }
  })

  it('renders the default portal colours with the palette that passes the contract', () => {
    const vars = paletteVars(branding({ colours: { ...DEFAULT_PORTAL_COLOURS } }))
    const derived = paletteFromColours(DEFAULT_PORTAL_COLOURS)!
    expect(vars).toMatchObject({
      '--rp-primary': derived.brandSurface,
      '--rp-accent': derived.accent,
      '--rp-hero-from': derived.heroFrom,
      '--rp-hero-to': derived.heroTo,
      '--rp-on-primary': derived.onBrandSurface,
      '--rp-brand-fg': derived.brandForeground,
      '--rp-on-accent': derived.onAccent,
      '--rp-accent-fg': derived.accentForeground,
      '--rp-focus': derived.focusRing,
      '--rp-on-hero': derived.onHero,
      '--rp-wash': derived.accentWash,
      '--rp-wash-strong': derived.accentWashStrong,
    })
  })

  it('uses a seeded colour it cannot measure as it is', () => {
    const vars = paletteVars(
      branding({
        colours: { primary: 'navy', accent: '#222222', heroFrom: '#333333', heroTo: '#444444' },
      }),
    )
    expect(vars['--rp-primary']).toBe('navy')
    expect(vars['--rp-brand-fg']).toBe('navy')
    expect(vars['--rp-on-primary']).toBe('#ffffff')
  })

  it("lifts a portal's own brand colours for the dark scheme", async () => {
    const { DARK_GREY_SUITE, ensureContrast } = await import('./theme.ts')
    const { mixHex } = await import('@research-portal/core')
    const colours = { ...DEFAULT_PORTAL_COLOURS }
    const vars = paletteVars(branding({ colours }), 'dark')
    const surface = DARK_GREY_SUITE['--rp-surface']!
    // Links and rings are drawn on the grey panels and the selected wash as well as the surface.
    // Lifted against the surface alone, the default accent was 4.41:1 on the grey panel and
    // 3.86:1 on the wash, so the lift goes on until every one of them reads.
    const accentGrounds = [
      surface,
      DARK_GREY_SUITE['--rp-paper']!,
      DARK_GREY_SUITE['--rp-surface-2']!,
      mixHex(colours.accent, surface, 0.18),
    ]
    expect(contrastRatio(ensureContrast(colours.accent, surface, 4.5), accentGrounds[3]!))
      .toBeLessThan(4.5)
    for (const ground of accentGrounds) {
      expect(contrastRatio(vars['--rp-accent-fg']!, ground), ground).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(vars['--rp-focus']!, ground), ground).toBeGreaterThanOrEqual(3)
    }
    // The brand ink also has to read on the washes Explore's tiles use, so it
    // is lifted past the surface-only value when that falls short there.
    const grounds = [
      surface,
      mixHex(colours.accent, surface, 0.18),
      mixHex(colours.accent, surface, 0.3),
    ]
    for (const ground of grounds) {
      expect(contrastRatio(vars['--rp-brand-fg']!, ground), ground).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrastRatio(ensureContrast(colours.primary, surface, 4.5), grounds[2]!))
      .toBeLessThan(4.5)
  })

  it('gives every palette and scheme a field edge at 3:1', async () => {
    const { DARK_GREY_SUITE } = await import('./theme.ts')
    for (const id of Object.keys(DEFAULT_PALETTES) as (keyof typeof DEFAULT_PALETTES)[]) {
      const vars = paletteVars(branding({ paletteId: id }))
      expect(vars['--rp-field']).toBe(fieldBorder(DEFAULT_PALETTES[id].palette))
      expect(contrastRatio(vars['--rp-field']!, vars['--rp-surface']!), id)
        .toBeGreaterThanOrEqual(3)
      if (DEFAULT_PALETTES[id].palette.mode === 'light') {
        const dark = paletteVars(branding({ paletteId: id }), 'dark')
        expect(dark['--rp-field']).toBe(DARK_GREY_SUITE['--rp-field'])
      }
    }
    for (const ground of ['--rp-surface', '--rp-surface-2', '--rp-paper']) {
      expect(contrastRatio(DARK_GREY_SUITE['--rp-field']!, DARK_GREY_SUITE[ground]!))
        .toBeGreaterThanOrEqual(3)
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

describe('foundation colour role guarantees', () => {
  const portalColours = {
    dark: {
      primary: '#2e2359',
      accent: '#b4ef2c',
      heroFrom: '#1f1740',
      heroTo: '#4a3a8f',
    },
    bright: {
      primary: '#4fbc62',
      accent: '#f4b400',
      heroFrom: '#237531',
      heroTo: '#164f35',
    },
    'mid-tone': {
      primary: '#767676',
      accent: '#bb6688',
      heroFrom: '#727272',
      heroTo: '#696969',
    },
    'near-black': {
      primary: '#101319',
      accent: '#5ce500',
      heroFrom: '#08090c',
      heroTo: '#1e2226',
    },
    pale: {
      primary: '#f7edcc',
      accent: '#c8e7ff',
      heroFrom: '#f2ecd9',
      heroTo: '#e1e5ee',
    },
    'CorpusKit paper': {
      primary: DEFAULT_PALETTES.corpuskit.palette.brandSurface,
      accent: DEFAULT_PALETTES.corpuskit.palette.accent,
      heroFrom: DEFAULT_PALETTES.corpuskit.palette.heroFrom,
      heroTo: DEFAULT_PALETTES.corpuskit.palette.heroTo,
    },
  }
  const fixtures = [
    ...Object.keys(DEFAULT_PALETTES).map((id) => ({
      label: `library ${id}`,
      branding: branding({ paletteId: id as keyof typeof DEFAULT_PALETTES }),
    })),
    ...Object.entries(portalColours).map(([label, colours]) => ({
      label: `portal ${label}`,
      branding: branding({ colours }),
    })),
  ]

  for (const fixture of fixtures) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${fixture.label}, ${scheme}: readable secondary tiers and distinct controls`, () => {
        const vars = paletteVars(fixture.branding, scheme)
        expect(contrastRatio(vars['--rp-on-primary-2']!, vars['--rp-primary']!))
          .toBeGreaterThanOrEqual(4.5)
        for (const endpoint of ['--rp-hero-from', '--rp-hero-to']) {
          expect(contrastRatio(vars['--rp-on-hero-2']!, vars[endpoint]!), endpoint)
            .toBeGreaterThanOrEqual(4.5)
        }
        const surface = vars['--rp-surface'] ?? HOUSE_LIGHT_SUITE.surface
        const paper = vars['--rp-paper'] ?? HOUSE_LIGHT_SUITE.paper
        for (const ground of [surface, paper]) {
          expect(contrastRatio(vars['--rp-control']!, ground), `control on ${ground}`)
            .toBeGreaterThanOrEqual(3)
        }
        expect(contrastRatio(vars['--rp-on-control']!, vars['--rp-control']!))
          .toBeGreaterThanOrEqual(4.5)
        if (paletteMode(fixture.branding, scheme) === 'dark') {
          for (let category = 1; category <= 6; category++) {
            const hue = vars[`--rp-cat-${category}`]!
            expect(contrastRatio(hue, surface), `category ${category} mark`)
              .toBeGreaterThanOrEqual(3)
            const ink = mixHex(hue, vars['--rp-ink']!, 0.55)
            expect(contrastRatio(ink, surface), `category ${category} ink`)
              .toBeGreaterThanOrEqual(4.5)
          }
        }
      })
    }
  }

  it('keeps white secondary text at least as strong as the 75% text tier', () => {
    for (const fixture of fixtures) {
      for (const scheme of ['light', 'dark'] as const) {
        const vars = paletteVars(fixture.branding, scheme)
        for (
          const [foreground, secondary, grounds] of [
            ['--rp-on-primary', '--rp-on-primary-2', ['--rp-primary']],
            ['--rp-on-hero', '--rp-on-hero-2', ['--rp-hero-from', '--rp-hero-to']],
          ] as const
        ) {
          if (vars[foreground] !== '#ffffff') continue
          const tier = mixHex(vars[grounds[0]]!, '#ffffff', 0.25)
          for (const ground of grounds) {
            expect(contrastRatio(vars[secondary]!, vars[ground]!), fixture.label)
              .toBeGreaterThanOrEqual(contrastRatio(tier, vars[ground]!))
          }
          if (grounds.every((ground) => contrastRatio(tier, vars[ground]!) >= 4.5)) {
            expect(vars[secondary], fixture.label).toBe(tier)
          }
        }
      }
    }
  })

  it('recovers contrast beyond the 75% tier for bright and mid-tone grounds', () => {
    for (const primary of ['#245ad4', '#767676']) {
      const vars = paletteVars(branding({
        colours: { ...DEFAULT_PORTAL_COLOURS, primary, heroFrom: primary, heroTo: primary },
      }))
      const tier = mixHex(primary, vars['--rp-on-primary']!, 0.25)
      expect(contrastRatio(tier, primary), primary).toBeLessThan(4.5)
      expect(vars['--rp-on-primary-2'], primary).not.toBe(tier)
      expect(contrastRatio(vars['--rp-on-primary-2']!, primary), primary)
        .toBeGreaterThanOrEqual(4.5)
      expect(vars['--rp-on-hero-2']).toBe(vars['--rp-on-primary-2'])
    }
  })

  it('uses a full-strength contrast fallback when the supplied foreground cannot read', () => {
    for (const grounds of [['#ffffff'], ['#f2efe7', '#fffdf8']]) {
      const fallback = secondaryInk('#ffffff', grounds)
      expect(fallback).toBe(HOUSE_LIGHT_SUITE.ink)
      for (const ground of grounds) {
        expect(contrastRatio(fallback, ground)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('chooses primary, then a qualified accent, then brand ink for light controls', () => {
    const fathom = paletteVars(branding({ paletteId: 'fathom' }))
    expect(fathom['--rp-control']).toBe(fathom['--rp-primary'])
    const corpuskit = paletteVars(branding({ paletteId: 'corpuskit' }))
    expect(corpuskit['--rp-control']).toBe(corpuskit['--rp-accent'])
    expect(corpuskit['--rp-control']).not.toBe(corpuskit['--rp-paper'])
    const pale = paletteVars(branding({ colours: portalColours.pale }))
    expect(pale['--rp-control']).toBe(pale['--rp-brand-fg'])
  })

  it('keeps the logo plate on its light design paper through a scheme change', () => {
    for (const fixture of fixtures) {
      const light = paletteVars(fixture.branding)
      const dark = paletteVars(fixture.branding, 'dark')
      const palette = fixture.branding.paletteId && fixture.branding.paletteId !== 'default'
        ? DEFAULT_PALETTES[fixture.branding.paletteId].palette
        : undefined
      expect(light['--rp-logo-plate']).toBe(
        palette?.mode === 'light' ? palette.paper : HOUSE_LIGHT_SUITE.paper,
      )
      expect(dark['--rp-logo-plate']).toBe(light['--rp-logo-plate'])
    }
  })

  it('always darkens the modal backdrop, including on the intrinsic dark palette', () => {
    for (const fixture of fixtures) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(paletteVars(fixture.branding, scheme)['--rp-scrim']).toBe(
          paletteMode(fixture.branding, scheme) === 'dark'
            ? 'rgba(0, 0, 0, 0.62)'
            : 'rgba(10, 10, 12, 0.5)',
        )
      }
    }
  })

  it('dims and edges thumbnails by the actual palette mode, including Observatory', () => {
    for (const fixture of fixtures) {
      for (const scheme of ['light', 'dark'] as const) {
        const vars = paletteVars(fixture.branding, scheme)
        const dark = paletteMode(fixture.branding, scheme) === 'dark'
        expect(vars['--rp-thumb-brightness']).toBe(dark ? '0.92' : '1')
        expect(vars['--rp-thumb-edge']).toBe(dark ? 'var(--rp-line)' : 'transparent')
      }
    }
  })

  it('emits every new role for non-hex identities with measurable control fallbacks', () => {
    const fallback = branding({
      colours: {
        primary: 'navy',
        accent: 'gold',
        heroFrom: 'midnightblue',
        heroTo: 'rebeccapurple',
      },
    })
    for (const scheme of ['light', 'dark'] as const) {
      const vars = paletteVars(fallback, scheme)
      for (
        const token of [
          '--rp-on-primary-2',
          '--rp-on-hero-2',
          '--rp-control',
          '--rp-on-control',
          '--rp-logo-plate',
          '--rp-scrim',
          ...Array.from({ length: 6 }, (_, i) => `--rp-cat-${i + 1}`),
        ]
      ) expect(vars[token], token).toBeTruthy()
      expect(vars['--rp-primary']).toBe('navy')
      expect(vars['--rp-on-primary-2']).toBe(vars['--rp-on-primary'])
      expect(vars['--rp-on-hero-2']).toBe(vars['--rp-on-hero'])
      expect(
        contrastRatio(vars['--rp-control']!, vars['--rp-surface'] ?? HOUSE_LIGHT_SUITE.surface),
      )
        .toBeGreaterThanOrEqual(3)
      expect(contrastRatio(vars['--rp-on-control']!, vars['--rp-control']!))
        .toBeGreaterThanOrEqual(4.5)
    }
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

describe('viewer dark scheme', () => {
  it('follows the system until a choice is stored', async () => {
    const { resolveScheme } = await import('./theme.ts')
    expect(resolveScheme('system', true)).toBe('dark')
    expect(resolveScheme('system', false)).toBe('light')
    expect(resolveScheme('light', true)).toBe('light')
    expect(resolveScheme('dark', false)).toBe('dark')
  })

  it('uses the tenant default before the system and keeps explicit viewer choices', async () => {
    const { resolveScheme } = await import('./theme.ts')
    expect(resolveScheme('system', true, 'light')).toBe('light')
    expect(resolveScheme('system', false, 'dark')).toBe('dark')
    expect(resolveScheme('dark', false, 'light')).toBe('dark')
    expect(resolveScheme('light', true, 'dark')).toBe('light')
    expect(resolveScheme('system', true)).toBe('dark')
  })

  it('maps a light portal onto the dark grey suite with AA brand inks', async () => {
    const { DARK_GREY_SUITE } = await import('./theme.ts')
    const { contrastRatio } = await import('@research-portal/core')
    const vars = paletteVars(
      branding({
        colours: {
          primary: '#2e2359',
          accent: '#8b6fd8',
          heroFrom: '#1f1740',
          heroTo: '#4a3a8f',
        },
      }),
      'dark',
    )
    expect(vars['--rp-surface']).toBe(DARK_GREY_SUITE['--rp-surface'])
    expect(vars['--rp-ink']).toBe(DARK_GREY_SUITE['--rp-ink'])
    // The deep violet brand ink is unreadable on a dark surface as-is; it is
    // lightened until it clears AA, while the brand surface itself is kept.
    expect(contrastRatio(vars['--rp-brand-fg']!, vars['--rp-surface']!)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(vars['--rp-accent-fg']!, vars['--rp-surface']!)).toBeGreaterThanOrEqual(
      4.5,
    )
    expect(vars['--rp-primary']).toBe('#2e2359')
    expect(vars['--rp-ok-bg']).toBe('#0e2f24')
    expect(tenantThemeVars(branding(), 'dark').colorScheme).toBe('dark')
  })

  it('keeps the brand ink at AA on the accent washes, not only on the surface', async () => {
    const { DARK_GREY_SUITE, ensureContrast } = await import('./theme.ts')
    const { contrastRatio, mixHex } = await import('@research-portal/core')
    // A near-black brand colour with a bright accent: lifted against the
    // surface alone, the brand ink fell to about 3.6:1 on the tiles' wash.
    const accent = '#5ce500'
    const vars = paletteVars(
      branding({
        colours: { primary: '#1e2226', accent, heroFrom: '#0b0f12', heroTo: '#1e2226' },
      }),
      'dark',
    )
    const surface = DARK_GREY_SUITE['--rp-surface']!
    for (const ground of [surface, mixHex(accent, surface, 0.18), mixHex(accent, surface, 0.3)]) {
      expect(contrastRatio(vars['--rp-brand-fg']!, ground), ground).toBeGreaterThanOrEqual(4.5)
    }
    // A bright accent already reads on every dark ground, so its ink is not lifted further.
    expect(vars['--rp-accent-fg']).toBe(ensureContrast(accent, surface, 4.5))
    expect(vars['--rp-wash']).toBe(`color-mix(in srgb, ${accent} 18%, ${surface})`)
    expect(vars['--rp-wash-strong']).toBe(`color-mix(in srgb, ${accent} 30%, ${surface})`)
  })

  it('gives the CorpusKit navigation a dark surface and readable links', async () => {
    const { DARK_GREY_SUITE } = await import('./theme.ts')
    const { contrastRatio } = await import('@research-portal/core')
    const vars = paletteVars(branding({ paletteId: 'corpuskit' }), 'dark')
    expect(vars['--rp-primary']).toBe(DARK_GREY_SUITE['--rp-surface'])
    expect(contrastRatio(vars['--rp-on-primary']!, vars['--rp-primary']!)).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it('leaves a light scheme, and a dark library palette, exactly as before', async () => {
    expect(paletteVars(branding(), 'light')).toEqual(paletteVars(branding()))
    const observatory = branding({ paletteId: 'observatory' })
    expect(paletteVars(observatory, 'dark')).toEqual(paletteVars(observatory))
    expect(paletteMode(observatory, 'light')).toBe('dark')
  })
})

describe('accent marks', () => {
  // A neutral test palette: a near-black brand ground with a mid-tone green as the accent and
  // the hero, 2.84:1 on white.
  const greenOnCharcoal = {
    primary: '#1C1C1C',
    accent: '#00B14E',
    heroFrom: '#00B14E',
    heroTo: '#7FD8A6',
  }
  const LIGHT_GROUNDS = [
    HOUSE_LIGHT_SUITE.surface,
    HOUSE_LIGHT_SUITE.paper,
    HOUSE_LIGHT_SUITE.surface2,
  ]

  it('keeps a mid-tone brand accent and gives its state marks and rings 3:1 on every ground', () => {
    const vars = paletteVars(branding({ colours: greenOnCharcoal, paletteId: 'default' }))
    // The stored brand colours are what the nav underline, the fills and the hero still use.
    expect(vars['--rp-accent']).toBe('#00b14e')
    expect(vars['--rp-hero-from']).toBe('#00b14e')
    expect(contrastRatio('#00b14e', '#ffffff')).toBeLessThan(3)
    // A state mark on the page is the green deepened only as far as 3:1 needs.
    const line = vars['--rp-accent-line']!
    expect(line).not.toBe('#00b14e')
    for (const ground of LIGHT_GROUNDS) {
      expect(contrastRatio(line, ground), ground).toBeGreaterThanOrEqual(3)
    }
    expect(contrastRatio(line, '#ffffff')).toBeLessThan(4.5)
    // The ring reads on the grey panels and the selected wash too, not only on white.
    for (const ground of [...LIGHT_GROUNDS, vars['--rp-wash']!]) {
      expect(contrastRatio(vars['--rp-focus']!, ground), ground).toBeGreaterThanOrEqual(3)
    }
    // The green reads on the near-black band as it is.
    expect(vars['--rp-accent-on-primary']).toBe('#00b14e')
  })

  it('leaves an accent that already reads alone', () => {
    const vars = paletteVars(branding({ colours: { ...DEFAULT_PORTAL_COLOURS } }))
    expect(vars['--rp-accent-line']).toBe(DEFAULT_PORTAL_COLOURS.accent)
    expect(vars['--rp-accent-on-primary']).toBe(DEFAULT_PORTAL_COLOURS.accent)
    for (const id of Object.keys(DEFAULT_PALETTES) as (keyof typeof DEFAULT_PALETTES)[]) {
      const palette = DEFAULT_PALETTES[id].palette
      const library = paletteVars(branding({ paletteId: id }))
      expect(library['--rp-accent-on-primary'], id).toBe(palette.accent)
    }
  })

  it('lifts the current-page underline where a dark scheme darkens the brand ground', () => {
    // The CorpusKit palette's nav band becomes the dark surface in the dark scheme, where its
    // blue accent underline was 2.56:1.
    const vars = paletteVars(branding({ paletteId: 'corpuskit' }), 'dark')
    const accent = DEFAULT_PALETTES.corpuskit.palette.accent
    expect(contrastRatio(accent, vars['--rp-primary']!)).toBeLessThan(3)
    expect(contrastRatio(vars['--rp-accent-on-primary']!, vars['--rp-primary']!))
      .toBeGreaterThanOrEqual(3)
    for (const ground of ['--rp-surface', '--rp-paper', '--rp-surface-2']) {
      expect(contrastRatio(vars['--rp-accent-line']!, vars[ground]!), ground)
        .toBeGreaterThanOrEqual(3)
      expect(contrastRatio(vars['--rp-focus']!, vars[ground]!), ground).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(vars['--rp-accent-fg']!, vars[ground]!), ground)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives every accent its marks, rings and links at their minimum in either scheme', () => {
    const channel = [0, 64, 128, 192, 255]
    for (const r of channel) {
      for (const g of channel) {
        for (const b of channel) {
          const accent = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          const colours = { ...greenOnCharcoal, accent, heroFrom: accent }
          for (const scheme of ['light', 'dark'] as const) {
            const vars = paletteVars(branding({ colours, paletteId: 'default' }), scheme)
            const label = `${accent} ${scheme}`
            const grounds = scheme === 'light'
              ? LIGHT_GROUNDS
              : ['--rp-surface', '--rp-paper', '--rp-surface-2'].map((t) => vars[t]!)
            for (const ground of grounds) {
              expect(contrastRatio(vars['--rp-accent-line']!, ground), label)
                .toBeGreaterThanOrEqual(3)
              expect(contrastRatio(vars['--rp-focus']!, ground), label).toBeGreaterThanOrEqual(3)
              expect(contrastRatio(vars['--rp-accent-fg']!, ground), label)
                .toBeGreaterThanOrEqual(4.5)
            }
            expect(contrastRatio(vars['--rp-accent-on-primary']!, vars['--rp-primary']!), label)
              .toBeGreaterThanOrEqual(3)
          }
        }
      }
    }
  })

  it('edges the hero ask field in the hero text colour where field and edge would blend in', () => {
    // A white field with a grey edge on a mid-tone green hero: 2.84:1 and 1.2:1.
    const green = paletteVars(branding({ colours: greenOnCharcoal, paletteId: 'default' }))
    expect(green['--rp-hero-field-edge']).toBe(green['--rp-on-hero'])
    // A dark hero shows the white field itself, so the house edge stays.
    const navy = paletteVars(branding({ colours: { ...DEFAULT_PORTAL_COLOURS } }))
    expect(navy['--rp-hero-field-edge']).toBe('var(--rp-field)')
  })

  it('edges the hero chips in the accent, deepened to 3:1, on a hero the accent tints', () => {
    const ends = ['#00B14E', '#7FD8A6']
    const tinted = paletteVars(branding({
      colours: { primary: '#1C1C1C', accent: '#00B14E', heroFrom: ends[0]!, heroTo: ends[1]! },
      paletteId: 'default',
    }))
    const edge = tinted['--rp-hero-chip-edge']!
    for (const end of ends) expect(contrastRatio(edge, end)).toBeGreaterThanOrEqual(3)
    // A dark green, not the hero's near-black text colour the ask field falls back to.
    expect(edge).not.toBe(tinted['--rp-on-hero'])
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(edge.slice(at, at + 2), 16))
    expect(g!).toBeGreaterThan(r!)
    expect(g!).toBeGreaterThan(b!)
    // Where the white fill already stands out, the chips keep the field's edge.
    const navy = paletteVars(branding({ colours: { ...DEFAULT_PORTAL_COLOURS } }))
    expect(navy['--rp-hero-chip-edge']).toBeUndefined()
    // A grey hero is not tinted by the accent, and an accent no step of which reads keeps none.
    expect(accentHeroEdge('#00B14E', ['#9a9a9a'], '#1a1815')).toBeNull()
    expect(accentHeroEdge('#00B14E', ['#0b3d1f', '#9be3b8'], '#1a1815')).toBeNull()
  })

  it("gives every hero's ask field a fill or an edge at 3:1 on it, in either scheme", () => {
    const channel = [0, 64, 128, 192, 255]
    for (const r of channel) {
      for (const g of channel) {
        for (const b of channel) {
          const hero = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          const colours = { ...greenOnCharcoal, heroFrom: hero, heroTo: hero }
          for (const scheme of ['light', 'dark'] as const) {
            const vars = paletteVars(branding({ colours, paletteId: 'default' }), scheme)
            const fill = vars['--rp-surface'] ?? HOUSE_LIGHT_SUITE.surface
            const value = vars['--rp-hero-field-edge']!
            const edge = value === 'var(--rp-field)'
              ? vars['--rp-field'] ?? fieldBorder(HOUSE_LIGHT_SUITE)
              : value
            const best = Math.max(contrastRatio(fill, hero), contrastRatio(edge, hero))
            expect(best, `${hero} ${scheme}`).toBeGreaterThanOrEqual(3)
          }
        }
      }
    }
  })

  it('uses the accent as it is when it cannot measure the colours', () => {
    expect(accentMarkVars({ '--rp-accent': 'rebeccapurple', '--rp-primary': 'navy' }, ['#ffffff']))
      .toEqual({
        '--rp-accent-line': 'rebeccapurple',
        '--rp-accent-on-primary': 'rebeccapurple',
        '--rp-hero-field-edge': 'var(--rp-field)',
      })
  })

  it('draws the hero field, the nav underlines and the on switch with the measured marks', async () => {
    // Whatever the hero is painted with, one band of the two-tone ring reads on it.
    expect(rule('.rp-field.rp-hero-field:focus-within')).toContain(
      'box-shadow: var(--rp-ring-inverse);',
    )
    expect(rule('.rp-navlink-active::after')).toContain(
      'background-color: var(--rp-accent-on-primary);',
    )
    const chrome = await Deno.readTextFile(new URL('../styles/chrome.css', import.meta.url))
    expect(rule(".rp-chrome-nav-row[aria-current='page']::after", chrome)).toContain(
      'background: var(--rp-accent-on-primary);',
    )
    expect(rule(".rp-switch[data-on='true']")).toContain('border-color: var(--rp-accent-line);')
    expect(rule('.rp-field.rp-hero-field')).toContain('border-color: var(--rp-hero-field-edge);')
    const explore = await Deno.readTextFile(new URL('../pages/ExplorePage.tsx', import.meta.url))
    expect(explore).toMatch(/'rp-field rp-hero-field /)
  })
})

/** A rule's declarations, by its exact selector, from the stylesheet. */
function rule(selector: string, source = styles): string {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim())
    if (selectors.includes(selector)) return match[2]!
  }
  throw new Error(`Missing stylesheet rule: ${selector}`)
}

describe('the house light suite', () => {
  it('matches the stylesheet defaults a portal on its own colours renders on', () => {
    const root = styles.slice(styles.indexOf('--rp-radius: 0px;'))
    const value = (token: string) => new RegExp(`${token}: ([^;]+);`).exec(root)?.[1]
    const ramp = (token: string) => new RegExp(`${token}: (#[0-9a-f]{6});`).exec(styles)?.[1]
    expect(ramp('--rp-paper')).toBe(HOUSE_LIGHT_SUITE.paper)
    expect(ramp('--rp-n-0')).toBe(HOUSE_LIGHT_SUITE.surface)
    expect(ramp('--rp-n-100')).toBe(HOUSE_LIGHT_SUITE.surface2)
    expect(ramp('--rp-n-200')).toBe(HOUSE_LIGHT_SUITE.line)
    expect(ramp('--rp-n-900')).toBe(HOUSE_LIGHT_SUITE.ink)
    expect(ramp('--rp-n-600')).toBe(HOUSE_LIGHT_SUITE.ink2)
    expect(value('--rp-ink-3')).toBe(HOUSE_LIGHT_SUITE.ink3)
    expect(value('--rp-surface')).toBe('var(--rp-n-0)')
    expect(value('--rp-surface-2')).toBe('var(--rp-n-100)')
    expect(value('--rp-ink')).toBe('var(--rp-n-900)')
    expect(value('--rp-ink-2')).toBe('var(--rp-n-600)')
    expect(value('--rp-field')).toBe(fieldBorder(HOUSE_LIGHT_SUITE))
  })
})

describe('focus not obscured', () => {
  it('scrolls a focused control into view below the sticky tenant header', () => {
    // TenantLayout writes the header's height to --rp-header-h on the root.
    expect(rule('html')).toContain('scroll-padding-top: calc(var(--rp-header-h, 0px) + 0.75rem);')
  })
})

describe('focus visibility', () => {
  it('keeps a transparent outline under every house ring, for forced-colours modes', () => {
    for (
      const selector of [
        '.rp-focus:focus-visible',
        '.rp-focus-inverse:focus-visible',
        '.rp-btn:focus-visible',
        '.rp-chip:focus-visible',
        '.rp-input:focus-visible',
        '.rp-field:focus-within',
      ]
    ) {
      const declarations = rule(selector)
      expect(declarations, selector).toContain('outline: 2px solid transparent;')
      expect(declarations, selector).toContain('box-shadow: var(--rp-ring')
      expect(declarations, selector).not.toContain('outline: none')
    }
  })

  it('paints focus in the system highlight when forced colours drop the ring', () => {
    const forced = styles.slice(styles.lastIndexOf('@media (forced-colors: active)'))
    expect(forced).toMatch(/^\s*:focus-visible,$/m)
    expect(forced).toContain('.rp-field:focus-within {')
    expect(forced).toContain('outline: 2px solid Highlight;')
  })

  it('draws the composite fields at 3:1 with a ring around the whole box', async () => {
    expect(rule('.rp-field')).toContain('border-color: var(--rp-field);')
    for (
      const file of [
        '../pages/AskPage.tsx',
        '../components/SearchField.tsx',
        '../pages/ResourceDetailPage.tsx',
      ]
    ) {
      const source = await Deno.readTextFile(new URL(file, import.meta.url))
      const boxes = [...source.matchAll(/['`](rp-field [^'`]*)/g)].map((m) => m[1]!)
      expect(boxes, file).toHaveLength(1)
      expect(boxes[0], file).toMatch(/\bborder\b/)
      expect(boxes[0], file).not.toContain('border-line')
    }
  })
})
