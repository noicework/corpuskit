import { useId } from 'react'
import { VIEW_MODES, type ViewMode } from './useViewMode.ts'

/**
 * The layout controls a resource listing carries: grid/list and, in grid, how
 * many cards sit across. Both listing pages (the library and the search page's
 * no-query state) render the same listing, so they render these same controls
 * rather than each growing its own take on them.
 *
 * Neither sets its own height - the host passes one so the pair lines up with
 * whatever row it sits in. The library's toolbar is a full 2.25rem control row
 * anchored by a search field; the search page's is a compact chip row.
 */
export function ViewToggle(
  { value, onChange, className = '' }: {
    value: ViewMode
    onChange: (next: ViewMode) => void
    className?: string
  },
) {
  return (
    <div
      className={`inline-flex overflow-hidden rounded-[var(--rp-radius-btn)] border border-line bg-surface ${className}`}
      role='radiogroup'
      aria-label='Result layout'
    >
      {VIEW_MODES.map((option, index) => {
        const active = value === option
        return (
          <button
            key={option}
            type='button'
            role='radio'
            aria-checked={active}
            onClick={() => onChange(option)}
            // The padding lives on the button, never the group: the selected
            // fill has to reach the group's border, and a host that sets a
            // taller group just stretches these to meet it.
            className={`rp-focus px-3 py-1.5 text-xs font-medium capitalize transition-colors duration-150 ${
              index > 0 ? 'border-l border-line' : ''
            } ${
              active
                // The on-primary token, not a literal white: a tenant whose
                // primary is a pale brand colour needs dark type on it.
                ? 'text-[var(--rp-on-primary)]'
                : 'text-[var(--rp-ink-2)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
            }`}
            style={active ? { backgroundColor: 'var(--rp-primary)' } : undefined}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

/**
 * How many cards the grid aims to fit across. Hidden rather than unmounted in
 * list view, where it has nothing to size, so the rest of the toolbar does not
 * shuffle sideways as the layout is toggled.
 */
export function GridDensity(
  { value, onChange, view, className = '' }: {
    value: number
    onChange: (next: number) => void
    view: ViewMode
    className?: string
  },
) {
  const id = useId()
  const hidden = view === 'list' ? 'hidden' : ''
  return (
    <>
      <label htmlFor={id} className={`text-xs font-medium text-ink-3 ${hidden}`}>
        Grid
      </label>
      <input
        id={id}
        type='range'
        min={2}
        max={7}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label='Cards across the grid'
        className={`rp-focus w-24 accent-[var(--rp-primary)] ${className} ${hidden}`}
      />
    </>
  )
}
