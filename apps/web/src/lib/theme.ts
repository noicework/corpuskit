import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  contrastRatio,
  deepenForContrast,
  DEFAULT_PALETTES,
  type DensityId,
  fieldBorder,
  FONT_PAIRINGS,
  type FontPairingId,
  FontPairingIdSchema,
  HOUSE_LIGHT_SUITE,
  mixHex,
  normaliseHex,
  type Palette,
  paletteFromColours,
  type ShapeId,
  type TenantConfig,
  textOn,
  type TextScaleId,
} from '@research-portal/core'

type Branding = TenantConfig['branding']

/**
 * Tenant theming: turns branding (colours, typography, shape) into the CSS
 * custom properties the token layer in styles.css reads, and loads whichever
 * font faces the choice needs. The pure functions here are the single mapping
 * from a branding document to theme vars; TenantLayout applies them inline on
 * the tenant wrapper so everything inside re-themes.
 */

export const PAIRING_IDS: readonly FontPairingId[] = FontPairingIdSchema.options

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif'

/** Families used by @font-face rules for uploaded custom fonts. */
export const CUSTOM_HEADING_FAMILY = 'RP Custom Heading'
export const CUSTOM_BODY_FAMILY = 'RP Custom Body'

/**
 * The radius each shape gives every dial. Surfaces round more than controls in
 * 'soft'; buttons and chips go full pill there while inputs stay moderate so a
 * multi-line textarea never renders as a lozenge.
 */
export const SHAPE_RADII: Record<
  ShapeId,
  { surface: string; btn: string; chip: string; input: string }
> = {
  square: { surface: '0px', btn: '0px', chip: '0px', input: '0px' },
  rounded: { surface: '10px', btn: '8px', chip: '8px', input: '8px' },
  soft: { surface: '16px', btn: '9999px', chip: '9999px', input: '14px' },
}

/** Horizontal button padding per shape - pill ends want a touch more air. */
const BTN_PX: Record<ShapeId, string> = {
  square: '0.875rem',
  rounded: '0.875rem',
  soft: '1.125rem',
}

export function fontStack(family: string): string {
  return `'${family}', ${SANS_FALLBACK}`
}

/**
 * Root font-size per text-scale choice. The whole interface is rem-based, so
 * scaling the root scales text and its tied spacing together, like browser
 * zoom - proportions and reading measures survive. null means leave the
 * browser default (the user's own setting) alone.
 */
export const TEXT_SCALES: Record<TextScaleId, string | null> = {
  default: null,
  smaller: '93.75%',
  larger: '106.25%',
}

/** A modest desktop step: the browser-default 16px root becomes 17px. */
export const DESKTOP_TEXT_SCALE_FACTOR = 1.0625

/**
 * CSS variables for a tenant's text scale. The stylesheet chooses the mobile
 * or desktop value at its breakpoint, while the values here precompose the
 * tenant choice with the desktop uplift. Keeping `font-size` out of the inline
 * style lets the media query work for every tenant, not only the default one.
 */
export function textScaleVars(scale: TextScaleId): Record<string, string> {
  const value = TEXT_SCALES[scale]
  if (!value) return {}
  return {
    '--rp-text-scale': value,
    '--rp-text-scale-desktop': `${Number.parseFloat(value) * DESKTOP_TEXT_SCALE_FACTOR}%`,
  }
}

/** Apply the tenant's text scale variables to the document root. */
export function useTextScale(branding: Branding | undefined): void {
  const scale = branding?.textScale ?? 'default'
  useEffect(() => {
    const root = document.documentElement
    const vars = textScaleVars(scale)
    for (const [property, value] of Object.entries(vars)) root.style.setProperty(property, value)
    return () => {
      root.style.removeProperty('--rp-text-scale')
      root.style.removeProperty('--rp-text-scale-desktop')
    }
  }, [scale])
}

