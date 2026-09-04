import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { Question } from '@research-portal/core'

type PaletteOption =
  | { kind: 'search'; text: string }
  | { kind: 'ask'; text: string }
  | { kind: 'suggested'; question: Question }

function optionKey(option: PaletteOption, index: number): string {
  if (option.kind === 'suggested') return `suggested-${option.question.id}`
  return `${option.kind}-${index}`
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The ⌘K palette: search-or-ask over the tenant's corpus. Enter with text
 * typed goes to search results by default (the first option, pre-highlighted);
 * "Ask" hands the same text to the Ask conversation instead; the
 * tenant's suggested questions are always browsable as quick options. Full
 * dialog a11y - focus moves to the input on open and back to the trigger on
 * close, Escape closes, Tab is trapped inside the dialog, and arrow keys walk
 * the option list via the standard combobox/listbox pairing (same pattern as
 * the hero's typeahead).
 */
export function CommandPalette({
  slug,
  suggestedQuestions,
  onClose,
}: {
  slug: string
  suggestedQuestions: Question[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const listboxId = useId()
  const navigate = useNavigate()

  const trimmed = query.trim()

  const options = useMemo<PaletteOption[]>(() => {
    const list: PaletteOption[] = []
    if (trimmed.length > 0) {
      list.push({ kind: 'search', text: trimmed })
      list.push({ kind: 'ask', text: trimmed })
    }
    const pool = trimmed.length === 0
      ? suggestedQuestions
      : suggestedQuestions.filter((question) =>
        question.text.toLowerCase().includes(trimmed.toLowerCase())
      )
    for (const question of pool.slice(0, 6)) {
      list.push({ kind: 'suggested', question })
    }
    return list
  }, [trimmed, suggestedQuestions])

  // Editing the query re-selects the top result, matching the omnibox
  // convention this dialog borrows from; navigating with the arrow keys
  // doesn't touch `query`, so it doesn't fight this reset.
  useEffect(() => {
    setHighlight(trimmed.length > 0 ? 0 : -1)
  }, [trimmed])

  function activate(option: PaletteOption) {
    if (option.kind === 'search') {
      navigate(`/t/${slug}/search?q=${encodeURIComponent(option.text)}`)
    } else if (option.kind === 'ask') {
      navigate(`/t/${slug}/ask?ask=${encodeURIComponent(option.text)}`)
    } else {
      navigate(`/t/${slug}/ask?ask=${encodeURIComponent(option.question.text)}`)
    }
    onClose()
  }

  // Focus the input on open, and give focus back to whatever opened the
  // dialog once it closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => {
      previouslyFocused?.focus()
    }
  }, [])

  // Lock the page behind the dialog.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // Escape closes; Tab is trapped inside the dialog so keyboard focus never
  // escapes to the page behind the backdrop.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const container = dialogRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (options.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((prev) => (prev + 1) % options.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((prev) => (prev <= 0 ? options.length - 1 : prev - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = highlight >= 0 ? options[highlight] : options[0]
      if (chosen) activate(chosen)
    }
  }

  return createPortal(
    <div
      className='rp-anim-fade fixed inset-0 z-[80] flex items-start justify-center bg-neutral-950/60 p-4 pt-[10vh] backdrop-blur-sm'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-label='Search or ask'
        className='rp-card rp-shadow-xl w-full max-w-lg overflow-hidden'
      >
        <div className='flex items-center gap-2.5 border-b border-line px-4 py-3'>
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
          <label htmlFor='command-palette-input' className='sr-only'>
            Search the library or ask a question
          </label>
          <input
            id='command-palette-input'
            ref={inputRef}
            type='text'
            autoComplete='off'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder='Search the library or ask a question'
            role='combobox'
            aria-autocomplete='list'
            aria-expanded={options.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={highlight >= 0 ? `${listboxId}-option-${highlight}` : undefined}
            className='min-w-0 flex-1 border-0 bg-transparent py-1 text-[0.95rem] text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
          />
          <kbd className='rp-badge rp-badge-quiet shrink-0 font-mono text-[10px]'>Esc</kbd>
        </div>

        <ul
          id={listboxId}
          role='listbox'
          aria-label='Quick actions'
          className='max-h-80 overflow-y-auto p-2'
        >
          {options.length === 0
            ? (
              <li className='px-3 py-8 text-center text-sm text-ink-3'>
                Type to search the library, or pick a suggested question below.
              </li>
            )
            : null}

          {options.map((option, index) => (
            <li
              key={optionKey(option, index)}
              id={`${listboxId}-option-${index}`}
              role='option'
              aria-selected={highlight === index}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                activate(option)
              }}
              className={`flex cursor-pointer items-center gap-2.5 rounded-[var(--rp-radius-btn)] px-2.5 py-2.5 text-sm transition-colors duration-150 ${
                highlight === index ? 'bg-surface-2 text-ink' : 'text-ink-2'
              }`}
            >
              {option.kind === 'search'
                ? (
                  <>
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
                    <span className='min-w-0 truncate'>
                      Search for{' '}
                      <span className='font-medium text-ink'>&ldquo;{option.text}&rdquo;</span>
                    </span>
                  </>
                )
                : null}
              {option.kind === 'ask'
                ? (
                  <>
                    <svg
                      viewBox='0 0 20 20'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.8'
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      aria-hidden='true'
                      className='h-4 w-4 shrink-0 text-ink-3'
                    >
                      <path d='M3 4.5h14v9H8.5L5 16.5v-3H3z' />
                    </svg>
                    <span className='min-w-0 truncate'>
                      Ask <span className='font-medium text-ink'>&ldquo;{option.text}&rdquo;</span>
                    </span>
                  </>
                )
                : null}
              {option.kind === 'suggested'
                ? (
                  <>
                    <svg
                      viewBox='0 0 20 20'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.8'
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      aria-hidden='true'
                      className='h-4 w-4 shrink-0 text-ink-3'
                    >
                      <path d='M10 13.5v-1c0-1 .6-1.5 1.2-2 .6-.5 1-1 1-1.9a2.2 2.2 0 10-4.4 0' />
                      <circle cx='10' cy='16' r='0.15' fill='currentColor' />
                    </svg>
                    <span className='rp-clamp-2 min-w-0'>{option.question.text}</span>
                  </>
                )
                : null}
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
