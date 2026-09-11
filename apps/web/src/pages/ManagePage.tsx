import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import { AdminPageAccess, OverviewAccess, useAdminOverview } from './AdminPage.tsx'

type TabId =
  | 'overview'
  | 'insights'
  | 'content'
  | 'enrichments'
  | 'taxonomy'
  | 'graph'
  | 'appearance'
  | 'behaviour'
  | 'extraction'
  | 'details'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'insights', label: 'Insights' },
  { id: 'content', label: 'Content' },
  { id: 'enrichments', label: 'Enrichments' },
  { id: 'taxonomy', label: 'Taxonomy' },
  { id: 'graph', label: 'Knowledge graph' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'extraction', label: 'Extraction' },
  { id: 'details', label: 'Details' },
]

/**
 * The portal's librarian workspace: everything that used to hang off the
 * global admin accordion, scoped to a single tenant and organised as tabs
 * rather than a stack of collapsible sections. Reuses the same
 * request-only access as the global admin page.
 */
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
  const queryClient = useQueryClient()

  const [searchParams] = useSearchParams()
  // A deep link (Tools > Extraction Lab) can open a tab directly.
  const [tab, setTab] = useState<TabId>(() => {
    const wanted = searchParams.get('tab')
    return TABS.some((t) => t.id === wanted) ? wanted as TabId : 'overview'
  })
  const [renaming, setRenaming] = useState(false)
  const overview = useAdminOverview(slug)
  const { data, isLoading, coarseAdminEligible } = overview
  const row = data?.find((r) => r.tenant.slug === slug)

  const onContentAdded = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-counters', slug] }),
    ])

  const onRenamed = () => {
    setRenaming(false)
    void queryClient.invalidateQueries({ queryKey: ['tenant-config', slug] })
  }

  const reachable = row ? row.resourceCount !== null : false

  return (
    <main className='min-h-[calc(100dvh-var(--rp-header-h,126px))] bg-app'>
      <div className='rp-shell py-10'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-semibold tracking-tight text-ink'>Manage</h1>
          </div>
          <div className='flex items-center gap-4'>
            <Link
              to={`/t/${slug}`}
              className='text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'
            >
              &larr; Back to the portal
            </Link>
            <Link to='/admin' className='text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'>
              Connections &rarr;
            </Link>
          </div>
        </div>

        {isLoading && (
          <div className='mt-8 space-y-3'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-40 w-full' />
          </div>
        )}

        <OverviewAccess overview={overview} returnTo={`/t/${slug}/manage`} />

        {row && (
          <div
            data-admin-overview
            className='mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]'
          >
            <nav
              aria-label='Manage sections'
              className='rp-no-scrollbar -mx-1 flex gap-1 overflow-x-auto whitespace-nowrap px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0'
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type='button'
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'true' : undefined}
                  className={`shrink-0 rounded-[var(--rp-radius)] px-3 py-2 text-left text-sm font-medium transition-colors duration-150 ${
                    tab === t.id
                      ? 'bg-surface-3 text-ink'
                      : 'text-ink-2 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            <div className='min-w-0'>
              {!coarseAdminEligible && !['details', 'content'].includes(tab) && (
                <div className='rp-card p-5'>
                  <h2 className='text-lg font-semibold'>{row.tenant.productName}</h2>
                  <p className='mt-3 text-sm text-ink-2'>
                    {row.resourceCount ?? 'Unknown'} documents in this snapshot.
                  </p>
                  <p className='mt-3 text-sm text-ink-2'>
                    Sign in with an administrator account to load this section automatically.
                  </p>
                </div>
              )}

              {coarseAdminEligible && tab === 'overview' && (
                <div className='space-y-4'>
                  {reachable
                    ? (
                      <div className='rp-card p-5'>
                        <StatTiles
                          slug={slug}
                          passcode='microsoft-sso'
                          resourceCount={row.resourceCount ?? 0}
                        />
                      </div>
                    )
                    : (
                      <div className='rp-card p-5'>
                        <p className='text-sm text-ink-3'>
                          Connect a knowledge box to see stats.{' '}
                          <Link
                            to='/admin'
                            className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'
                          >
                            Go to connections
                          </Link>
                        </p>
                      </div>
                    )}
                  <div className='rp-card p-5'>
                    <RecentList slug={slug} />
                  </div>
                </div>
              )}

              {coarseAdminEligible && tab === 'insights' && (
                <div className='rp-card p-5'>
                  {reachable
                    ? <InsightsPanel slug={slug} passcode='microsoft-sso' />
                    : (
                      <p className='text-sm text-ink-3'>
                        Connect a knowledge box to see insights.{' '}
                        <Link
                          to='/admin'
                          className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'
                        >
                          Go to connections
                        </Link>
                      </p>
                    )}
                </div>
              )}

              {tab === 'content' && (
                <div className='space-y-4'>
                  <div className='rp-card p-5'>
                    {reachable
                      ? (
                        <AddContent
                          slug={slug}
                          onAdded={onContentAdded}
                        />
                      )
                      : (
                        <p className='text-sm text-ink-3'>
                          Connect a knowledge box to add content.{' '}
                          <Link
                            to='/admin'
                            className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'
                          >
                            Go to connections
                          </Link>
                        </p>
                      )}
                  </div>
                  {reachable && <SourcesPanel slug={slug} />}
                  <div className='rp-card p-5'>
                    <RecentList slug={slug} />
                  </div>
                  {reachable && coarseAdminEligible && (
                    <CorpusHealthPanel slug={slug} passcode='microsoft-sso' />
                  )}
                </div>
              )}

              {coarseAdminEligible && tab === 'enrichments' && (
                reachable
                  ? <EnrichmentsPanel slug={slug} passcode='microsoft-sso' />
                  : (
                    <div className='rp-card p-5'>
                      <p className='text-sm text-ink-3'>
                        Connect a knowledge box to generate enrichments.
                      </p>
                    </div>
                  )
              )}

              {coarseAdminEligible && tab === 'taxonomy' && (
                // One container: the tab card. Everything inside is a flat
                // section (heading, then controls), separated by hairlines.
                <div className='rp-card p-5'>
                  <div className='flex flex-wrap items-baseline justify-between gap-3'>
                    <h3 className='text-sm font-semibold text-ink'>Label sets</h3>
                    <Link
                      to={`/t/${slug}/taxonomy`}
                      className='text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'
                    >
                      Open taxonomy &rarr;
                    </Link>
                  </div>
                  {reachable
                    ? (
                      <>
                        <LabelsetsPanel
                          slug={slug}
                          passcode='microsoft-sso'
                          organisation={config.branding.organisation}
                        />
                        <AnalysePanel slug={slug} passcode='microsoft-sso' />
                        <InterrogatePanel slug={slug} passcode='microsoft-sso' />
                      </>
                    )
                    : (
                      <p className='mt-4 text-sm text-ink-3'>
                        Connect a knowledge box to edit label sets or run analysis.
                      </p>
                    )}
                </div>
              )}

              {coarseAdminEligible && tab === 'graph' && (
                <div className='rp-card p-5'>
                  {reachable
                    ? <KgPanel slug={slug} passcode='microsoft-sso' open={tab === 'graph'} />
                    : (
                      <p className='text-sm text-ink-3'>
                        Connect a knowledge box to build a knowledge graph.
                      </p>
                    )}
                </div>
              )}

              {coarseAdminEligible && tab === 'appearance' && (
                <AppearancePanel
                  slug={slug}
                  passcode='microsoft-sso'
                  branding={config.branding}
                />
              )}

              {coarseAdminEligible && tab === 'behaviour' && (
                <BehaviourPanel slug={slug} passcode='microsoft-sso' />
              )}
              {coarseAdminEligible && tab === 'extraction' && (
                <ExtractionPanel slug={slug} passcode='microsoft-sso' />
              )}

              {tab === 'details' && (
                <div className='rp-card p-5'>
                  {renaming
                    ? (
                      <RenamePortal
                        slug={slug}
                        initialName={config.branding.productName}
                        initialOrganisation={config.branding.organisation}
                        initialTagline={config.branding.tagline}
                        onCancel={() => setRenaming(false)}
                        onSaved={onRenamed}
                      />
                    )
                    : (
                      <div className='flex flex-wrap items-start justify-between gap-4'>
                        <div>
                          <h3 className='text-sm font-semibold text-ink'>
                            {config.branding.productName}
                          </h3>
                          <p className='mt-0.5 text-sm text-ink-3'>
                            {config.branding.organisation}
                          </p>
                          <p className='mt-0.5 text-sm text-ink-3'>{config.branding.tagline}</p>
                        </div>
                        <button
                          type='button'
                          onClick={() => setRenaming(true)}
                          className='rp-btn rp-btn-outline'
                        >
                          Rename
                        </button>
                      </div>
                    )}
                  <p className='mt-5 border-t border-line pt-4 text-xs text-ink-3'>
                    To disable or remove this portal, or change its knowledge box connection, use
                    {' '}
                    <Link to='/admin' className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'>
                      the global connections page
                    </Link>.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
