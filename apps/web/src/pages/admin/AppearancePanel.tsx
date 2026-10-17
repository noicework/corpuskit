import { messageFor } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { type ChangeEvent, type ComponentProps, type ReactNode, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  type ColourSchemeId,
  DEFAULT_PALETTES,
  type DensityId,
  FONT_PAIRINGS,
  HOUSE_LIGHT_SUITE,
  type Palette,
  type PaletteChoice,
  pickerPaletteIds,
  type ShapeId,
  type TenantConfig,
  type TextScaleId,
  type TypographyChoice,
} from '@research-portal/core'
import { updatePortalAppearance, uploadBranding } from '../../api/client.ts'
import {
  CUSTOM_BODY_FAMILY,
  CUSTOM_HEADING_FAMILY,
  DENSITY_DIALS,
  fontStack,
  PAIRING_IDS,
  paletteMode,
  paletteVars,
  SHAPE_RADII,
  tenantThemeVars,
  useAllPairingFonts,
} from '../../lib/theme.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { Check, Upload } from '../../components/icons.tsx'

const MAX_BYTES = 5 * 1024 * 1024

function useAppearanceSave(slug: string) {
  const { runExplicit } = usePermissionAdminAccess('appearance.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  return (input: Parameters<typeof updatePortalAppearance>[2], label: string) =>
    runExplicit(label, async (access) => {
      const result = await updatePortalAppearance(slug, access, input)
      assertCurrent()
      if (result?.ok !== true) throw new AdminAccessError()
      return true
    })
}

type Branding = TenantConfig['branding']
type ImageKind = 'logo' | 'logo-dark' | 'hero'
type FontKind = 'font-heading' | 'font-body'

const CHECKERBOARD_STYLE = {
  backgroundImage: 'repeating-conic-gradient(var(--rp-surface-3) 0% 25%, var(--rp-surface) 0% 50%)',
  backgroundSize: '16px 16px',
}

function brandingUrl(slug: string, kind: ImageKind, version: number): string {
  return `/api/t/${encodeURIComponent(slug)}/branding/${kind}?v=${version}`
}

/** One upload card: preview, guidance copy and an "Upload…" pill button. */
function UploadCard({
  slug,
  kind,
  title,
  guidance,
  branding,
  onUploaded,
}: {
  slug: string
  kind: ImageKind
  title: string
  guidance: string
  branding: Branding
  onUploaded: () => Promise<unknown>
}) {
  const { ui } = usePortalLocale()

  const { runExplicit } = usePermissionAdminAccess('appearance.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [version, setVersion] = useState(0)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      setMessage(messageFor('error', ({ ui }) => ui('That file is too large - the limit is 5 MB.')))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const uploaded = await runExplicit(
        ui('Upload {value1} for {slug}', { value1: title.toLowerCase(), slug: slug }),
        async (access) => {
          const result = await uploadBranding(slug, access, kind, file)
          assertCurrent()
          if (result?.ok !== true || typeof result.url !== 'string') throw new AdminAccessError()
          return true
        },
      )
      assertCurrent()
      if (uploaded === undefined) return
      setVersion((v) => v + 1)
      setMissing(false)
      await onUploaded()
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) => ui('Uploaded - the portal now uses it.')))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            errorMessage(err, 'Could not upload that image - please try again.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <div className='min-w-0 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-surface-2 p-4'>
      <h3 className='text-sm font-semibold text-ink'>{title}</h3>
      <p className='mt-1 text-xs text-ink-3'>{guidance}</p>

      {kind === 'hero'
        ? (
          <div
            style={CHECKERBOARD_STYLE}
            className='mt-3 aspect-[16/6] overflow-hidden rounded-[var(--rp-radius)] border border-line'
          >
            {missing
              ? (
                <div className='flex h-full items-center justify-center text-xs text-ink-3'>
                  {ui('None uploaded yet')}
                </div>
              )
              : (
                <img
                  key={version}
                  src={brandingUrl(slug, kind, version)}
                  alt={ui('{title} preview', { title })}
                  onError={() => setMissing(true)}
                  className='h-full w-full object-cover'
                />
              )}
          </div>
        )
        : (
          <LogoHeaderPreview
            key={`${branding.logoUrl}:${branding.logoDarkUrl}:${version}`}
            slug={slug}
            branding={branding}
            scheme={kind === 'logo-dark' ? 'dark' : 'light'}
            version={version}
          />
        )}

      <label className='rp-admin-upload relative rp-btn rp-btn-primary mt-3 cursor-pointer'>
        <Upload size='sm' />
        {busy ? ui('Uploading…') : ui('Upload…')}
        <input
          type='file'
          data-branding-upload={kind}
          accept='image/png,image/jpeg,image/webp'
          className='absolute inset-0 h-full w-full cursor-pointer opacity-0'
          disabled={busy}
          onChange={(e) => void onChoose(e)}
        />
      </label>

      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}

