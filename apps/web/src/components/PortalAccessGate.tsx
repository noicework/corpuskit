import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type Branding, DEFAULT_PALETTES } from '@research-portal/core'
import { Link } from 'react-router-dom'
import { useAccess } from './AccessProvider.tsx'
import { externalLoginUrl, microsoftLoginUrl } from '../api/auth.ts'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '../lib/theme.ts'
import { readSafePortalMetadata } from '../api/portal-metadata.ts'

const housePalette = DEFAULT_PALETTES.corpuskit.palette
const houseBranding: Branding = {
  productName: 'CorpusKit',
  organisation: 'CorpusKit',
  tagline: '',
  paletteId: 'corpuskit',
  colours: {
    primary: housePalette.brandSurface,
    accent: housePalette.accent,
    heroFrom: housePalette.heroFrom,
    heroTo: housePalette.heroTo,
  },
}

export function PortalAccessGate({ children }: { children: ReactNode }) {
  const access = useAccess()
  if (access.slug && access.can('portal.read', { kind: 'portal', slug: access.slug })) {
    return children
  }
  return <AccessUnavailable />
}

/** Platform pages also wait for a resolved identity before mounting any queries. */
export function ResolvedAccess({ children }: { children: ReactNode }) {
  const { state } = useAccess()
  return state.status === 'ready' ? children : <AccessUnavailable />
}

export function AccessUnavailable({ failedRead = false, suspended = false }: {
  failedRead?: boolean
  suspended?: boolean
}) {
  const { state, slug, identityKey, generation, refresh, controller, safeClient } = useAccess()
  const loading = state.status === 'loading'
  const authorityFailed = state.status === 'unavailable' || (failedRead && !suspended)
  // This query retains only the D9 projection. It never stores a full config response.
  const safe = useQuery({
    queryKey: ['safe-portal-metadata', identityKey, slug, generation],
    enabled: !!slug && state.status === 'ready' && (!failedRead || suspended),
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/t/${encodeURIComponent(slug!)}/config`, {
        signal,
        cache: 'no-store',
      })
      return readSafePortalMetadata(response, slug!)
    },
  }, safeClient)
  const failed = authorityFailed || safe.isError
  const paused = !loading && !failed && (suspended || safe.data?.status === 'suspended')
  const branding: Branding = safe.data ? { ...safe.data.branding, tagline: '' } : houseBranding
  const { scheme } = useViewerScheme()
  useBodyTheme(branding, scheme)
  const name = safe.data?.branding.productName ?? 'This portal'
  const anonymous = state.session?.authenticated === false
  const heading = useRef<HTMLHeadingElement>(null)
  const [profile, setProfile] = useState(false)
  useEffect(() => {
    heading.current?.focus()
  }, [loading, failed, safe.data])
  const title = loading
    ? 'Checking access...'
    : failed
    ? 'Access could not be checked. Try again.'
    : paused
    ? `${name} is paused`
    : anonymous && slug
    ? `Sign in to ${name}`
    : slug
    ? `${name} is unavailable`
    : 'This administration page is unavailable.'
  return (
    <div
      className='rp-tenant min-h-screen bg-app text-ink'
      style={branding ? tenantThemeVars(branding, scheme) : undefined}
      data-access-state={loading ? 'loading' : failed ? 'failed' : paused ? 'paused' : 'denied'}
      data-safe-metadata={safe.data ? 'ready' : undefined}
    >
      <header className='border-b border-line bg-surface'>
        <div className='rp-shell flex min-w-0 flex-wrap items-center justify-between gap-4 py-4'>
          <a className='rp-focus rp-display text-xl' href='/'>CorpusKit</a>
          {state.session?.user
            ? (
              <div className='flex flex-wrap gap-3'>
                <button
                  type='button'
                  className='rp-btn rp-btn-ghost'
                  onClick={() => setProfile(!profile)}
                  aria-expanded={profile}
                >
                  Profile
                </button>
                <a
                  href='/auth/logout'
                  className='rp-btn rp-btn-ghost'
                  onClick={() => controller.invalidate('sign out')}
                >
                  Sign out
                </a>
              </div>
            )
            : null}
        </div>
      </header>
      <main className='rp-shell min-w-0 py-12'>
        {profile && state.session?.user
          ? (
            <section className='mb-8 break-words' aria-label='Profile'>
              <h2 className='rp-display text-xl'>Your organisation account</h2>
              <p>{state.session.user.email}</p>
            </section>
          )
          : null}
        <h1
          ref={heading}
          tabIndex={-1}
          className='rp-display max-w-[24ch] break-words text-3xl outline-none'
        >
          {title}
        </h1>
        <p className='mt-4 max-w-prose text-ink-2' role='status'>
          {loading
            ? 'Please wait while we check this page.'
            : failed
            ? 'Try again to check your current access.'
            : paused
            ? 'This portal is temporarily paused. Contact your portal administrator for help.'
            : anonymous
            ? 'Use your organisation account to continue.'
            : 'You cannot open this portal with your current account.'}
        </p>
        <div className='mt-6 flex flex-wrap gap-3'>
          {failed
            ? (
              <button
                type='button'
                className='rp-btn rp-btn-primary'
                onClick={() => {
                  void refresh().catch(() => {})
                }}
              >
                Try again
              </button>
            )
            : null}
          {!loading && !failed && !paused && anonymous && slug &&
              state.session?.entraEnabled !== false
            ? (
              <a
                className='rp-btn rp-btn-primary whitespace-normal text-center'
                href={microsoftLoginUrl()}
              >
                Sign in with Microsoft
              </a>
            )
            : null}
          {!loading && !failed && !paused && anonymous && slug && state.session?.externalLogin
            ? (
              <a
                className='rp-btn rp-btn-outline whitespace-normal text-center'
                href={externalLoginUrl(state.session.externalLogin.startUrl)}
                data-external-login
              >
                {state.session.externalLogin.name}
              </a>
            )
            : null}
          <Link className='rp-btn rp-btn-outline' to='/'>Back to portals</Link>
        </div>
      </main>
    </div>
  )
}
