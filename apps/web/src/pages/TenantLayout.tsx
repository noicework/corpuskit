import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'
import { tenantThemeVars, useBodyTheme, useTenantFonts, useTextScale } from '../lib/theme.ts'
import { CommandPalette } from '../components/CommandPalette.tsx'
import { AccountMenu } from '../components/AccountMenu.tsx'
import { KbSwitcher } from '../components/KbSwitcher.tsx'
import { PortalFooter } from '../components/PortalFooter.tsx'
import { SignInDialog } from '../components/SignInDialog.tsx'
import { getAuthSession } from '../api/auth.ts'

export type TenantOutletContext = {
  config: TenantConfig
}

function FullPageSpinner() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-app' role='status'>
      <div
        className='h-9 w-9 animate-spin rounded-full border-2 border-line'
        style={{ borderTopColor: 'var(--rp-ink)' }}
        aria-hidden='true'
      />
      <span className='sr-only'>Loading portal</span>
    </div>
  )
}

// Explore is reached by the logo and Help by its own icon.
const NAV_ITEMS: { path: string; label: string; end: boolean }[] = [
  { path: '/library', label: 'Library', end: false },
  { path: '/ask', label: 'Ask', end: false },
  { path: '/graph', label: 'Graph', end: false },
  { path: '/tools', label: 'Tools', end: false },
]

// The phone sheet lists the same four destinations as the desktop nav band.
const MOBILE_NAV_ITEMS: { path: string; label: string; end: boolean }[] = [
  ...NAV_ITEMS,
]

// One name each for the help and account controls, read by both the header
// icons and the phone sheet's rows so the two surfaces cannot drift apart. The
const HELP_LABEL = 'Help'
const ACCOUNT_LABEL = 'My account'

function HelpIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={className}
      aria-hidden='true'
    >
      <circle cx='12' cy='12' r='9' />
      <path d='M9.4 9.2a2.7 2.7 0 015.2.9c0 1.8-2.6 2.4-2.6 4' />
      <path d='M12 17.4h.01' />
    </svg>
  )
}

/**
 * The menu trigger's three bars, which rotate and translate into the cross
 * rather than cross-fading to a second icon. Every state lives in
 * `.rp-navtoggle-bar` in styles.css, keyed off the button's own
 * `aria-expanded`, so the drawn state and the announced state cannot disagree.
 */
function MenuBars() {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      className='h-6 w-6'
      aria-hidden='true'
    >
      <path className='rp-navtoggle-bar rp-navtoggle-bar-top' d='M4 7h16' />
      <path className='rp-navtoggle-bar rp-navtoggle-bar-mid' d='M4 12h16' />
      <path className='rp-navtoggle-bar rp-navtoggle-bar-bot' d='M4 17h16' />
    </svg>
  )
}