export function shapeVars(shape: Branding['shape']): Record<string, string> {
  const radii = SHAPE_RADII[shape ?? 'square']
  return {
    '--rp-radius': radii.surface,
    '--rp-radius-btn': radii.btn,
    '--rp-radius-chip': radii.chip,
    '--rp-radius-input': radii.input,
    '--rp-btn-px': BTN_PX[shape ?? 'square'],
  }
}

/**
 * The two density dials per level. `rhythm` rescales the Tailwind spacing
 * scale (paddings, gaps, stacks - see .rp-tenant in styles.css); `ctl` is
 * deliberately damped so buttons, chips and inputs move less than the space
 * around them. Text sizes never ride either dial.
 */
export const DENSITY_DIALS: Record<DensityId, { rhythm: number; ctl: number }> = {
  compact: { rhythm: 0.85, ctl: 0.93 },
  default: { rhythm: 1, ctl: 1 },
  comfortable: { rhythm: 1.2, ctl: 1.06 },
  spacious: { rhythm: 1.4, ctl: 1.12 },
}

export function densityVars(density: Branding['density']): Record<string, string> {
  const dials = DENSITY_DIALS[density ?? 'default']
  return {
    '--rp-density': String(dials.rhythm),
    '--rp-density-ctl': String(dials.ctl),
  }
}

export function typographyVars(branding: Branding): Record<string, string> {
  const choice = branding.typography
  if (!choice || choice === 'default') {
    // 'default' means this portal's own default: its seeded brand faces when
    // it has them (when a portal seeds its own faces), else the house faces
    // from :root.
    if (!branding.fonts) return {}
    return {
      '--rp-font-body': branding.fonts.sans,
      '--rp-font-display': branding.fonts.display,
    }
  }
  if (choice === 'custom') {
    return {
      ...(branding.headingFontUrl ? { '--rp-font-display': fontStack(CUSTOM_HEADING_FAMILY) } : {}),
      ...(branding.bodyFontUrl ? { '--rp-font-body': fontStack(CUSTOM_BODY_FAMILY) } : {}),
    }
  }
  const pairing = FONT_PAIRINGS[choice]
  return {
    '--rp-font-display': fontStack(pairing.heading.family),
    '--rp-font-display-weight': String(pairing.heading.weight),
    '--rp-font-display-bold-weight': String(pairing.heading.boldWeight),
    '--rp-font-display-tracking': pairing.heading.tracking,
    '--rp-font-display-leading': pairing.heading.leading,
    '--rp-font-body': fontStack(pairing.body.family),
    '--rp-font-body-weight': String(pairing.body.weight),
  }
}

/**
 * Dark-polarity semantic status colours. The light values are the stylesheet
 * defaults; a dark-suite palette overrides them so a status chip never glares
 * a pastel ground into a near-black interface.
 */
const DARK_STATUS_VARS: Record<string, string> = {
  '--rp-ok-bg': '#0e2f24',
  '--rp-ok-ink': '#3fd598',
  '--rp-ok-line': '#1d5c42',
  '--rp-warn-bg': '#34270d',
  '--rp-warn-ink': '#f5bd4f',
  '--rp-warn-line': '#6b4e14',
  '--rp-bad-bg': '#3b141d',
  '--rp-bad-ink': '#fb7d90',
  '--rp-bad-line': '#771f31',
}

/** Marks keep their category identity while the dark set lifts their lightness. */
const CATEGORICAL_COLOURS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7'],
  dark: ['#6da4eb', '#ef946d', '#4bc495', '#efbb55', '#eb9cba', '#9d91e2'],
} as const

/** The library palette a portal has chosen, or null for its seeded identity. */
export function resolvePalette(branding: Branding): Palette | null {
  const choice = branding.paletteId
  if (!choice || choice === 'default') return null
  return DEFAULT_PALETTES[choice].palette
}

/** The viewer's colour scheme: their own choice, or what the system asked for. */
export type ViewerScheme = 'light' | 'dark'

/** 'dark' when a dark-suite library palette is active, or the viewer chose dark. */
export function paletteMode(branding: Branding, scheme: ViewerScheme = 'light'): 'light' | 'dark' {
  if (scheme === 'dark') return 'dark'
  return resolvePalette(branding)?.mode ?? 'light'
}

