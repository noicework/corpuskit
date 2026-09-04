import { z } from 'zod'

// ---------------------------------------------------------------------------
// Tenant colour palettes - the twelve-role + grey-suite model.
//
// A palette is a complete visual identity: every coloured surface has an
// explicit on-colour, foreground accents are separated from vivid decorative
// accents, focus is its own role, the pale interaction washes are authored
// hexes rather than runtime mixes, and the grey suite (paper, surfaces,
// hairline, three-step ink ramp) travels with the brand so its temperature
// matches. `mode` says which polarity the suite is - a dark palette flips
// the semantic status colours and `color-scheme` with it.
//
// The five DEFAULT_PALETTES are the portal's stock library (signed off
// 2026-08-31): original identities, not sampled from any real organisation's
// brand. Every palette must pass the PALETTE_CONTRACT below - palettes.test.ts
// enforces it, so a bad edit fails the build rather than shipping an
// illegible portal.
// ---------------------------------------------------------------------------

const hexColour = z.string().regex(/^#[0-9a-f]{6}$/i)

export const PaletteSchema = z.object({
  /** UI polarity of the grey suite. Statuses and color-scheme follow it. */
  mode: z.enum(['light', 'dark']),
  /** Dark brand ground: nav band, footer, primary buttons. */
  brandSurface: hexColour,
  /** Text and icons on brandSurface (including its alpha-dimmed tiers). */
  onBrandSurface: hexColour,
  /** Brand-coloured text and icon strokes on surface. */
  brandForeground: hexColour,
  /** The vivid brand pop: nav active underline, solid selection fills, marks. */
  accent: hexColour,
  /** Text and ticks on solid accent - a deep brand shade, not assumed white. */
  onAccent: hexColour,
  /** Accessible accent ink: links, citation superscripts, chip labels. */
  accentForeground: hexColour,
  /** Focus indicator against the light surfaces. */
  focusRing: hexColour,
  /** Tinted ground for selected chips and bubbles (authored, not mixed). */
  accentWash: hexColour,
  /** Stronger tinted ground for hovers and strong selection. */
  accentWashStrong: hexColour,
  /** Hero gradient/duotone endpoints - analogous hues, never complementary. */
  heroFrom: hexColour,
  heroTo: hexColour,
  /** Hero text. */
  onHero: hexColour,
  /** App ground - barely off white (or near black), brand-temperature tinted. */
  paper: hexColour,
  /** Card ground. */
  surface: hexColour,
  /** Faint panel ground - the quiet grey workhorse. */
  surface2: hexColour,
  /** Hairline borders. */
  line: hexColour,
  /** Three-step text ramp on surface. */
  ink: hexColour,
  ink2: hexColour,
  ink3: hexColour,
})
export type Palette = z.infer<typeof PaletteSchema>

export const PaletteIdSchema = z.enum(['fathom', 'canopy', 'damson', 'kiln', 'observatory'])
export type PaletteId = z.infer<typeof PaletteIdSchema>

/**
 * A portal's palette choice: a library palette, or 'default' for the portal's
 * own seeded identity (its legacy four-colour branding). Absent means
 * 'default', so existing portals render unchanged.
 */
export const PaletteChoiceSchema = z.union([PaletteIdSchema, z.literal('default')])
export type PaletteChoice = z.infer<typeof PaletteChoiceSchema>

export interface PaletteEntry {
  id: PaletteId
  label: string
  /** One-line story shown in the palette picker. */
  description: string
  palette: Palette
}

export const DEFAULT_PALETTES: Record<PaletteId, PaletteEntry> = {
  fathom: {
    id: 'fathom',
    label: 'Fathom',
    description: 'Deep water seen from the surface - marine blue with an azure flash.',
    palette: {
      mode: 'light',
      brandSurface: '#0a3a57',
      onBrandSurface: '#ffffff',
      brandForeground: '#0f4a73',
      accent: '#38a8e0',
      onAccent: '#062940',
      accentForeground: '#0b628f',
      focusRing: '#0b628f',
      accentWash: '#e3f2fb',
      accentWashStrong: '#c4e4f6',
      heroFrom: '#123a63',
      heroTo: '#0b4d66',
      onHero: '#ffffff',
      paper: '#f8fafb',
      surface: '#ffffff',
      surface2: '#f0f4f7',
      line: '#d8e1e8',
      ink: '#16222c',
      ink2: '#3d4f5c',
      ink3: '#587082',
    },
  },
  canopy: {
    id: 'canopy',
    label: 'Canopy',
    description: 'Fir-dark green lifted by a fresh leaf accent.',
    palette: {
      mode: 'light',
      brandSurface: '#1b4227',
      onBrandSurface: '#ffffff',
      brandForeground: '#206032',
      accent: '#63c76d',
      onAccent: '#0c3620',
      accentForeground: '#1d6f38',
      focusRing: '#1d6f38',
      accentWash: '#e7f4ea',
      accentWashStrong: '#cfe9d5',
      heroFrom: '#1c4a2b',
      heroTo: '#155345',
      onHero: '#ffffff',
      paper: '#f8fbf8',
      surface: '#ffffff',
      surface2: '#f0f6f1',
      line: '#d9e4da',
      ink: '#182420',
      ink2: '#3c4f45',
      ink3: '#587266',
    },
  },
  damson: {
    id: 'damson',
    label: 'Damson',
    description: 'Aubergine ground with an orchid-rose accent, wine-toned throughout.',
    palette: {
      mode: 'light',
      brandSurface: '#40224f',
      onBrandSurface: '#ffffff',
      brandForeground: '#55286b',
      accent: '#d783c9',
      onAccent: '#3a1440',
      accentForeground: '#a1247f',
      focusRing: '#a1247f',
      accentWash: '#f9ecf6',
      accentWashStrong: '#f0d5ea',
      heroFrom: '#3f2153',
      heroTo: '#5a1c52',
      onHero: '#ffffff',
      paper: '#faf9fb',
      surface: '#ffffff',
      surface2: '#f4f1f6',
      line: '#e0d9e3',
      ink: '#221a26',
      ink2: '#4a4050',
      ink3: '#6d6175',
    },
  },
  kiln: {
    id: 'kiln',
    label: 'Kiln',
    description: 'Fired clay and copper - earthy, scholarly warmth.',
    palette: {
      mode: 'light',
      brandSurface: '#58281a',
      onBrandSurface: '#ffffff',
      brandForeground: '#77351f',
      accent: '#e0863c',
      onAccent: '#3c1c0b',
      accentForeground: '#9d4310',
      focusRing: '#9d4310',
      accentWash: '#fbeee1',
      accentWashStrong: '#f5d9bd',
      heroFrom: '#571f19',
      heroTo: '#6e3414',
      onHero: '#ffffff',
      paper: '#fbf9f6',
      surface: '#ffffff',
      surface2: '#f7f3ee',
      line: '#e3dad2',
      ink: '#271d18',
      ink2: '#52463e',
      ink3: '#756052',
    },
  },
  observatory: {
    id: 'observatory',
    label: 'Observatory',
    description: 'Deep-space indigo under starlight gold, on near-black paper.',
    palette: {
      mode: 'dark',
      brandSurface: '#2b2a55',
      onBrandSurface: '#f4f4fd',
      brandForeground: '#b4baf5',
      accent: '#f0c75a',
      onAccent: '#3b2c08',
      accentForeground: '#eccb69',
      focusRing: '#eccb69',
      // Brand-family washes: with a complementary indigo/gold split, the
      // washes follow the family that carries their text (see the studio's
      // Observatory iteration) - gold-tinted washes read olive under
      // periwinkle brand text.
      accentWash: '#292552',
      accentWashStrong: '#37326b',
      heroFrom: '#232558',
      heroTo: '#3c2160',
      onHero: '#ffffff',
      paper: '#131119',
      surface: '#1a1826',
      surface2: '#232138',
      line: '#3a3754',
      ink: '#f0eff9',
      ink2: '#d2d0e6',
      ink3: '#a5a3c4',
    },
  },
}

// ---------------------------------------------------------------------------
// WCAG contrast - the validation contract every palette must pass.
// ---------------------------------------------------------------------------

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '')
  const channel = (offset: number) => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export interface PaletteContractPair {
  foreground: keyof Palette
  background: keyof Palette
  /** Minimum ratio for a light-suite palette. */
  light: number
  /** Minimum ratio for a dark-suite palette (dark grounds need headroom). */
  dark: number
  use: string
}

