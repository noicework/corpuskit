import { useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { TenantConfig } from '@research-portal/core'
import type { AuthUser } from '../api/auth.ts'
import { externalLoginUrl, microsoftLoginUrl } from '../api/auth.ts'
import { useAccess } from './AccessProvider.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { roleLabel } from './account-menu-behaviour.ts'
import { ArrowRight, Grid2x2, LogOut, X } from './icons.tsx'
import { IconButton } from './ui.tsx'

export function SignInDialog({ onClose }: { onClose: () => void; user?: AuthUser | null }) {
  const { ui, number } = usePortalLocale()
  const access = useAccess()
  const portalName =
    useQueryClient().getQueryData<TenantConfig>(['tenant-config', access.slug])?.branding
      .productName ?? access.slug
  const session = access.state.session
  const user = session?.user
  const external = session?.sessionProvenance === 'external' || user?.provenance === 'external'
  const signInAgain = external
    ? session?.externalLogin && externalLoginUrl(session.externalLogin.startUrl)
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
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const summaryId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const title = user ? ui('Profile') : ui('Sign in')
  const summary = user ? ui('Your organisation account.') : ui('Use your organisation account.')

  useLayoutEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    dialog.showModal()
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
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
      dialog.close()
      document.body.style.overflow = previous
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      className='rp-dialog rp-chrome-signin rp-anim-fade'
      onCancel={(event) => {
        event.preventDefault()
        closeCallback.current()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom
        ) onClose()
      }}
    >
      <div className='flex items-start justify-between gap-4 border-b border-line px-6 py-5'>
        <div className='min-w-0'>
          <h2 id={titleId} className='text-lg font-semibold text-ink'>
            {title}
          </h2>
          <p id={summaryId} className='mt-1 text-sm text-ink-2'>{summary}</p>
        </div>
        <IconButton
          ref={closeRef}
          icon={X}
          label={ui('Close')}
          onClick={onClose}
          className='shrink-0'
        />
      </div>

      <div className='px-6 py-6'>
        {user
          ? (
            <div className='break-words'>
              <p className='font-semibold text-ink'>{user.name}</p>
              <p className='mt-1 text-sm text-ink-2'>{user.email}</p>
              <section
                aria-label={ui('Current access')}
                className='mt-4 space-y-2 text-sm text-ink-2'
              >
                {portalRole && (
                  <p>
                    {portalName}: <span className='text-ink'>{ui(portalRole)}</span>
                  </p>
                )}
                {platformRole && (
                  <p>
                    {ui('Platform')}: <span className='text-ink'>{ui(platformRole)}</span>
                  </p>
                )}
                {sources.length > 0 && (
                  <p>
                    {ui('Access source: {sources}', {
                      sources: sources.map((source) => ui(source)).join(', '),
                    })}
                  </p>
                )}
                {external && <p>{ui('Signed in through the external identity provider.')}</p>}
                {!external && (
                  <p>
                    {claimAge == null
                      ? ui('Entra claim age unavailable')
                      : ui('Entra claims checked {age} ago.', {
                        age: claimAge < 60
                          ? ui('less than a minute')
                          : claimAge < 3600
                          ? ui('{count} minutes', { count: number(Math.floor(claimAge / 60)) })
                          : ui('{count} hours', { count: number(Math.floor(claimAge / 3600)) }),
                      })}
                  </p>
                )}
                <p>
                  {!external && <>{ui('Entra access updates when you sign in again.')}</>}
                  {ui('Local assignments are checked on each request.')}
                </p>
                {signInAgain && (
                  <a
                    href={signInAgain}
                    className='rp-link-standalone'
                  >
                    {ui('Sign in again')}
                    <ArrowRight size='sm' />
                  </a>
                )}
              </section>
              <a
                href='/auth/logout'
                onClick={() => access.controller.invalidate('sign out')}
                className='rp-btn rp-btn-outline mt-6 w-full'
              >
                <LogOut size='sm' />
                {ui('Sign out')}
              </a>
            </div>
          )
          : (
            <>
              {session?.entraEnabled !== false && (
                <a
                  href={microsoftLoginUrl()}
                  className='rp-btn rp-btn-primary rp-btn-lg w-full whitespace-normal text-center'
                >
                  <Grid2x2 className='shrink-0' />
                  {ui('Sign in with Microsoft')}
                </a>
              )}
              {session?.externalLogin && (
                <a
                  href={externalLoginUrl(session.externalLogin.startUrl)}
                  className='rp-btn rp-btn-outline mt-3 w-full whitespace-normal text-center'
                  data-external-login
                >
                  {session.externalLogin.name}
                </a>
              )}

              <p className='mt-4 text-sm leading-relaxed text-ink-2'>
                {access.state.status === 'unavailable'
                  ? ui('Access could not be checked.')
                  : ui('You will be redirected to your organisation’s sign-in page.')}
              </p>
            </>
          )}
      </div>
    </dialog>,
    document.body,
  )
}
