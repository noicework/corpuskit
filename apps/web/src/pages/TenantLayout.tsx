import { usePortalLocale } from '../lib/portal-locale.tsx'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Permission, TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'
import { retryTenantConfig } from '../api/portal-metadata.ts'
import {
  tenantThemeVars,
  useBodyTheme,
  useTenantFonts,
  useTextScale,
  useViewerScheme,
} from '../lib/theme.ts'
import { ArrowLeft, ArrowRight, Menu, Moon, Search, Sun, X } from '../components/icons.tsx'
import { Button, IconButton } from '../components/ui.tsx'
import { CommandPalette } from '../components/CommandPalette.tsx'
import { AccountMenu } from '../components/AccountMenu.tsx'
import {
  accountEntries,
  MANAGEMENT_PERMISSIONS,
  roleLabel,
} from '../components/account-menu-behaviour.ts'
import { HelpItemIcon, HelpMenu } from '../components/HelpMenu.tsx'
import { helpMenuItems } from '../components/help-menu-items.ts'
import { pageTitle } from '../lib/page-title.ts'
import { portalNavigation } from '../lib/portal-nav.ts'
import { KbSwitcher } from '../components/KbSwitcher.tsx'
import { PortalFooter } from '../components/PortalFooter.tsx'
import { LayoutAnchor } from '../components/LayoutLink.tsx'
import { AcmdSiteFooter, AcmdSiteHeader } from '../components/AcmdChrome.tsx'
import { SignInDialog } from '../components/SignInDialog.tsx'
import { useAccess } from '../components/AccessProvider.tsx'
import { AccessUnavailable } from '../components/PortalAccessGate.tsx'
import {
  localisePortalConfig,
  PortalLanguageSwitch,
  PortalLocaleContext,
  usePortalLocaleState,
} from '../lib/portal-locale.tsx'

export type TenantOutletContext = {
  config: TenantConfig
}

function FullPageSpinner() {
  const { ui } = usePortalLocale()

  return (
    <div className='flex min-h-screen items-center justify-center bg-app' role='status'>
      <div
        className='h-9 w-9 animate-spin rounded-full border-2 border-line'
        style={{ borderTopColor: 'var(--rp-ink)' }}
        aria-hidden='true'
      />
      <span className='sr-only'>{ui('Loading portal')}</span>
    </div>
  )
}

// Explore is reached by the logo and Help by its own icon. A portal layout may leave the items
// it can hide (`HIDEABLE_NAV_ITEMS`) out of the navigation; their routes still work.
const NAV_ITEMS: {
  id: string
  path: string
  label: string
  end: boolean
  permission: Permission
}[] = [
  { id: 'library', path: '/library', label: 'Library', end: false, permission: 'portal.read' },
  { id: 'ask', path: '/ask', label: 'Ask', end: false, permission: 'portal.ask' },
  { id: 'graph', path: '/graph', label: 'Graph', end: false, permission: 'portal.read' },
  { id: 'tools', path: '/tools', label: 'Tools', end: false, permission: 'portal.read' },
  {
    id: 'investigations',
    path: '/investigations',
    label: 'Investigations',
    end: false,
    permission: 'portal.read',
  },
  {
    id: 'generate',
    path: '/generate',
    label: 'Generate',
    end: false,
    permission: 'portal.generate',
  },
  {
    id: 'assessment',
    path: '/assessment',
    label: 'Assessment',
    end: false,
    permission: 'portal.generate',
  },
]

// One name for the account control, read by both the header icon and the phone
// sheet's row so the two surfaces cannot drift apart. The help destinations come
// from `helpMenuItems` for the same reason.
const ACCOUNT_LABEL = 'My account'