/** The pairs a palette must satisfy - the authoring-time validation contract. */
export const PALETTE_CONTRACT: PaletteContractPair[] = [
  {
    foreground: 'onBrandSurface',
    background: 'brandSurface',
    light: 7,
    dark: 7,
    use: 'nav and button text',
  },
  {
    foreground: 'brandForeground',
    background: 'surface',
    light: 4.5,
    dark: 7,
    use: 'brand text on surface',
  },
  {
    foreground: 'brandForeground',
    background: 'accentWashStrong',
    light: 4.5,
    dark: 4.5,
    use: 'text on strong wash',
  },
  {
    foreground: 'accent',
    background: 'brandSurface',
    light: 3,
    dark: 3,
    use: 'nav active underline',
  },
  {
    foreground: 'onAccent',
    background: 'accent',
    light: 4.5,
    dark: 4.5,
    use: 'text on solid accent',
  },
  {
    foreground: 'accentForeground',
    background: 'surface',
    light: 4.5,
    dark: 7,
    use: 'links and citations',
  },
  {
    foreground: 'accentForeground',
    background: 'accentWash',
    light: 4.5,
    dark: 4.5,
    use: 'chip labels on wash',
  },
  { foreground: 'focusRing', background: 'surface', light: 3, dark: 3, use: 'focus indicator' },
  {
    foreground: 'onHero',
    background: 'heroFrom',
    light: 7,
    dark: 7,
    use: 'hero text (raw endpoint)',
  },
  {
    foreground: 'onHero',
    background: 'heroTo',
    light: 7,
    dark: 7,
    use: 'hero text (raw endpoint)',
  },
  { foreground: 'ink', background: 'surface', light: 4.5, dark: 4.5, use: 'body text' },
  { foreground: 'ink2', background: 'surface', light: 4.5, dark: 4.5, use: 'secondary text' },
  { foreground: 'ink3', background: 'surface', light: 4.5, dark: 4.5, use: 'captions and labels' },
  {
    foreground: 'ink3',
    background: 'surface2',
    light: 4.5,
    dark: 4.5,
    use: 'captions on the grey ground',
  },
]

/** Every contract pair a palette fails, empty when it is valid. */
export function validatePalette(palette: Palette): string[] {
  const failures: string[] = []
  for (const pair of PALETTE_CONTRACT) {
    const minimum = palette.mode === 'dark' ? pair.dark : pair.light
    const ratio = contrastRatio(palette[pair.foreground], palette[pair.background])
    if (ratio < minimum) {
      failures.push(
        `${pair.foreground}/${pair.background} (${pair.use}): ${ratio.toFixed(2)} < ${minimum}`,
      )
    }
  }
  return failures
}
