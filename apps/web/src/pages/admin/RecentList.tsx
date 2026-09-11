import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecentResource } from '@research-portal/core'
import { getAdminRecent, setResourceHidden } from '../../api/client.ts'
import { useAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { Skeleton } from '../../components/ui.tsx'
import { errorMessage } from './shared.ts'

function StatusChip({ status }: { status: RecentResource['status'] }) {
  if (status === 'pending') {
    return (
      <span className='rp-badge rp-badge-warn'>
        <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--rp-warn-ink)]' />
        Processing
      </span>
    )
  }
  if (status === 'processed') {
    return <span className='rp-badge rp-badge-ok'>Indexed</span>
  }
  return <span className='rp-badge rp-badge-bad'>Error</span>
}

/** Visibility control for a single resource row: hide a published resource,
 * or publish a draft one, and refetch the list on success. */
function VisibilityControl({
  slug,
  resource,
  onChanged,
}: {
  slug: string
  resource: RecentResource
  onChanged: () => Promise<unknown>
}) {
  const { runExplicit } = useAdminAccess()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await runExplicit(
        resource.hidden ? 'Publish resource' : 'Hide resource',
        (access) => setResourceHidden(slug, access, resource.id, !resource.hidden),
      )
      if (result === undefined) return
      if (result.ok !== true) throw new AdminAccessError()
      await onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not change visibility.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className='flex flex-wrap items-center gap-2'>
      {resource.hidden && <span className='rp-badge rp-badge-quiet'>Draft</span>}
      <button
        type='button'
        disabled={busy}
        onClick={() => void toggle()}
        className='text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        {busy ? '…' : resource.hidden ? 'Publish' : 'Hide'}
      </button>
      {error && <span className='text-xs text-[var(--rp-bad-ink)]'>{error}</span>}
    </span>
  )
}

/**
 * Recently added resources for a tenant, polling every four seconds while
 * anything is still pending so the "Processing" chip flips to "Indexed"
 * without a manual refresh. Each row also carries a visibility control so
 * the librarian can hide a resource (draft) or publish it again.
 */
export function RecentList({ slug }: { slug: string }) {
  const { runExplicit, sessionAccess, coarseAdminEligible, pending } = useAdminAccess()
  const [snapshot, setSnapshot] = useState<RecentResource[]>()
  const [error, setError] = useState<string>()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['admin-recent', slug],
    queryFn: () => getAdminRecent(slug, sessionAccess),
    enabled: coarseAdminEligible,
    retry: false,
    refetchInterval: (query) =>
      coarseAdminEligible && query.state.data?.some((r) => r.status === 'pending') ? 4000 : false,
  })

  const { isLoading, isError } = query
  const data = coarseAdminEligible ? query.data : snapshot
  const refresh = async () => {
    setError(undefined)
    try {
      const result = await runExplicit(
        'Read recent additions',
        (access) => getAdminRecent(slug, access),
      )
      if (result === undefined) return
      if (coarseAdminEligible) queryClient.setQueryData(['admin-recent', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setError(errorMessage(err, 'Could not load recent additions.'))
    }
  }
  const onChanged = () => queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] })

  return (
    <div>
      <h3 className='text-sm font-medium text-ink'>Recent additions</h3>
      <button
        type='button'
        className='rp-btn rp-btn-outline mt-3'
        disabled={pending}
        onClick={() => void refresh()}
      >
        Refresh recent additions
      </button>
      {!coarseAdminEligible && (
        <p className='mt-2 text-xs text-ink-3'>
          This is a snapshot. Refresh explicitly to check processing or visibility changes.
        </p>
      )}
      {error && <p role='alert' className='mt-2 text-sm text-[var(--rp-bad-ink)]'>{error}</p>}

      {isLoading && (
        <div className='mt-2 space-y-2'>
          <Skeleton className='h-10 w-full' />
          <Skeleton className='h-10 w-full' />
        </div>
      )}

      {isError && <p className='mt-2 text-sm text-ink-3'>Could not load recent additions.</p>}

      {data && data.length === 0 && <p className='mt-2 text-sm text-ink-3'>Nothing added yet.</p>}

      {data && data.length > 0 && (
        <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
          {data.map((resource) => (
            <li
              key={resource.id}
              className='flex flex-wrap items-center justify-between gap-2 bg-surface px-4 py-2.5'
            >
              <span className='min-w-0 truncate text-sm text-ink'>{resource.title}</span>
              <span className='flex min-w-0 flex-wrap items-center gap-3'>
                {resource.created && (
                  <span className='text-xs text-ink-3'>{resource.created.slice(0, 10)}</span>
                )}
                <StatusChip status={resource.status} />
                <VisibilityControl
                  slug={slug}
                  resource={resource}
                  onChanged={onChanged}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
