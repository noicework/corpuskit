import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  canAssignPalette,
  contrastRatio,
  deepenForContrast,
  DEFAULT_PALETTES,
  DEFAULT_PORTAL_COLOURS,
  fieldBorder,
  HOUSE_LIGHT_SUITE,
  isListedPalette,
  NEW_PORTAL_PALETTE,
  normaliseHex,
  PaletteChoiceSchema,
  paletteFromColours,
  type PaletteId,
  PaletteIdSchema,
  PaletteSchema,
  pickerPaletteIds,
  textOn,
  validatePalette,
} from './palettes.ts'

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 2)
  })
})

describe('DEFAULT_PALETTES', () => {
  it('covers every palette id with a schema-valid palette', () => {
    for (const id of PaletteIdSchema.options) {
      const entry = DEFAULT_PALETTES[id]
      expect(entry.id).toBe(id)
      expect(entry.label.length).toBeGreaterThan(0)
      PaletteSchema.parse(entry.palette)
    }
  })

  it('every library palette passes the full validation contract', () => {
    for (const entry of Object.values(DEFAULT_PALETTES)) {
      expect({ id: entry.id, failures: validatePalette(entry.palette) })
        .toEqual({ id: entry.id, failures: [] })
    }
  })

  it('observatory is the dark palette; the rest are light', () => {
    for (const entry of Object.values(DEFAULT_PALETTES)) {
      expect(entry.palette.mode).toBe(entry.id === 'observatory' ? 'dark' : 'light')
    }
  })
})

describe('validatePalette', () => {
  it('names the failing pair when a palette breaks the contract', () => {
    const broken = { ...DEFAULT_PALETTES.fathom.palette, accentForeground: '#38a8e0' }
    const failures = validatePalette(broken)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.join('\n')).toContain('accentForeground/surface')
  })
})

describe('unlisted palettes', () => {
  const listed: PaletteId[] = ['fathom', 'canopy', 'damson', 'kiln', 'observatory', 'corpuskit']

  it('keeps ACMD a valid palette id but lists every other palette', () => {
    expect(PaletteIdSchema.options).toContain('acmd')
    expect(PaletteChoiceSchema.parse('acmd')).toBe('acmd')
    expect(DEFAULT_PALETTES.acmd.listed).toBe(false)
    expect(PaletteIdSchema.options.filter(isListedPalette).sort()).toEqual([...listed].sort())
  })

  it('offers every listed palette, in library order, and never ACMD to another portal', () => {
    const libraryOrder = PaletteIdSchema.options.filter((id) => id !== 'acmd')
    for (const current of [undefined, 'default', 'fathom', 'observatory', 'corpuskit'] as const) {
      expect(pickerPaletteIds(current)).toEqual(libraryOrder)
    }
  })

  it('still offers ACMD to the portal already using it', () => {
    expect(pickerPaletteIds('acmd')).toEqual(PaletteIdSchema.options)
  })

  it('assigns the portal colours, any listed palette, or the unlisted palette already in use', () => {
    for (const current of [undefined, 'default', 'kiln', 'acmd'] as const) {
      expect(canAssignPalette('default', current)).toBe(true)
      for (const id of listed) expect(canAssignPalette(id, current)).toBe(true)
    }
    expect(canAssignPalette('acmd', 'acmd')).toBe(true)
    for (const current of [undefined, 'default', 'kiln', 'corpuskit'] as const) {
      expect(canAssignPalette('acmd', current)).toBe(false)
    }
  })
})

