import { type ChangeEvent, type ReactNode, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_PALETTES,
  type DensityId,
  FONT_PAIRINGS,
  type Palette,
  type PaletteChoice,
  PaletteIdSchema,
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
  SHAPE_RADII,
  useAllPairingFonts,
} from '../../lib/theme.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

const MAX_BYTES = 5 * 1024 * 1024

type Branding = TenantConfig['branding']
type ImageKind = 'logo' | 'hero'
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
  passcode,
  kind,
  title,
  guidance,
  onUploaded,
}: {
  slug: string
  passcode: string
  kind: ImageKind
  title: string
  guidance: string
  onUploaded: () => Promise<unknown>
}) {
  const [version, setVersion] = useState(0)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      setMessage({ tone: 'error', text: 'That file is too large - the limit is 5 MB.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await uploadBranding(slug, passcode, kind, file)
      setVersion((v) => v + 1)
      setMissing(false)
      await onUploaded()
      setMessage({ tone: 'ok', text: 'Uploaded - the portal now uses it.' })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not upload that image - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <h4 className='text-sm font-semibold text-ink'>{title}</h4>
      <p className='mt-1 text-xs text-ink-3'>{guidance}</p>

      <div
        style={CHECKERBOARD_STYLE}
        className={`mt-3 overflow-hidden rounded-[var(--rp-radius)] border border-line ${
          kind === 'logo' ? 'flex h-16 items-center justify-center p-2' : 'aspect-[16/6]'
        }`}
      >
        {missing
          ? (
            <div className='flex h-full w-full items-center justify-center text-xs text-ink-3'>
              None uploaded yet
            </div>
          )
          : (
            <img
              key={version}
              src={brandingUrl(slug, kind, version)}
              alt={`${title} preview`}
              onError={() => setMissing(true)}
              className={kind === 'logo'
                ? 'h-full w-auto object-contain'
                : 'h-full w-full object-cover'}
            />
          )}
      </div>

      <label className='rp-btn rp-btn-primary mt-3 cursor-pointer'>
        {busy ? 'Uploading…' : 'Upload…'}
        <input
          type='file'
          accept='image/png,image/jpeg,image/webp,image/svg+xml'
          className='sr-only'
          disabled={busy}
          onChange={(e) => void onChoose(e)}
        />
      </label>

      {message && <MessagePanel message={message} className='mt-3' />}
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
      className={`rp-focus relative rounded-[calc(var(--rp-radius)+4px)] border p-4 text-left transition-colors duration-150 disabled:opacity-60 ${
        selected ? '' : 'border-line hover:bg-surface-2'
      }`}
      style={selected
        ? {
          borderColor: 'var(--rp-accent)',
          backgroundColor: 'color-mix(in srgb, var(--rp-accent) 7%, var(--rp-surface))',
        }
        : undefined}
    >
      {selected && (
        <span
          aria-hidden='true'
          className='absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full text-[var(--rp-on-accent)]'
          style={{ backgroundColor: 'var(--rp-accent)' }}
        >
          <svg
            viewBox='0 0 12 12'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            className='h-3 w-3'
          >
            <path d='M2.5 6.5 5 9l4.5-5.5' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </span>
      )}
      {children}
    </button>
  )
}

/** Miniature of a palette: brand band, hero, then a button/chip/accent strip. */
function PaletteMini({ palette }: { palette: MiniPalette }) {
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
        <span style={{ color: palette.onHero, fontSize: '9px', fontWeight: 700 }}>Aa</span>
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
  passcode,
  branding,
}: {
  slug: string
  passcode: string
  branding: Branding
}) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const selected: PaletteChoice = branding.paletteId ?? 'default'

  const choose = async (paletteId: PaletteChoice, label: string) => {
    if (paletteId === selected) return
    setBusy(true)
    setMessage(null)
    try {
      await updatePortalAppearance(slug, passcode, { paletteId })
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      setMessage({ tone: 'ok', text: `Saved - this portal now uses ${label}.` })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save that choice.') })
    } finally {
      setBusy(false)
    }
  }

  const defaultMini: MiniPalette = {
    band: branding.colours.primary,
    underline: branding.colours.accent,
    heroFrom: branding.colours.heroFrom,
    heroTo: branding.colours.heroTo,
    onHero: '#ffffff',
    paper: '#ffffff',
    wash: `color-mix(in srgb, ${branding.colours.accent} 12%, #ffffff)`,
    chipBorder: branding.colours.accent,
    accent: branding.colours.accent,
  }

  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Colours</h3>
      <p className='mt-1 text-xs text-ink-3'>
        The portal's colour identity - its own brand colours, or a palette from the library. Each
        library palette carries its matching greys; Observatory is a dark interface. Applies as soon
        as you choose.
      </p>

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        <ChoiceTile
          selected={selected === 'default'}
          disabled={busy}
          onSelect={() => void choose('default', 'its own brand colours')}
          label='Portal default colours'
        >
          <PaletteMini palette={defaultMini} />
          <span className='mt-3 block text-sm font-semibold text-ink'>Portal default</span>
          <span className='mt-0.5 block text-xs text-ink-3'>
            This portal's own seeded brand colours.
          </span>
        </ChoiceTile>
        {PaletteIdSchema.options.map((id) => {
          const entry = DEFAULT_PALETTES[id]
          return (
            <ChoiceTile
              key={id}
              selected={selected === id}
              disabled={busy}
              onSelect={() => void choose(id, entry.label)}
              label={`${entry.label} palette`}
            >
              <PaletteMini palette={miniFromLibrary(entry.palette)} />
              <span className='mt-3 block text-sm font-semibold text-ink'>{entry.label}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{entry.description}</span>
            </ChoiceTile>
          )
        })}
      </div>

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
  passcode,
  branding,
}: {
  slug: string
  passcode: string
  branding: Branding
}) {
  useAllPairingFonts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const selected: TypographyChoice = branding.typography ?? 'default'
  const selectedScale: TextScaleId = branding.textScale ?? 'default'

  const save = async (
    input: { typography?: TypographyChoice; textScale?: TextScaleId },
    confirmation: string,
  ) => {
    setBusy(true)
    setMessage(null)
    try {
      await updatePortalAppearance(slug, passcode, input)
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      setMessage({ tone: 'ok', text: confirmation })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save that choice.') })
    } finally {
      setBusy(false)
    }
  }

  const choose = (choice: TypographyChoice, label: string) => {
    if (choice === selected) return
    return save({ typography: choice }, `Saved - this portal now uses ${label}.`)
  }

  const chooseScale = (scale: TextScaleId, label: string) => {
    if (scale === selectedScale) return
    return save({ textScale: scale }, `Saved - text size is now ${label.toLowerCase()}.`)
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
        bodyText: `${bodyFamily} - ${BODY_SAMPLE}`,
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
        bodyText: `${pairing.body.family} - ${BODY_SAMPLE}`,
        bodyStyle: { fontFamily: fontStack(pairing.body.family), fontWeight: pairing.body.weight },
      }
    }),
  ]

  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Typography</h3>
      <p className='mt-1 text-xs text-ink-3'>
        The heading and body faces used across this portal - pick a pairing, or upload your own.
        Applies as soon as you choose.
      </p>

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        {previews.map((option) => (
          <ChoiceTile
            key={option.id}
            selected={selected === option.id}
            disabled={busy}
            onSelect={() => void choose(option.id, option.label)}
            label={`${option.label} typeface pairing`}
          >
            <span className='block truncate pr-6 text-xl text-ink' style={option.headingStyle}>
              {option.headingText}
            </span>
            <span className='rp-clamp-2 mt-1.5 block text-sm text-ink-2' style={option.bodyStyle}>
              {option.bodyText}
            </span>
            <span className='mt-2 block text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-ink-3'>
              {option.id === 'default' ? 'Portal default' : 'Heading & body'}
            </span>
          </ChoiceTile>
        ))}

        <ChoiceTile
          selected={selected === 'custom'}
          disabled={busy}
          onSelect={() => void choose('custom', 'your uploaded fonts')}
          label='Custom uploaded fonts'
        >
          <span
            className='block truncate pr-6 text-xl text-ink'
            style={branding.headingFontUrl
              ? { fontFamily: fontStack(CUSTOM_HEADING_FAMILY) }
              : undefined}
          >
            Custom fonts
          </span>
          <span
            className='rp-clamp-2 mt-1.5 block text-sm text-ink-2'
            style={branding.bodyFontUrl ? { fontFamily: fontStack(CUSTOM_BODY_FAMILY) } : undefined}
          >
            Upload your own heading and body faces.
          </span>
          <span className='mt-2 block text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-ink-3'>
            WOFF2, WOFF, TTF or OTF
          </span>
        </ChoiceTile>
      </div>

      {selected === 'custom' && (
        <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <FontUploadCard
            slug={slug}
            passcode={passcode}
            kind='font-heading'
            title='Heading font'
            uploaded={Boolean(branding.headingFontUrl)}
            previewFamily={CUSTOM_HEADING_FAMILY}
          />
          <FontUploadCard
            slug={slug}
            passcode={passcode}
            kind='font-body'
            title='Body font'
            uploaded={Boolean(branding.bodyFontUrl)}
            previewFamily={CUSTOM_BODY_FAMILY}
          />
        </div>
      )}

      <h4 className='mt-6 text-sm font-semibold text-ink'>Text size</h4>
      <p className='mt-1 text-xs text-ink-3'>
        The base size everything is set against - the whole interface scales with it.
      </p>
      <div className='mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3'>
        {TEXT_SCALE_OPTIONS.map((option) => (
          <ChoiceTile
            key={option.id}
            selected={selectedScale === option.id}
            disabled={busy}
            onSelect={() => void chooseScale(option.id, option.label)}
            label={`${option.label} text size`}
          >
            <span
              aria-hidden='true'
              className='block leading-none text-ink'
              style={{ fontSize: option.previewSize }}
            >
              Aa
            </span>
            <span className='mt-2 block text-sm font-semibold text-ink'>{option.label}</span>
            <span className='mt-0.5 block text-xs text-ink-3'>{option.description}</span>
          </ChoiceTile>
        ))}
      </div>

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
  passcode,
  kind,
  title,
  uploaded,
  previewFamily,
}: {
  slug: string
  passcode: string
  kind: FontKind
  title: string
  uploaded: boolean
  previewFamily: string
}) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      setMessage({ tone: 'error', text: 'That file is too large - the limit is 5 MB.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await uploadBranding(slug, passcode, kind, file)
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      setMessage({ tone: 'ok', text: 'Uploaded - the portal now uses it.' })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not upload that font - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div className='flex items-center justify-between gap-3'>
        <h4 className='text-sm font-semibold text-ink'>{title}</h4>
        <span className={`rp-badge ${uploaded ? 'rp-badge-ok' : 'rp-badge-quiet'}`}>
          {uploaded ? 'In use' : 'None yet'}
        </span>
      </div>
      <p
        className='mt-2 truncate text-2xl text-ink'
        style={uploaded ? { fontFamily: fontStack(previewFamily) } : undefined}
        aria-hidden='true'
      >
        {uploaded ? 'Aa Research knowledge' : 'Awaiting a font file'}
      </p>
      <label className='rp-btn rp-btn-primary mt-3 cursor-pointer'>
        {busy ? 'Uploading…' : 'Upload…'}
        <input
          type='file'
          accept='.woff2,.woff,.ttf,.otf'
          className='sr-only'
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
  passcode,
  branding,
}: {
  slug: string
  passcode: string
  branding: Branding
}) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const selected: ShapeId = branding.shape ?? 'square'

  const choose = async (shape: ShapeId, label: string) => {
    if (shape === selected) return
    setBusy(true)
    setMessage(null)
    try {
      await updatePortalAppearance(slug, passcode, { shape })
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      setMessage({ tone: 'ok', text: `Saved - this portal is now ${label.toLowerCase()}.` })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save that choice.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Shape</h3>
      <p className='mt-1 text-xs text-ink-3'>
        How rounded surfaces, buttons and tags are across the portal. Applies as soon as you choose.
      </p>

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3'>
        {SHAPE_OPTIONS.map((option) => {
          const radii = SHAPE_RADII[option.id]
          return (
            <ChoiceTile
              key={option.id}
              selected={selected === option.id}
              disabled={busy}
              onSelect={() => void choose(option.id, option.label)}
              label={`${option.label} shape`}
            >
              {/* Miniature of a card with a button and a tag in this shape. */}
              <span
                aria-hidden='true'
                className='block border border-line bg-surface p-2.5'
                style={{ borderRadius: radii.surface }}
              >
                <span className='block h-1.5 w-3/5 rounded-[1px] bg-surface-3' />
                <span className='mt-1 block h-1.5 w-2/5 rounded-[1px] bg-surface-3' />
                <span className='mt-2.5 flex items-center gap-1.5'>
                  <span
                    className='block h-5 w-14'
                    style={{ borderRadius: radii.btn, backgroundColor: 'var(--rp-primary)' }}
                  />
                  <span
                    className='block h-5 w-11 border border-line bg-surface-2'
                    style={{ borderRadius: radii.chip }}
                  />
                </span>
              </span>
              <span className='mt-3 block text-sm font-semibold text-ink'>{option.label}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{option.description}</span>
            </ChoiceTile>
          )
        })}
      </div>

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
  passcode,
  branding,
}: {
  slug: string
  passcode: string
  branding: Branding
}) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const selected: DensityId = branding.density ?? 'default'

  const choose = async (density: DensityId, label: string) => {
    if (density === selected) return
    setBusy(true)
    setMessage(null)
    try {
      await updatePortalAppearance(slug, passcode, { density })
      await queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
      setMessage({ tone: 'ok', text: `Saved - density is now ${label.toLowerCase()}.` })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save that choice.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rp-card p-5'>
      <h3 className='text-sm font-semibold text-ink'>Density</h3>
      <p className='mt-1 text-xs text-ink-3'>
        How much air the interface keeps around content. Spacing changes; text size does not.
        Applies as soon as you choose.
      </p>

      <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'>
        {DENSITY_OPTIONS.map((option) => {
          const rhythm = DENSITY_DIALS[option.id].rhythm
          return (
            <ChoiceTile
              key={option.id}
              selected={selected === option.id}
              disabled={busy}
              onSelect={() => void choose(option.id, option.label)}
              label={`${option.label} density`}
            >
              {/* Miniature card whose padding and line rhythm follow the dial. */}
              <span
                aria-hidden='true'
                className='block border border-line bg-surface'
                style={{
                  borderRadius: 'var(--rp-radius)',
                  padding: `${Math.round(10 * rhythm)}px`,
                }}
              >
                {['60%', '40%', '50%'].map((width, index) => (
                  <span
                    key={width}
                    className='block h-1.5 rounded-[1px] bg-surface-3'
                    style={{ width, marginTop: index === 0 ? 0 : `${Math.round(7 * rhythm)}px` }}
                  />
                ))}
              </span>
              <span className='mt-3 block text-sm font-semibold text-ink'>{option.label}</span>
              <span className='mt-0.5 block text-xs text-ink-3'>{option.description}</span>
            </ChoiceTile>
          )
        })}
      </div>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

/**
 * Appearance: the portal's images (logo, hero), typeface pairing, shape
 * language and density. Every choice saves immediately and re-themes the
 * live portal - including this page, which is the fastest possible preview.
 */
export function AppearancePanel({
  slug,
  passcode,
  branding,
}: {
  slug: string
  passcode: string
  branding: Branding
}) {
  const queryClient = useQueryClient()

  const onUploaded = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tenant-config'] }),
      queryClient.invalidateQueries({ queryKey: ['tenants'] }),
    ])

  return (
    <div className='space-y-4'>
      <div className='rp-card p-5'>
        <h3 className='text-sm font-semibold text-ink'>Images</h3>
        <p className='mt-1 text-xs text-ink-3'>
          The logo shown in the header and the photograph behind the portal hero.
        </p>
        <div className='mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <UploadCard
            slug={slug}
            passcode={passcode}
            kind='logo'
            title='Logo'
            guidance='PNG or SVG with transparency works best - shown in the header at 28px tall.'
            onUploaded={onUploaded}
          />
          <UploadCard
            slug={slug}
            passcode={passcode}
            kind='hero'
            title='Hero image'
            guidance='Wide photographic image, at least 1600px - shown behind the portal hero.'
            onUploaded={onUploaded}
          />
        </div>
      </div>

      <ColoursSection slug={slug} passcode={passcode} branding={branding} />
      <TypographySection slug={slug} passcode={passcode} branding={branding} />
      <ShapeSection slug={slug} passcode={passcode} branding={branding} />
      <DensitySection slug={slug} passcode={passcode} branding={branding} />
    </div>
  )
}
