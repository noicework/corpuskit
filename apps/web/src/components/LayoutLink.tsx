import { usePortalLocale } from '../lib/portal-locale.tsx'
import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { layoutHrefTarget } from '@research-portal/core'

/** What a screen reader hears after the label of every link that leaves the portal. */
export const EXTERNAL_LINK_NOTE = '(opens external site)'

/**
 * The marker on a link that leaves the portal: a small arrow for the eye and a note for a screen
 * reader. External links open in the same tab, like every other link in the portal, so the
 * note says where the link goes rather than warning of a new window.
 */
export function ExternalMark({ className = '' }: { className?: string }) {
  const { ui } = usePortalLocale()
  return (
    <>
      <svg
        viewBox='0 0 12 12'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
        aria-hidden='true'
        className={`rp-external-mark ${className}`}
      >
        <path d='M4 2.75h5.25V8M9 3L3 9' />
      </svg>
      <span className='sr-only'>{ui(EXTERNAL_LINK_NOTE)}</span>
    </>
  )
}

/**
 * A link from a portal layout: a route inside the portal (`/library` resolves to
 * `/t/:slug/library`), or an external `https://` address with `rel="noopener"` and the external
 * marker. A link that fails the layout's rules renders nothing; the server refuses one anyway.
 */
export function LayoutAnchor({
  href,
  slug,
  className,
  children,
  nav = false,
  mark = true,
}: {
  href: string
  slug: string
  className?: string
  children: ReactNode
  /** In a navigation bar: a link to a route shows as current there. */
  nav?: boolean
  /** False when the children place the external marker themselves. */
  mark?: boolean
}) {
  const target = layoutHrefTarget(href, slug)
  if (!target) return null
  if (target.external) {
    return (
      <a href={target.url} rel='noopener' className={className}>
        {children}
        {mark ? <ExternalMark /> : null}
      </a>
    )
  }
  // A link with a query or a fragment points into a page rather than naming it, so it never
  // claims to be the current page alongside the built-in item for that route.
  if (nav && !/[?#]/.test(href)) {
    return (
      <NavLink
        to={target.to}
        end
        className={({ isActive }) => `${className ?? ''}${isActive ? ' rp-navlink-active' : ''}`}
      >
        {children}
      </NavLink>
    )
  }
  return <Link to={target.to} className={className}>{children}</Link>
}