/**
 * The house dark grey suite - what the viewer's dark toggle maps every
 * light-suite portal onto. Neutral rather than temperature-tinted so it sits
 * under any brand colour; the same polarity Observatory (the library's dark
 * palette) uses, with status colours from DARK_STATUS_VARS.
 */
export const DARK_GREY_SUITE: Record<string, string> = {
  '--rp-paper': '#121316',
  '--rp-app': '#121316',
  '--rp-surface': '#1a1c20',
  '--rp-surface-2': '#23262b',
  '--rp-surface-3': '#33373e',
  '--rp-line': '#33373e',
  '--rp-line-2': '#23262b',
  '--rp-ink': '#f2f3f5',
  '--rp-ink-2': '#cfd2d8',
  '--rp-ink-3': '#a3a8b1',
  // A field's edge at 3:1 on the dark grounds (WCAG 1.4.11); `--rp-line` stays for dividers.
  '--rp-field': fieldBorder({
    ink3: '#a3a8b1',
    surface: '#1a1c20',
    surface2: '#23262b',
    paper: '#121316',
  }),
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = parseInt(m[1]!, 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function mixWithWhite(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const channel = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/**
 * A brand colour that reads on a light surface (a deep violet, a fir green)
 * can fall under 3:1 on a dark one. Lighten it in small steps until it
 * clears the ratio asked for, so brand ink and links stay legible in the
 * viewer's dark scheme without a hand-authored dark palette.
 */
export function ensureContrast(hex: string, surface: string, minimum: number): string {
  if (!hexToRgb(hex)) return hex
  let candidate = hex
  for (let step = 0; step <= 10; step++) {
    candidate = mixWithWhite(hex, step / 10)
    if (contrastRatio(candidate, surface) >= minimum) return candidate
  }
  return candidate
}

/**
 * `ensureContrast` over several grounds at once: the ink is lightened until it
 * clears the ratio on every one of them.
 */
function ensureContrastOn(hex: string, grounds: readonly string[], minimum: number): string {
  if (!hexToRgb(hex)) return hex
  let candidate = hex
  for (let step = 0; step <= 10; step++) {
    candidate = mixWithWhite(hex, step / 10)
    if (grounds.every((ground) => contrastRatio(candidate, ground) >= minimum)) return candidate
  }
  return candidate
}

/** The shares of accent in the dark washes, as `--rp-wash` and `--rp-wash-strong` mix them. */
const DARK_WASH_SHARE = 0.18
const DARK_WASH_STRONG_SHARE = 0.3

/**
 * Token overrides for the viewer's dark scheme on a portal whose own
 * palette is light: the dark grey suite, dark-polarity status colours, an
 * opaque-enough glass, washes mixed from the accent over the dark surface,
 * and brand/accent inks lightened to AA on the dark surface. Brand ink is
 * also checked on both washes, since Explore's tiles set it on them: a bright
 * accent makes a wash light enough that a brand ink checked against the
 * surface alone fell under AA there. Accent ink and the focus ring are checked
 * on every ground they are drawn on - the surface, the app ground, the grey
 * panels and the selected wash - since a lift measured on the surface alone
 * left links at 3.9:1 on the wash and rings at 2.8:1 on the grey panels.
 */
function viewerDarkVars(roles: Record<string, string>): Record<string, string> {
  const surface = DARK_GREY_SUITE['--rp-surface']!
  const accent = roles['--rp-accent'] ?? '#888888'
  const washes = hexToRgb(accent)
    ? [mixHex(accent, surface, DARK_WASH_SHARE), mixHex(accent, surface, DARK_WASH_STRONG_SHARE)]
    : []
  const inkGrounds = [surface, ...washes]
  const accentGrounds = [
    surface,
    DARK_GREY_SUITE['--rp-paper']!,
    DARK_GREY_SUITE['--rp-surface-2']!,
    ...washes.slice(0, 1),
  ]
  return {
    ...DARK_GREY_SUITE,
    ...DARK_STATUS_VARS,
    '--rp-glass-bg': `color-mix(in srgb, ${surface} 92%, transparent)`,
    '--rp-brand-fg': ensureContrastOn(roles['--rp-brand-fg'] ?? accent, inkGrounds, 4.5),
    '--rp-accent-fg': ensureContrastOn(roles['--rp-accent-fg'] ?? accent, accentGrounds, 4.5),
    '--rp-focus': ensureContrastOn(roles['--rp-focus'] ?? accent, accentGrounds, 3),
    '--rp-wash': `color-mix(in srgb, ${accent} ${DARK_WASH_SHARE * 100}%, ${surface})`,
    '--rp-wash-strong': `color-mix(in srgb, ${accent} ${
      DARK_WASH_STRONG_SHARE * 100
    }%, ${surface})`,
  }
}

/**
 * Secondary ink starts at 75% text and regains strength in 1% steps until AA.
 * Hero ink checks both endpoints while mixing toward the first one. An
 * unmeasurable CSS colour keeps the full-strength foreground rather than dimming
 * text without evidence that the result remains readable.
 */
export function secondaryInk(foreground: string, grounds: readonly string[]): string {
  const text = normaliseHex(foreground)
  const measuredGrounds = grounds.map(normaliseHex)
  if (!text || measuredGrounds.some((ground) => ground === null)) return foreground
  const hexGrounds = measuredGrounds as string[]
  for (let step = 25; step >= 0; step--) {
    const candidate = mixHex(hexGrounds[0]!, text, step / 100)
    if (hexGrounds.every((ground) => contrastRatio(candidate, ground) >= 4.5)) return candidate
  }
  return textOn(hexGrounds, 4.5)
}

/**
 * The accent where it has to be seen, not only enjoyed (WCAG 1.4.11), measured on the actual
 * grounds after the scheme swap:
 *
 * - `--rp-accent-line`: the accent as a state or emphasis mark on the page - an on switch's edge,
 *   a relevance bar, a quote rule, a "new results" dot - at 3:1 on the surface, the app ground
 *   and the grey panels. The accent itself when it already reads, else stepped toward the ink.
 * - `--rp-accent-on-primary`: the current-page underline on the brand ground, at 3:1 there.
 * - `--rp-hero-field-edge`: the hero ask field's border. The house field edge while the field's
 *   fill or that edge stands out from both hero endpoints at 3:1; the hero's text colour when
 *   neither does, as on a mid-tone hero where a white field and a grey edge blend into it.
 *
 * Colours this cannot measure (a seed may use any CSS colour) keep the accent and the house edge.
 */
export function accentMarkVars(
  roles: Record<string, string>,
  grounds: readonly string[],
): Record<string, string> {
  const accent = normaliseHex(roles['--rp-accent'] ?? '')
  const primary = normaliseHex(roles['--rp-primary'] ?? '')
  const onPrimary = normaliseHex(roles['--rp-on-primary'] ?? '')
  const ink = normaliseHex(roles['--rp-ink'] ?? '') ?? HOUSE_LIGHT_SUITE.ink
  const measured = grounds.map(normaliseHex)
  const vars: Record<string, string> = {
    '--rp-accent-line': roles['--rp-accent']!,
    '--rp-accent-on-primary': roles['--rp-accent']!,
    // Set here, not only at :root, so the field edge resolves against this portal's own tokens.
    '--rp-hero-field-edge': 'var(--rp-field)',
  }
  if (accent && measured.every((ground) => ground !== null)) {
    vars['--rp-accent-line'] = deepenForContrast(accent, measured as string[], 3, ink)
  }
  if (accent && primary && onPrimary) {
    vars['--rp-accent-on-primary'] = deepenForContrast(accent, [primary], 3, onPrimary)
  }
  const fill = measured[0]
  const edge = normaliseHex(roles['--rp-field'] ?? '') ?? fieldBorder(HOUSE_LIGHT_SUITE)
  const hero = [roles['--rp-hero-from'], roles['--rp-hero-to']].map((c) => normaliseHex(c ?? ''))
  const onHero = normaliseHex(roles['--rp-on-hero'] ?? '')
  if (fill && onHero && hero.every((ground) => ground !== null)) {
    const shows = (hero as string[]).every((ground) =>
      contrastRatio(fill, ground) >= 3 || contrastRatio(edge, ground) >= 3
    )
    if (!shows) vars['--rp-hero-field-edge'] = onHero
  }
  return vars
}

/** The duotone's shares of each hero endpoint over a hero photo, as the stylesheet draws it. */
const HERO_VEIL = { from: 0.85, to: 0.6 } as const

/**
 * A hero photo shows through the duotone, so the hero's text is only as legible as the lightest
 * or darkest pixel a photo can put behind it. `--rp-hero-veil-from` / `-to` raise each
 * endpoint's share, in 5% steps from the drawn default, until the hero's text (`texts`, both
 * tiers) reads at 4.5:1 over a white and a black pixel alike (WCAG 1.4.3); the photo stays as
 * visible as that allows. `--rp-hero-scrim` darkens the foot of a photo hero under light text
 * and lightens it under dark text, so it helps whichever text sits there instead of eroding it.
 * Colours this cannot measure keep the drawn defaults.
 */
export function heroVeilVars(
  heroFrom: string,
  heroTo: string,
  texts: readonly string[],
): Record<string, string> {
  const from = normaliseHex(heroFrom)
  const to = normaliseHex(heroTo)
  const inks = texts.map(normaliseHex)
  const vars: Record<string, string> = {
    '--rp-hero-veil-from': `${HERO_VEIL.from * 100}%`,
    '--rp-hero-veil-to': `${HERO_VEIL.to * 100}%`,
    '--rp-hero-scrim': '10 10 12',
  }
  if (!from || !to || inks.some((ink) => ink === null)) return vars
  const reads = (endpoint: string, share: number) =>
    ['#ffffff', '#000000'].every((pixel) =>
      (inks as string[]).every((ink) => contrastRatio(ink, mixHex(endpoint, pixel, share)) >= 4.5)
    )
  const veil = (endpoint: string, start: number) => {
    for (let share = start; share < 1; share = Math.round((share + 0.05) * 100) / 100) {
      if (reads(endpoint, share)) return share
    }
    return 1
  }
  vars['--rp-hero-veil-from'] = `${Math.round(veil(from, HERO_VEIL.from) * 100)}%`
  vars['--rp-hero-veil-to'] = `${Math.round(veil(to, HERO_VEIL.to) * 100)}%`
  // Dark text (it reads better on white than on black) gets a light scrim.
  const ink = inks[0]!
  if (contrastRatio(ink, '#ffffff') > contrastRatio(ink, '#000000')) {
    vars['--rp-hero-scrim'] = '255 255 255'
  }
  return vars
}

/** Derived roles run after the scheme swap, so they measure the actual grounds. */
function foundationRoleVars(
  branding: Branding,
  roles: Record<string, string>,
  scheme: ViewerScheme,
): Record<string, string> {
  const mode = paletteMode(branding, scheme)
  const surface = roles['--rp-surface'] ?? HOUSE_LIGHT_SUITE.surface
  const paper = roles['--rp-paper'] ?? HOUSE_LIGHT_SUITE.paper
  const primary = roles['--rp-primary']!
  const accent = roles['--rp-accent']!
  const grounds = [surface, paper]
  const qualifies = (colour: string) => {
    const hex = normaliseHex(colour)
    return hex !== null && grounds.every((ground) => contrastRatio(hex, ground) >= 3)
  }
  let control: string
  if (mode === 'dark') {
    // CSS colours outside the hex contract cannot be measured here. Keep the
    // identity intact and give its controls a known, contrasting house fill.
    control = ensureContrastOn(normaliseHex(primary) ?? '#27364b', grounds, 3)
  } else if (qualifies(primary)) {
    control = normaliseHex(primary)!
  } else if (
    qualifies(accent) && normaliseHex(roles['--rp-on-accent']!) &&
    contrastRatio(normaliseHex(roles['--rp-on-accent']!)!, normaliseHex(accent)!) >= 4.5
  ) {
    control = normaliseHex(accent)!
  } else {
    control = qualifies(roles['--rp-brand-fg']!)
      ? normaliseHex(roles['--rp-brand-fg']!)!
      : '#27364b'
  }
  const palette = resolvePalette(branding)
  const surface2 = roles['--rp-surface-2'] ?? HOUSE_LIGHT_SUITE.surface2
  const onHero2 = secondaryInk(roles['--rp-on-hero']!, [
    roles['--rp-hero-from']!,
    roles['--rp-hero-to']!,
  ])
  return {
    ...accentMarkVars(roles, [surface, paper, surface2]),
    '--rp-on-primary-2': secondaryInk(roles['--rp-on-primary']!, [primary]),
    '--rp-on-hero-2': onHero2,
    ...heroVeilVars(roles['--rp-hero-from']!, roles['--rp-hero-to']!, [
      roles['--rp-on-hero']!,
      onHero2,
    ]),
    '--rp-control': control,
    '--rp-on-control': textOn([control], 4.5),
    '--rp-logo-plate': palette?.mode === 'light' ? palette.paper : HOUSE_LIGHT_SUITE.paper,
    '--rp-scrim': mode === 'dark' ? 'rgba(0, 0, 0, 0.62)' : 'rgba(10, 10, 12, 0.5)',
    '--rp-thumb-brightness': mode === 'dark' ? '0.92' : '1',
    '--rp-thumb-edge': mode === 'dark' ? 'var(--rp-line)' : 'transparent',
    ...Object.fromEntries(
      CATEGORICAL_COLOURS[mode].map((colour, i) => [`--rp-cat-${i + 1}`, colour]),
    ),
  }
}

/**
 * The colour tokens, twelve roles plus the grey suite. With no library
 * palette chosen this derives the role tokens from the portal's seeded
 * four-colour identity (`paletteFromColours`): the four colours themselves
 * are kept, and the text and focus drawn on top of them are chosen for
 * contrast (AA text on the page and on the accent whatever the colours; see
 * `paletteFromColours` for what still depends on them). The grey suite then
 * stays on the house defaults from the stylesheet.
 */
export function paletteVars(
  branding: Branding,
  scheme: ViewerScheme = 'light',
): Record<string, string> {
  const roles = paletteRoleVars(branding)
  let resolved = roles
  // A dark library palette is already dark; the viewer's toggle only has
  // work to do on a light suite.
  if (scheme === 'dark' && paletteMode(branding) === 'light') {
    // On a portal's own colours the dark inks are lifted from the brand colours
    // themselves, not from the light inks deepened for a white surface.
    const own = resolvePalette(branding) === null
    const { primary, accent } = branding.colours
    resolved = {
      ...roles,
      ...viewerDarkVars(
        own
          ? { ...roles, '--rp-brand-fg': primary, '--rp-accent-fg': accent, '--rp-focus': accent }
          : roles,
      ),
      ...(branding.paletteId === 'corpuskit'
        ? {
          '--rp-primary': DARK_GREY_SUITE['--rp-surface']!,
          '--rp-on-primary': DARK_GREY_SUITE['--rp-ink']!,
        }
        : {}),
    }
  }
  return { ...resolved, ...foundationRoleVars(branding, resolved, scheme) }
}

function paletteRoleVars(branding: Branding): Record<string, string> {
  const palette = resolvePalette(branding)
  if (!palette) {
    const derived = paletteFromColours(branding.colours)
    if (derived) {
      return {
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
      }
    }
    // A colour that is not a hex colour (a seed may use any CSS colour) cannot
    // be measured, so the identity is used as it is.
    const { primary, accent, heroFrom, heroTo } = branding.colours
    return {
      '--rp-primary': primary,
      '--rp-accent': accent,
      '--rp-hero-from': heroFrom,
      '--rp-hero-to': heroTo,
      '--rp-on-primary': '#ffffff',
      '--rp-brand-fg': primary,
      '--rp-on-accent': '#ffffff',
      '--rp-accent-fg': accent,
      '--rp-focus': accent,
      '--rp-on-hero': '#ffffff',
      '--rp-wash': `color-mix(in srgb, ${accent} 12%, var(--rp-surface))`,
      '--rp-wash-strong': `color-mix(in srgb, ${accent} 22%, var(--rp-surface))`,
    }
  }
  return {
    '--rp-primary': palette.brandSurface,
    '--rp-on-primary': palette.onBrandSurface,
    '--rp-brand-fg': palette.brandForeground,
    '--rp-accent': palette.accent,
    '--rp-on-accent': palette.onAccent,
    '--rp-accent-fg': palette.accentForeground,
    '--rp-focus': palette.focusRing,
    '--rp-wash': palette.accentWash,
    '--rp-wash-strong': palette.accentWashStrong,
    '--rp-hero-from': palette.heroFrom,
    '--rp-hero-to': palette.heroTo,
    '--rp-on-hero': palette.onHero,
    '--rp-paper': palette.paper,
    '--rp-app': palette.paper,
    '--rp-surface': palette.surface,
    '--rp-surface-2': palette.surface2,
    '--rp-surface-3': palette.line,
    '--rp-line': palette.line,
    '--rp-line-2': palette.surface2,
    '--rp-ink': palette.ink,
    '--rp-ink-2': palette.ink2,
    '--rp-ink-3': palette.ink3,
    '--rp-field': fieldBorder(palette),
    ...(palette.mode === 'dark'
      ? {
        ...DARK_STATUS_VARS,
        '--rp-glass-bg': `color-mix(in srgb, ${palette.surface} 92%, transparent)`,
      }
      : {}),
  }
}

/** Every theme var the tenant wrapper sets inline - palette, faces, radii, density. */
export function tenantThemeVars(
  branding: Branding,
  scheme: ViewerScheme = 'light',
): CSSProperties {
  return {
    ...paletteVars(branding, scheme),
    ...typographyVars(branding),
    ...shapeVars(branding.shape),
    ...densityVars(branding.density),
    colorScheme: paletteMode(branding, scheme),
  } as CSSProperties
}

const SCHEME_KEY = 'rp-scheme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** What the viewer stored: an explicit choice, or nothing (follow the system). */
export type SchemeChoice = ViewerScheme | 'system'

/** Explicit viewer choice, then a configured tenant default, then the system preference. */
export function resolveScheme(
  choice: SchemeChoice,
  prefersDark: boolean,
  defaultScheme?: ViewerScheme,
): ViewerScheme {
  if (choice === 'dark' || choice === 'light') return choice
  if (defaultScheme) return defaultScheme
  return prefersDark ? 'dark' : 'light'
}

function readSchemeChoice(): SchemeChoice {
  try {
    const raw = globalThis.localStorage?.getItem(SCHEME_KEY)
    return raw === 'dark' || raw === 'light' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(DARK_QUERY).matches
}

/**
 * The viewer's colour scheme: a tenant may supply the default before a viewer chooses.
 * Otherwise follows the system; explicit toggles are persisted in localStorage.
 */
export function useViewerScheme(defaultScheme?: ViewerScheme): {
  scheme: ViewerScheme
  choice: SchemeChoice
  setChoice: (choice: SchemeChoice) => void
} {
  const [choice, setChoiceState] = useState<SchemeChoice>(readSchemeChoice)
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark)
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return
    const media = globalThis.matchMedia(DARK_QUERY)
    const onChange = () => setPrefersDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const setChoice = (next: SchemeChoice) => {
    setChoiceState(next)
    try {
      if (next === 'system') globalThis.localStorage?.removeItem(SCHEME_KEY)
      else globalThis.localStorage?.setItem(SCHEME_KEY, next)
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this visit.
    }
  }
  return { scheme: resolveScheme(choice, prefersDark, defaultScheme), choice, setChoice }
}

/**
 * Mirror the tenant theme onto <body> (and the paper ground plus
 * color-scheme onto <html>, which sits above the wrapper and paints the
 * overscroll). Overlays that portal to document.body render outside the
 * tenant wrapper and would otherwise fall back to the house theme - fonts,
 * shape, density and palette alike. Applied while a tenant layout is
 * mounted, removed when it unmounts, so non-tenant routes keep the neutral
 * defaults.
 */
export function useBodyTheme(branding: Branding | undefined, scheme: ViewerScheme = 'light'): void {
  useEffect(() => {
    if (!branding) return
    const { colorScheme, ...rest } = tenantThemeVars(branding, scheme) as Record<string, string>
    const root = document.documentElement
    const resolved = colorScheme ?? 'light'
    document.body.classList.add('rp-tenant')
    for (const [name, value] of Object.entries(rest)) {
      document.body.style.setProperty(name, value)
    }
    document.body.style.colorScheme = resolved
    root.style.colorScheme = resolved
    const paper = rest['--rp-paper']
    if (paper) root.style.setProperty('--rp-paper', paper)
    return () => {
      document.body.classList.remove('rp-tenant')
      for (const name of Object.keys(rest)) document.body.style.removeProperty(name)
      document.body.style.removeProperty('color-scheme')
      root.style.removeProperty('color-scheme')
      root.style.removeProperty('--rp-paper')
    }
  }, [branding, scheme])
}

export function googleFontsUrl(id: FontPairingId): string {
  return `https://fonts.googleapis.com/css2?${FONT_PAIRINGS[id].googleQuery}&display=swap`
}

/** Idempotently add the stylesheet for one pairing to <head>. */
export function loadPairingFonts(id: FontPairingId): void {
  const elementId = `rp-fonts-${id}`
  if (document.getElementById(elementId)) return
  const link = document.createElement('link')
  link.id = elementId
  link.rel = 'stylesheet'
  link.href = googleFontsUrl(id)
  document.head.appendChild(link)
}

export function customFontCss(headingFontUrl?: string, bodyFontUrl?: string): string {
  const face = (family: string, url: string) =>
    `@font-face{font-family:'${family}';src:url('${url}');font-weight:100 900;font-display:swap;}`
  return [
    headingFontUrl ? face(CUSTOM_HEADING_FAMILY, headingFontUrl) : '',
    bodyFontUrl ? face(CUSTOM_BODY_FAMILY, bodyFontUrl) : '',
  ].filter(Boolean).join('\n')
}

/**
 * Load whatever faces the tenant's typography choice needs: a Google Fonts
 * stylesheet for a pairing, or @font-face rules over the uploaded files for
 * 'custom'. Loaded faces stay in <head> (they are cached; switching back is
 * instant) - only the custom rules are refreshed, since an upload replaces
 * the file behind the same URL.
 */
export function useTenantFonts(branding: Branding | undefined): void {
  const choice = branding?.typography
  const headingFontUrl = branding?.headingFontUrl
  const bodyFontUrl = branding?.bodyFontUrl
  useEffect(() => {
    if (!choice || choice === 'default') return
    if (choice !== 'custom') {
      loadPairingFonts(choice)
      return
    }
    const css = customFontCss(headingFontUrl, bodyFontUrl)
    const existing = document.getElementById('rp-fonts-custom')
    if (existing) {
      if (existing.textContent !== css) existing.textContent = css
      return
    }
    const style = document.createElement('style')
    style.id = 'rp-fonts-custom'
    style.textContent = css
    document.head.appendChild(style)
  }, [choice, headingFontUrl, bodyFontUrl])
}

/** Preload every pairing's faces - the Appearance tab shows live previews of all of them. */
export function useAllPairingFonts(): void {
  useEffect(() => {
    for (const id of PAIRING_IDS) loadPairingFonts(id)
  }, [])
}