/** Cache stamps do not turn a light logo into a distinct dark asset. */
export function portalLogo(
  branding: Pick<TenantConfig['branding'], 'logoUrl' | 'logoDarkUrl'>,
  scheme: 'light' | 'dark',
): { src: string | undefined; plate: boolean } {
  const withoutVersion = (value: string) => {
    const url = new URL(value, 'https://corpuskit.invalid')
    url.searchParams.delete('v')
    return url.href
  }
  const distinctDark = !!branding.logoDarkUrl &&
    (!branding.logoUrl || withoutVersion(branding.logoDarkUrl) !== withoutVersion(branding.logoUrl))
  return {
    src: scheme === 'dark' && distinctDark ? branding.logoDarkUrl : branding.logoUrl,
    plate: scheme === 'dark' && !!branding.logoUrl && !distinctDark,
  }
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
  // scrim and the rows can animate away and the trigger can change back from the
  // cross instead of the whole thing being ripped out of the DOM mid-gesture.
  const [navMounted, setNavMounted] = useState(false)
  const [navTop, setNavTop] = useState<number | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const [headerQuery, setHeaderQuery] = useState('')
  const [signInOpen, setSignInOpen] = useState(false)
  const access = useAccess()
  const auth = access.state.session
  const accountName = auth?.user?.name
  const menuEntries = slug ? accountEntries(slug, access.can) : []
  const portalRole = auth?.user ? roleLabel(auth.portalAccess?.effectiveRole) : null
  const platformRole = auth?.user ? roleLabel(auth.effectiveRoles.platformRole) : null
  const scope = { kind: 'portal' as const, slug: slug ?? '' }
  const permitted = NAV_ITEMS.filter((item) => access.can(item.permission, scope))
  const section = location.pathname.split('/')[3] ?? ''
  // Manage owns exact section permission checks and the first-allowed fallback.
  // The outer route gate must not reject a stale or forbidden tab before that runs.
  const routeAllowed = section === 'manage'
    ? MANAGEMENT_PERMISSIONS.some((permission) => access.can(permission, scope))
    : access.can(
      section === 'ask'
        ? 'portal.ask'
        : ['generate', 'assessment'].includes(section)
        ? 'portal.generate'
        : 'portal.read',
      scope,
    )
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
        if (document.querySelector('dialog[open]')) return
        navRestoreFocus.current = false
        setNavOpen(false)
        setNavMounted(false)
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
  // that it shows the close icon - so it joins the front of the cycle instead
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
    data: sourceConfig,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug ?? ''),
    enabled: !!slug && access.can('portal.read', scope),
    retry: retryTenantConfig,
  })
  const locale = usePortalLocaleState(sourceConfig)
  const { ui } = locale
  const config = useMemo(
    () => sourceConfig ? localisePortalConfig(sourceConfig, locale.language) : undefined,
    [sourceConfig, locale.language],
  )
  // Routes whose page owns the full viewport height.
  const isViewportHeightRoute = /\/(ask|graph)(\/|$)/.test(location.pathname)

  const { data: kbStatus } = useQuery({
    queryKey: ['kb-status', access.identityKey, slug, access.generation],
    queryFn: () => getKnowledgeBoxStatus(slug ?? ''),
    enabled: !!slug && access.can('portal.read', scope),
  })

  // The header is two-tier and its height changes with the breakpoint, so full
  // -height pages read it from a custom property instead of guessing.
  useEffect(() => {
    const element = headerRef.current
    if (!element) return
    const apply = () => {
      const bounds = element.getBoundingClientRect()
      document.documentElement.style.setProperty(
        '--rp-header-h',
        `${Math.round(bounds.height)}px`,
      )
      if (navMounted) setNavTop(Math.max(0, bounds.bottom))
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
    // Keyed on config: the header does not exist on the first render (the
    // layout shows a spinner while the tenant loads), so a mount-only effect
    // would attach to nothing and never set the property.
  }, [config, navMounted])

  // Every surface names itself in the tab, so two open portal tabs are told
  // apart by what they hold rather than by the product name alone (D6-14).
  useEffect(() => {
    if (config) {
      document.title = pageTitle(location.pathname, config.branding.productName, ui)
    }
    return () => {
      document.title = ui('Research Portal')
    }
  }, [config, location.pathname, ui])

  // Load the faces for the tenant's typography choice, apply its text scale,
  // and mirror the theme onto <body> so portaled overlays follow it too (all
  // no-ops until the config loads).
  useTenantFonts(config?.branding)
  useTextScale(config?.branding)
  // The viewer's light/dark scheme: system preference by default, their own
  // choice once they toggle it, persisted per browser.
  const { scheme: viewerScheme, setChoice } = useViewerScheme(config?.branding.defaultColourScheme)
  // Start the CorpusKit identity in light mode, independent of browser preferences.
  const [demoScheme, setDemoScheme] = useState<'light' | 'dark'>('light')
  const isCorpusKit = config?.branding.paletteId === 'corpuskit'
  const isAcmd = config?.branding.paletteId === 'acmd'
  const legacyDemoScheme = (isCorpusKit || isAcmd) && !config?.branding.defaultColourScheme
  // A portal set to light stays light for every viewer, and offers no toggle.
  const lightOnly = config?.branding.colourScheme === 'light'
  const scheme = lightOnly ? 'light' : legacyDemoScheme ? demoScheme : viewerScheme
  const schemeLabel = locale.ui(scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode')
  const toggleScheme = () => {
    const next = scheme === 'dark' ? 'light' : 'dark'
    if (legacyDemoScheme) setDemoScheme(next)
    else setChoice(next)
  }
  useBodyTheme(config?.branding, scheme)

  if (isLoading) {
    return <FullPageSpinner />
  }

  // Only the refused config read is the paused screen: platform administrators still get the
  // full config of a suspended portal, and use it under a banner.
  if (error instanceof ApiError && error.code === 'portal_suspended') {
    return <AccessUnavailable suspended />
  }
  if (isError || !config) return <AccessUnavailable failedRead />

  // The portal's own header links follow the built-in items it keeps.
  const { items: navigation, links: customLinks } = portalNavigation(
    permitted,
    config.branding.layout,
  )

  // Links sit on the solid brand band, so the active state is on-primary type over
  // an accent underline (see .rp-navlink in styles.css) rather than the accent
  // wash the old light-background header used.
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rp-navlink rp-chrome-nav-link${isActive ? ' rp-navlink-active' : ''}`

  const logo = portalLogo(config.branding, scheme)
  const SchemeIcon = scheme === 'dark' ? Moon : Sun

  const accountControl = (
    <AccountMenu
      entries={menuEntries}
      portalRole={portalRole}
      platformRole={platformRole}
      portalName={config.branding.productName}
      label={accountName || ui(ACCOUNT_LABEL)}
      onProfile={() => setSignInOpen(true)}
    />
  )

  return (
    <PortalLocaleContext.Provider value={locale}>
      <div
        className={`rp-tenant min-h-screen bg-app${
          config.branding.paletteId === 'acmd' ? ' rp-acmd' : ''
        }`}
        style={tenantThemeVars(config.branding, scheme)}
        data-colour-scheme={scheme}
        lang={locale.language}
      >
        {
          /* Two-tier header: a surface strip carrying the logo, over a solid
        * brand-colour band carrying the navigation. */
        }
        <header
          ref={headerRef}
          className={section === 'graph' ? 'relative z-40 md:sticky md:top-0' : 'sticky top-0 z-40'}
        >
          {isAcmd && <AcmdSiteHeader slug={config.slug} onSearch={() => setPaletteOpen(true)} />}
          {isAcmd
            ? (
              <div className='acmd-portal-bar'>
                <div className='rp-shell acmd-portal-bar-inner'>
                  <Link to={`/t/${config.slug}`} className='acmd-portal-name rp-focus'>
                    {ui('Research portal')}
                  </Link>
                  <nav aria-label={ui('Primary')} className='acmd-portal-nav'>
                    {navigation.map((item) => (
                      <NavLink
                        key={item.label}
                        to={`/t/${config.slug}${item.path}`}
                        end={item.end}
                        className={navLinkClass}
                      >
                        {locale.ui(item.label)}
                      </NavLink>
                    ))}
                    {customLinks.map((link, index) => (
                      <LayoutAnchor
                        key={`custom-${index}`}
                        href={link.href}
                        slug={config.slug}
                        className='rp-navlink rp-chrome-nav-link'
                        nav
                      >
                        {link.label}
                      </LayoutAnchor>
                    ))}
                  </nav>
                  <div className='acmd-portal-tools'>
                    {!lightOnly && (
                      <span className='hidden sm:inline-flex'>
                        <IconButton
                          onClick={toggleScheme}
                          label={schemeLabel}
                          icon={SchemeIcon}
                          size='lg'
                          aria-pressed={scheme === 'dark'}
                          className='rp-chrome-header-control'
                        />
                      </span>
                    )}
                    <span className='hidden sm:inline-flex'>
                      <HelpMenu slug={config.slug} />
                    </span>
                    <span className='hidden sm:inline-flex'>
                      {accountControl}
                    </span>
                    <span className='md:hidden'>
                      <button
                        ref={navTriggerRef}
                        type='button'
                        onClick={() => {
                          if (navOpen) {
                            navRestoreFocus.current = true
                            setNavOpen(false)
                          } else {
                            setNavTop(
                              Math.max(0, headerRef.current?.getBoundingClientRect().bottom ?? 0),
                            )
                            setNavMounted(true)
                            setNavOpen(true)
                          }
                        }}
                        aria-label={navOpen ? ui('Close menu') : ui('Open menu')}
                        aria-expanded={navOpen}
                        aria-controls='mobile-nav-sheet'
                        className='acmd-portal-menu rp-focus min-h-11'
                      >
                        {ui('Explore ')}
                        {navOpen ? <X /> : <Menu />}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            )
            : (
              <>
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
                        className={`rp-focus rp-chrome-home flex min-w-0 items-center gap-3 rounded-[var(--rp-radius-btn)]${
                          logo.plate && !logoFailed && !isCorpusKit ? ' rp-logo-plate' : ''
                        }`}
                      >
                        {isCorpusKit
                          ? (
                            <span className='rp-corpuskit-wordmark'>
                              {ui('CorpusKit')}
                              <span
                                style={{ color: 'var(--rp-accent-fg)' }}
                              >
                                /
                              </span>
                            </span>
                          )
                          : config.branding.logoUrl && !logoFailed
                          ? (
                            <img
                              src={logo.src}
                              alt={config.branding.organisation}
                              onError={() => setLogoFailed(true)}
                              style={config.branding.logoMaxWidth === undefined ? undefined : {
                                maxWidth:
                                  `min(${config.branding.logoMaxWidth}px, var(--rp-chrome-logo-cap), 100%)`,
                              }}
                              className='rp-chrome-logo min-w-0 shrink object-contain'
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
                      {config.branding.showPortalSwitcher !== false && (
                        <KbSwitcher config={config} />
                      )}
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
                        className='rp-field flex w-full items-center gap-1 rounded-[var(--rp-radius-input)] border bg-surface p-1'
                      >
                        <label htmlFor='header-search' className='sr-only'>
                          {locale.ui('Search')} {config.branding.productName}
                        </label>
                        <input
                          id='header-search'
                          type='search'
                          value={headerQuery}
                          onChange={(event) => setHeaderQuery(event.target.value)}
                          placeholder={config.searchPlaceholder}
                          className='min-h-[calc(2.75rem*var(--rp-density-ctl,1))] min-w-0 flex-1 bg-transparent px-3 text-base text-ink outline-none'
                        />
                        <IconButton
                          type='submit'
                          label={locale.ui('Search')}
                          icon={Search}
                          size='lg'
                        />
                      </form>
                    </div>

                    {
                      /* Below `sm` this cluster takes exactly the width its buttons
              * need, so the rest of the row belongs to the logo. `flex-1` from
              * `sm` up restores the even three-way split that keeps the desktop
              * search box optically centred. */
                    }
                    <div className='ml-auto flex flex-none items-center justify-end gap-2 sm:flex-1'>
                      <PortalLanguageSwitch config={config} locale={locale} />
                      {kbStatus?.status === 'none' &&
                        access.can('portal.create', { kind: 'platform' }) && (
                        <span className='hidden shrink-0 lg:block'>
                          <Link to='/admin' className='rp-badge rp-badge-quiet rp-focus'>
                            {ui('Not connected')}
                          </Link>
                        </span>
                      )}
                      {
                        /* Below `sm` the help and account controls live in the phone
                * menu only (the sheet carries both): three 44px circles plus
                * the logo no longer fit a 390px header once the root font is
                * scaled up for accessibility. Wrapped, for the same reason as
                * the menu toggle below - component classes set their own
                * display and would beat a utility on the element itself. */
                      }
                      {!lightOnly && (
                        <span className='hidden sm:inline-flex'>
                          <IconButton
                            onClick={toggleScheme}
                            label={schemeLabel}
                            icon={SchemeIcon}
                            size='lg'
                            aria-pressed={scheme === 'dark'}
                            className='rp-chrome-header-control'
                          />
                        </span>
                      )}
                      <span className='hidden sm:inline-flex'>
                        <HelpMenu slug={config.slug} />
                      </span>
                      <span className='hidden sm:inline-flex'>
                        {accountControl}
                      </span>
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
                        <IconButton
                          ref={navTriggerRef}
                          type='button'
                          onClick={() => {
                            if (navOpen) {
                              navRestoreFocus.current = true
                              setNavOpen(false)
                              return
                            }
                            // On the mobile graph the header can be partially
                            // scrolled away. The fixed sheet follows its visible
                            // bottom without changing full-height page offsets.
                            setNavTop(
                              Math.max(0, headerRef.current?.getBoundingClientRect().bottom ?? 0),
                            )
                            setNavMounted(true)
                            setNavOpen(true)
                          }}
                          label={locale.ui(navOpen ? 'Close menu' : 'Open menu')}
                          icon={navOpen ? X : Menu}
                          size='lg'
                          aria-expanded={navOpen}
                          aria-controls='mobile-nav-sheet'
                          className='rp-navtoggle rp-chrome-header-control'
                        />
                      </span>
                    </div>
                  </div>
                </div>

                <div className='rp-navband relative hidden md:block'>
                  <div className='rp-shell'>
                    <nav
                      aria-label={ui('Primary')}
                      className='rp-no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap'
                    >
                      {navigation.map((item) => (
                        <NavLink
                          key={item.label}
                          to={`/t/${config.slug}${item.path}`}
                          end={item.end}
                          className={navLinkClass}
                        >
                          {locale.ui(item.label)}
                        </NavLink>
                      ))}
                      {customLinks.map((link, index) => (
                        <LayoutAnchor
                          key={`custom-${index}`}
                          href={link.href}
                          slug={config.slug}
                          className='rp-navlink rp-chrome-nav-link'
                          nav
                        >
                          {link.label}
                        </LayoutAnchor>
                      ))}
                    </nav>
                  </div>
                </div>
              </>
            )}
          {config.slug === 'acmd' && (
            <div className='border-b border-line bg-surface-2'>
              <p className='rp-shell py-2 text-xs leading-relaxed text-ink-2'>
                {ui(
                  'Demo portal. Answers currently use the CorpusKit documentation knowledge base.',
                )}
              </p>
            </div>
          )}
          {config.status === 'suspended' && (
            <div
              role='status'
              className='border-b'
              data-portal-suspended
              style={{
                background: 'var(--rp-warn-bg)',
                color: 'var(--rp-warn-ink)',
                borderColor: 'var(--rp-warn-line)',
              }}
            >
              <p className='rp-shell py-2 text-sm leading-relaxed'>
                <strong>{ui('This portal is paused.')}</strong>{' '}
                {ui('Visitors see a paused screen. Only platform administrators can open it.')}
              </p>
            </div>
          )}
          {config.status === 'read_only' && auth?.authenticated && (
            <div
              role='status'
              className='border-b'
              data-portal-read-only
              style={{
                background: 'var(--rp-warn-bg)',
                color: 'var(--rp-warn-ink)',
                borderColor: 'var(--rp-warn-line)',
              }}
            >
              <p className='rp-shell py-2 text-sm leading-relaxed'>
                <strong>{ui('This portal is read-only.')}</strong> {ui(
                  'You can browse, search and ask questions. Content and settings cannot be changed.',
                )}
              </p>
            </div>
          )}
        </header>

        {
          /* The phone menu. It hangs from under the header rather than covering
        * it, which is what lets the trigger stay put and show the close icon
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
              className={`rp-scrim fixed inset-x-0 bottom-0 z-60 ${
                navOpen ? 'rp-navsheet-scrim' : 'rp-navsheet-scrim rp-navsheet-scrim-exit'
              }`}
              style={{ top: navTop === null ? 'var(--rp-header-h, 4rem)' : `${navTop}px` }}
            />
            <nav
              id='mobile-nav-sheet'
              ref={navPanelRef}
              aria-label={ui('Primary')}
              className={`fixed inset-x-0 z-60 overflow-y-auto overflow-x-hidden border-b border-[var(--rp-on-primary)]/20 px-4 pb-7 pt-2 ${
                navOpen ? 'rp-navsheet-panel' : 'rp-navsheet-panel rp-navsheet-panel-exit'
              }`}
              style={{
                top: navTop === null ? 'var(--rp-header-h, 4rem)' : `${navTop}px`,
                maxHeight: `calc(100dvh - ${
                  navTop === null ? 'var(--rp-header-h, 4rem)' : `${navTop}px`
                })`,
                backgroundColor: 'var(--rp-primary)',
              }}
            >
              <ul>
                {navigation.map((item, index) => (
                  <li
                    key={item.label}
                    className={navOpen ? 'rp-navsheet-item' : 'rp-navsheet-item-exit'}
                    style={{ '--rp-stage-i': index } as CSSProperties}
                  >
                    <NavLink
                      to={`/t/${config.slug}${item.path}`}
                      end={item.end}
                      className='rp-chrome-nav-row rp-focus-inverse flex min-h-11 items-center gap-3 border-b border-[var(--rp-on-primary)]/15 py-4 text-lg font-normal text-[var(--rp-on-primary)]'
                    >
                      <ArrowRight className='shrink-0' />
                      {locale.ui(item.label)}
                    </NavLink>
                  </li>
                ))}
                {customLinks.map((link, index) => (
                  <li
                    key={`custom-${index}`}
                    className={navOpen ? 'rp-navsheet-item' : 'rp-navsheet-item-exit'}
                    style={{ '--rp-stage-i': navigation.length + index } as CSSProperties}
                  >
                    <LayoutAnchor
                      href={link.href}
                      slug={config.slug}
                      className='rp-chrome-nav-row rp-focus-inverse flex min-h-11 items-center gap-3 border-b border-[var(--rp-on-primary)]/15 py-4 text-lg font-normal text-[var(--rp-on-primary)]'
                    >
                      <ArrowRight className='shrink-0' />
                      {link.label}
                    </LayoutAnchor>
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
                style={{ '--rp-stage-i': navigation.length + customLinks.length } as CSSProperties}
              >
                {!lightOnly && (
                  <Button
                    variant='ghost'
                    onClick={toggleScheme}
                    aria-pressed={scheme === 'dark'}
                    className='rp-navsheet-action rp-focus-inverse'
                  >
                    <SchemeIcon className='shrink-0' />
                    {locale.ui(scheme === 'dark' ? 'Light mode' : 'Dark mode')}
                  </Button>
                )}
                {helpMenuItems(config.slug).map((item) => (
                  <NavLink
                    key={item.key}
                    to={item.href}
                    className='rp-navsheet-action rp-focus-inverse'
                  >
                    <HelpItemIcon item={item} className='shrink-0' />
                    {ui(item.label)}
                  </NavLink>
                ))}
                <AccountMenu
                  entries={menuEntries}
                  portalRole={portalRole}
                  platformRole={platformRole}
                  portalName={config.branding.productName}
                  label={accountName || ui(ACCOUNT_LABEL)}
                  variant='mobile'
                  onProfile={() => {
                    navRestoreFocus.current = false
                    navTriggerRef.current?.focus()
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
          {routeAllowed
            ? <Outlet context={{ config } satisfies TenantOutletContext} />
            : (
              <main data-route-unavailable className='rp-shell py-12'>
                <h1 className='rp-display text-2xl text-ink' tabIndex={-1}>
                  {ui('This page is unavailable')}
                </h1>
                <p className='mt-4 text-ink-2'>
                  {ui('You cannot open this page with your current account.')}
                </p>
                <Link to={`/t/${config.slug}/library`} className='rp-btn rp-btn-outline mt-6'>
                  <ArrowLeft size='sm' />
                  {ui('Back to the library')}
                </Link>
              </main>
            )}
        </div>

        {
          /* Ask and desktop Graph own the viewport. Mobile Graph gives the
        * scene a full viewport below its scrolling chrome. None needs a footer
        * stacked beneath the interactive canvas or panel. */
        }
        {isViewportHeightRoute
          ? null
          : isAcmd
          ? <AcmdSiteFooter />
          : <PortalFooter branding={config.branding} slug={config.slug} />}

        {signInOpen
          ? <SignInDialog user={auth?.user} onClose={() => setSignInOpen(false)} />
          : null}

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
    </PortalLocaleContext.Provider>
  )
}
