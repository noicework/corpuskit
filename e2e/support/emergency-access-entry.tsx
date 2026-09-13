import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  EmergencyAccessProvider,
  usePermissionAdminAccess,
} from '../../apps/web/src/components/EmergencyAccess.tsx'
import { microsoftLoginUrl } from '../../apps/web/src/api/auth.ts'
import { AccessProvider, useAccess } from '../../apps/web/src/components/AccessProvider.tsx'
import { MemoryRouter } from 'react-router-dom'
import { googleFontsUrl, tenantThemeVars, useBodyTheme } from '../../apps/web/src/lib/theme.ts'
import { BrandingSchema } from '@research-portal/core'

declare const __EMERGENCY_FIXTURE_BUILD__: string
const params = new URLSearchParams(location.search)
const branding = BrandingSchema.parse({
  productName: 'CorpusKit',
  organisation: 'Example research',
  tagline: 'Research administration',
  colours: { primary: '#17372d', accent: '#e0ba63', heroFrom: '#17372d', heroTo: '#234f45' },
  paletteId: params.get('palette') === 'observatory' ? 'observatory' : 'default',
  shape: 'soft',
  density: 'spacious',
  typography: 'lexend-zilla',
})

function ActionFixture() {
  const { runExplicit, breakGlassEnabled, sessionAllowed } = usePermissionAdminAccess(
    'portal.create',
    { kind: 'platform' },
  )
  const [outcome, setOutcome] = useState('idle')
  function run() {
    void runExplicit('Refresh the portal resource count', async (access) => {
      const result = await access.request('/api/admin/__test/emergency-action', { method: 'POST' })
      await result.json()
      if (params.get('scenario') === 'batch') {
        await access.request('/api/admin/__test/emergency-action')
      }
      return true
    }).then((result) => setOutcome(result ? 'completed' : 'cancelled')).catch(() =>
      setOutcome('failed')
    )
  }
  return (
    <section className='rp-card p-6'>
      <h2 className='rp-display text-xl'>Portal resources</h2>
      <p className='my-4 text-sm text-ink-2'>Refresh the resource count for this portal.</p>
      <div className='flex flex-wrap gap-4'>
        <a className='rp-btn rp-btn-ghost' href={microsoftLoginUrl()}>Sign in with Microsoft</a>
        {breakGlassEnabled && !sessionAllowed
          ? (
            <button
              type='button'
              id='emergency-entry'
              className='rp-btn rp-btn-primary'
              onClick={run}
            >
              Use emergency access
            </button>
          )
          : null}
        {sessionAllowed
          ? (
            <button
              type='button'
              id='session-action'
              className='rp-btn rp-btn-primary'
              onClick={run}
            >
              Refresh resource count
            </button>
          )
          : null}
      </div>
      <p data-outcome={outcome} className='mt-4 text-sm text-ink-2'>
        {outcome === 'completed' ? 'Resource count refreshed.' : 'One request per action.'}
      </p>
    </section>
  )
}

function Fixture() {
  const { state, refresh } = useAccess()
  const session = state.session
  const [mounted, setMounted] = useState(true)
  useBodyTheme(branding)
  useEffect(() => {
    const font = document.createElement('link')
    font.rel = 'stylesheet'
    font.href = googleFontsUrl('lexend-zilla')
    document.head.append(font)
    const reload = () => {
      void refresh().catch(() => {})
    }
    addEventListener('fixture-refresh-capability', reload)
    const unmount = () => setMounted(false)
    addEventListener('fixture-unmount', unmount)
    return () => {
      font.remove()
      removeEventListener('fixture-refresh-capability', reload)
      removeEventListener('fixture-unmount', unmount)
    }
  }, [refresh])
  return (
    <div
      className='rp-tenant min-h-screen bg-app text-ink'
      style={tenantThemeVars(branding)}
      data-fixture-mounted
      data-fixture-ready={state.status !== 'loading' ? true : undefined}
      data-authority-status={state.status}
      data-fixture-build={__EMERGENCY_FIXTURE_BUILD__}
    >
      <header className='border-b border-line bg-surface p-6'>
        <h1 className='rp-display text-xl'>CorpusKit administration</h1>
      </header>
      <main className='p-6'>
        {mounted
          ? (
            <EmergencyAccessProvider session={session}>
              <ActionFixture />
            </EmergencyAccessProvider>
          )
          : null}
      </main>
    </div>
  )
}

