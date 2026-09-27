import { useAccess } from '../../components/AccessProvider.tsx'
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecentResource } from '@research-portal/core'
import { getAdminRecent, setResourceHidden } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError, type AdminRequestAccess } from '../../api/break-glass.ts'
import { Skeleton } from '../../components/ui.tsx'
import { deletedNotice, DeleteDocumentButton } from '../../components/DeleteDocument.tsx'
import { errorMessage } from './shared.ts'

export async function readRecent(slug: string, access: AdminRequestAccess, limit?: number) {
  const rows = await getAdminRecent(slug, access, limit)
  if (
    !Array.isArray(rows) ||
    rows.some((row) =>
      !row || typeof row.id !== 'string' || typeof row.title !== 'string' ||
      !['pending', 'processed', 'error'].includes(row.status)
    )
  ) throw new AdminAccessError()
  return rows
}

function StatusChip({ status, stuck }: { status: RecentResource['status']; stuck?: boolean }) {
  // Stuck: a link still unprocessed an hour after it was added, holding its storage space.
  if (stuck) return <span className='rp-badge rp-badge-bad'>Stuck</span>
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
  const { runExplicit } = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
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
      assertCurrent()
      if (result === undefined) return
      if (result.ok !== true) throw new AdminAccessError()
      assertCurrent()
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
        className='rp-focus min-h-[44px] min-w-[44px] text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-ink)]'
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
function RecentListContent({ slug }: { slug: string }) {
  const { runExplicit, sessionAccess, sessionAllowed, pending } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const [snapshot, setSnapshot] = useState<RecentResource[]>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['admin-recent', slug],
    queryFn: () => readRecent(slug, sessionAccess),
    enabled: sessionAllowed,
    retry: false,
    // A stuck link stays pending until it is deleted, so it does not keep the list polling.
    refetchInterval: (query) =>
      sessionAllowed && query.state.data?.some((r) => r.status === 'pending' && !r.stuck)
        ? 4000
        : false,
  })

  const { isLoading, isError } = query
  const data = sessionAllowed ? query.data : snapshot
  const refresh = async () => {
    setError(undefined)
    try {
      const result = await runExplicit(
        'Read recent additions',
        (access) => readRecent(slug, access),
      )
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) queryClient.setQueryData(['admin-recent', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setError(errorMessage(err, 'Could not load recent additions.'))
    }
  }
  const onChanged = () => queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] })
  const onDeleted =
    (resource: RecentResource) => (outcome: Parameters<typeof deletedNotice>[1]) => {
      setNotice(deletedNotice(resource.title, outcome))
      // A snapshot taken with emergency access is not refetched: drop the row from it here.
      setSnapshot((rows) => rows?.filter((row) => row.id !== resource.id))
      // The row, and the control that had focus, go: focus the list instead of the page body.
      heading.current?.focus()
    }

  return (
    <div>
      <h3 ref={heading} tabIndex={-1} className='text-sm font-medium text-ink'>
        Recent additions
      </h3>
      <button
        type='button'
        className='rp-btn rp-btn-outline mt-3 min-h-[44px] h-auto whitespace-normal py-2'
        style={{ height: 'auto', minHeight: '44px', paddingBlock: '0.5rem' }}
        disabled={pending}
        onClick={() => void refresh()}
      >
        Refresh recent additions
      </button>
      {!sessionAllowed && (
        <p className='mt-2 text-xs text-ink-3'>
          This is a snapshot. Refresh explicitly to check processing or visibility changes.
        </p>
      )}
      {error && <p role='alert' className='mt-2 text-sm text-[var(--rp-bad-ink)]'>{error}</p>}
      <p role='status' className='text-sm text-ink-2 [&:not(:empty)]:mt-2'>{notice}</p>

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
                <StatusChip status={resource.status} stuck={resource.stuck} />
                <VisibilityControl
                  slug={slug}
                  resource={resource}
                  onChanged={onChanged}
                />
                <DeleteDocumentButton
                  slug={slug}
                  document={resource}
                  onDeleted={onDeleted(resource)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {data?.some((resource) => resource.stuck) && (
        <p className='mt-2 text-xs text-ink-3'>
          A stuck link was never processed. Its space still counts against the storage limit until
          you delete it.
        </p>
      )}
    </div>
  )
}

/** Authority generations own form state and emergency snapshots. */
export function RecentList(props: { slug: string }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <RecentListContent key={`${props.slug}:${authority.generation}`} {...props} />
}
