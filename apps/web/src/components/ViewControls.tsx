import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useId } from 'react'
import { VIEW_MODES, type ViewMode } from './useViewMode.ts'

/**
 * The layout controls a resource listing carries: grid/list and, in grid, how
 * many cards sit across. Both listing pages (the library and the search page's
 * no-query state) render the same listing, so they render these same controls
 * rather than each growing its own take on them.
 *
 * The shared segment and range classes supply their control heights, including
 * the phone target floor, so callers do not need to impose a fixed height.
 */
export function ViewToggle(
  { value, onChange, className = '' }: {
    value: ViewMode
    onChange: (next: ViewMode) => void
    className?: string
  },
) {
  const { ui } = usePortalLocale()
  return (
    <div
      className={`rp-seg shrink-0 ${className}`}
      role='group'
      aria-label={ui('Result layout')}
    >
      {VIEW_MODES.map((option) => {
        const active = value === option
        return (
          <button
            key={option}
            type='button'
            aria-pressed={active}
            onClick={() => onChange(option)}
            className='rp-seg-item rp-btn-sm capitalize'
          >
            {ui(option)}
          </button>
        )
      })}
    </div>
  )
}

/**
 * How many cards the grid aims to fit across, with a visible label and a range
 * box that remains easy to reach on a phone or with a coarse pointer.
 */
export function GridDensity(
  { value, onChange, view, className = '' }: {
    value: number
    onChange: (next: number) => void
    view: ViewMode
    className?: string
  },
) {
  const { ui } = usePortalLocale()
  const id = useId()
  if (view === 'list') return null
  return (
    <div className={`flex flex-wrap items-center gap-x-2 ${className}`}>
      <label htmlFor={id} className='text-xs font-medium text-ink-3'>
        {ui('Cards across the grid')}
      </label>
      <input
        id={id}
        type='range'
        min={2}
        max={7}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className='rp-focus min-h-[2.75rem] w-24 lg:min-h-6 [@media(pointer:coarse)]:min-h-[2.75rem]'
      />
    </div>
  )
}