if (typeof __EMERGENCY_FIXTURE_BUILD__ !== 'undefined') {
  createRoot(document.getElementById('emergency-fixture-root')!).render(
    <MemoryRouter>
      <AccessProvider>
        <Fixture />
      </AccessProvider>
    </MemoryRouter>,
  )
}

// Isolated legacy operation surfaces remain test-only until their scoped migration.
import { useQueryClient } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { Skeleton } from '../../apps/web/src/components/ui.tsx'
import { AddContent } from '../../apps/web/src/pages/admin/AddContent.tsx'
import { AnalysePanel } from '../../apps/web/src/pages/admin/AnalysePanel.tsx'
import { InterrogatePanel } from '../../apps/web/src/pages/admin/InterrogatePanel.tsx'
import { AppearancePanel } from '../../apps/web/src/pages/admin/AppearancePanel.tsx'
import { BehaviourPanel } from '../../apps/web/src/pages/admin/BehaviourPanel.tsx'
import { ExtractionPanel } from '../../apps/web/src/pages/admin/ExtractionPanel.tsx'
import { CorpusHealthPanel } from '../../apps/web/src/pages/admin/CorpusHealthPanel.tsx'
import { EnrichmentsPanel } from '../../apps/web/src/pages/admin/EnrichmentsPanel.tsx'
import { InsightsPanel } from '../../apps/web/src/pages/admin/InsightsPanel.tsx'
import { KgPanel } from '../../apps/web/src/pages/admin/KgPanel.tsx'
import { LabelsetsPanel } from '../../apps/web/src/pages/admin/LabelsetsPanel.tsx'
import { RecentList } from '../../apps/web/src/pages/admin/RecentList.tsx'
import { RenamePortal } from '../../apps/web/src/pages/admin/RenamePortal.tsx'
import { SourcesPanel } from '../../apps/web/src/pages/admin/SourcesPanel.tsx'
import { StatTiles } from '../../apps/web/src/pages/admin/StatTiles.tsx'
import type { TenantOutletContext } from '../../apps/web/src/pages/TenantLayout.tsx'
import {
  AdminPageAccess,
  OverviewAccess,
  useAdminOverview,
} from '../../apps/web/src/pages/AdminPage.tsx'

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
export function EmergencyManageFixture() {
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
  const { data, isLoading } = overview
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
              {tab === 'overview' && (
                <div className='space-y-4'>
                  {reachable
                    ? (
                      <div className='rp-card p-5'>
                        <StatTiles
                          slug={slug}
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

              {tab === 'insights' && (
                <div className='rp-card p-5'>
                  {reachable ? <InsightsPanel slug={slug} /> : (
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
                  {reachable && <CorpusHealthPanel slug={slug} />}
                </div>
              )}

              {tab === 'enrichments' && (
                reachable ? <EnrichmentsPanel slug={slug} /> : (
                  <div className='rp-card p-5'>
                    <p className='text-sm text-ink-3'>
                      Connect a knowledge box to generate enrichments.
                    </p>
                  </div>
                )
              )}

              {tab === 'taxonomy' && (
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
                          organisation={config.branding.organisation}
                        />
                        <AnalysePanel slug={slug} />
                        <InterrogatePanel slug={slug} />
                      </>
                    )
                    : (
                      <p className='mt-4 text-sm text-ink-3'>
                        Connect a knowledge box to edit label sets or run analysis.
                      </p>
                    )}
                </div>
              )}

              {tab === 'graph' && (
                <div className='min-w-0'>
                  {reachable
                    ? <KgPanel slug={slug} open={tab === 'graph'} />
                    : (
                      <p className='text-sm text-ink-3'>
                        Connect a knowledge box to build a knowledge graph.
                      </p>
                    )}
                </div>
              )}

              {tab === 'appearance' && (
                <AppearancePanel
                  slug={slug}
                  branding={config.branding}
                />
              )}

              {tab === 'behaviour' && <BehaviourPanel slug={slug} />}
              {tab === 'extraction' && <ExtractionPanel slug={slug} />}

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
