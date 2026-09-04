import { assessCurrency, type CurrencySource } from '../lib/currency.ts'

export interface CurrencyNoteProps {
  /**
   * The sources the answer is actually grounded on (the cited subset for a
   * cited answer, or all grounding sources for a generated artifact). Only
   * their published year is read.
   */
  sources: readonly CurrencySource[]
  /** Optional wrapper classes for spacing within each surface. */
  className?: string
}

/** A small, muted calendar glyph for the always-shown recency line. */
function CalendarGlyph() {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className='h-3.5 w-3.5 shrink-0'
    >
      <rect x='3' y='4.5' width='18' height='16' rx='2' />
      <path d='M3 9h18M8 3v3M16 3v3' />
    </svg>
  )
}

/**
 * The currency / staleness guard, rendered once beneath a grounded answer.
 *
 * Two calibrated parts, both derived purely from the cited sources' years:
 *  - a quiet, always-shown recency line ("Sources: 1971-1998"); and
 *  - a single honest caveat, shown ONLY when the newest cited source is older
 *    than the threshold (see `assessCurrency`).
 *
 * When no cited source carries a year, it renders nothing rather than guessing.
 * Deliberately muted - product honesty, not a nervous legal disclaimer - and
 * theme-token only so it reads correctly in light and dark.
 */
export function CurrencyNote({ sources, className }: CurrencyNoteProps) {
  const currency = assessCurrency(sources)
  if (!currency.recencyLabel) return null

  return (
    <div className={className}>
      <p className='flex items-center gap-1.5 text-xs text-ink-3'>
        <CalendarGlyph />
        <span className='tabular-nums'>{currency.recencyLabel}</span>
      </p>

      {currency.showCaveat && currency.caveatText
        ? (
          <p
            className='mt-2 border-l-2 border-line pl-2.5 text-xs leading-relaxed text-ink-2'
            role='note'
          >
            {currency.caveatText}
          </p>
        )
        : null}
    </div>
  )
}
