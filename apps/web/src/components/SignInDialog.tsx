import { useEffect, useRef } from 'react'
import type { AuthUser } from '../api/auth.ts'
import { microsoftLoginUrl } from '../api/auth.ts'

export function SignInDialog({ onClose, user }: { onClose: () => void; user?: AuthUser | null }) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const title = user ? 'Profile' : 'Sign in'
  const summary = user ? 'Your organisation account.' : 'Use your organisation account.'

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div
      className='rp-anim-fade fixed inset-0 z-50 flex items-center justify-center p-4'
      style={{ backgroundColor: 'rgba(10, 10, 12, 0.55)' }}
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='signin-title'
        className='rp-shadow-xl w-full max-w-md bg-surface'
        onClick={(event) => event.stopPropagation()}
      >
        <div className='flex items-start justify-between gap-4 border-b border-line px-6 py-5'>
          <div className='min-w-0'>
            <h2 id='signin-title' className='rp-display text-xl text-ink'>
              {title}
            </h2>
            <p className='mt-1 text-sm text-ink-2'>{summary}</p>
          </div>
          <button
            ref={closeRef}
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rp-btn rp-btn-ghost h-9 w-9 shrink-0 !px-0'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>

        <div className='px-6 py-6'>
          {user
            ? (
              <div>
                <p className='font-semibold text-ink'>{user.name}</p>
                <p className='mt-1 text-sm text-ink-2'>{user.email}</p>
                {user.isAdmin
                  ? <span className='rp-badge rp-badge-quiet mt-3'>Administrator</span>
                  : null}
                <a href='/auth/logout' className='rp-btn rp-btn-secondary mt-6 w-full'>
                  Sign out
                </a>
              </div>
            )
            : (
              <>
                <a
                  href={microsoftLoginUrl()}
                  className='rp-focus flex w-full items-center justify-center gap-3 px-5 py-3.5 text-base font-semibold text-[var(--rp-on-primary)] transition-opacity duration-150 hover:opacity-90'
                  style={{ backgroundColor: 'var(--rp-primary)' }}
                >
                  <svg viewBox='0 0 21 21' aria-hidden='true' className='h-5 w-5'>
                    <rect x='0' y='0' width='9.5' height='9.5' fill='#f25022' />
                    <rect x='11.5' y='0' width='9.5' height='9.5' fill='#7fba00' />
                    <rect x='0' y='11.5' width='9.5' height='9.5' fill='#00a4ef' />
                    <rect x='11.5' y='11.5' width='9.5' height='9.5' fill='#ffb900' />
                  </svg>
                  Sign in with Microsoft
                </a>

                <p className='mt-4 text-sm leading-relaxed text-ink-2'>
                  You will be redirected to your organisation's sign-in page. Access is granted by
                  role; if you cannot sign in, ask an administrator to assign you one.
                </p>
              </>
            )}
        </div>
      </div>
    </div>
  )
}
