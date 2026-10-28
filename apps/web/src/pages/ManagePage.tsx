import { EvaluationsPanel } from './admin/EvaluationsPanel.tsx'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { Button, SectionHeader, Skeleton } from '../components/ui.tsx'
import { ArrowLeft, ArrowRight, Check, Pencil } from '../components/icons.tsx'
import { AddContent } from './admin/AddContent.tsx'
import { AddDocumentsLink } from '../components/AddDocumentsLink.tsx'
import { AnalysePanel } from './admin/AnalysePanel.tsx'
import { InterrogatePanel } from './admin/InterrogatePanel.tsx'
import { AppearancePanel } from './admin/AppearancePanel.tsx'
import { BehaviourPanel } from './admin/BehaviourPanel.tsx'
import { ExtractionPanel } from './admin/ExtractionPanel.tsx'
import { CorpusHealthPanel } from './admin/CorpusHealthPanel.tsx'
import { EnrichmentsPanel } from './admin/EnrichmentsPanel.tsx'
import { InsightsPanel } from './admin/InsightsPanel.tsx'
import { KgPanel } from './admin/KgPanel.tsx'
import { LabelsetsPanel } from './admin/LabelsetsPanel.tsx'
import { RecentList } from './admin/RecentList.tsx'
import { RenamePortal } from './admin/RenamePortal.tsx'
import { SourcesPanel } from './admin/SourcesPanel.tsx'
import { StatTiles } from './admin/StatTiles.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { AdminPageAccess } from './AdminPage.tsx'
import type { Permission } from '@research-portal/core'
import { useAccess } from '../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../components/EmergencyAccess.tsx'
import { getManageContent, getManageStatus } from '../api/manage.ts'
import { PortalConnections } from './admin/PortalConnections.tsx'
import { ACCESS_SECTION_PERMISSIONS, AccessPanel } from './admin/AccessPanel.tsx'
import { AuditPanel } from './admin/AuditPanel.tsx'

const TABS: { id: string; label: string; permission: Permission }[] = [
  { id: 'overview', label: 'Overview', permission: 'content.write' },
  { id: 'insights', label: 'Insights', permission: 'content.write' },
  { id: 'content', label: 'Content', permission: 'content.write' },
  { id: 'enrichments', label: 'Enrichments', permission: 'enrichments.write' },
  { id: 'taxonomy', label: 'Taxonomy', permission: 'taxonomy.write' },
  { id: 'graph', label: 'Knowledge graph', permission: 'graph.write' },
  { id: 'appearance', label: 'Appearance', permission: 'appearance.write' },
  { id: 'evaluations', label: 'Evaluations', permission: 'behaviour.write' },
  { id: 'behaviour', label: 'Behaviour', permission: 'behaviour.write' },
  { id: 'extraction', label: 'Extraction', permission: 'content.write' },
  { id: 'details', label: 'Details', permission: 'appearance.write' },
  { id: 'connections', label: 'Connections', permission: 'bindings.write' },
  { id: 'access', label: 'Access', permission: 'members.manage' },
  { id: 'audit', label: 'Audit', permission: 'audit.read' },
]

/** The overview's way into adding documents, and the empty-collection prompt. */
function AddDocumentsCard({ slug, empty }: { slug: string; empty: boolean }) {
  const { ui } = usePortalLocale()

  return (
    <div
      className='rp-card p-5 lg:p-6'
      data-overview-add-documents
      data-collection-empty={empty ? 'true' : undefined}
    >
      <SectionHeader
        className='rp-manage-section-head'
        title={empty ? ui('No documents yet') : ui('Add documents')}
        description={empty
          ? ui('This collection is empty. Upload files or add web pages to start building it.')
          : ui('Upload files, add web pages, paste text or crawl a site.')}
        actions={<AddDocumentsLink slug={slug} />}
      />
    </div>
  )
}

export function ManagePage() {
  return (
    <AdminPageAccess>
      <ManageContent />
    </AdminPageAccess>
  )
}

