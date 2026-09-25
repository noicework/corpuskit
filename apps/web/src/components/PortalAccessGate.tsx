import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { type Branding, BrandingSchema, DEFAULT_PALETTES } from '@research-portal/core'
import { Link } from 'react-router-dom'
import { useAccess } from './AccessProvider.tsx'
import { externalLoginUrl, microsoftLoginUrl } from '../api/auth.ts'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '../lib/theme.ts'

const safeMetadataSchema = z.object({
  slug: z.string(),
  accessMode: z.enum(['public', 'authenticated', 'restricted']),
  branding: BrandingSchema.pick({
    productName: true,
    organisation: true,
    logoUrl: true,
    colours: true,
    paletteId: true,
  }).extend({ logoUrl: z.string().nullable().optional().transform((value) => value ?? undefined) }),
})
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

export function AccessUnavailable({ failedRead = false }: { failedRead?: boolean }) {
  const { state, slug, identityKey, generation, refresh, controller, safeClient } = useAccess()
  const loading = state.status === 'loading'
  const authorityFailed = state.status === 'unavailable' || failedRead
  // This query retains only the D9 projection. It never stores a full config response.
  const safe = useQuery({
    queryKey: ['safe-portal-metadata', identityKey, slug, generation],
    enabled: !!slug && state.status === 'ready' && !failedRead,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/t/${encodeURIComponent(slug!)}/config`, {
        signal,
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Safe metadata unavailable')
      const value = safeMetadataSchema.parse(await response.json())
      if (value.slug !== slug) throw new Error('Mismatched portal')
      return value
    },
  }, safeClient)
  const failed = authorityFailed || safe.isError
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
    : anonymous && slug
    ? `Sign in to ${name}`
    : slug
    ? `${name} is unavailable`
    : 'This administration page is unavailable.'
  return (
    <div
      className='rp-tenant min-h-screen bg-app text-ink'
      style={branding ? tenantThemeVars(branding, scheme) : undefined}
      data-access-state={loading ? 'loading' : failed ? 'failed' : 'denied'}
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
          {!loading && !failed && anonymous && slug && state.session?.entraEnabled !== false
            ? (
              <a
                className='rp-btn rp-btn-primary whitespace-normal text-center'
                href={microsoftLoginUrl()}
              >
                Sign in with Microsoft
              </a>
            )
            : null}
          {!loading && !failed && anonymous && slug && state.session?.externalLogin
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
