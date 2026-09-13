import { useAccess } from '../../components/AccessProvider.tsx'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAdminCounters } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { AdminAccessError, type AdminRequestAccess } from '../../api/break-glass.ts'
import { Skeleton } from '../../components/ui.tsx'

async function readCounters(slug: string, access: AdminRequestAccess) {
  const counters = await getAdminCounters(slug, access)
  if (
    !counters || ![counters.paragraphs, counters.sentences, counters.indexMb].every(Number.isFinite)
  ) {
    throw new AdminAccessError()
  }
  return counters
}

function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
      <dt className='rp-eyebrow text-ink-3'>{label}</dt>
      {value === null
        ? <Skeleton className='mt-1.5 h-5 w-10' />
        : <dd className='mt-1 text-lg font-semibold text-ink'>{value}</dd>}
    </div>
  )
}

/**
 * Four compact stat tiles for a reachable knowledge box: document count
 * (from the overview, already known) plus paragraphs, sentences and index
 * size (from the live /counters endpoint). Emergency reads are local snapshots.
 */
function StatTilesContent({
  slug,
  resourceCount,
}: {
  slug: string
  resourceCount: number
}) {
  const { runExplicit, sessionAccess, sessionAllowed, pending } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const client = useQueryClient()
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof getAdminCounters>>>()
  const [error, setError] = useState<string>()
  const query = useQuery({
    queryKey: ['admin-counters', slug],
    queryFn: () => readCounters(slug, sessionAccess),
    enabled: sessionAllowed,
    retry: false,
  })

  const data = sessionAllowed ? query.data : snapshot
  const refresh = async () => {
    setError(undefined)
    try {
      const result = await runExplicit('Read corpus metrics', async (access) => {
        const counters = await readCounters(slug, access)
        if (
          !counters ||
          ![counters.paragraphs, counters.sentences, counters.indexMb].every(Number.isFinite)
        ) throw new AdminAccessError()
        return counters
      })
      assertCurrent()
      if (result === undefined) return
      if (sessionAllowed) client.setQueryData(['admin-counters', slug], result)
      else setSnapshot(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load metrics.')
    }
  }

  return (
    <div className='space-y-3' data-admin-metrics>
      <button
        type='button'
        className='rp-btn rp-btn-outline'
        disabled={pending || query.isFetching}
        onClick={() => void refresh()}
      >
        Refresh metrics
      </button>
      {!sessionAllowed && (
        <p className='text-xs text-ink-3'>
          Metrics are a snapshot. Refresh explicitly to read them again.
        </p>
      )}
      {(error || query.isError) && (
        <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
          {error ?? 'Could not load metrics.'}
        </p>
      )}
      <dl className='grid grid-cols-1 gap-3 sm:grid-cols-4'>
        <StatTile label='Documents' value={String(resourceCount)} />
        <StatTile
          label='Paragraphs'
          value={data ? String(data.paragraphs) : query.isLoading ? null : '-'}
        />
        <StatTile
          label='Sentences'
          value={data ? String(data.sentences) : query.isLoading ? null : '-'}
        />
        <StatTile
          label='Index MB'
          value={data ? data.indexMb.toFixed(1) : query.isLoading ? null : '-'}
        />
      </dl>
    </div>
  )
}

/** Authority generations own form state and emergency snapshots. */
export function StatTiles(props: { slug: string; resourceCount: number }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('content.write', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <StatTilesContent key={`${props.slug}:${authority.generation}`} {...props} />
}