function ManageContent() {
  const { ui, number } = usePortalLocale()

  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const authority = useAccess()
  const scope = { kind: 'portal' as const, slug }
  const can = (permission: Permission) => authority.can(permission, scope)
  const contentAccess = usePermissionAdminAccess('content.write', scope)
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const allowedTabs = TABS.filter((item) =>
    item.id === 'access'
      ? ACCESS_SECTION_PERMISSIONS.some(can)
      : item.id === 'audit'
      ? can('audit.read') || can('audit.export')
      : can(item.permission)
  )
  const wanted = searchParams.get('tab')
  const tab = allowedTabs.find((item) => item.id === wanted)?.id ?? allowedTabs[0]?.id
  const navigation = useRef<HTMLElement>(null)
  const [scrollEdges, setScrollEdges] = useState({ start: false, end: false })
  useLayoutEffect(() => {
    const nav = navigation.current
    const active = nav?.querySelector<HTMLElement>('[aria-current=true]')
    if (!nav || !active) return
    const updateEdges = () => {
      const start = nav.scrollLeft > 1
      const end = nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 1
      setScrollEdges((current) =>
        current.start === start && current.end === end ? current : { start, end }
      )
    }
    const reveal = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        const container = nav.parentElement?.getBoundingClientRect() ?? nav.getBoundingClientRect()
        const item = active.getBoundingClientRect()
        const inset = Number.parseFloat(getComputedStyle(nav).scrollPaddingInlineStart) || 0
        if (item.left < container.left + inset) {
          nav.scrollLeft += item.left - container.left - inset
        } else if (item.right > container.right - inset) {
          nav.scrollLeft += item.right - container.right + inset
        }
      }
      updateEdges()
    }
    reveal()
    nav.addEventListener('scroll', updateEdges, { passive: true })
    const observer = new ResizeObserver(reveal)
    observer.observe(nav)
    return () => {
      nav.removeEventListener('scroll', updateEdges)
      observer.disconnect()
    }
  }, [tab])
  const [renaming, setRenaming] = useState(false)
  const status = useQuery({
    queryKey: ['manage-status', slug, authority.identityKey, authority.generation],
    queryFn: ({ signal }) =>
      getManageStatus(slug, {
        signal,
        authority: authority.controller,
        context: authority.controller.context,
      }),
    enabled: !!tab && can('portal.read'),
    retry: false,
  })
  const content = useQuery({
    queryKey: ['manage-content', slug, authority.identityKey, authority.generation],
    queryFn: ({ signal }) => getManageContent(slug, contentAccess.sessionAccess, signal),
    enabled: !!tab && contentAccess.sessionAllowed,
    retry: false,
  })
  const platformConnections = authority.can('portal.create', { kind: 'platform' })
  const chooseTab = (id: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', id)
    setSearchParams(next)
  }
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['manage-content', slug] }),
      queryClient.invalidateQueries({ queryKey: ['manage-status', slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-counters', slug] }),
    ])
  const reachable = content.data !== undefined || status.data?.status === 'connected' ||
    status.data?.status === 'demo'
  const unavailable = (
    <p className='text-sm text-ink-2'>{ui('This section is currently unavailable.')}</p>
  )
  if (!tab) {
    return (
      <main className='rp-shell py-8 lg:py-10' data-route-unavailable>
        <h1 className='rp-display text-2xl'>{ui('Manage')}</h1>
        <p className='mt-4 text-ink-2'>{ui('This administration page is unavailable.')}</p>
      </main>
    )
  }

  return (
    <main
      className='rp-manage-shell min-h-[calc(100dvh-var(--rp-header-h,126px))] bg-app'
      data-manage-shell
    >
      <div className='rp-shell py-8 lg:py-10'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h1 className='rp-display text-2xl text-ink sm:text-3xl'>{ui('Manage')}</h1>
          <div className='flex min-w-0 flex-wrap items-center gap-2 sm:gap-4'>
            <Link
              to={`/t/${slug}`}
              className='rp-link-standalone text-sm font-medium'
            >
              <ArrowLeft size='sm' />
              {ui('Back to the portal')}
            </Link>
            {platformConnections && (
              <Link
                to='/admin'
                className='rp-link-standalone text-sm font-medium'
              >
                {ui('Platform connections')}
                <ArrowRight size='sm' />
              </Link>
            )}
          </div>
        </div>
        <section aria-label={ui('Portal status')} className='rp-card mt-6 min-w-0 p-5 lg:p-6'>
          <SectionHeader
            className='rp-manage-section-head'
            title={ui('Portal status')}
            description={
              <span className='flex items-start gap-2' data-manage-status>
                {status.isSuccess && !status.isFetching && status.data.status === 'connected' && (
                  <span
                    data-manage-connected-check
                    className='mt-0.5 shrink-0 text-[var(--rp-ok-ink)]'
                  >
                    <Check size='sm' />
                  </span>
                )}
                <span className='min-w-0'>
                  {status.data
                    ? status.data.status === 'connected'
                      ? ui('Knowledge box connected')
                      : status.data.status === 'demo'
                      ? ui('Demo knowledge box')
                      : status.data.status === 'unavailable'
                      ? ui('Knowledge box connection unavailable. Reconnect or disconnect it.')
                      : ui('Knowledge box not connected')
                    : status.isError
                    ? ui('Connection status is unavailable.')
                    : ui('Checking connection...')}
                </span>
              </span>
            }
          />
          {can('content.write') && content.data && (
            <div className='mt-3 min-w-0 space-y-2 text-sm'>
              <p data-manage-counts>
                <strong>{number(content.data.counters.resources)}</strong>
                {ui(' documents ·')} {number(content.data.counters.paragraphs)}
                {ui(' paragraphs')}
              </p>
              <p data-manage-recent className='break-words text-ink-2'>
                {content.data.recent[0]
                  ? ui('Latest addition: {title}', { title: content.data.recent[0].title })
                  : ui('No recent additions.')}
              </p>
            </div>
          )}
          {content.isLoading && can('content.write') && <Skeleton className='mt-3 h-5 w-32' />}
          {content.isError && can('content.write') && (
            <p role='alert' className='mt-3 text-sm text-ink-2'>
              {ui('Content statistics are unavailable.')}
            </p>
          )}
          {(status.data?.status === 'none' || status.data?.status === 'unavailable') &&
            can('bindings.write') && tab !== 'connections' && (
            <Button
              variant='outline'
              trailingIcon={ArrowRight}
              className='mt-3'
              onClick={() => chooseTab('connections')}
            >
              {ui('Open connections')}
            </Button>
          )}
        </section>
        <div className='mt-8 grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)]'>
          <div
            className='rp-manage-nav-wrap min-w-0'
            data-scroll-start={scrollEdges.start || undefined}
            data-scroll-end={scrollEdges.end || undefined}
          >
            <nav
              ref={navigation}
              aria-label={ui('Manage sections')}
              className='rp-manage-nav rp-no-scrollbar -mx-1 flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0'
            >
              {allowedTabs.map((item) => (
                <button
                  key={item.id}
                  type='button'
                  data-manage-tab={item.id}
                  onClick={() => chooseTab(item.id)}
                  aria-current={tab === item.id ? 'true' : undefined}
                  className='rp-btn rp-btn-ghost rp-manage-tab shrink-0 justify-start'
                >
                  {ui(item.label)}
                </button>
              ))}
            </nav>
          </div>
          <div className='min-w-0 space-y-6 lg:space-y-8'>
            {tab === 'access' && <AccessPanel slug={slug} name={config.branding.productName} />}
            {tab === 'audit' && <AuditPanel scope={scope} name={config.branding.productName} />}
            {tab === 'overview' && can('content.write') && (
              <>
                {reachable && (
                  <AddDocumentsCard
                    slug={slug}
                    empty={content.data?.counters.resources === 0}
                  />
                )}
                {can('content.write') && reachable && (
                  <div className='rp-card p-5 lg:p-6'>
                    <StatTiles slug={slug} resourceCount={content.data?.counters.resources ?? 0} />
                  </div>
                )}
                {can('content.write') && (
                  <div className='rp-card p-5 lg:p-6'>
                    <RecentList slug={slug} />
                  </div>
                )}
              </>
            )}
            {tab === 'content' && can('content.write') && (
              <>
                {can('content.write') && reachable && (
                  <div className='rp-card p-5 lg:p-6'>
                    <AddContent slug={slug} onAdded={refresh} />
                  </div>
                )}
                {can('content.write') && reachable && <SourcesPanel slug={slug} />}
                {can('content.write') && (
                  <div className='rp-card p-5 lg:p-6'>
                    <RecentList slug={slug} />
                  </div>
                )}
                {can('content.write') && reachable && <CorpusHealthPanel slug={slug} />}
              </>
            )}
            {tab === 'insights' && can('content.write') &&
              (can('content.write') && reachable
                ? (
                  <div className='rp-card p-5 lg:p-6'>
                    <InsightsPanel slug={slug} />
                  </div>
                )
                : unavailable)}
            {tab === 'taxonomy' && can('taxonomy.write') && (
              <div className='rp-card p-5 lg:p-6'>
                <SectionHeader
                  className='rp-manage-section-head'
                  title={ui('Label sets')}
                  actions={
                    <Link to={`/t/${slug}/taxonomy`} className='rp-link-standalone text-sm'>
                      {ui('Open taxonomy')}
                      <ArrowRight size='sm' />
                    </Link>
                  }
                />
                {can('taxonomy.write') && reachable && (
                  <LabelsetsPanel slug={slug} organisation={config.branding.organisation} />
                )}
              </div>
            )}
            {tab === 'taxonomy' && can('behaviour.write') && reachable && (
              <>
                <div className='rp-card p-5 lg:p-6'>
                  <AnalysePanel slug={slug} />
                </div>
                <div className='rp-card p-5 lg:p-6'>
                  <InterrogatePanel slug={slug} />
                </div>
              </>
            )}
            {tab === 'graph' && can('graph.write') &&
              (can('graph.write') && reachable ? <KgPanel slug={slug} open /> : unavailable)}
            {tab === 'enrichments' && can('enrichments.write') &&
              (can('enrichments.write') && reachable
                ? <EnrichmentsPanel slug={slug} />
                : unavailable)}
            {tab === 'appearance' && can('appearance.write') && (
              <AppearancePanel slug={slug} branding={config.branding} />
            )}
            {tab === 'evaluations' && <EvaluationsPanel slug={slug} />}
            {tab === 'behaviour' && can('behaviour.write') && <BehaviourPanel slug={slug} />}
            {tab === 'extraction' && can('content.write') && <ExtractionPanel slug={slug} />}
            {tab === 'details' && can('appearance.write') && (
              <div className='rp-card p-5 lg:p-6'>
                {renaming && can('appearance.write')
                  ? (
                    <RenamePortal
                      slug={slug}
                      initialName={config.branding.productName}
                      initialOrganisation={config.branding.organisation}
                      initialTagline={config.branding.tagline}
                      onCancel={() => setRenaming(false)}
                      onSaved={() => {
                        setRenaming(false)
                        void queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
                      }}
                    />
                  )
                  : (
                    <>
                      <SectionHeader
                        className='rp-manage-section-head'
                        title={config.branding.productName}
                        description={config.branding.organisation}
                        actions={can('appearance.write') && (
                          <Button
                            variant='ghost'
                            size='sm'
                            leadingIcon={Pencil}
                            onClick={() => setRenaming(true)}
                          >
                            {ui('Rename')}
                          </Button>
                        )}
                      />
                      <p className='mt-4 text-sm text-ink-2'>{config.branding.tagline}</p>
                    </>
                  )}
              </div>
            )}
            {tab === 'connections' && can('bindings.write') && status.data && (
              <div className='rp-card min-w-0 p-5'>
                <PortalConnections
                  slug={slug}
                  name={config.branding.productName}
                  knowledgeBox={status.data}
                  resourceCount={content.data?.counters.resources ?? null}
                  onChanged={refresh}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