/** Preview the same asset and header ground used by the portal in each scheme. */
export function LogoHeaderPreview({ slug, branding, scheme, version = 0 }: {
  slug: string
  branding: Branding
  scheme: 'light' | 'dark'
  version?: number
}) {
  const { ui } = usePortalLocale()
  const [missing, setMissing] = useState(false)
  const distinctDark = Boolean(branding.logoDarkUrl && branding.logoDarkUrl !== branding.logoUrl)
  const dark = paletteMode(branding, scheme) === 'dark'
  const plate = dark && !distinctDark
  const source = dark && distinctDark ? branding.logoDarkUrl : branding.logoUrl
  // A light preview must not inherit the surrounding page's dark grey suite.
  const previewVars = {
    '--rp-surface': HOUSE_LIGHT_SUITE.surface,
    '--rp-line': HOUSE_LIGHT_SUITE.line,
    '--rp-ink-3': HOUSE_LIGHT_SUITE.ink3,
    ...tenantThemeVars(branding, scheme),
  }
  return (
    <div className='mt-3'>
      <p className='mb-2 text-xs font-medium text-ink-2'>
        {scheme === 'dark' ? ui('Dark header preview') : ui('Light header preview')}
      </p>
      <div
        style={previewVars}
        className='rp-tenant rp-admin-logo-preview flex min-h-24 items-center justify-center overflow-hidden rounded-[var(--rp-radius-btn)] border border-line bg-surface p-3'
      >
        {missing
          ? <span className='text-xs text-ink-3'>{ui('None uploaded yet')}</span>
          : (
            <span className={plate ? 'rp-logo-plate min-w-0' : 'inline-flex min-w-0'}>
              <img
                src={source ??
                  brandingUrl(
                    slug,
                    dark && distinctDark ? 'logo-dark' : 'logo',
                    version,
                  )}
                alt={ui('{title} preview', { title: ui('Logo') })}
                onError={() => setMissing(true)}
                className='rp-admin-logo-image h-auto max-h-10 w-auto max-w-full lg:max-h-16'
                style={branding.logoMaxWidth === undefined
                  ? undefined
                  : { maxWidth: `min(${branding.logoMaxWidth / 16}rem, 100%)` }}
              />
            </span>
          )}
      </div>
      {scheme === 'dark' && (
        <p className='mt-2 text-xs text-ink-3'>
          {distinctDark ? ui('The separate dark logo is shown on the header ground.') : ui(
            'Without a separate dark logo, the light logo is shown on a light plate in dark mode.',
          )}
        </p>
      )}
    </div>
  )
}