describe('a portal on its own colours', () => {
  it('derives a palette from the default portal colours that passes the full contract', () => {
    const palette = paletteFromColours(DEFAULT_PORTAL_COLOURS)!
    expect(PaletteSchema.safeParse(palette).success).toBe(true)
    expect(validatePalette(palette)).toEqual([])
    // Citation markers and links were the accent itself, 3.44:1 on white.
    expect(contrastRatio(DEFAULT_PORTAL_COLOURS.accent, '#ffffff')).toBeLessThan(4.5)
    expect(contrastRatio(palette.accentForeground, palette.surface)).toBeGreaterThanOrEqual(4.5)
    // White on the solid accent was 3.44:1 too; the text on it is now chosen by contrast.
    expect(palette.onAccent).toBe(HOUSE_LIGHT_SUITE.ink)
  })

  it('keeps the seeded colours themselves and only chooses what is drawn on them', () => {
    const palette = paletteFromColours({
      primary: '#143669',
      accent: '#00B8A5',
      heroFrom: '#0b2247',
      heroTo: '#0e5f6b',
    })!
    expect(palette.brandSurface).toBe('#143669')
    expect(palette.accent).toBe('#00b8a5')
    expect([palette.heroFrom, palette.heroTo]).toEqual(['#0b2247', '#0e5f6b'])
    // A colour that already reads is left alone.
    expect(palette.brandForeground).toBe('#143669')
    expect(palette.onBrandSurface).toBe('#ffffff')
    expect(validatePalette(palette)).toEqual([])
  })

  it('reads at AA for text and 3:1 for focus whatever accent a portal chose', () => {
    const channel = [0, 64, 128, 192, 255]
    for (const r of channel) {
      for (const g of channel) {
        for (const b of channel) {
          const accent = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          const palette = paletteFromColours({ ...DEFAULT_PORTAL_COLOURS, accent })!
          const label = `accent ${accent}`
          for (const ground of [palette.surface, palette.accentWash]) {
            expect(contrastRatio(palette.accentForeground, ground), label)
              .toBeGreaterThanOrEqual(4.5)
          }
          expect(contrastRatio(palette.focusRing, palette.surface), label)
            .toBeGreaterThanOrEqual(3)
          expect(contrastRatio(palette.onAccent, accent), label).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('uses a colour it cannot measure as it is', () => {
    expect(paletteFromColours({ ...DEFAULT_PORTAL_COLOURS, accent: 'rebeccapurple' })).toBeNull()
    expect(normaliseHex('#ABC')).toBe('#aabbcc')
    expect(normaliseHex(' #A1b2C3 ')).toBe('#a1b2c3')
    expect(normaliseHex('rgb(1, 2, 3)')).toBeNull()
  })

  it('deepens only as far as it must, and picks the text that reads', () => {
    expect(deepenForContrast('#1a1815', ['#ffffff'], 4.5)).toBe('#1a1815')
    const deepened = deepenForContrast('#8ec5ff', ['#ffffff'], 4.5)
    expect(contrastRatio(deepened, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(deepened, '#ffffff')).toBeLessThan(6)
    expect(textOn(['#0a3a57'], 4.5)).toBe('#ffffff')
    expect(textOn(['#f5d000'], 4.5)).toBe(HOUSE_LIGHT_SUITE.ink)
    // A mid-tone ground neither white nor the ink reaches: black does.
    const mid = textOn(['#767676'], 4.5)
    expect(contrastRatio(mid, '#767676')).toBeGreaterThanOrEqual(4.5)
  })

  it('starts portals created in the app on a listed palette that passes the contract', () => {
    expect(isListedPalette(NEW_PORTAL_PALETTE)).toBe(true)
    expect(validatePalette(DEFAULT_PALETTES[NEW_PORTAL_PALETTE].palette)).toEqual([])
  })
})

describe('fieldBorder', () => {
  it('gives every palette and the house suite a field edge at 3:1 on each ground', () => {
    const suites = [
      ['house', HOUSE_LIGHT_SUITE],
      ...Object.entries(DEFAULT_PALETTES).map(([id, entry]) => [id, entry.palette] as const),
    ] as const
    for (const [id, suite] of suites) {
      const border = fieldBorder(suite)
      for (const ground of [suite.surface, suite.surface2, suite.paper]) {
        expect(contrastRatio(border, ground), `${id} on ${ground}`).toBeGreaterThanOrEqual(3)
      }
      // Lighter than the caption ink it is mixed from: an edge, not text.
      expect(contrastRatio(border, suite.surface)).toBeLessThan(
        contrastRatio(suite.ink3, suite.surface),
      )
    }
  })
})
