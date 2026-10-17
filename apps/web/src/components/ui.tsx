import { portalUi } from '../lib/locale-messages.ts'
import { type Locale, usePortalLocale } from '../lib/portal-locale.tsx'
import {
  type ButtonHTMLAttributes,
  type ComponentType,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { isStudyDesignId, type ResourceType, studyDesignLabel } from '@research-portal/core'
import { AlertTriangle, type IconProps, RotateCcw } from './icons.tsx'

const originalUi: Locale['ui'] = (english, values) => portalUi('en', english, values)

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-outline'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  leadingIcon?: ComponentType<IconProps>
  trailingIcon?: ComponentType<IconProps>
}

/** Native button behaviour with the shared size, variant and icon contract. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    leadingIcon: LeadingIcon,
    trailingIcon: TrailingIcon,
    className = '',
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  const iconSize = size === 'lg' ? 'md' : 'sm'
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`rp-btn rp-btn-${variant}${size === 'md' ? '' : ` rp-btn-${size}`} ${className}`
        .trim()}
    >
      {LeadingIcon && <LeadingIcon size={iconSize} />}
      {children}
      {TrailingIcon && <TrailingIcon size={iconSize} />}
    </button>
  )
})

export interface IconButtonProps
  extends Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon' | 'aria-label' | 'title'> {
  label: string
  icon: ComponentType<IconProps>
}

/** An icon-only action always has the same accessible name and hover title. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, variant = 'ghost', size = 'md', className = '', ...props },
  ref,
) {
  if (!label?.trim()) throw new TypeError('IconButton requires a non-empty label')
  return (
    <Button
      {...props}
      ref={ref}
      variant={variant}
      size={size}
      className={`rp-icon-btn ${className}`.trim()}
      aria-label={label}
      title={label}
    >
      <Icon size={size === 'lg' ? 'md' : 'sm'} />
    </Button>
  )
})

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
}

/** Section text and utilities share one responsive header anatomy. */
export function SectionHeader({
  title,
  description,
  actions,
  headingLevel = 2,
  className = '',
  ...props
}: SectionHeaderProps) {
  const Heading = `h${headingLevel}` as `h${1 | 2 | 3 | 4 | 5 | 6}`
  return (
    <div
      {...props}
      className={`rp-section-head flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between ${className}`
        .trim()}
    >
      <div className='rp-section-head-text min-w-0 flex-1'>
        <Heading className='rp-section-title text-base font-semibold'>{title}</Heading>
        {description && (
          <p className='rp-section-desc mt-1 max-w-prose text-sm text-ink-2'>{description}</p>
        )}
      </div>
      {actions && (
        <div className='rp-section-head-actions flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto'>
          {actions}
        </div>
      )}
    </div>
  )
}

/**
 * A placeholder block used across loading states. A travelling shimmer rather
 * than a flat pulse, so a page of skeletons reads as one loading surface. The
 * surface token rides over the shimmer's own fill so it holds up in dark mode.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rp-shimmer bg-surface-3 rounded-[var(--rp-radius)] ${className}`}
      aria-hidden='true'
    />
  )
}

const TYPE_LABELS: Record<ResourceType, string> = {
  document: 'Document',
  pdf: 'PDF',
  video: 'Video',
  web: 'Web',
}

/** The human label for a resource type, for de-duplicating against kind chips. */
export function typeLabel(type: ResourceType, ui: Locale['ui'] = originalUi): string {
  return ui(TYPE_LABELS[type])
}

/** Whether two chip labels say the same thing, ignoring case and separators. */
export function sameLabel(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[_\-\s]+/g, ' ').trim()
  return norm(a) === norm(b)
}

/**
 * Small square badge showing the resource type. Deliberately monochrome: type
 * is a category, not a status, so it stays out of the ok/warn/bad palette and
 * reads the same in either theme.
 */
export function TypeBadge({ type }: { type: ResourceType }) {
  const { ui } = usePortalLocale()
  return (
    <span className='rp-badge rp-badge-quiet'>
      {typeLabel(type, ui)}
    </span>
  )
}

/** Inline error state with a retry action, used wherever a query can fail. */
export function ErrorCard({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { ui, error } = usePortalLocale()
  return (
    <div className='rp-card p-5'>
      <div className='flex items-start gap-3'>
        <span
          aria-hidden='true'
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--rp-radius)] bg-[var(--rp-bad-bg)] text-[var(--rp-bad-ink)]'
        >
          <AlertTriangle size='sm' />
        </span>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-semibold text-ink'>{ui('Something went wrong')}</p>
          <p className='mt-1 text-sm leading-relaxed text-ink-2'>
            {error(message, 'Something went wrong')}
          </p>
          <Button variant='outline' leadingIcon={RotateCcw} onClick={onRetry} className='mt-3'>
            {ui('Try again')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Honest empty state - message plus optional supporting content (e.g. suggestions). */
export function EmptyState(
  { title, description, children }: { title: string; description?: string; children?: ReactNode },
) {
  return (
    <div className='rounded-[var(--rp-radius)] border border-dashed border-line bg-surface-2 p-6'>
      <p className='text-sm font-semibold text-ink'>{title}</p>
      {description
        ? <p className='mt-1 max-w-xl text-sm leading-relaxed text-ink-2'>{description}</p>
        : null}
      {children ? <div className='mt-4'>{children}</div> : null}
    </div>
  )
}

/** Minimal live region for status announcements - render with an empty message while idle. */
export function LiveStatus({ message }: { message: string }) {
  return (
    <div aria-live='polite' role='status' className='sr-only'>
      {message}
    </div>
  )
}

/**
 * Human title for a platform label that may be stored as a slug
 * ("swri-network" -> "SWRI Network"). Real display titles pass through
 * untouched; the organisation name supplies the acronym to uppercase.
 */
export function prettyLabel(
  label: string,
  organisation?: string,
  ui: Locale['ui'] = originalUi,
): string {
  // A study design (the kind a research article carries) has its own wording.
  if (isStudyDesignId(label)) return ui(studyDesignLabel(label))
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(label)) return label
  const acronym = (organisation ?? '')
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .join('')
    .toLowerCase()
  return label
    .split('-')
    .map((w) => (w === acronym ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Export confirmation. Every download in the portal (the Ask trail, an
// investigation, a generated artefact) confirms itself the same way: a short
// status line naming the file, announced to assistive technology, that
// clears itself after a few seconds.
// ---------------------------------------------------------------------------

/** The notice text for a saved file: "Saved <name> (Word document)". */
export function savedFileNotice(
  fileName: string,
  format: string,
  ui: Locale['ui'] = originalUi,
): string {
  return ui('Saved {name} ({format})', { name: fileName, format })
}

/** State for an export confirmation: `announce` shows a notice, which clears itself. */
export function useExportNotice(clearAfterMs = 5000): {
  notice: string | null
  announce: (text: string) => void
} {
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const announce = useCallback((text: string) => {
    setNotice(text)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(null), clearAfterMs)
  }, [clearAfterMs])
  return { notice, announce }
}

/** The confirmation line itself; renders nothing while there is no notice. */
export function ExportNotice(
  { notice, className = '' }: { notice: string | null; className?: string },
) {
  if (!notice) return null
  return <span role='status' className={`text-xs text-ink-3 ${className}`}>{notice}</span>
}
