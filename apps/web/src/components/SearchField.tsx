import type { ChangeEvent, FormEvent } from 'react'

/**
 * The bordered text field a listing page puts at the top of itself: a magnifier
 * glyph, a screen-reader label, and an input that fills the rest of the box.
 *
 * The library and the search page both open on a wall of results, and both need
 * to say what is being looked at and let the reader change it in place - so they
 * render this rather than each growing its own field. (The same reasoning that
 * pulled ViewControls out of the two of them.) On a phone it is the only search
 * box in the product: the header's is `lg:` and up, and the mobile menu has none.
 *
 * The two pages commit an edit differently, which is the one thing this leaves
 * to the host. The library filters a client-side listing as you type, so it
 * passes `onChange` alone and debounces. The search page's query lives in the
 * URL and a search is a round trip, so it passes `onSubmit` too and the box
 * becomes a real search form that Enter (or the phone keyboard's Search key)
 * commits. The host owns the value either way; this only draws it.
 *
 * Sizing: 2.25rem to sit in a control row on the desktop, floored at the 44px
 * touch target below `lg`. That floor is the same one styles.css puts on
 * `.rp-input` for the iOS zoom fix - the input inside here is not an `.rp-input`
 * so it never inherited it, yet it is subject to the same 16px font floor, and a
 * 16px line in a 36px box is a cramped tap target on a phone.
 */
export function SearchField(
  { id, label, value, onChange, onSubmit, placeholder, className = '' }: {
    id: string
    /** Screen-reader label. The field is unlabelled visually - the glyph carries it. */
    label: string
    value: string
    onChange: (next: string) => void
    /** Set on a page whose query is committed rather than applied as you type. */
    onSubmit?: (value: string) => void
    placeholder: string
    /** How the host's row sizes the box - it sets no width of its own. */
    className?: string
  },
) {
  const shell =
    `flex h-[calc(2.25rem*var(--rp-density-ctl,1))] items-center gap-2 rounded-[var(--rp-radius-input)] border border-line bg-surface px-3 max-lg:min-h-11 ${className}`

  const body = (
    <>
      <label htmlFor={id} className='sr-only'>{label}</label>
      <svg
        viewBox='0 0 20 20'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.8'
        strokeLinecap='round'
        aria-hidden='true'
        className='h-4 w-4 shrink-0 text-ink-3'
      >
        <circle cx='9' cy='9' r='5.5' />
        <path d='M13.2 13.2L17 17' />
      </svg>
      <input
        id={id}
        type='text'
        autoComplete='off'
        // Only where there is something to submit: on the library the key does
        // nothing, because the listing has already filtered.
        enterKeyHint={onSubmit ? 'search' : undefined}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        placeholder={placeholder}
        className='min-w-0 flex-1 border-0 bg-transparent text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
      />
    </>
  )

  if (!onSubmit) return <div className={shell}>{body}</div>

  return (
    <form
      role='search'
      className={shell}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      {body}
    </form>
  )
}
