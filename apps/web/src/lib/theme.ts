import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_PALETTES,
  type DensityId,
  FONT_PAIRINGS,
  type FontPairingId,
  FontPairingIdSchema,
  type Palette,
  type ShapeId,
  type TenantConfig,
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

/** The library palette a portal has chosen, or null for its seeded identity. */
export function resolvePalette(branding: Branding): Palette | null {
  const choice = branding.paletteId
  if (!choice || choice === 'default') return null
  return DEFAULT_PALETTES[choice].palette
}

/** 'dark' only when a dark-suite library palette is active. */
export function paletteMode(branding: Branding): 'light' | 'dark' {
  return resolvePalette(branding)?.mode ?? 'light'
}

/**
 * The colour tokens, twelve roles plus the grey suite. With no library
 * palette chosen this derives the role tokens from the portal's seeded
 * four-colour identity exactly as the code used to hardcode them (white on
 * primary and accent, accent doubling as link and focus, washes as mixes),
 * so existing portals render unchanged; the grey suite then stays on the
 * house defaults from the stylesheet.
 */
export function paletteVars(branding: Branding): Record<string, string> {
  const palette = resolvePalette(branding)
  if (!palette) {
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
    ...(palette.mode === 'dark'
      ? {
        ...DARK_STATUS_VARS,
        '--rp-glass-bg': `color-mix(in srgb, ${palette.surface} 92%, transparent)`,
      }
      : {}),
  }
}

/** Every theme var the tenant wrapper sets inline - palette, faces, radii, density. */
export function tenantThemeVars(branding: Branding): CSSProperties {
  return {
    ...paletteVars(branding),
    ...typographyVars(branding),
    ...shapeVars(branding.shape),
    ...densityVars(branding.density),
    colorScheme: paletteMode(branding),
  } as CSSProperties
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
export function useBodyTheme(branding: Branding | undefined): void {
  useEffect(() => {
    if (!branding) return
    const { colorScheme, ...rest } = tenantThemeVars(branding) as Record<string, string>
    const root = document.documentElement
    const scheme = colorScheme ?? 'light'
    document.body.classList.add('rp-tenant')
    for (const [name, value] of Object.entries(rest)) {
      document.body.style.setProperty(name, value)
    }
    document.body.style.colorScheme = scheme
    root.style.colorScheme = scheme
    const paper = rest['--rp-paper']
    if (paper) root.style.setProperty('--rp-paper', paper)
    return () => {
      document.body.classList.remove('rp-tenant')
      for (const name of Object.keys(rest)) document.body.style.removeProperty(name)
      document.body.style.removeProperty('color-scheme')
      root.style.removeProperty('color-scheme')
      root.style.removeProperty('--rp-paper')
    }
  }, [branding])
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
