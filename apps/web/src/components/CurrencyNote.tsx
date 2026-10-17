import { usePortalLocale } from '../lib/portal-locale.tsx'
import { assessCurrency, type CurrencySource } from '../lib/currency.ts'
import { Calendar } from './icons.tsx'

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
  const { ui } = usePortalLocale()
  const currency = assessCurrency(sources)
  const span = currency.span
  if (!currency.recencyLabel) return null

  return (
    <div className={className}>
      <p className='flex items-center gap-1.5 text-xs text-ink-3'>
        <Calendar size='sm' className='shrink-0' />
        <span className='tabular-nums'>
          {span
            ? ui(
              span.earliest === span.latest
                ? 'Most recent cited source: {latest}'
                : 'Cited sources: {earliest}-{latest}',
              { earliest: span.earliest, latest: span.latest },
            )
            : currency.recencyLabel}
        </span>
      </p>

      {currency.showCaveat && currency.caveatText
        ? (
          <p
            className='mt-2 border-l-2 border-line pl-2.5 text-xs leading-relaxed text-ink-2'
            role='note'
          >
            {ui(
              'This answer draws on sources up to {year} and may not reflect developments since.',
              { year: currency.mostRecentYear ?? '' },
            )}
          </p>
        )
        : null}
    </div>
  )
}