/** Selectable option tile shared by the typography and shape pickers. */
function ChoiceTile({
  selected,
  disabled,
  onSelect,
  children,
  label,
}: {
  selected: boolean
  disabled: boolean
  onSelect: () => void
  children: ReactNode
  /** Accessible name for the tile. */
  label: string
}) {
  return (
    <button
      type='button'
      aria-pressed={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      className={`rp-focus relative min-w-0 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border p-4 text-left transition-colors duration-150 disabled:opacity-60 ${
        selected ? '' : 'border-line hover:bg-surface-2'
      }`}
      style={selected
        ? {
          borderColor: 'var(--rp-accent-fg)',
          backgroundColor: 'var(--rp-wash)',
        }
        : undefined}
    >
      {selected && (
        <span
          aria-hidden='true'
          className='absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full text-[var(--rp-on-accent)]'
          style={{ backgroundColor: 'var(--rp-accent)' }}
        >
          <Check size='sm' />
        </span>
      )}
      {children}
    </button>
  )
}

/** Miniature of a palette: brand band, hero, then a button/chip/accent strip. */
function PaletteMini({ palette }: { palette: MiniPalette }) {
  const { ui } = usePortalLocale()

  return (
    <span
      aria-hidden='true'
      className='block overflow-hidden border'
      style={{ borderColor: 'var(--rp-line)', borderRadius: 'var(--rp-radius)' }}
    >
      <span
        className='block h-2.5'
        style={{
          background: palette.band,
          boxShadow: `inset 26px -2px 0 -1px ${palette.underline}`,
        }}
      />
      <span
        className='flex h-10 items-center justify-center'
        style={{ background: `linear-gradient(135deg, ${palette.heroFrom}, ${palette.heroTo})` }}
      >
        <span className='text-2xs font-semibold' style={{ color: palette.onHero }}>{ui('Aa')}</span>
      </span>
      <span className='flex items-center gap-1.5 p-1.5' style={{ background: palette.paper }}>
        <span
          className='block h-3.5 w-9'
          style={{ background: palette.band, borderRadius: 'var(--rp-radius-btn)' }}
        />
        <span
          className='block h-3.5 w-7 border'
          style={{
            background: palette.wash,
            borderColor: palette.chipBorder,
            borderRadius: 'var(--rp-radius-chip)',
          }}
        />
        <span
          className='ml-auto block h-3 w-3 rounded-full'
          style={{ background: palette.accent }}
        />
      </span>
    </span>
  )
}

type MiniPalette = {
  band: string
  underline: string
  heroFrom: string
  heroTo: string
  onHero: string
  paper: string
  wash: string
  chipBorder: string
  accent: string
}

function miniFromLibrary(palette: Palette): MiniPalette {
  return {
    band: palette.brandSurface,
    underline: palette.accent,
    heroFrom: palette.heroFrom,
    heroTo: palette.heroTo,
    onHero: palette.onHero,
    paper: palette.paper,
    wash: palette.accentWash,
    chipBorder: palette.accentForeground,
    accent: palette.accent,
  }
}

function ColoursSection({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()
  const saveAppearance = useAppearanceSave(slug)
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [selected, setSelected] = useState<PaletteChoice>(branding.paletteId ?? 'default')

  const choose = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (!await saveAppearance({ paletteId: selected }, ui('Save portal colours'))) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) => ui('Saved - the portal colours are updated.')))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that choice.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  const ownRoles = paletteVars({ ...branding, paletteId: 'default' }, 'light')
  const defaultMini: MiniPalette = {
    band: branding.colours.primary,
    underline: branding.colours.accent,
    heroFrom: branding.colours.heroFrom,
    heroTo: branding.colours.heroTo,
    onHero: ownRoles['--rp-on-hero']!,
    paper: ownRoles['--rp-logo-plate']!,
    wash: ownRoles['--rp-wash']!,
    chipBorder: ownRoles['--rp-accent-fg']!,
    accent: branding.colours.accent,
  }

  return (
    <div className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={2}
        title={ui('Colours')}
        description={
          <>
            {ui(
              "The portal's colour identity - its own brand colours, or a palette from the library. Each library palette carries its matching greys; Observatory is a dark interface. Choose a preview, then save to apply it.",
            )}
          </>
        }
      />

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        <ChoiceTile
          selected={selected === 'default'}
          disabled={busy}
          onSelect={() => setSelected('default')}
          label={ui('Portal default colours')}
        >
          <PaletteMini palette={defaultMini} />
          <span className='mt-3 block text-sm font-semibold text-ink'>{ui('Portal default')}</span>
          <span className='mt-0.5 block text-xs text-ink-3'>
            {ui("This portal's own seeded brand colours.")}
          </span>
        </ChoiceTile>
        {pickerPaletteIds(branding.paletteId).map((id) => {
          const entry = DEFAULT_PALETTES[id]
          return (
            <ChoiceTile
              key={id}
              selected={selected === id}
              disabled={busy}
              onSelect={() => setSelected(id)}
              label={ui('{label} palette', { label: entry.label })}
            >
              <PaletteMini palette={miniFromLibrary(entry.palette)} />
              <span className='mt-3 block text-sm font-semibold text-ink'>{ui(entry.label)}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{ui(entry.description)}</span>
            </ChoiceTile>
          )
        })}
      </div>

      <Button
        data-appearance-save='colours'
        disabled={busy || ((branding.paletteId ?? 'default') === selected)}
        onClick={() => void choose()}
        className='mt-4'
      >
        {busy ? ui('Saving…') : ui('Save colours')}
      </Button>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

/** The house faces, always loaded via index.html. */
const DEFAULT_HEADING_STACK = fontStack('Inter')
const DEFAULT_BODY_STACK = fontStack('Manrope')

const BODY_SAMPLE = 'Fast, credible answers with cited sources.'

/** Leading family name out of a CSS font stack, for preview labels. */
function firstFamily(stack: string): string {
  return stack.match(/^\s*'([^']+)'/)?.[1] ?? (stack.split(',')[0] ?? stack).trim()
}

