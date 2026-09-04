import type { ReactNode } from 'react'
import type { ResourceType } from '@research-portal/core'

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
  document: 'Report',
  pdf: 'PDF',
  video: 'Video',
  web: 'Web',
}

/** The human label for a resource type, for de-duplicating against kind chips. */
export function typeLabel(type: ResourceType): string {
  return TYPE_LABELS[type]
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
  return (
    <span className='rp-badge rp-badge-quiet'>
      {TYPE_LABELS[type]}
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
  return (
    <div className='rp-card p-5'>
      <div className='flex items-start gap-3'>
        <span
          aria-hidden='true'
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--rp-radius)] bg-[var(--rp-bad-bg)] text-[var(--rp-bad-ink)]'
        >
          <svg viewBox='0 0 20 20' fill='currentColor' className='h-4 w-4'>
            <path
              fillRule='evenodd'
              d='M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.516 2.63H3.72c-1.347 0-2.189-1.463-1.515-2.63zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z'
              clipRule='evenodd'
            />
          </svg>
        </span>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-semibold text-ink'>Something went wrong</p>
          <p className='mt-1 text-sm leading-relaxed text-ink-2'>{message}</p>
          <button type='button' onClick={onRetry} className='rp-btn rp-btn-outline mt-3'>
            Try again
          </button>
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
export function prettyLabel(label: string, organisation?: string): string {
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
