import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecentResource } from '@research-portal/core'
import { getAdminRecent, setResourceHidden } from '../../api/client.ts'
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
  passcode,
  resource,
  onChanged,
}: {
  slug: string
  passcode: string
  resource: RecentResource
  onChanged: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await setResourceHidden(slug, passcode, resource.id, !resource.hidden)
      await onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not change visibility.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className='flex shrink-0 items-center gap-2'>
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
export function RecentList({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-recent', slug],
    queryFn: () => getAdminRecent(slug, passcode),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'pending') ? 4000 : false,
  })

  const onChanged = () => queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] })

  return (
    <div>
      <h3 className='text-sm font-medium text-ink'>Recent additions</h3>

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
              <span className='flex shrink-0 flex-wrap items-center gap-3'>
                {resource.created && (
                  <span className='text-xs text-ink-3'>{resource.created.slice(0, 10)}</span>
                )}
                <StatusChip status={resource.status} />
                <VisibilityControl
                  slug={slug}
                  passcode={passcode}
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
