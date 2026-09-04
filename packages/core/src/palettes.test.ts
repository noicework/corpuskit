import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  contrastRatio,
  DEFAULT_PALETTES,
  PaletteIdSchema,
  PaletteSchema,
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
