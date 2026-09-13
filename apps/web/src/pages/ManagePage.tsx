import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { Skeleton } from '../components/ui.tsx'
import { AddContent } from './admin/AddContent.tsx'
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

// Removed after the final panel migration. Readiness never grants a permission.
const MANAGE_PANEL_READY = {
  recentList: true,
  statTiles: true,
  addContent: true,
  corpusHealth: true,
  sources: true,
  insights: true,
  labelsets: true,
  graph: true,
  enrichments: true,
  analyse: true,
  interrogate: true,
  behaviour: true,
  extraction: false,
  appearance: false,
  rename: false,
}

const TABS: { id: string; label: string; permission: Permission }[] = [
  { id: 'overview', label: 'Overview', permission: 'content.write' },
  { id: 'insights', label: 'Insights', permission: 'content.write' },
  { id: 'content', label: 'Content', permission: 'content.write' },
  { id: 'enrichments', label: 'Enrichments', permission: 'enrichments.write' },
  { id: 'taxonomy', label: 'Taxonomy', permission: 'taxonomy.write' },
  { id: 'graph', label: 'Knowledge graph', permission: 'graph.write' },
  { id: 'appearance', label: 'Appearance', permission: 'appearance.write' },
  { id: 'behaviour', label: 'Behaviour', permission: 'behaviour.write' },
  { id: 'extraction', label: 'Extraction', permission: 'content.write' },
  { id: 'details', label: 'Details', permission: 'appearance.write' },
  { id: 'connections', label: 'Connections', permission: 'bindings.write' },
  // Access and Audit are mounted by their owning panel migrations.
]

export function ManagePage() {
  return (
    <AdminPageAccess>
      <ManageContent />
    </AdminPageAccess>
  )
}