function TypographySection({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  useAllPairingFonts()
  const queryClient = useQueryClient()
  const saveAppearance = useAppearanceSave(slug)
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [selected, setSelected] = useState<TypographyChoice>(branding.typography ?? 'default')
  const [selectedScale, setSelectedScale] = useState<TextScaleId>(branding.textScale ?? 'default')

  const save = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (
        !await saveAppearance(
          { typography: selected, textScale: selectedScale },
          'Save portal typography',
        )
      ) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) => ui('Saved - the portal typography is updated.')))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that choice.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  const previews: {
    id: TypographyChoice
    label: string
    headingText: string
    headingStyle: { fontFamily: string; fontWeight: number; letterSpacing: string }
    bodyText: string
    bodyStyle: { fontFamily: string; fontWeight: number }
  }[] = [
    // 'default' is this portal's own default: its seeded brand faces (when a
    // portal seeds its own faces), else the house Inter & Manrope.
    (() => {
      const headingFamily = branding.fonts ? firstFamily(branding.fonts.display) : 'Inter'
      const bodyFamily = branding.fonts ? firstFamily(branding.fonts.sans) : 'Manrope'
      return {
        id: 'default' as TypographyChoice,
        label: headingFamily === bodyFamily ? headingFamily : `${headingFamily} & ${bodyFamily}`,
        headingText: headingFamily,
        headingStyle: {
          fontFamily: branding.fonts?.display ?? DEFAULT_HEADING_STACK,
          fontWeight: 600,
          letterSpacing: '-0.022em',
        },
        bodyText: `${bodyFamily} - ${ui(BODY_SAMPLE)}`,
        bodyStyle: { fontFamily: branding.fonts?.sans ?? DEFAULT_BODY_STACK, fontWeight: 400 },
      }
    })(),
    ...PAIRING_IDS.map((id) => {
      const pairing = FONT_PAIRINGS[id]
      return {
        id: id as TypographyChoice,
        label: pairing.label,
        headingText: pairing.heading.family,
        headingStyle: {
          fontFamily: fontStack(pairing.heading.family),
          fontWeight: pairing.heading.weight,
          letterSpacing: pairing.heading.tracking,
        },
        bodyText: `${pairing.body.family} - ${ui(BODY_SAMPLE)}`,
        bodyStyle: { fontFamily: fontStack(pairing.body.family), fontWeight: pairing.body.weight },
      }
    }),
  ]

  return (
    <div className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={2}
        title={ui('Typography')}
        description={
          <>
            {ui(
              'The heading and body faces used across this portal - pick a pairing, or upload your own. Choose a preview, then save to apply it.',
            )}
          </>
        }
      />

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        {previews.map((option) => (
          <ChoiceTile
            key={option.id}
            selected={selected === option.id}
            disabled={busy}
            onSelect={() => setSelected(option.id)}
            label={ui('{label} typeface pairing', { label: option.label })}
          >
            <span className='block break-words pr-6 text-xl text-ink' style={option.headingStyle}>
              {option.headingText}
            </span>
            <span className='rp-clamp-2 mt-1.5 block text-sm text-ink-2' style={option.bodyStyle}>
              {option.bodyText}
            </span>
            <span className='mt-2 block text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3'>
              {option.id === 'default' ? ui('Portal default') : ui('Heading & body')}
            </span>
          </ChoiceTile>
        ))}

        <ChoiceTile
          selected={selected === 'custom'}
          disabled={busy}
          onSelect={() => setSelected('custom')}
          label={ui('Custom uploaded fonts')}
        >
          <span
            className='block break-words pr-6 text-xl text-ink'
            style={branding.headingFontUrl
              ? { fontFamily: fontStack(CUSTOM_HEADING_FAMILY) }
              : undefined}
          >
            {ui('Custom fonts')}
          </span>
          <span
            className='rp-clamp-2 mt-1.5 block text-sm text-ink-2'
            style={branding.bodyFontUrl ? { fontFamily: fontStack(CUSTOM_BODY_FAMILY) } : undefined}
          >
            {ui('Upload your own heading and body faces.')}
          </span>
          <span className='mt-2 block text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3'>
            {ui('WOFF2, WOFF, TTF or OTF')}
          </span>
        </ChoiceTile>
      </div>

      {selected === 'custom' && (
        <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <FontUploadCard
            slug={slug}
            kind='font-heading'
            title={ui('Heading font')}
            uploaded={Boolean(branding.headingFontUrl)}
            previewFamily={CUSTOM_HEADING_FAMILY}
          />
          <FontUploadCard
            slug={slug}
            kind='font-body'
            title={ui('Body font')}
            uploaded={Boolean(branding.bodyFontUrl)}
            previewFamily={CUSTOM_BODY_FAMILY}
          />
        </div>
      )}

      <h3 className='mt-6 text-sm font-semibold text-ink'>{ui('Text size')}</h3>
      <p className='mt-1 text-xs text-ink-3'>
        {ui('The base size everything is set against - the whole interface scales with it.')}
      </p>
      <div className='mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3'>
        {TEXT_SCALE_OPTIONS.map((option) => (
          <ChoiceTile
            key={option.id}
            selected={selectedScale === option.id}
            disabled={busy}
            onSelect={() => setSelectedScale(option.id)}
            label={ui('{label} text size', { label: ui(option.label) })}
          >
            <span
              aria-hidden='true'
              className='block leading-none text-ink'
              style={{ fontSize: option.previewSize }}
            >
              {ui('Aa')}
            </span>
            <span className='mt-2 block text-sm font-semibold text-ink'>{ui(option.label)}</span>
            <span className='mt-0.5 block text-xs text-ink-3'>{ui(option.description)}</span>
          </ChoiceTile>
        ))}
      </div>

      <Button
        data-appearance-save='typography'
        disabled={busy ||
          ((branding.typography ?? 'default') === selected &&
            (branding.textScale ?? 'default') === selectedScale)}
        onClick={() => void save()}
        className='mt-4'
      >
        {busy ? ui('Saving…') : ui('Save typography')}
      </Button>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

const TEXT_SCALE_OPTIONS: {
  id: TextScaleId
  label: string
  description: string
  previewSize: string
}[] = [
  {
    id: 'smaller',
    label: 'Smaller',
    description: 'A denser read - more on screen.',
    previewSize: '1.5rem',
  },
  { id: 'default', label: 'Default', description: 'The standard size.', previewSize: '1.75rem' },
  {
    id: 'larger',
    label: 'Larger',
    description: 'Easier reading at a distance.',
    previewSize: '2rem',
  },
]

function FontUploadCard({
  slug,
  kind,
  title,
  uploaded,
  previewFamily,
}: {
  slug: string
  kind: FontKind
  title: string
  uploaded: boolean
  previewFamily: string
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()
  const { runExplicit } = usePermissionAdminAccess('appearance.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      setMessage(messageFor('error', ({ ui }) => ui('That file is too large - the limit is 5 MB.')))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const uploaded = await runExplicit(
        ui('Upload {value1} for {slug}', { value1: title.toLowerCase(), slug: slug }),
        async (access) => {
          const result = await uploadBranding(slug, access, kind, file)
          assertCurrent()
          if (result?.ok !== true || typeof result.url !== 'string') throw new AdminAccessError()
          return true
        },
      )
      assertCurrent()
      if (uploaded === undefined) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) => ui('Uploaded - the portal now uses it.')))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) =>
            errorMessage(err, 'Could not upload that font - please try again.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <div className='min-w-0 rounded-[max(0px,calc(var(--rp-radius)-0.25rem))] border border-line bg-surface-2 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h3 className='text-sm font-semibold text-ink'>{title}</h3>
        <span className={`rp-badge shrink-0 ${uploaded ? 'rp-badge-ok' : 'rp-badge-quiet'}`}>
          {uploaded ? ui('In use') : ui('None yet')}
        </span>
      </div>
      <p
        className='mt-2 break-words text-2xl text-ink'
        style={uploaded ? { fontFamily: fontStack(previewFamily) } : undefined}
        aria-hidden='true'
      >
        {uploaded ? ui('Aa Research knowledge') : ui('Awaiting a font file')}
      </p>
      <label className='rp-admin-upload relative rp-btn rp-btn-primary mt-3 cursor-pointer'>
        <Upload size='sm' />
        {busy ? ui('Uploading…') : ui('Upload…')}
        <input
          type='file'
          data-branding-upload={kind}
          accept='.woff2,.woff,.ttf,.otf'
          className='absolute inset-0 h-full w-full cursor-pointer opacity-0'
          disabled={busy}
          onChange={(e) => void onChoose(e)}
        />
      </label>
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}

