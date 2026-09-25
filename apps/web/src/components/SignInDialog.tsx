import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TenantConfig } from '@research-portal/core'
import type { AuthUser } from '../api/auth.ts'
import { microsoftLoginUrl } from '../api/auth.ts'
import { useAccess } from './AccessProvider.tsx'
import { roleLabel } from './account-menu-behaviour.ts'

export function SignInDialog({ onClose }: { onClose: () => void; user?: AuthUser | null }) {
  const access = useAccess()
  const portalName =
    useQueryClient().getQueryData<TenantConfig>(['tenant-config', access.slug])?.branding
      .productName ?? access.slug
  const session = access.state.session
  const user = session?.user
  const external = session?.sessionProvenance === 'external' || user?.provenance === 'external'
  const signInAgain = external
    ? session?.externalLogin?.startUrl
    : session?.entraEnabled !== false
    ? microsoftLoginUrl()
    : undefined
  const portalRole = roleLabel(session?.portalAccess?.effectiveRole)
  const platformRole = roleLabel(session?.effectiveRoles.platformRole)
  const sources = [
    ...new Set(
      session?.provenance.filter((entry) =>
        entry.scope.kind === 'platform' || entry.scope.slug === access.slug
      ).map((
        entry,
      ) => ({
        'app-role': 'Entra app role',
        group: 'Entra group',
        local: 'Local assignment',
      }[entry.source])) ?? [],
    ),
  ]
  const claimAge = session?.claimAgeSeconds
  const closeCallback = useRef(onClose)
  closeCallback.current = onClose
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const title = user ? 'Profile' : 'Sign in'
  const summary = user ? 'Your organisation account.' : 'Use your organisation account.'

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeCallback.current()
      }
      if (event.key !== 'Tab') return
      const items = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
      )
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div
      className='rp-anim-fade fixed inset-0 z-50 flex items-center justify-center p-4'
      style={{ backgroundColor: 'rgba(10, 10, 12, 0.55)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='signin-title'
        className='rp-shadow-xl max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-[var(--rp-radius)] bg-surface'
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
            className='rp-btn rp-btn-ghost min-h-11 min-w-11 shrink-0 !px-0'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>

        <div className='px-6 py-6'>
          {user
            ? (
              <div className='break-words'>
                <p className='font-semibold text-ink'>{user.name}</p>
                <p className='mt-1 text-sm text-ink-2'>{user.email}</p>
                <section aria-label='Current access' className='mt-4 space-y-2 text-sm text-ink-2'>
                  {portalRole && (
                    <p>
                      {portalName}: <span className='text-ink'>{portalRole}</span>
                    </p>
                  )}
                  {platformRole && (
                    <p>
                      Platform: <span className='text-ink'>{platformRole}</span>
                    </p>
                  )}
                  {sources.length > 0 && <p>Access source: {sources.join(', ')}</p>}
                  {external && <p>Signed in through the external identity provider.</p>}
                  {!external && (
                    <p>
                      {claimAge == null
                        ? 'Entra claim age unavailable'
                        : `Entra claims checked ${
                          claimAge < 60
                            ? 'less than a minute'
                            : claimAge < 3600
                            ? `${Math.floor(claimAge / 60)} minutes`
                            : `${Math.floor(claimAge / 3600)} hours`
                        } ago.`}
                    </p>
                  )}
                  <p>
                    {!external && 'Entra access updates when you sign in again. '}
                    Local assignments are checked on each request.
                  </p>
                  {signInAgain && (
                    <a
                      href={signInAgain}
                      className='rp-focus text-[var(--rp-accent-fg)] underline'
                    >
                      Sign in again
                    </a>
                  )}
                </section>
                <a
                  href='/auth/logout'
                  onClick={() => access.controller.invalidate('sign out')}
                  className='rp-btn rp-btn-secondary mt-6 w-full'
                >
                  Sign out
                </a>
              </div>
            )
            : (
              <>
                {session?.entraEnabled !== false && (
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
                )}
                {session?.externalLogin && (
                  <a
                    href={session.externalLogin.startUrl}
                    className='rp-btn rp-btn-outline mt-3 w-full whitespace-normal text-center'
                    data-external-login
                  >
                    {session.externalLogin.name}
                  </a>
                )}

                <p className='mt-4 text-sm leading-relaxed text-ink-2'>
                  {access.state.status === 'unavailable'
                    ? 'Access could not be checked.'
                    : 'You will be redirected to your organisation’s sign-in page.'}
                </p>
              </>
            )}
        </div>
      </div>
    </div>
  )
}
