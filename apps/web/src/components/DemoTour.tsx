import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { demoTourMode, type TenantConfig } from '@research-portal/core'
import { getCatalog } from '../api/client.ts'
import {
  federatedAsk,
  isTourDone,
  markTourDone,
  needsFirstPdf,
  resolveScenes,
  startsOnArrival,
} from '../lib/demo-tour.ts'
import { DemoTourDialog } from './DemoTourDialog.tsx'

/**
 * The guided tour on the home page: nothing visible of its own. On `auto` it opens by itself
 * once per browser on arrival; on `auto` or `request` the Help menu's "Take the tour" brings
 * the reader here with `?tour=1`, which opens it. Only the home page ever opens it, so an
 * automatic tour never lands over an answer the reader is in the middle of.
 */
export function DemoTour({ config }: { config: TenantConfig }) {
  const { ui } = usePortalLocale()
  const mode = demoTourMode(config)
  const slug = config.slug
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const arrived = useRef(false)
  const copy = config.copy?.demoTour

  // On arrival, and again whenever the address gains `?tour=`: open where the setting or the
  // link says so, and take the parameter out of the address so a reload does not open it again.
  useEffect(() => {
    if (mode === 'off') return
    const forced = new URLSearchParams(location.search).has('tour')
    if (!arrived.current || forced) {
      if (startsOnArrival(mode, location.search, arrived.current || isTourDone())) setOpen(true)
    }
    arrived.current = true
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
  if (mode === 'off' || !open) return null
  const firstPdfId = catalogue.data?.items
    .find((item) => item.status === 'processed' && item.type === 'pdf')?.id ?? null
  const scenes = resolveScenes(config, firstPdfId, ui)
  const portal = config.branding.productName
  const heading = copy?.heading ?? ui('Welcome to {portal}', { portal })
  const intro = copy?.intro ??
    ui(
      'This platform brings together research published and curated by {organisation}{partners}. Here you can search, ask questions of, and make connections within the collection.',
      {
        organisation: config.branding.organisation,
        partners: federatedAsk(config) ? ui(' and its research partners') : '',
      },
    )

  function closeTour() {
    markTourDone()
    setOpen(false)
  }

  return (
    <DemoTourDialog
      onClose={closeTour}
      slug={slug}
      productName={portal}
      heading={heading}
      intro={intro}
      scenes={scenes}
      graphKinds={config.entityTypes.map((type) => type.label)}
    />
  )
}
