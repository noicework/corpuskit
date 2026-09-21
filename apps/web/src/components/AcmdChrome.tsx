import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

const ACMD = 'https://acmd.org.au'
const groups = [
  {
    label: 'Our Work',
    links: [['Programs', '/programs'], ['Projects', '/projects'], ['Education', '/education']],
  },
  {
    label: 'About Us',
    links: [['The ACMD', '/the-acmd'], ['Our Story', '/our-story'], ['Our People', '/our-people']],
  },
  { label: 'News & Events', links: [['News', '/news'], ['Events', '/events']] },
]
const footerGroups = [
  groups[0]!.links,
  [...groups[1]!.links, ...groups[2]!.links],
  [['Support Us', '/support-us'], ['Donate Now', '/donate-now/'], ['eduroam at ACMD', '/eduroam'], [
    'Terms of Use',
    '/terms-of-use',
  ], ['Privacy Policy', '/privacy-policy']],
]

/** ACMD's public-site navigation, with the search action opening this portal. */
export function AcmdSiteHeader({ slug, onSearch }: { slug: string; onSearch: () => void }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const mobileTrigger = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!openGroup && !mobileOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpenGroup(null)
        setMobileOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (openGroup) {
          setOpenGroup(null)
          trigger.current?.focus()
        } else {
          setMobileOpen(false)
          mobileTrigger.current?.focus()
        }
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [openGroup, mobileOpen])

  return (
    <div ref={root} className='acmd-site-header'>
      <div className='rp-shell acmd-site-header-inner'>
        <Link
          to={`/t/${slug}`}
          className='rp-focus acmd-site-logo'
          aria-label='ACMD Research Portal home'
        >
          <img src='/brands/acmd/logo.png' alt='ACMD' width='164' height='30' />
        </Link>
        <button
          type='button'
          className='acmd-site-menu rp-focus'
          ref={mobileTrigger}
          aria-expanded={mobileOpen}
          aria-controls='acmd-site-navigation'
          onClick={(event) => {
            trigger.current = event.currentTarget
            setMobileOpen(!mobileOpen)
            setOpenGroup(null)
          }}
        >
          {mobileOpen ? 'Close' : 'Menu'}
          <svg
            viewBox='0 0 24 24'
            width='24'
            height='24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.5'
            aria-hidden='true'
          >
            <path d={mobileOpen ? 'M5 5l14 14M5 19 19 5' : 'M2 5h20M2 12h20M2 19h20'} />
          </svg>
        </button>
        <nav
          id='acmd-site-navigation'
          aria-label='ACMD website'
          className={`acmd-site-nav${mobileOpen ? ' acmd-site-nav-open' : ''}`}
        >
          {groups.map((group, index) => (
            <div
              className='acmd-site-nav-group'
              key={group.label}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenGroup(null)
              }}
            >
              <button
                type='button'
                className='acmd-site-nav-trigger rp-focus'
                aria-expanded={openGroup === group.label}
                aria-controls={`acmd-site-group-${index}`}
                onClick={(event) => {
                  trigger.current = event.currentTarget
                  setOpenGroup(openGroup === group.label ? null : group.label)
                }}
              >
                {group.label}
                <svg
                  viewBox='0 0 20 11'
                  width='14'
                  height='8'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='1.5'
                  aria-hidden='true'
                >
                  <path d='m1 1 9 9 9-9' />
                </svg>
              </button>
              {openGroup === group.label && (
                <ul id={`acmd-site-group-${index}`} className='acmd-site-dropdown'>
                  {group.links.map(([label, path]) => (
                    <li key={path}>
                      <a className='rp-focus' href={`${ACMD}${path}`}>{label}</a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <a href={`${ACMD}/contact`} className='rp-focus'>Contact</a>
          <button
            type='button'
            className='acmd-site-search rp-focus'
            aria-label='Search research portal'
            onClick={() => {
              setMobileOpen(false)
              setOpenGroup(null)
              onSearch()
            }}
          >
            <svg
              viewBox='0 0 28 28'
              width='26'
              height='26'
              fill='none'
              stroke='currentColor'
              strokeWidth='1.5'
              aria-hidden='true'
            >
              <circle cx='11.5' cy='11.5' r='8.5' />
              <path d='m18 18 8 8' />
            </svg>
          </button>
          <a href={`${ACMD}/support-us`} className='acmd-pill rp-focus'>Support Us</a>
        </nav>
      </div>
    </div>
  )
}

/** Public ACMD destinations and acknowledgement, taken from its existing footer. */
export function AcmdSiteFooter() {
  return (
    <footer className='acmd-site-footer'>
      <div className='acmd-newsletter'>
        <div className='acmd-newsletter-inner'>
          <a href={ACMD} className='rp-focus'>
            <img
              src='/brands/acmd/logo-footer.png'
              alt='ACMD'
              width='164'
              height='32'
              loading='lazy'
            />
          </a>
          <h2>Sign up to our newsletter</h2>
          <p>Discover the latest research, projects and events from the ACMD.</p>
          <a href={`${ACMD}/#signupForm`} className='acmd-pill rp-focus'>
            Sign up <span aria-hidden='true'>↗</span>
          </a>
          <p className='acmd-newsletter-note'>Subscribe on the ACMD website.</p>
        </div>
      </div>
      <div className='acmd-footer-main'>
        <div className='acmd-footer-inner'>
          <h2 className='acmd-footer-tagline'>Engineering the future of healthcare</h2>
          <nav aria-label='ACMD footer' className='acmd-footer-links'>
            {footerGroups.map((links, index) => (
              <ul key={index}>
                {links.map(([label, path]) => (
                  <li key={path}>
                    <a href={`${ACMD}${path}`} className='rp-focus-inverse'>{label}</a>
                  </li>
                ))}
              </ul>
            ))}
          </nav>
          <div className='acmd-footer-actions'>
            <a
              href='https://www.linkedin.com/company/aikenhead-centre-for-medical-discovery/'
              className='rp-focus-inverse acmd-linkedin'
              aria-label='ACMD on LinkedIn'
            >
              <svg
                viewBox='0 0 24 24'
                width='24'
                height='24'
                fill='none'
                stroke='currentColor'
                strokeWidth='1.7'
                aria-hidden='true'
              >
                <rect x='2' y='2' width='20' height='20' rx='5' />
                <path d='M7 10v8M11 18v-8M11 13a3 3 0 0 1 6 0v5' />
                <circle cx='7' cy='6.5' r='.8' fill='currentColor' stroke='none' />
              </svg>
            </a>
            <a href={`${ACMD}/contact`} className='acmd-pill acmd-pill-white rp-focus-inverse'>
              Contact Us
            </a>
          </div>
          <p className='acmd-acknowledgement'>
            The ACMD recognises the Traditional Owners/Custodians of the land on which its many
            sites are located. We pay our respects to the Elders past and present and welcome all
            Aboriginal and/or Torres Strait Islander people to the ACMD.
          </p>
          <button
            type='button'
            className='acmd-back-top rp-focus-inverse'
            aria-label='Back to top'
            onClick={() =>
              globalThis.scrollTo({
                top: 0,
                behavior: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 'instant'
                  : 'smooth',
              })}
          >
            <svg
              viewBox='0 0 32 32'
              width='32'
              height='32'
              fill='none'
              stroke='currentColor'
              strokeWidth='1.4'
              aria-hidden='true'
            >
              <path d='M16 29V3M3 16 16 3l13 13' />
            </svg>
          </button>
        </div>
      </div>
    </footer>
  )
}
