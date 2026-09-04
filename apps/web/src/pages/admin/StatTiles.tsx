import { useQuery } from '@tanstack/react-query'
import { getAdminCounters } from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'

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
 * size (from the live /counters endpoint). Fails silently - if counters
 * can't be fetched the strip just isn't shown.
 */
export function StatTiles({
  slug,
  passcode,
  resourceCount,
}: {
  slug: string
  passcode: string
  resourceCount: number
}) {
  const { data, isError } = useQuery({
    queryKey: ['admin-counters', slug],
    queryFn: () => getAdminCounters(slug, passcode),
  })

  if (isError) return null

  return (
    <dl className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
      <StatTile label='Documents' value={String(resourceCount)} />
      <StatTile label='Paragraphs' value={data ? String(data.paragraphs) : null} />
      <StatTile label='Sentences' value={data ? String(data.sentences) : null} />
      <StatTile label='Index MB' value={data ? data.indexMb.toFixed(1) : null} />
    </dl>
  )
}
