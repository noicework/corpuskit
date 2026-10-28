import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useId, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { demoTourMode, type TenantConfig } from '@research-portal/core'
import { getCatalog } from '../api/client.ts'
import {
  isTourDone,
  markTourDone,
  needsFirstPdf,
  resolveScenes,
  startsOnArrival,
} from '../lib/demo-tour.ts'
import { DemoTourDialog } from './DemoTourDialog.tsx'
import { Button } from './ui.tsx'
import { Compass } from './icons.tsx'

/**
 * The guided tour's place on the home page: a short band that offers it, and the dialog
 * itself. A portal on `request` offers it here and through `?tour=1`; on `auto` the band also
 * opens it once per browser on arrival. Only the home page ever opens it by itself, so an
 * automatic tour never lands over an answer the reader is in the middle of.
 */
export function DemoTour({ config }: { config: TenantConfig }) {
  const { ui } = usePortalLocale()
  const mode = demoTourMode(config)
  const slug = config.slug
  const headingId = useId()
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const arrived = useRef(false)
  const copy = config.copy?.demoTour

  // Once, on arrival: open by itself where the setting or the link says so, and take the
  // link's parameter out of the address so a reload does not open it again.
  useEffect(() => {
    if (arrived.current || mode === 'off') return
    arrived.current = true
    const forced = new URLSearchParams(location.search).has('tour')
    if (startsOnArrival(mode, location.search, isTourDone())) setOpen(true)
    if (forced) {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous)
        next.delete('tour')
        return next
      }, { replace: true })
    }
  }, [mode, location.search, setSearchParams])

  // The cited-page scene opens the collection's first PDF unless the portal names a document.
  const wantsPdf = mode !== 'off' && needsFirstPdf(config)
  const catalogue = useQuery({
    queryKey: ['demo-tour-pdf', slug],
    queryFn: () => getCatalog(slug, { pageSize: 24, sort: 'created', order: 'desc' }),
    staleTime: 5 * 60 * 1000,
    enabled: wantsPdf,
  })
  if (mode === 'off') return null
  const firstPdfId = catalogue.data?.items
    .find((item) => item.status === 'processed' && item.type === 'pdf')?.id ?? null
  const scenes = resolveScenes(config, firstPdfId, ui)
  const heading = copy?.heading ?? ui('See what this platform does')
  const intro = copy?.intro ??
    ui('Ask a question, check where the answer came from, and open the page it cites.')

  function closeTour() {
    markTourDone()
    setOpen(false)
  }

  return (
    <section aria-labelledby={headingId} className='rp-layout-band' data-demo-tour-entry>
      <div className='rp-shell rp-layout-section flex flex-col gap-5 md:flex-row md:items-center md:justify-between'>
        <div className='rp-measure min-w-0'>
          <h2 id={headingId} className='rp-display break-words text-xl sm:text-[1.375rem]'>
            {heading}
          </h2>
          <p className='mt-2 text-base leading-relaxed text-ink-2'>{intro}</p>
        </div>
        <Button
          size='lg'
          leadingIcon={Compass}
          className='shrink-0 self-start md:self-auto'
          onClick={() => setOpen(true)}
        >
          {ui('Take the tour')}
        </Button>
      </div>
      {open
        ? (
          <DemoTourDialog
            onClose={closeTour}
            slug={slug}
            scenes={scenes}
          />
        )
        : null}
    </section>
  )
}
