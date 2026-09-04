import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

const DISMISS_KEY_PREFIX = 'rp-chat-fab-dismissed:'

/** Routes where Ask already has its own entry point, so the
 * floating button would be redundant - Ask itself, and search,
 * which now carries its own AI answer panel. */
const HIDE_ROUTE = /\/(ask|search)(\/|$)/

function readDismissed(slug: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY_PREFIX + slug) === '1'
  } catch {
    // Session storage can be unavailable (private browsing, a locked-down
    // policy) - the button just can't remember a dismissal, which is a safe
    // fallback rather than a broken page.
    return false
  }
}

function writeDismissed(slug: string) {
  try {
    sessionStorage.setItem(DISMISS_KEY_PREFIX + slug, '1')
  } catch {
    // Nothing to fall back to - the button simply reappears next visit.
  }
}

/**
 * Floating "Ask a question" action for the browse surfaces, so a reader is
 * always one tap from Ask. Hidden on Ask itself and on
 * search (which already surfaces an AI answer inline), dismissible for the
 * session, and safe-area aware so it never sits under a device's home
 * indicator or a browser chrome overlay on mobile.
 */
export function ChatFab({ slug }: { slug: string }) {
  const location = useLocation()
  const [dismissed, setDismissed] = useState(() => readDismissed(slug))

  // Switching tenants gets its own dismissal state rather than inheriting one.
  useEffect(() => {
    setDismissed(readDismissed(slug))
  }, [slug])

  if (HIDE_ROUTE.test(location.pathname) || dismissed) return null

  function dismiss() {
    writeDismissed(slug)
    setDismissed(true)
  }

  return (
    <div
      className='fixed z-30 flex items-center gap-2'
      style={{
        right: 'max(1rem, env(safe-area-inset-right))',
        bottom: 'max(1.25rem, env(safe-area-inset-bottom))',
      }}
    >
      <button
        type='button'
        onClick={dismiss}
        aria-label='Dismiss the Ask button for this session'
        className='rp-focus rp-shadow-md flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-3 transition-colors duration-150 hover:text-ink'
      >
        <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-3 w-3'>
          <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
        </svg>
      </button>
      <Link
        to={`/t/${slug}/ask`}
        aria-label='Ask a question'
        className='rp-focus rp-shadow-lg rp-lift inline-flex h-12 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold text-[var(--rp-on-primary)] transition-colors duration-150 hover:brightness-110'
        style={{ backgroundColor: 'var(--rp-primary)' }}
      >
        <svg
          viewBox='0 0 20 20'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.7'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
          className='h-5 w-5 shrink-0'
        >
          <path d='M3 4.5h14v9H8.5L5 16.5v-3H3z' />
        </svg>
        <span className='hidden sm:inline'>Ask a question</span>
      </Link>
    </div>
  )
}
