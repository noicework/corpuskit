import { platformBranding } from '../components/PortalAccessGate.tsx'
import { tenantThemeVars, useBodyTheme, useViewerScheme } from '../lib/theme.ts'
import { Link, useParams } from 'react-router-dom'
import { AppLanguageSwitch, usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect } from 'react'
import { ArrowLeft } from '../components/icons.tsx'

// ---------------------------------------------------------------------------
// Not-found pages - the catch-all for any route the app does not recognise.
// Without these, an unmatched path renders an empty <Routes> (a blank screen),
// which is exactly what a stale link, a typo, or someone guessing a URL like
// `/t/{slug}/explore` used to hit. A world-class app answers with a friendly,
// on-brand way back instead.
//
// Two variants: `NotFoundPage` renders inside the tenant layout (so the header
// and portal chrome stay in place, and the links point back into this portal),
// and `RootNotFound` is a standalone full-screen fallback for paths outside any
// tenant.
// ---------------------------------------------------------------------------

/** Tenant-scoped 404 - rendered inside TenantLayout's outlet, keeps the portal chrome. */
export function NotFoundPage() {
  const { ui } = usePortalLocale()
  const { slug } = useParams<{ slug: string }>()
  const base = slug ? `/t/${slug}` : '/'
  const shortcuts = [
    { to: base, label: 'Explore' },
    { to: `${base}/search`, label: 'Search' },
    { to: `${base}/library`, label: 'Library' },
    { to: `${base}/ask`, label: 'Ask' },
    { to: `${base}/help`, label: 'Help' },
  ]

  return (
    <main className='rp-shell flex min-h-[60vh] flex-col items-center justify-center py-8 text-center lg:py-10'>
      <p className='rp-eyebrow text-ink-3'>{ui('Error 404')}</p>
      <h1 className='rp-display mt-3 text-2xl text-ink sm:text-3xl'>{ui('Page not found')}</h1>
      <p className='rp-measure mt-3 text-sm leading-relaxed text-ink-2'>
        {ui(
          'We could not find that page in this portal. It may have moved, or the link you followed may be out of date.',
        )}
      </p>
      <Link to={base} className='rp-btn rp-btn-primary mt-6'>
        <ArrowLeft size='sm' />
        {ui('Back to Explore')}
      </Link>
      <div className='rp-measure mt-6 w-full border-t border-line pt-5 lg:mt-8'>
        <p className='rp-eyebrow text-ink-3'>
          {ui('Or jump to')}
        </p>
        <div className='mt-3 flex flex-wrap justify-center gap-2'>
          {shortcuts.map((shortcut) => (
            <Link key={shortcut.label} to={shortcut.to} className='rp-chip'>
              {ui(shortcut.label)}
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}

/** Root-level 404 - a standalone full-screen fallback for paths outside any portal. */
export function RootNotFound() {
  const { ui } = usePortalLocale()
  useEffect(() => {
    document.title = `${ui('Page not found')} | CorpusKit`
  }, [ui])
  const { scheme } = useViewerScheme()
  useBodyTheme(platformBranding, scheme)
  return (
    <main
      className='rp-tenant flex min-h-screen items-center justify-center bg-app p-6 text-ink'
      style={tenantThemeVars(platformBranding, scheme)}
      data-platform-scheme={scheme}
    >
      <div className='rp-card w-full max-w-xl p-5 text-center lg:p-6'>
        <div className='mb-6 flex justify-center'>
          <AppLanguageSwitch />
        </div>
        <p className='rp-eyebrow text-ink-3'>{ui('Error 404')}</p>
        <h1 className='rp-display mt-3 text-2xl text-ink sm:text-3xl'>{ui('Page not found')}</h1>
        <p className='rp-measure mt-2 text-sm leading-relaxed text-ink-2'>
          {ui('We could not find that page. It may have moved, or the link may be out of date.')}
        </p>
        <Link to='/' className='rp-btn rp-btn-primary mt-6'>
          <ArrowLeft size='sm' />
          {ui('Back to portals')}
        </Link>
      </div>
    </main>
  )
}
