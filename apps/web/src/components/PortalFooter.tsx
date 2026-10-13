import type { Branding, PortalLayout } from '@research-portal/core'
import { ExternalMark, LayoutAnchor } from './LayoutLink.tsx'

type LayoutFooterContent = NonNullable<PortalLayout['footer']>

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
    <footer className='bg-[var(--rp-primary)]'>
      <div className='rp-shell flex flex-col gap-3 py-8 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8'>
        <p className='min-w-0 text-sm text-[var(--rp-on-primary)]'>
          &copy; {year} {branding.organisation}
        </p>
        <div className='min-w-0 sm:text-right'>
          <p className='text-sm text-[var(--rp-on-primary)]/80'>{branding.productName}</p>
          <p className='mt-1 text-xs leading-relaxed text-[var(--rp-on-primary)]/65'>
            {branding.tagline}
          </p>
        </div>
      </div>
    </footer>
  )
}

/**
 * The fuller footer a portal's layout asks for: the portal's name and tagline beside its own
 * link columns, then a closing row with the organisation, the layout's note and, when asked
 * for, "Powered by CorpusKit". Every word and link in it comes from the layout or the branding.
 */
function LayoutFooter(
  { branding, slug, footer }: { branding: Branding; slug: string; footer: LayoutFooterContent },
) {
  const year = new Date().getFullYear()
  const columns = footer.columns ?? []
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
            <p className='mt-3 text-sm leading-relaxed text-[var(--rp-on-primary)]/75'>
              {branding.tagline}
            </p>
          </div>
          {columns.length
            ? (
              <nav
                aria-label='Footer'
                className='grid min-w-0 grid-cols-1 gap-x-8 gap-y-10 min-[420px]:grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]'
              >
                {columns.map((column, index) => (
                  <div key={`${index}-${column.heading}`} className='min-w-0'>
                    <h2 className='rp-eyebrow text-[var(--rp-on-primary)]/75'>{column.heading}</h2>
                    <ul className='mt-3 space-y-0.5 text-[0.9375rem]'>
                      {column.links.map((link, linkIndex) => (
                        <li key={`${linkIndex}-${link.href}`}>
                          <LayoutAnchor
                            href={link.href}
                            slug={slug}
                            className='rp-layout-footer-link rp-focus-inverse'
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
        <div className='mt-12 flex flex-col gap-3 border-t border-[var(--rp-on-primary)]/15 pt-6 text-xs leading-relaxed text-[var(--rp-on-primary)]/80 md:flex-row md:items-baseline md:gap-8'>
          <p className='min-w-0 shrink-0'>&copy; {year} {branding.organisation}</p>
          {footer.note ? <p className='min-w-0 flex-1'>{footer.note}</p> : null}
          {footer.poweredBy
            ? (
              <p className='min-w-0 shrink-0 md:ml-auto'>
                <a
                  href='https://corpuskit.org'
                  rel='noopener'
                  className='rp-layout-footer-link rp-focus-inverse'
                >
                  Powered by CorpusKit
                  <ExternalMark />
                </a>
              </p>
            )
            : null}
        </div>
      </div>
    </footer>
  )
}