const SHAPE_OPTIONS: { id: ShapeId; label: string; description: string }[] = [
  { id: 'square', label: 'Square', description: 'Sharp corners everywhere - crisp and editorial.' },
  { id: 'rounded', label: 'Rounded', description: 'Slightly rounded surfaces, buttons and tags.' },
  { id: 'soft', label: 'Soft', description: 'Generous rounding with pill buttons and tags.' },
]

function ShapeSection({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()
  const saveAppearance = useAppearanceSave(slug)
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [selected, setSelected] = useState<ShapeId>(branding.shape ?? 'square')

  const choose = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (!await saveAppearance({ shape: selected }, ui('Save portal shape'))) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) =>
        ui('Saved - this portal is now {selected}.', {
          selected: ui(SHAPE_OPTIONS.find((option) => option.id === selected)!.label),
        })))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that choice.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={2}
        title={ui('Shape')}
        description={
          <>
            {ui(
              'How rounded surfaces, buttons and tags are across the portal. Choose a preview, then save to apply it.',
            )}
          </>
        }
      />

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3'>
        {SHAPE_OPTIONS.map((option) => {
          const radii = SHAPE_RADII[option.id]
          return (
            <ChoiceTile
              key={option.id}
              selected={selected === option.id}
              disabled={busy}
              onSelect={() => setSelected(option.id)}
              label={ui('{label} shape', { label: ui(option.label) })}
            >
              {/* Miniature of a card with a button and a tag in this shape. */}
              <span
                aria-hidden='true'
                className='block border border-line bg-surface p-2.5'
                style={{ borderRadius: radii.surface }}
              >
                <span className='block h-1.5 w-3/5 rounded-[var(--rp-radius-chip)] bg-surface-3' />
                <span className='mt-1 block h-1.5 w-2/5 rounded-[var(--rp-radius-chip)] bg-surface-3' />
                <span className='mt-2.5 flex items-center gap-1.5'>
                  <span
                    className='block h-5 w-14'
                    style={{ borderRadius: radii.btn, backgroundColor: 'var(--rp-control)' }}
                  />
                  <span
                    className='block h-5 w-11 border border-line bg-surface-2'
                    style={{ borderRadius: radii.chip }}
                  />
                </span>
              </span>
              <span className='mt-3 block text-sm font-semibold text-ink'>{ui(option.label)}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{ui(option.description)}</span>
            </ChoiceTile>
          )
        })}
      </div>

      <Button
        data-appearance-save='shape'
        disabled={busy || ((branding.shape ?? 'square') === selected)}
        onClick={() => void choose()}
        className='mt-4'
      >
        {busy ? ui('Saving…') : ui('Save shape')}
      </Button>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

