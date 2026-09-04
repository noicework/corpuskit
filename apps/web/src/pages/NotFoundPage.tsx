import { Link, useParams } from 'react-router-dom'

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
    <div className='mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center'>
      <p className='rp-eyebrow text-ink-3'>Error 404</p>
      <h1 className='mt-3 font-display text-2xl text-ink sm:text-3xl'>Page not found</h1>
      <p className='mt-3 text-sm leading-relaxed text-ink-2'>
        We could not find that page in this portal. It may have moved, or the link you followed may
        be out of date.
      </p>
      <Link to={base} className='rp-btn rp-btn-primary mt-6'>
        Back to Explore
      </Link>
      <div className='mt-8 w-full border-t border-line pt-5'>
        <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
          Or jump to
        </p>
        <div className='mt-3 flex flex-wrap justify-center gap-2'>
          {shortcuts.map((shortcut) => (
            <Link key={shortcut.label} to={shortcut.to} className='rp-chip'>
              {shortcut.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Root-level 404 - a standalone full-screen fallback for paths outside any portal. */
export function RootNotFound() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-app p-6'>
      <div className='rp-card max-w-md p-6 text-center'>
        <p className='rp-eyebrow text-ink-3'>Error 404</p>
        <h1 className='mt-3 font-display text-xl text-ink'>Page not found</h1>
        <p className='mt-2 text-sm text-ink-2'>
          We could not find that page. It may have moved, or the link may be out of date.
        </p>
        <Link to='/' className='rp-btn rp-btn-primary mt-4'>
          Back to portals
        </Link>
      </div>
    </div>
  )
}
