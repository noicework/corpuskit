import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getTypeahead } from '../api/client.ts'

/** One suggestion: a corpus entity to fold into the query, or a resource title. */
export interface TypeaheadItem {
  kind: 'entity' | 'title'
  text: string
}

const MIN_CHARS = 2
const DEBOUNCE_MS = 200
const MAX_ENTITIES = 6
const MAX_TITLES = 5

/** Id for one flattened option, shared between the input's `aria-activedescendant` and the listbox. */
export function typeaheadOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`
}

export interface TypeaheadState {
  open: boolean
  loading: boolean
  entities: string[]
  titles: string[]
  /** Entities then titles, in the order the keyboard walks them. */
  items: TypeaheadItem[]
  highlight: number
  setHighlight: (index: number) => void
  pick: (item: TypeaheadItem) => void
  close: () => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  wrapRef: RefObject<HTMLDivElement>
  /** Id of the listbox element - wire to the input's `aria-controls`. */
  listboxId: string
  /** Id of the highlighted option, or undefined when nothing is highlighted - wire to `aria-activedescendant`. */
  activeDescendant: string | undefined
}

/**
 * Corpus type-ahead: debounced suggestions from the knowledge box, a flattened
 * keyboard walk over both groups, and dismissal on Escape or an outside click.
 * The caller owns the query string and decides what a pick means - entities
 * usually fold back into the input, titles usually navigate.
 *
 * Attach `wrapRef` to the element that wraps both the input and the dropdown,
 * and `onKeyDown` to the input.
 */
export function useTypeahead(
  slug: string,
  query: string,
  onPick: (item: TypeaheadItem) => void,
): TypeaheadState {
  const [entities, setEntities] = useState<string[]>([])
  const [titles, setTitles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [interacted, setInteracted] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>
  const listboxId = useId()

  const trimmed = query.trim()

  // Typing anything reopens the list and drops the previous highlight. The
  // first run (a prefilled input on mount, e.g. ?q=) must NOT count as
  // interaction - the dropdown only opens once the user actually types.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setDismissed(false)
    setInteracted(true)
    setHighlight(-1)
  }, [trimmed])

  useEffect(() => {
    if (trimmed.length < MIN_CHARS) {
      setEntities([])
      setTitles([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      getTypeahead(slug, trimmed)
        .then((result) => {
          if (cancelled) return
          setEntities(result.entities.slice(0, MAX_ENTITIES))
          setTitles(result.titles.slice(0, MAX_TITLES))
        })
        .catch(() => {
          // A failed suggestion lookup is never worth an error state - the
          // reader can still submit what they typed.
          if (cancelled) return
          setEntities([])
          setTitles([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [slug, trimmed])

  const items = useMemo<TypeaheadItem[]>(
    () => [
      ...entities.map((text): TypeaheadItem => ({ kind: 'entity', text })),
      ...titles.map((text): TypeaheadItem => ({ kind: 'title', text })),
    ],
    [entities, titles],
  )

  const open = interacted && !dismissed && trimmed.length >= MIN_CHARS &&
    (loading || items.length > 0)

  const close = useCallback(() => {
    setDismissed(true)
    setHighlight(-1)
  }, [])

  const pick = useCallback(
    (item: TypeaheadItem) => {
      setDismissed(true)
      setHighlight(-1)
      onPick(item)
    },
    [onPick],
  )

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      close()
      return
    }
    if (!open || items.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((prev) => (prev + 1) % items.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((prev) => (prev <= 0 ? items.length - 1 : prev - 1))
      return
    }
    if (event.key === 'Enter') {
      const item = highlight >= 0 ? items[highlight] : undefined
      // No highlight means the reader wants what they typed - let the form submit.
      if (!item) return
      event.preventDefault()
      pick(item)
    }
  }

  return {
    open,
    loading,
    entities,
    titles,
    items,
    highlight,
    setHighlight,
    pick,
    close,
    onKeyDown,
    wrapRef,
    listboxId,
    activeDescendant: highlight >= 0 ? typeaheadOptionId(listboxId, highlight) : undefined,
  }
}

/**
 * The suggestion panel itself - entities as chips, resources as rows. Absolutely
 * positioned, so the element carrying `wrapRef` must be `relative`.
 */
export function TypeaheadDropdown({ state }: { state: TypeaheadState }) {
  const { open, loading, entities, titles, items, highlight, setHighlight, pick, listboxId } = state
  if (!open) return null

  return (
    <div
      id={listboxId}
      className='rp-card rp-anim-fade absolute left-0 right-0 top-full z-40 mt-2 p-2.5 text-left'
      role='listbox'
      aria-label='Suggestions'
    >
      {items.length === 0 && loading
        ? (
          <div className='space-y-2 px-1 py-1'>
            <div
              className='rp-shimmer bg-surface-3 h-4 w-2/5 rounded-[var(--rp-radius)]'
              aria-hidden='true'
            />
            <div
              className='rp-shimmer bg-surface-3 h-4 w-3/5 rounded-[var(--rp-radius)]'
              aria-hidden='true'
            />
          </div>
        )
        : null}

      {entities.length > 0
        ? (
          <div>
            <p className='rp-eyebrow px-1 pb-1.5 text-ink-3'>Entities</p>
            <div className='flex flex-wrap gap-1.5'>
              {entities.map((text, index) => (
                <div
                  key={text}
                  id={typeaheadOptionId(listboxId, index)}
                  role='option'
                  tabIndex={-1}
                  aria-selected={highlight === index}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pick({ kind: 'entity', text })
                  }}
                  className={`rp-chip cursor-pointer ${
                    highlight === index ? 'rp-chip-active' : ''
                  }`}
                >
                  {text}
                </div>
              ))}
            </div>
          </div>
        )
        : null}

      {titles.length > 0
        ? (
          <div className={entities.length > 0 ? 'mt-3 border-t border-line pt-2.5' : ''}>
            <p className='rp-eyebrow px-1 pb-1 text-ink-3'>Resources</p>
            <div className='flex flex-col'>
              {titles.map((text, index) => {
                const flatIndex = entities.length + index
                return (
                  <div
                    key={text}
                    id={typeaheadOptionId(listboxId, flatIndex)}
                    role='option'
                    tabIndex={-1}
                    aria-selected={highlight === flatIndex}
                    onMouseEnter={() => setHighlight(flatIndex)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      pick({ kind: 'title', text })
                    }}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-1.5 py-2 text-left text-sm transition-colors duration-150 ${
                      highlight === flatIndex ? 'bg-surface-2 text-ink' : 'text-ink-2'
                    }`}
                  >
                    <svg
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.6'
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      aria-hidden='true'
                      className='h-3.5 w-3.5 shrink-0 text-ink-3'
                    >
                      <path d='M7 3h7l5 5v13H7zM14 3v5h5' />
                    </svg>
                    <span className='rp-clamp-2 min-w-0'>{text}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
        : null}
    </div>
  )
}