const DENSITY_OPTIONS: { id: DensityId; label: string; description: string }[] = [
  { id: 'compact', label: 'Compact', description: 'More on screen - an analyst’s read.' },
  { id: 'default', label: 'Default', description: 'The standard rhythm.' },
  { id: 'comfortable', label: 'Comfortable', description: 'A touch more air around everything.' },
  { id: 'spacious', label: 'Spacious', description: 'Airy and reading-first.' },
]

function DensitySection({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()
  const saveAppearance = useAppearanceSave(slug)
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [selected, setSelected] = useState<DensityId>(branding.density ?? 'default')

  const choose = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (!await saveAppearance({ density: selected }, ui('Save portal density'))) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(messageFor('ok', ({ ui }) =>
        ui('Saved - density is now {selected}.', {
          selected: ui(DENSITY_OPTIONS.find((option) => option.id === selected)!.label),
        })))
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that choice.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={2}
        title={ui('Density')}
        description={
          <>
            {ui(
              'How much air the interface keeps around content. Spacing changes; text size does not. Choose a preview, then save to apply it.',
            )}
          </>
        }
      />

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'>
        {DENSITY_OPTIONS.map((option) => {
          const rhythm = DENSITY_DIALS[option.id].rhythm
          return (
            <ChoiceTile
              key={option.id}
              selected={selected === option.id}
              disabled={busy}
              onSelect={() => setSelected(option.id)}
              label={ui('{label} density', { label: ui(option.label) })}
            >
              {/* Miniature card whose padding and line rhythm follow the dial. */}
              <span
                aria-hidden='true'
                className='block border border-line bg-surface'
                style={{
                  borderRadius: 'var(--rp-radius)',
                  padding: `${0.625 * rhythm}rem`,
                }}
              >
                {['60%', '40%', '50%'].map((width, index) => (
                  <span
                    key={width}
                    className='block h-1.5 rounded-[var(--rp-radius-chip)] bg-surface-3'
                    style={{ width, marginTop: index === 0 ? 0 : `${0.4375 * rhythm}rem` }}
                  />
                ))}
              </span>
              <span className='mt-3 block text-sm font-semibold text-ink'>{ui(option.label)}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{ui(option.description)}</span>
            </ChoiceTile>
          )
        })}
      </div>

      <Button
        data-appearance-save='density'
        disabled={busy || ((branding.density ?? 'default') === selected)}
        onClick={() => void choose()}
        className='mt-4'
      >
        {busy ? ui('Saving…') : ui('Save density')}
      </Button>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

const COLOUR_SCHEME_OPTIONS: { id: ColourSchemeId; label: string; description: string }[] = [
  {
    id: 'viewer',
    label: 'Light and dark',
    description: 'Follows each viewer’s system setting, with a toggle in the header.',
  },
  {
    id: 'light',
    label: 'Light only',
    description: 'Always light, whatever the viewer’s system prefers. No toggle.',
  },
]

function ColourSchemeSection({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()
  const saveAppearance = useAppearanceSave(slug)
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const current = branding.colourScheme ?? 'viewer'
  const [selected, setSelected] = useState<ColourSchemeId>(current)

  const choose = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (!await saveAppearance({ colourScheme: selected }, ui('Save portal dark mode'))) return
      assertCurrent()
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      assertCurrent()
      setMessage(
        messageFor(
          'ok',
          ({ ui }) =>
            selected === 'light'
              ? ui('Saved - the portal is now light for every viewer.')
              : ui('Saved - viewers can now read the portal in light or dark.'),
        ),
      )
    } catch (err) {
      if (context !== authority.controller.context) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not save that choice.', localError),
        ),
      )
    } finally {
      if (context === authority.controller.context) setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5 lg:p-6'>
      <SectionHeader
        className='rp-admin-section-head'
        headingLevel={2}
        title={ui('Dark mode')}
        description={
          <>
            {ui(
              'Whether viewers may read the portal in dark. Choose an option, then save to apply it.',
            )}
          </>
        }
      />

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
        {COLOUR_SCHEME_OPTIONS.map((option) => (
          <ChoiceTile
            key={option.id}
            selected={selected === option.id}
            disabled={busy}
            onSelect={() => setSelected(option.id)}
            label={ui(option.label)}
          >
            <span className='block text-sm font-semibold text-ink'>{ui(option.label)}</span>
            <span className='mt-0.5 block text-xs text-ink-3'>{ui(option.description)}</span>
          </ChoiceTile>
        ))}
      </div>

      <Button
        data-appearance-save='colour-scheme'
        disabled={busy || current === selected}
        onClick={() => void choose()}
        className='mt-4'
      >
        {busy ? ui('Saving…') : ui('Save dark mode')}
      </Button>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

/**
 * Appearance: the portal's images (logo, hero), typeface pairing, shape
 * language, density and dark mode. Choices stay local until saved. Each upload is a separate explicit request.
 */
function AppearancePanelContent({
  slug,
  branding,
}: {
  slug: string
  branding: Branding
}) {
  const { ui } = usePortalLocale()

  const queryClient = useQueryClient()

  const onUploaded = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tenant-config'] }),
      queryClient.invalidateQueries({ queryKey: ['tenants'] }),
    ])

  return (
    <div className='space-y-6 lg:space-y-8'>
      <div className='rp-card p-5 lg:p-6'>
        <SectionHeader
          className='rp-admin-section-head'
          headingLevel={2}
          title={ui('Images')}
          description={
            <>
              {ui('The logo shown in the header and the photograph behind the portal hero.')}
            </>
          }
        />
        <div className='mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <UploadCard
            slug={slug}
            branding={branding}
            kind='logo'
            title={ui('Logo')}
            guidance={ui(
              'PNG or WebP with transparency works best. Previewed below as it appears in the header.',
            )}
            onUploaded={onUploaded}
          />
          <UploadCard
            slug={slug}
            branding={branding}
            kind='logo-dark'
            title={ui('Logo for dark mode')}
            guidance={ui(
              'Optional. Upload a separate logo designed for dark backgrounds.',
            )}
            onUploaded={onUploaded}
          />
          <UploadCard
            slug={slug}
            branding={branding}
            kind='hero'
            title={ui('Hero image')}
            guidance={ui(
              'Wide photographic image, at least 1600px - shown behind the portal hero.',
            )}
            onUploaded={onUploaded}
          />
        </div>
      </div>

      <ColoursSection slug={slug} branding={branding} />
      <TypographySection slug={slug} branding={branding} />
      <ShapeSection slug={slug} branding={branding} />
      <DensitySection slug={slug} branding={branding} />
      <ColourSchemeSection slug={slug} branding={branding} />
    </div>
  )
}

export function AppearancePanel(props: ComponentProps<typeof AppearancePanelContent>) {
  const authority = useAccess()
  const permission = usePermissionAdminAccess('appearance.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (
    authority.state.status !== 'ready' ||
    (!permission.sessionAllowed && !permission.breakGlassEnabled)
  ) return null
  return <AppearancePanelContent key={`${props.slug}:${authority.generation}`} {...props} />
}
