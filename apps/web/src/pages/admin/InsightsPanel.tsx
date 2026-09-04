import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AskInsightRow } from '../../api/client.ts'
import { getInsights } from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'

/** Same relative-time shape as the agentic trace table, applied to ISO timestamps. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function formatScore(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}/5`
}

function formatDuration(seconds: number | null): string {
  return seconds === null ? '-' : `${seconds.toFixed(1)}s`
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
      <dt className='rp-eyebrow text-ink-3'>{label}</dt>
      <dd className='mt-1 text-lg font-semibold text-ink'>{value}</dd>
    </div>
  )
}

/**
 * The librarian's ask-analytics dashboard: what people are asking, how well
 * the corpus is answering, and - the hero of the panel - the specific
 * questions the corpus could not ground well, so the librarian knows exactly
 * what content to add next.
 */
export function InsightsPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['admin-insights', slug],
    queryFn: () => getInsights(slug, passcode),
  })

  const onRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-insights', slug] })
    void refetch()
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-ink'>Insights</h3>
          <p className='mt-0.5 text-xs text-ink-3'>
            What people are asking, and where the corpus is falling short.
          </p>
        </div>
        <button
          type='button'
          disabled={isFetching}
          onClick={onRefresh}
          className='rp-btn rp-btn-outline'
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {isLoading && (
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
          </div>
          <Skeleton className='h-40 w-full' />
        </div>
      )}

      {isError && <p className='text-sm text-ink-3'>Could not load insights.</p>}

      {data && data.totalAsks === 0 && (
        <div className='rounded-[var(--rp-radius)] border border-dashed border-line bg-surface-2 p-6'>
          <p className='text-sm font-semibold text-ink'>No questions asked yet</p>
          <p className='mt-1 max-w-xl text-sm leading-relaxed text-ink-2'>
            Insights appear once people start using Ask.
          </p>
        </div>
      )}

      {data && data.totalAsks > 0 && (
        <>
          <dl className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
            <StatTile label='Questions asked' value={String(data.totalAsks)} />
            <StatTile label='Answered' value={String(data.answered)} />
            <StatTile label='Unanswered' value={String(data.unanswered)} />
            <StatTile
              label='Avg groundedness'
              value={data.avgGroundedness === null ? '-' : `${data.avgGroundedness.toFixed(1)}/5`}
            />
          </dl>

          {data.topQuestions.length > 0 && (
            <div className='rp-card p-5'>
              <h4 className='text-sm font-semibold text-ink'>Most asked</h4>
              <ul className='mt-3 divide-y divide-line'>
                {data.topQuestions.map((q, index) => (
                  <li
                    key={index}
                    className='flex items-center justify-between gap-3 py-2 text-sm'
                  >
                    <span className='min-w-0 truncate text-ink-2'>{q.question}</span>
                    <span className='rp-badge rp-badge-quiet shrink-0'>
                      {q.count} {q.count === 1 ? 'ask' : 'asks'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className='rp-card p-5'>
            <h4 className='text-sm font-semibold text-ink'>Knowledge gaps</h4>
            <p className='mt-1 text-xs text-ink-3'>
              Questions the corpus could not answer well - add sources that cover them to close the
              gap.
            </p>
            {data.gaps.length === 0
              ? <p className='mt-3 text-sm text-ink-3'>No gaps found - the corpus is holding up.</p>
              : (
                <ul className='mt-3 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
                  {data.gaps.map((gap, index) => (
                    <li key={index} className='bg-surface px-4 py-2.5'>
                      <div className='flex flex-wrap items-start justify-between gap-2'>
                        <p className='min-w-0 text-sm text-ink'>{gap.question}</p>
                        <span className='rp-badge rp-badge-warn shrink-0'>{gap.reason}</span>
                      </div>
                      <p className='mt-1 text-xs text-ink-3'>{relativeTime(gap.ts)}</p>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div className='rp-card p-5'>
            <h4 className='text-sm font-semibold text-ink'>Recent questions</h4>
            {data.recent.length === 0
              ? <p className='mt-3 text-sm text-ink-3'>Nothing recent.</p>
              : (
                <div className='mt-3 overflow-x-auto'>
                  <table className='w-full min-w-[640px] border-collapse text-sm'>
                    <thead>
                      <tr className='border-b border-line text-left text-xs text-ink-3'>
                        <th className='py-2 pr-3 font-medium'>Question</th>
                        <th className='py-2 pr-3 font-medium'>When</th>
                        <th className='py-2 pr-3 font-medium'>Answered</th>
                        <th className='py-2 pr-3 font-medium'>Citations</th>
                        <th className='py-2 pr-3 font-medium'>Relevance</th>
                        <th className='py-2 pr-3 font-medium'>Grounded</th>
                        <th className='py-2 pr-3 font-medium'>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((row: AskInsightRow, index: number) => (
                        <tr key={index} className='border-b border-line last:border-0'>
                          <td className='max-w-xs truncate py-2 pr-3 text-ink'>{row.question}</td>
                          <td className='py-2 pr-3 text-ink-3'>{relativeTime(row.ts)}</td>
                          <td className='py-2 pr-3'>
                            {row.answered
                              ? <span className='rp-badge rp-badge-ok'>Answered</span>
                              : <span className='rp-badge rp-badge-bad'>Unanswered</span>}
                          </td>
                          <td className='py-2 pr-3 text-ink-2'>{row.citations}</td>
                          <td className='py-2 pr-3 text-ink-2'>
                            {formatScore(row.answerRelevance)}
                          </td>
                          <td className='py-2 pr-3 text-ink-2'>{formatScore(row.groundedness)}</td>
                          <td className='py-2 pr-3 text-ink-2'>
                            {formatDuration(row.durationSec)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </>
      )}
    </div>
  )
}
