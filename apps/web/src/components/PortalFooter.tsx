import { usePortalLocale } from '../lib/portal-locale.tsx'
import type { Branding, PortalLayout } from '@research-portal/core'
import { LayoutAnchor } from './LayoutLink.tsx'

type LayoutFooterContent = NonNullable<PortalLayout['footer']>

const footerLinkTargets =
  'min-h-[2.75rem] min-w-[2.75rem] lg:min-h-[1.5rem] lg:min-w-[1.5rem] [@media(pointer:coarse)]:min-h-[2.75rem] [@media(pointer:coarse)]:min-w-[2.75rem]'
const creditLinkClassName =
  `rp-focus-inverse inline-flex max-w-full items-center rounded-[var(--rp-radius-btn)] py-1.5 text-[var(--rp-on-primary-2)] underline-offset-[0.2em] [overflow-wrap:anywhere] hover:underline ${footerLinkTargets}`

/**
 * The portal footer, on the brand surface. A portal whose layout sets a footer gets the fuller
 * one, with its own link columns, note and an optional "Powered by CorpusKit"; every other portal
 * gets the slim band.
 */
export function PortalFooter({ branding, slug }: { branding: Branding; slug: string }) {
  const footer = branding.layout?.footer
  return footer
    ? <LayoutFooter branding={branding} slug={slug} footer={footer} />
    : <SlimFooter branding={branding} />
}

/**
 * The slim footer: one band carrying only what the portal actually knows about itself - the
 * organisation it belongs to, the product name and the tagline, all of which come from the
 * tenant's branding.
 *
 * It deliberately invents nothing. Link columns, legal pages, social accounts and an
 * Acknowledgement of Country belong to a real organisation and cannot be generated for one, so a
 * portal that wants them supplies them in its layout (`branding.layout.footer`) rather than having
 * this component guess. That also means every portal gets a footer, instead of only the ones
 * with hand-written content.
 */
function SlimFooter({ branding }: { branding: Branding }) {
  const year = new Date().getFullYear()
  return (
    <footer className='bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'>
      <div className='rp-shell flex flex-col gap-3 py-8 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8'>
        <p className='min-w-0 text-xs text-[var(--rp-on-primary-2)]'>
          &copy; {year} {branding.organisation}
        </p>
        <div className='min-w-0 sm:text-right'>
          <p className='rp-display break-words text-2xl'>{branding.productName}</p>
          <p className='mt-1 text-sm leading-relaxed text-[var(--rp-on-primary-2)]'>
            {branding.tagline}
          </p>
        </div>
      </div>
    </footer>
  )
}

/**
 * The fuller footer a portal's layout asks for: the portal's name and tagline beside its own
 * link columns, then a closing row with the organisation, the layout's note, its credit links
 * and, when asked for, "Powered by CorpusKit". Every word and link in it comes from the layout
 * or the branding.
 */
function LayoutFooter(
  { branding, slug, footer }: { branding: Branding; slug: string; footer: LayoutFooterContent },
) {
  const { ui } = usePortalLocale()
  const year = new Date().getFullYear()
  const columns = footer.columns ?? []
  const credits = [
    ...(footer.credits ?? []),
    ...(footer.poweredBy
      ? [{ label: ui('Powered by CorpusKit'), href: 'https://corpuskit.org' }]
      : []),
  ]
  return (
    <footer className='bg-[var(--rp-primary)] text-[var(--rp-on-primary)]'>
      <div className='rp-shell py-12 sm:py-14 lg:py-16'>
        <div
          className={`grid gap-10 ${
            columns.length ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16' : ''
          }`}
        >
          <div className='min-w-0 max-w-md'>
            <p className='rp-display break-words text-2xl'>{branding.productName}</p>
            <p className='mt-3 text-sm leading-relaxed text-[var(--rp-on-primary-2)]'>
              {branding.tagline}
            </p>
          </div>
          {columns.length
            ? (
              <nav
                aria-label={ui('Footer')}
                className='grid min-w-0 grid-cols-1 gap-x-8 gap-y-10 min-[420px]:grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]'
              >
                {columns.map((column, index) => (
                  <div key={`${index}-${column.heading}`} className='min-w-0'>
                    <h2 className='rp-eyebrow text-[var(--rp-on-primary-2)]'>{column.heading}</h2>
                    <ul className='mt-3 space-y-0.5 text-[0.9375rem]'>
                      {column.links.map((link, linkIndex) => (
                        <li key={`${linkIndex}-${link.href}`}>
                          <LayoutAnchor
                            href={link.href}
                            slug={slug}
                            className={`rp-layout-footer-link rp-focus-inverse ${footerLinkTargets}`}
                          >
                            {link.label}
                          </LayoutAnchor>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            )
            : null}
        </div>
        <div className='mt-12 flex flex-col gap-3 border-t border-[var(--rp-on-primary)]/15 pt-6 text-xs leading-relaxed text-[var(--rp-on-primary-2)] md:flex-row md:flex-wrap md:items-baseline md:gap-8'>
          <p className='min-w-0'>&copy; {year} {branding.organisation}</p>
          {footer.note ? <p className='min-w-0 max-w-prose md:flex-1'>{footer.note}</p> : null}
          {credits.length
            ? (
              <ul
                role='list'
                className='flex min-w-0 max-w-full flex-col items-start gap-x-2 gap-y-1 md:ml-auto md:shrink-0 md:flex-row md:flex-nowrap md:items-baseline'
              >
                {credits.map((credit, index) => (
                  <li
                    key={`${index}-${credit.href}`}
                    className='inline-flex min-w-0 max-w-full items-baseline gap-2'
                  >
                    {index > 0
                      ? <span aria-hidden='true' className='hidden shrink-0 md:inline'>·</span>
                      : null}
                    <LayoutAnchor
                      href={credit.href}
                      slug={slug}
                      className={creditLinkClassName}
                    >
                      {credit.label}
                    </LayoutAnchor>
                  </li>
                ))}
              </ul>
            )
            : null}
        </div>
      </div>
    </footer>
  )
}
