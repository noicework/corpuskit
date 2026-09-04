import { type FormEvent, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ApiError, getAdminOverview } from '../api/client.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { AddPortal } from './admin/AddPortal.tsx'
import { MigratePanel } from './admin/MigratePanel.tsx'
import { PortalRow } from './admin/PortalRow.tsx'
import { getAuthSession, microsoftLoginUrl } from '../api/auth.ts'

/**
 * Global connections: passcode-gated overview of every portal and its
 * knowledge box connection - connect, replace, revert, disable or remove.
 * The passcode lives in sessionStorage for the tab, never anywhere else.
 * Everything else about a portal (content, appearance, behaviour, analysis)
 * lives in that portal's own Manage workspace at /t/:slug/manage.
 *
 * Portals render as a compact accordion - one collapsed summary row each,
 * with only one expanded at a time - so the whole overview fits a single
 * viewport rather than one long scroll.
 */
export function AdminPage() {
  const [passcode, setPasscode] = useState(() => sessionStorage.getItem('rp-admin-passcode') ?? '')
  const [draft, setDraft] = useState('')
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const { data: auth, isLoading: authLoading } = useQuery({
    queryKey: ['auth-session'],
    queryFn: getAuthSession,
    staleTime: 60_000,
    retry: false,
  })
  const ssoAdmin = auth?.user?.isAdmin === true
  const adminCredential = ssoAdmin ? 'microsoft-sso' : passcode

  const { data, isLoading, isError, error, refetch } = useQuery({
    // The passcode is part of the key: submitting a new one must run a fresh
    // check, not replay the cached 401 from an earlier wrong entry.
    queryKey: ['admin-overview', adminCredential],
    queryFn: () => getAdminOverview(adminCredential),
    enabled: adminCredential.length > 0,
    retry: false,
  })

  const unauthorised = isError && error instanceof ApiError && error.status === 401

  const submitPasscode = (event: FormEvent) => {
    event.preventDefault()
    sessionStorage.setItem('rp-admin-passcode', draft)
    setPasscode(draft)
  }

  if (authLoading && !passcode) {
    return <main className='min-h-screen bg-app' aria-busy='true' />
  }

  if (!adminCredential || unauthorised) {
    return (
      <main className='flex min-h-screen flex-col items-center justify-center bg-app px-6'>
        <div className='rp-card w-full max-w-sm p-8'>
          <p className='rp-eyebrow text-ink-3'>Research portal</p>
          <h1 className='mt-1 text-xl font-semibold tracking-tight text-ink'>Knowledge boxes</h1>
          {auth?.user
            ? (
              <p className='mt-4 text-sm text-ink-2'>
                {auth.user.email} is signed in but does not have the CorpusKit administrator role.
              </p>
            )
            : (
              <a href={microsoftLoginUrl('/admin')} className='rp-btn rp-btn-primary mt-5 w-full'>
                Sign in with Microsoft
              </a>
            )}
          <form onSubmit={submitPasscode} className='mt-5 space-y-4'>
            <div>
              <label htmlFor='admin-passcode' className='mb-1.5 block text-sm font-medium text-ink'>
                Admin passcode
              </label>
              <input
                id='admin-passcode'
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
          <Link to='/' className='mt-4 inline-block text-sm text-ink-3 hover:text-[var(--rp-ink)]'>
            &larr; Back to portals
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className='min-h-screen bg-app'>
      <div className='mx-auto max-w-3xl px-6 py-12'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <p className='rp-eyebrow text-ink-3'>Research portal</p>
            <h1 className='mt-1 text-2xl font-semibold tracking-tight text-ink'>Knowledge boxes</h1>
            <p className='mt-1 text-sm text-ink-3'>
              Connect, replace or revert each portal's knowledge box. For content, appearance and
              behaviour, open a portal's own management workspace.
            </p>
          </div>
          <Link
            to='/'
            className='shrink-0 text-sm font-medium text-ink-3 hover:text-[var(--rp-ink)]'
          >
            &larr; Back to portals
          </Link>
        </div>

        {isLoading && (
          <div className='mt-8 space-y-3'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
          </div>
        )}

        {isError && !unauthorised && (
          <div className='mt-8'>
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load the overview.'}
              onRetry={() => void refetch()}
            />
          </div>
        )}

        {data && (
          <div className='mt-8 space-y-4'>
            <AddPortal passcode={adminCredential} />

            <div className='space-y-3'>
              {data.map((row) => (
                <PortalRow
                  key={row.tenant.slug}
                  row={row}
                  passcode={adminCredential}
                  expanded={expandedSlug === row.tenant.slug}
                  onToggleExpanded={() =>
                    setExpandedSlug((prev) => (prev === row.tenant.slug ? null : row.tenant.slug))}
                />
              ))}
            </div>

            <MigratePanel rows={data} passcode={adminCredential} />
          </div>
        )}
      </div>
    </main>
  )
}