function ManageContent() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const authority = useAccess()
  const scope = { kind: 'portal' as const, slug }
  const can = (permission: Permission) => authority.can(permission, scope)
  const contentAccess = usePermissionAdminAccess('content.write', scope)
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const allowedTabs = TABS.filter((item) => can(item.permission))
  const wanted = searchParams.get('tab')
  const tab = allowedTabs.find((item) => item.id === wanted)?.id ?? allowedTabs[0]?.id
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
  const unavailable = <p className='text-sm text-ink-2'>This section is currently unavailable.</p>
  if (!tab) {
    return (
      <main className='rp-shell py-10' data-route-unavailable>
        <h1 className='rp-display text-2xl'>Manage</h1>
        <p className='mt-4 text-ink-2'>This administration page is unavailable.</p>
      </main>
    )
  }

  return (
    <main className='min-h-[calc(100dvh-var(--rp-header-h,126px))] bg-app' data-manage-shell>
      <div className='rp-shell py-10'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h1 className='rp-display text-2xl text-ink'>Manage</h1>
          <div className='flex min-w-0 flex-wrap items-center gap-4'>
            <Link
              to={`/t/${slug}`}
              className='text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'
            >
              &larr; Back to the portal
            </Link>
            {platformConnections && (
              <Link
                to='/admin'
                className='text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'
              >
                Platform connections &rarr;
              </Link>
            )}
          </div>
        </div>
        <section aria-label='Portal status' className='rp-card mt-6 min-w-0 p-5'>
          <p className='text-sm text-ink-2' data-manage-status>
            {status.data
              ? status.data.status === 'connected'
                ? 'Knowledge box connected'
                : status.data.status === 'demo'
                ? 'Demo knowledge box'
                : 'Knowledge box not connected'
              : status.isError
              ? 'Connection status is unavailable.'
              : 'Checking connection...'}
          </p>
          {can('content.write') && content.data && (
            <div className='mt-3 min-w-0 space-y-2 text-sm'>
              <p data-manage-counts>
                <strong>{content.data.counters.resources}</strong> documents ·{' '}
                {content.data.counters.paragraphs} paragraphs
              </p>
              <p data-manage-recent className='break-words text-ink-2'>
                {content.data.recent[0]
                  ? `Latest addition: ${content.data.recent[0].title}`
                  : 'No recent additions.'}
              </p>
            </div>
          )}
          {content.isLoading && can('content.write') && <Skeleton className='mt-3 h-5 w-32' />}
          {content.isError && can('content.write') && (
            <p role='alert' className='mt-3 text-sm text-ink-2'>
              Content statistics are unavailable.
            </p>
          )}
          {status.data?.status === 'none' && can('bindings.write') && tab !== 'connections' && (
            <button
              type='button'
              className='rp-btn rp-btn-outline mt-3'
              onClick={() => chooseTab('connections')}
            >
              Open connections
            </button>
          )}
        </section>
        <div className='mt-8 grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]'>
          <nav
            aria-label='Manage sections'
            className='rp-no-scrollbar -mx-1 flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0'
          >
            {allowedTabs.map((item) => (
              <button
                key={item.id}
                type='button'
                data-manage-tab={item.id}
                onClick={() => chooseTab(item.id)}
                aria-current={tab === item.id ? 'true' : undefined}
                className={`shrink-0 rounded-[var(--rp-radius)] px-3 py-2 text-left text-sm font-medium transition-colors duration-150 ${
                  tab === item.id
                    ? 'bg-surface-3 text-ink'
                    : 'text-ink-2 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className='min-w-0 space-y-4'>
            {tab === 'overview' && can('content.write') && (
              <>
                {MANAGE_PANEL_READY.statTiles && can('content.write') && reachable && (
                  <div className='rp-card p-5'>
                    <StatTiles slug={slug} resourceCount={content.data?.counters.resources ?? 0} />
                  </div>
                )}
                {MANAGE_PANEL_READY.recentList && can('content.write') && (
                  <div className='rp-card p-5'>
                    <RecentList slug={slug} />
                  </div>
                )}
              </>
            )}
            {tab === 'content' && can('content.write') && (
              <>
                {MANAGE_PANEL_READY.addContent && can('content.write') && reachable && (
                  <div className='rp-card p-5'>
                    <AddContent slug={slug} onAdded={refresh} />
                  </div>
                )}
                {MANAGE_PANEL_READY.sources && can('content.write') && reachable && (
                  <SourcesPanel slug={slug} />
                )}
                {MANAGE_PANEL_READY.recentList && can('content.write') && (
                  <div className='rp-card p-5'>
                    <RecentList slug={slug} />
                  </div>
                )}
                {MANAGE_PANEL_READY.corpusHealth && can('content.write') && reachable && (
                  <CorpusHealthPanel slug={slug} />
                )}
                {!MANAGE_PANEL_READY.addContent && unavailable}
              </>
            )}
            {tab === 'insights' && can('content.write') &&
              (MANAGE_PANEL_READY.insights && can('content.write') && reachable
                ? (
                  <div className='rp-card p-5'>
                    <InsightsPanel slug={slug} />
                  </div>
                )
                : unavailable)}
            {tab === 'taxonomy' && can('taxonomy.write') && (
              <div className='rp-card p-5'>
                <div className='flex flex-wrap items-baseline justify-between gap-3'>
                  <h2 className='text-sm font-semibold text-ink'>Label sets</h2>
                  <Link to={`/t/${slug}/taxonomy`} className='text-sm text-ink-2'>
                    Open taxonomy &rarr;
                  </Link>
                </div>
                {MANAGE_PANEL_READY.labelsets && can('taxonomy.write') && reachable && (
                  <LabelsetsPanel slug={slug} organisation={config.branding.organisation} />
                )}
                {MANAGE_PANEL_READY.analyse && can('behaviour.write') && reachable && (
                  <AnalysePanel slug={slug} />
                )}
                {MANAGE_PANEL_READY.interrogate && can('behaviour.write') && reachable && (
                  <InterrogatePanel slug={slug} />
                )}
              </div>
            )}
            {tab === 'graph' && can('graph.write') &&
              (MANAGE_PANEL_READY.graph && can('graph.write') && reachable
                ? <KgPanel slug={slug} open />
                : unavailable)}
            {tab === 'enrichments' && can('enrichments.write') &&
              (MANAGE_PANEL_READY.enrichments && can('enrichments.write') && reachable
                ? <EnrichmentsPanel slug={slug} />
                : unavailable)}
            {tab === 'appearance' && can('appearance.write') &&
              (MANAGE_PANEL_READY.appearance && can('appearance.write')
                ? <AppearancePanel slug={slug} branding={config.branding} />
                : unavailable)}
            {tab === 'behaviour' && can('behaviour.write') &&
              (MANAGE_PANEL_READY.behaviour && can('behaviour.write')
                ? <BehaviourPanel slug={slug} />
                : unavailable)}
            {tab === 'extraction' && can('content.write') &&
              (MANAGE_PANEL_READY.extraction && can('content.write')
                ? <ExtractionPanel slug={slug} />
                : unavailable)}
            {tab === 'details' && can('appearance.write') && (
              <div className='rp-card p-5'>
                {renaming && MANAGE_PANEL_READY.rename && can('appearance.write')
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
                      <h2 className='text-sm font-semibold text-ink'>
                        {config.branding.productName}
                      </h2>
                      <p className='mt-2 text-sm text-ink-2'>{config.branding.organisation}</p>
                      <p className='mt-2 text-sm text-ink-2'>{config.branding.tagline}</p>
                      {MANAGE_PANEL_READY.rename && can('appearance.write') && (
                        <button
                          type='button'
                          className='rp-btn rp-btn-outline mt-4'
                          onClick={() => setRenaming(true)}
                        >
                          Rename
                        </button>
                      )}
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
