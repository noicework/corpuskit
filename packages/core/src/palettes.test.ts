import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  canAssignPalette,
  contrastRatio,
  DEFAULT_PALETTES,
  isListedPalette,
  PaletteChoiceSchema,
  type PaletteId,
  PaletteIdSchema,
  PaletteSchema,
  pickerPaletteIds,
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