/** Anything the sheet's focus cycle should stop on. */
const NAV_FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function TenantLayout() {
  const { slug } = useParams<{ slug: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)
  // The sheet outlives `navOpen` by the length of its exit, so the panel, the
  // scrim and the rows can animate away and the trigger can morph back from the
  // cross instead of the whole thing being ripped out of the DOM mid-gesture.
  const [navMounted, setNavMounted] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const [headerQuery, setHeaderQuery] = useState('')
  const [signInOpen, setSignInOpen] = useState(false)
  const { data: auth } = useQuery({
    queryKey: ['auth-session'],
    queryFn: getAuthSession,
    staleTime: 60_000,
    retry: false,
  })
  const accountLabel = auth?.user?.name || ACCOUNT_LABEL
  const accountIsAdmin = auth?.user?.isAdmin === true
  const headerRef = useRef<HTMLElement | null>(null)
  const navPanelRef = useRef<HTMLElement | null>(null)
  const navTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Set only by the deliberate close paths (the trigger, Escape, the scrim).
  // Following a link closes the sheet too, and there the new page should keep
  // the focus rather than have it yanked back up to the header.
  const navRestoreFocus = useRef(false)

  // Cmd/Ctrl+K opens the search-or-ask palette from anywhere in the portal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  // The mobile nav sheet closes on navigation, on Escape, and locks page
  // scroll behind it while open. Following a link is not a deliberate dismissal,
  // so the focus stays with the page that was just opened.
  useEffect(() => {
    navRestoreFocus.current = false
    setNavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    globalThis.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
  }, [location.pathname, location.search])

  // The palette closes itself once it navigates - this only catches a route
  // change from elsewhere (e.g. browser back) while it happens to be open.
  useEffect(() => {
    setPaletteOpen(false)
  }, [location.pathname])

  // Escape closes, and Tab is held inside the sheet. The trigger sits in the
  // header rather than in the panel - it is the sheet's own close control now
  // that it morphs into the cross - so it joins the front of the cycle instead
  // of being tabbed past into the page underneath.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        navRestoreFocus.current = true
        setNavOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const panel = navPanelRef.current
      const trigger = navTriggerRef.current
      if (!panel || !trigger) return
      const stops = [trigger, ...panel.querySelectorAll<HTMLElement>(NAV_FOCUSABLE)]
      const index = stops.indexOf(document.activeElement as HTMLElement)
      if (index === -1) {
        event.preventDefault()
        stops[0]?.focus()
        return
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault()
        stops[stops.length - 1]?.focus()
      } else if (!event.shiftKey && index === stops.length - 1) {
        event.preventDefault()
        stops[0]?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  // Opening moves the focus to the first destination in the sheet.
  useEffect(() => {
    if (!navOpen) return
    navPanelRef.current?.querySelector<HTMLElement>(NAV_FOCUSABLE)?.focus()
  }, [navOpen])

  // The exit: hand the focus back before anything is unmounted, then hold the
  // sheet in the DOM for exactly as long as its animations run. Under reduced
  // motion there are none, so it goes immediately.
  useEffect(() => {
    if (navOpen || !navMounted) return
    if (navRestoreFocus.current) {
      navRestoreFocus.current = false
      navTriggerRef.current?.focus()
    }
    const timer = setTimeout(() => setNavMounted(false), prefersReducedMotion() ? 0 : 220)
    return () => clearTimeout(timer)
  }, [navOpen, navMounted])

  // The sheet is a phone control. Crossing to the desktop breakpoint with it
  // open would otherwise leave the body scroll locked behind a hidden panel.
  useEffect(() => {
    if (!navMounted) return
    const query = globalThis.matchMedia('(min-width: 768px)')
    const sync = () => {
      if (!query.matches) return
      navRestoreFocus.current = false
      setNavOpen(false)
    }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [navMounted])

  useEffect(() => {
    if (!navMounted) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [navMounted])
  const {
    data: config,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug ?? ''),
    enabled: Boolean(slug),
  })
  // Routes whose page owns the full viewport height.
  const isViewportHeightRoute = /\/(ask|graph)(\/|$)/.test(location.pathname)

  const { data: kbStatus } = useQuery({
    queryKey: ['kb-status', slug],
    queryFn: () => getKnowledgeBoxStatus(slug ?? ''),
    enabled: Boolean(slug),
  })

  // The header is two-tier and its height changes with the breakpoint, so full
  // -height pages read it from a custom property instead of guessing.
  useEffect(() => {
    const element = headerRef.current
    if (!element) return
    const apply = () => {
      document.documentElement.style.setProperty(
        '--rp-header-h',
        `${Math.round(element.getBoundingClientRect().height)}px`,
      )
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
    // Keyed on config: the header does not exist on the first render (the
    // layout shows a spinner while the tenant loads), so a mount-only effect
    // would attach to nothing and never set the property.
  }, [config])

  useEffect(() => {
    if (config) {
      const surface = /\/ask(?:\/|$)/.test(location.pathname)
        ? 'Ask'
        : /\/tools(?:\/|$)/.test(location.pathname)
        ? 'Tools'
        : null
      document.title = surface
        ? `${surface} | ${config.branding.productName}`
        : config.branding.productName
    }
    return () => {
      document.title = 'Research Portal'
    }
  }, [config, location.pathname])

  // Load the faces for the tenant's typography choice, apply its text scale,
  // and mirror the theme onto <body> so portaled overlays follow it too (all
  // no-ops until the config loads).
  useTenantFonts(config?.branding)
  useTextScale(config?.branding)
  useBodyTheme(config?.branding)

  if (isLoading) {
    return <FullPageSpinner />
  }

  if (isError || !config) {
    const notFound = error instanceof ApiError && error.status === 404

    return (
      <main className='flex min-h-screen flex-col items-center justify-center bg-app px-6 text-center'>
        <h1 className='rp-display text-3xl text-ink'>
          {notFound ? 'This portal does not exist' : 'Something went wrong'}
        </h1>
        <p className='mt-3 max-w-sm text-sm leading-relaxed text-ink-2'>
          {notFound
            ? 'Check the address, or head back and choose a portal from the list.'
            : error instanceof Error
            ? error.message
            : 'We could not load this portal right now.'}
        </p>
        <Link to='/' className='rp-btn rp-btn-primary mt-6'>
          Back to portals
        </Link>
      </main>
    )
  }

  // Links sit on the solid brand band, so the active state is white type over
  // an accent underline (see .rp-navlink in styles.css) rather than the accent
  // wash the old light-background header used.
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rp-navlink${isActive ? ' rp-navlink-active' : ''}`

  return (
    <div
      className='rp-tenant min-h-screen bg-app'
      style={tenantThemeVars(config.branding)}
    >
      {
        /* Two-tier header: a white strip carrying the logo, over a solid
        * brand-colour band carrying the navigation. */
      }
      <header ref={headerRef} className='sticky top-0 z-40'>
        <div className='border-b border-line bg-surface'>
          {
            /* Below `sm` the row may wrap, and the wordmark keeps a 10rem
            * floor. A portal with no uploaded logo falls back to its product
            * name here, and the floor is in rem so it grows with the reader's
            * text size: at a 22px root font the three round controls alone eat
            * most of a 390px row, and without the floor the name was squeezed
            * into a 38px column and clipped to one letter a line. When the two
            * no longer fit, the controls take their own line instead. */
          }
          <div className='rp-shell flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap sm:gap-6'>
            <div className='flex min-w-[10rem] flex-1 items-center gap-2 sm:min-w-0'>
              <Link
                to={`/t/${config.slug}`}
                className='rp-focus flex min-w-0 items-center gap-3 rounded-[var(--rp-radius-btn)]'
              >
                {config.branding.logoUrl && !logoFailed
                  ? (
                    <img
                      src={config.branding.logoUrl}
                      alt={config.branding.organisation}
                      onError={() => setLogoFailed(true)}
                      // Tenant logos vary wildly in aspect ratio (a wordmark
                      // with a tagline under it can be 4:1 while a compact
                      // wordmark is closer to 2:1), so a fixed height alone
                      // decides nothing about how much of a phone row the logo
                      // eats. Below `sm` it is boxed by BOTH a max
                      // width and a max height and left free to pick its own
                      // height, so every tenant fits the same slot without being
                      // letterboxed. `min-w-0` is the real overlap guard: an
                      // image is a flex item whose automatic minimum size is its
                      // intrinsic width, so without it the logo refuses to
                      // shrink and simply paints over its neighbours. Desktop is
                      // untouched - `sm:` restores h-16 with the 20rem cap.
                      className='h-auto max-h-10 w-auto min-w-0 max-w-[9rem] object-contain sm:h-16 sm:max-h-none sm:max-w-[20rem]'
                    />
                  )
                  : (
                    <span className='rp-display truncate text-lg text-ink sm:text-xl'>
                      {config.branding.productName}
                    </span>
                  )}
              </Link>
              {
                /* Portal switcher, beside the logo - each portal is its own
                * knowledge box, content and branding. */
              }
              <KbSwitcher config={config} />
            </div>
            {
              /* Header search, centred and full-measure: it is the only search
              * box in the product now, so it carries the weight. */
            }
            <div className='hidden w-[min(40rem,42vw)] shrink-0 items-center lg:flex'>
              <form
                role='search'
                onSubmit={(event) => {
                  event.preventDefault()
                  const trimmed = headerQuery.trim()
                  if (!trimmed) return
                  navigate(`/t/${config.slug}/search?q=${encodeURIComponent(trimmed)}`)
                  setHeaderQuery('')
                }}
                className='flex w-full items-center'
              >
                <label htmlFor='header-search' className='sr-only'>
                  Search {config.branding.productName}
                </label>
                <input
                  id='header-search'
                  type='search'
                  value={headerQuery}
                  onChange={(event) => setHeaderQuery(event.target.value)}
                  placeholder={config.searchPlaceholder}
                  className='rp-input rp-input-flush-end h-[calc(3rem*var(--rp-density-ctl,1))] min-w-0 flex-1 text-base'
                />
                <button
                  type='submit'
                  aria-label='Search'
                  className='rp-focus flex h-[calc(3rem*var(--rp-density-ctl,1))] w-[calc(3rem*var(--rp-density-ctl,1))] shrink-0 items-center justify-center rounded-e-[var(--rp-radius-input)] border border-l-0 transition-colors duration-150'
                  style={{
                    borderColor: 'var(--rp-line)',
                    color: 'var(--rp-primary)',
                  }}
                >
                  <svg
                    viewBox='0 0 20 20'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.8'
                    strokeLinecap='round'
                    className='h-5 w-5'
                    aria-hidden='true'
                  >
                    <circle cx='9' cy='9' r='5.5' />
                    <path d='M13.2 13.2 17 17' />
                  </svg>
                </button>
              </form>
            </div>

            {
              /* Below `sm` this cluster takes exactly the width its buttons
              * need, so the rest of the row belongs to the logo. `flex-1` from
              * `sm` up restores the even three-way split that keeps the desktop
              * search box optically centred. */
            }
            <div className='ml-auto flex flex-none items-center justify-end gap-2 sm:flex-1'>
              {kbStatus?.status === 'none' && (
                <span className='hidden shrink-0 lg:block'>
                  <Link to='/admin' className='rp-badge rp-badge-quiet rp-focus'>
                    Not connected
                  </Link>
                </span>
              )}
              <Link
                to={`/t/${config.slug}/help`}
                aria-label={HELP_LABEL}
                title={HELP_LABEL}
                className='rp-focus flex h-[calc(2.75rem*var(--rp-density-ctl,1))] w-[calc(2.75rem*var(--rp-density-ctl,1))] shrink-0 items-center justify-center rounded-full border transition-colors duration-150'
                style={{
                  borderColor: 'color-mix(in srgb, var(--rp-primary) 25%, transparent)',
                  color: 'var(--rp-primary)',
                }}
              >
                <HelpIcon className='h-6 w-6' />
              </Link>
              <AccountMenu
                isAdmin={accountIsAdmin}
                label={accountLabel}
                manageHref='/admin'
                onProfile={() => setSignInOpen(true)}
              />
              {
                /* Wrapped, because .rp-navtoggle sets its own display and would
                * beat a `md:hidden` utility on the button itself - component
                * classes in styles.css are unlayered and win over Tailwind's
                * utility layer no matter what the class list says. That is
                * exactly why this control used to show next to the full desktop
                * nav. The toggle is sized to match the help and account buttons
                * beside it rather than being scaled up on its own, so the three
                * read as one 44px cluster. */
              }
              <span className='md:hidden'>
                <button
                  ref={navTriggerRef}
                  type='button'
                  onClick={() => {
                    if (navOpen) {
                      navRestoreFocus.current = true
                      setNavOpen(false)
                      return
                    }
                    setNavMounted(true)
                    setNavOpen(true)
                  }}
                  aria-label={navOpen ? 'Close menu' : 'Open menu'}
                  aria-expanded={navOpen}
                  aria-controls='mobile-nav-sheet'
                  className='rp-navtoggle rp-focus'
                >
                  <MenuBars />
                </button>
              </span>
            </div>
          </div>
        </div>

        <div className='rp-navband relative hidden md:block'>
          <div className='rp-shell'>
            <nav
              aria-label='Primary'
              className='rp-no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap'
            >
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.label}
                  to={`/t/${config.slug}${item.path}`}
                  end={item.end}
                  className={navLinkClass}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      </header>

      {
        /* The phone menu. It hangs from under the header rather than covering
        * it, which is what lets the trigger stay put and morph into the cross
        * in place, and leaves a real scrim over the page below. Both layers
        * carry `md:hidden` and neither animation class sets `display`, so the
        * utility is unopposed - verified on the computed style at 1440px. */
      }
      {navMounted && (
        <div className='md:hidden'>
          <div
            aria-hidden='true'
            onClick={() => {
              navRestoreFocus.current = true
              setNavOpen(false)
            }}
            className={`fixed inset-x-0 bottom-0 z-50 ${
              navOpen ? 'rp-navsheet-scrim' : 'rp-navsheet-scrim rp-navsheet-scrim-exit'
            }`}
            style={{ top: 'var(--rp-header-h, 4rem)' }}
          />
          <nav
            id='mobile-nav-sheet'
            ref={navPanelRef}
            aria-label='Primary'
            className={`fixed inset-x-0 z-50 overflow-y-auto overflow-x-hidden border-b border-[var(--rp-on-primary)]/20 px-4 pb-7 pt-2 ${
              navOpen ? 'rp-navsheet-panel' : 'rp-navsheet-panel rp-navsheet-panel-exit'
            }`}
            style={{
              top: 'var(--rp-header-h, 4rem)',
              maxHeight: 'calc(100dvh - var(--rp-header-h, 4rem))',
              backgroundColor: 'var(--rp-primary)',
            }}
          >
            <ul>
              {MOBILE_NAV_ITEMS.map((item, index) => (
                <li
                  key={item.label}
                  className={navOpen ? 'rp-navsheet-item' : 'rp-navsheet-item-exit'}
                  style={{ '--rp-stage-i': index } as CSSProperties}
                >
                  <NavLink
                    to={`/t/${config.slug}${item.path}`}
                    end={item.end}
                    className='rp-focus-inverse group flex items-center gap-3 border-b border-[var(--rp-on-primary)]/15 py-4 text-lg font-light text-[var(--rp-on-primary)]'
                  >
                    <span
                      aria-hidden='true'
                      className='transition-transform duration-200 group-hover:translate-x-1'
                    >
                      &rarr;
                    </span>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>

            {
              /* Support and account, under the navigation list. The same two
              * controls as the header, drawn from the same icons and named by
              * the same constants so the two surfaces cannot drift. They span
              * the full sheet width so both stay one comfortable tap target at
              * every root font size. */
            }
            <div
              className={`mt-7 flex min-w-0 flex-col gap-2.5 ${
                navOpen ? 'rp-navsheet-item' : 'rp-navsheet-item-exit'
              }`}
              style={{ '--rp-stage-i': MOBILE_NAV_ITEMS.length } as CSSProperties}
            >
              <NavLink
                to={`/t/${config.slug}/help`}
                className='rp-navsheet-action rp-focus-inverse'
              >
                <HelpIcon className='h-5 w-5 shrink-0' />
                {HELP_LABEL}
              </NavLink>
              <AccountMenu
                isAdmin={accountIsAdmin}
                label={accountLabel}
                manageHref='/admin'
                variant='mobile'
                onProfile={() => {
                  navRestoreFocus.current = false
                  setNavOpen(false)
                  setSignInOpen(true)
                }}
                onTabOut={(direction) => {
                  if (direction === 'forward') {
                    navTriggerRef.current?.focus()
                    return
                  }
                  const stops = Array.from(
                    navPanelRef.current?.querySelectorAll<HTMLElement>(NAV_FOCUSABLE) ?? [],
                  )
                  stops[stops.length - 2]?.focus()
                }}
              />
            </div>
          </nav>
        </div>
      )}

      {/* Keyed on the path so each route change replays the entrance. */}
      <div key={location.pathname} className='rp-page-enter'>
        <Outlet context={{ config } satisfies TenantOutletContext} />
      </div>

      {
        /* Ask and Graph size themselves to the viewport and scroll
        * internally, so there is no room beneath them for a footer. On iOS the
        * dynamic viewport grows as the URL bar collapses, the panel grows with
        * it, and it overruns anything stacked below - which is exactly the
        * overlap this avoids. */
      }
      {isViewportHeightRoute ? null : <PortalFooter branding={config.branding} />}

      {signInOpen ? <SignInDialog user={auth?.user} onClose={() => setSignInOpen(false)} /> : null}

      {paletteOpen
        ? (
          <CommandPalette
            slug={config.slug}
            suggestedQuestions={config.suggestedQuestions}
            onClose={() => setPaletteOpen(false)}
          />
        )
        : null}
    </div>
  )
}
