import { type FormEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import { ApiError, getAdminOverview } from '../api/client.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { AddContent } from './admin/AddContent.tsx'
import { AnalysePanel } from './admin/AnalysePanel.tsx'
import { InterrogatePanel } from './admin/InterrogatePanel.tsx'
import { AppearancePanel } from './admin/AppearancePanel.tsx'
import { BehaviourPanel } from './admin/BehaviourPanel.tsx'
import { CorpusHealthPanel } from './admin/CorpusHealthPanel.tsx'
import { EnrichmentsPanel } from './admin/EnrichmentsPanel.tsx'
import { InsightsPanel } from './admin/InsightsPanel.tsx'
import { KgPanel } from './admin/KgPanel.tsx'
import { RecentList } from './admin/RecentList.tsx'
import { RenamePortal } from './admin/RenamePortal.tsx'
import { SourcesPanel } from './admin/SourcesPanel.tsx'
import { StatTiles } from './admin/StatTiles.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'
import { getAuthSession, microsoftLoginUrl } from '../api/auth.ts'

type TabId =
  | 'overview'
  | 'insights'
  | 'content'
  | 'enrichments'
  | 'taxonomy'
  | 'graph'
  | 'appearance'
  | 'behaviour'
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
  { id: 'details', label: 'Details' },
]

/**
 * The portal's librarian workspace: everything that used to hang off the
 * global admin accordion, scoped to a single tenant and organised as tabs
 * rather than a stack of collapsible sections. Reuses the same
 * sessionStorage passcode as the global admin page.
 */
export function ManagePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const queryClient = useQueryClient()

  const [passcode, setPasscode] = useState(() => sessionStorage.getItem('rp-admin-passcode') ?? '')
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<TabId>('overview')
  const [renaming, setRenaming] = useState(false)
  const { data: auth, isLoading: authLoading } = useQuery({
    queryKey: ['auth-session'],
    queryFn: getAuthSession,
    staleTime: 60_000,
    retry: false,
  })
  const ssoAdmin = auth?.user?.isAdmin === true
  const adminCredential = ssoAdmin ? 'microsoft-sso' : passcode

  const { data, isLoading, isError, error, refetch } = useQuery({
    // Passcode in the key so a corrected entry re-checks instead of replaying
    // a cached 401 (invalidateQueries below matches by prefix, so it still hits).
    queryKey: ['admin-overview', adminCredential],
    queryFn: () => getAdminOverview(adminCredential),
    enabled: adminCredential.length > 0,
    retry: false,
  })

  const unauthorised = isError && error instanceof ApiError && error.status === 401
  const row = data?.find((r) => r.tenant.slug === slug)

  const submitPasscode = (event: FormEvent) => {
    event.preventDefault()
    sessionStorage.setItem('rp-admin-passcode', draft)
    setPasscode(draft)
  }

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

  if (authLoading && !passcode) {
    return (
      <main className='min-h-[calc(100dvh-var(--rp-header-h,126px))] bg-app' aria-busy='true' />
    )
  }

  if (!adminCredential || unauthorised) {
    return (
      <main className='flex min-h-[calc(100dvh-var(--rp-header-h,126px))] flex-col items-center justify-center bg-app px-6'>
        <div className='rp-card w-full max-w-sm p-8'>
          <p className='rp-eyebrow text-ink-3'>{config.branding.productName}</p>
          <h1 className='mt-1 text-xl font-semibold tracking-tight text-ink'>Manage this portal</h1>
          {auth?.user
            ? (
              <p className='mt-4 text-sm text-ink-2'>
                {auth.user.email} is signed in but does not have the CorpusKit administrator role.
              </p>
            )
            : (
              <a
                href={microsoftLoginUrl(`/t/${slug}/manage`)}
                className='rp-btn rp-btn-primary mt-5 w-full'
              >
                Sign in with Microsoft
              </a>
            )}
          <form onSubmit={submitPasscode} className='mt-5 space-y-4'>
            <div>
              <label
                htmlFor='manage-passcode'
                className='mb-1.5 block text-sm font-medium text-ink'
              >
                Admin passcode
              </label>
              <input
                id='manage-passcode'
                type='password'
                className='rp-input'
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoComplete='off'
                required
              />
            </div>
            {unauthorised && (
              <p role='alert' className='text-sm' style={{ color: 'var(--rp-bad-ink)' }}>
                That passcode was not accepted.
              </p>
            )}
            <button type='submit' className='rp-btn rp-btn-primary w-full'>
              Enter
            </button>
          </form>
          <Link
            to={`/t/${slug}`}
            className='mt-4 inline-block text-sm text-ink-3 hover:text-[var(--rp-ink)]'
          >
            &larr; Back to the portal
          </Link>
        </div>
      </main>
    )
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

        {isError && !unauthorised && (
          <div className='mt-8'>
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load this portal.'}
              onRetry={() => void refetch()}
            />
          </div>
        )}

        {row && (
          <div className='mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]'>
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
                          passcode={adminCredential}
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
                    <RecentList slug={slug} passcode={adminCredential} />
                  </div>
                </div>
              )}

              {tab === 'insights' && (
                <div className='rp-card p-5'>
                  {reachable
                    ? <InsightsPanel slug={slug} passcode={adminCredential} />
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
                          passcode={adminCredential}
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
                  {reachable && <SourcesPanel slug={slug} passcode={adminCredential} />}
                  {reachable && <CorpusHealthPanel slug={slug} passcode={adminCredential} />}
                </div>
              )}

              {tab === 'enrichments' && (
                reachable
                  ? <EnrichmentsPanel slug={slug} passcode={adminCredential} />
                  : (
                    <div className='rp-card p-5'>
                      <p className='text-sm text-ink-3'>
                        Connect a knowledge box to generate enrichments.
                      </p>
                    </div>
                  )
              )}

              {tab === 'taxonomy' && (
                <div className='rp-card p-5'>
                  <div className='flex flex-wrap items-center justify-between gap-3'>
                    <p className='text-sm text-ink-2'>
                      Run analysis here, or open the full taxonomy view.
                    </p>
                    <Link to={`/t/${slug}/taxonomy`} className='rp-btn rp-btn-outline'>
                      Open taxonomy &rarr;
                    </Link>
                  </div>
                  {reachable
                    ? (
                      <>
                        <AnalysePanel slug={slug} passcode={adminCredential} />
                        <InterrogatePanel slug={slug} passcode={adminCredential} />
                      </>
                    )
                    : (
                      <p className='mt-4 text-sm text-ink-3'>
                        Connect a knowledge box to run analysis.
                      </p>
                    )}
                </div>
              )}

              {tab === 'graph' && (
                <div className='rp-card p-5'>
                  {reachable
                    ? <KgPanel slug={slug} passcode={adminCredential} open={tab === 'graph'} />
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
                  passcode={adminCredential}
                  branding={config.branding}
                />
              )}

              {tab === 'behaviour' && <BehaviourPanel slug={slug} passcode={adminCredential} />}

              {tab === 'details' && (
                <div className='rp-card p-5'>
                  {renaming
                    ? (
                      <RenamePortal
                        slug={slug}
                        passcode={adminCredential}
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
