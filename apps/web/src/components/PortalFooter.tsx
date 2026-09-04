import type { Branding } from '@research-portal/core'

/**
 * The portal footer: one slim band on the brand surface, carrying only what the
 * portal actually knows about itself - the organisation it belongs to, the
 * product name and the tagline, all of which come from the tenant's branding.
 *
 * It deliberately invents nothing. Link columns, legal pages, social accounts
 * and an Acknowledgement of Country belong to a real organisation and cannot be
 * generated for one, so a portal that wants them supplies them through its own
 * site rather than having this component guess. That also means every portal
 * gets a footer, instead of only the ones with hand-written content.
 */
export function PortalFooter({ branding }: { branding: Branding }) {
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
