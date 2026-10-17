import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useAccess } from './AccessProvider.tsx'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageSquare, X } from './icons.tsx'
import { IconButton } from './ui.tsx'

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
  const { ui } = usePortalLocale()
  const access = useAccess()
  const location = useLocation()
  const [dismissed, setDismissed] = useState(() => readDismissed(slug))

  // Switching tenants gets its own dismissal state rather than inheriting one.
  useEffect(() => {
    setDismissed(readDismissed(slug))
  }, [slug])

  if (
    !access.can('portal.ask', { kind: 'portal', slug }) || HIDE_ROUTE.test(location.pathname) ||
    dismissed
  ) return null

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
      <IconButton
        icon={X}
        label={ui('Dismiss the Ask button for this session')}
        variant='outline'
        onClick={dismiss}
        className='rp-shadow-md shrink-0 rounded-full'
      />
      <Link
        to={`/t/${slug}/ask`}
        aria-label={ui('Ask a question')}
        className='rp-btn rp-btn-primary rp-btn-lg rp-shadow-lg rp-lift shrink-0 rounded-full'
      >
        <MessageSquare className='shrink-0' />
        <span className='hidden sm:inline'>{ui('Ask a question')}</span>
      </Link>
    </div>
  )
}
