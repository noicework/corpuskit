import { type ReactNode, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getAdminOverview } from '../api/client.ts'
import { useAccess } from '../components/AccessProvider.tsx'
import { Skeleton } from '../components/ui.tsx'
import { AddPortal } from './admin/AddPortal.tsx'
import { MigratePanel } from './admin/MigratePanel.tsx'
import { PortalRow } from './admin/PortalRow.tsx'
import { microsoftLoginUrl } from '../api/auth.ts'
import {
  EmergencyAccessProvider,
  usePermissionAdminAccess,
} from '../components/EmergencyAccess.tsx'

export function AdminPageAccess({ children }: { children: ReactNode }) {
  const { state, generation } = useAccess()
  useEffect(() => {
    sessionStorage.removeItem('rp-admin-passcode')
  }, [])
  return (
    <EmergencyAccessProvider key={generation} session={state.session}>
      {children}
    </EmergencyAccessProvider>
  )
}

/** Session reads can refetch. An emergency result is a snapshot, never a session unlock. */
export function useAdminOverview(scope: string) {
  const { state, identityKey, generation, controller } = useAccess()
  const auth = state.session
  const { sessionAccess, runExplicit, sessionAllowed, breakGlassEnabled, pending } =
    usePermissionAdminAccess('portal.create', { kind: 'platform' })
  const query = useQuery({
    queryKey: ['admin-overview', identityKey, generation, scope],
    queryFn: () => getAdminOverview(sessionAccess),
    enabled: sessionAllowed,
    retry: false,
  })
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getAdminOverview>>>()
  const [operationError, setOperationError] = useState<string>()
  const refresh = async () => {
    const context = controller.context
    setOperationError(undefined)
    if (sessionAllowed) {
      await query.refetch()
      return
    }
    try {
      const result = await runExplicit(
        'Read the knowledge box overview',
        (access) => getAdminOverview(access),
      )
      controller.assertCurrent(context)
      if (result !== undefined) setSnapshot(result)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Could not load the overview.')
    }
  }
  return {
    data: sessionAllowed ? query.data : snapshot,
    isLoading: query.isLoading,
    error: operationError ?? (query.error instanceof Error ? query.error.message : undefined),
    refresh,
    pending,
    sessionAllowed,
    breakGlassEnabled,
    auth,
  }
}

export function OverviewAccess(
  { overview, returnTo }: { overview: ReturnType<typeof useAdminOverview>; returnTo: string },
) {
  return (
    <div className='mt-5 space-y-4' data-admin-unavailable={!overview.data ? true : undefined}>
      {!overview.sessionAllowed && (
        <>
          <p className='text-sm text-ink-2'>
            {overview.data
              ? 'This overview is a snapshot. Each emergency action needs its own confirmation.'
              : 'You do not have access to this administration page.'}
          </p>
        </>
      )}
      <div className='flex flex-wrap gap-3'>
        {!overview.sessionAllowed && (
          <a href={microsoftLoginUrl(returnTo)} className='rp-btn rp-btn-primary'>
            Sign in with Microsoft
          </a>
        )}
        {(overview.sessionAllowed || overview.breakGlassEnabled) && (
          <button
            type='button'
            disabled={overview.pending}
            onClick={() => void overview.refresh()}
            className='rp-btn rp-btn-outline'
          >
            {overview.sessionAllowed ? 'Refresh overview' : 'Use emergency access'}
          </button>
        )}
      </div>
      {overview.error && (
        <p role='alert' className='text-sm' style={{ color: 'var(--rp-bad-ink)' }}>
          {overview.error}
        </p>
      )}
    </div>
  )
}

/** Global knowledge box connections. Each emergency operation needs a fresh request. */
export function AdminPage() {
  return (
    <AdminPageAccess>
      <AdminContent />
    </AdminPageAccess>
  )
}

function AdminContent() {
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const overview = useAdminOverview('platform')
  const { data, isLoading } = overview
  return (
    <main className='min-h-screen bg-app'>
      <div className='rp-shell py-12'>
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

        <OverviewAccess overview={overview} returnTo='/admin' />

        {data && (
          <div className='mt-8 space-y-4' data-admin-overview>
            <AddPortal />

            <div className='space-y-3'>
              {data.map((row) => (
                <PortalRow
                  key={row.tenant.slug}
                  row={row}
                  expanded={expandedSlug === row.tenant.slug}
                  onToggleExpanded={() =>
                    setExpandedSlug((prev) => (prev === row.tenant.slug ? null : row.tenant.slug))}
                />
              ))}
            </div>

            <MigratePanel rows={data} />
          </div>
        )}
      </div>
    </main>
  )
}
