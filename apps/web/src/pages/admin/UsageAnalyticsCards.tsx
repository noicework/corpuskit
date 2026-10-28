import type { UsageCounts } from '@research-portal/core'
import { SectionHeader } from '../../components/ui.tsx'
import { usePortalLocale } from '../../lib/portal-locale.tsx'

/** Shared by the current Insights snapshot and the selected month's printable report. */
export function UsageAnalyticsCards(
  { totals, headingLevel = 3 }: { totals: UsageCounts; headingLevel?: 3 | 4 },
) {
  const { ui, number } = usePortalLocale()
  const topics = totals.topics ?? []
  const count = (value: number | null) => value === null ? ui('Not reported') : number(value)
  return (
    <div className='grid min-w-0 gap-4 xl:grid-cols-2' data-usage-analytics>
      <section className='rp-card min-w-0 p-5 lg:p-6' data-top-topics>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={headingLevel}
          title={ui('Top topics')}
          description={ui(
            'Questions counted by the topics of their cited documents. A question counts once in each cited topic. Unanswered questions have no citation topic.',
          )}
        />
        {topics.some((t) => t.questions > 0)
          ? (
            <ol className='mt-3 divide-y divide-line'>
              {topics.filter((t) => t.questions > 0).map((topic) => (
                <li key={topic.id} className='flex items-start justify-between gap-3 py-2 text-sm'>
                  <span className='min-w-0 break-words text-ink-2'>{topic.label}</span>
                  <span className='shrink-0 tabular-nums text-ink'>{number(topic.questions)}</span>
                </li>
              ))}
            </ol>
          )
          : (
            <p className='mt-3 text-sm text-ink-3'>
              {ui('No citation topics recorded in this period.')}
            </p>
          )}
      </section>
      <section className='rp-card min-w-0 p-5 lg:p-6' data-evidence-coverage>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={headingLevel}
          title={ui('Evidence coverage by topic')}
          description={ui(
            'Distinct currently held documents cited at least once in this period, out of all documents the topic currently holds. This measures use of the collection, not answer quality or coverage of unanswered questions.',
          )}
        />
        <dl className='mt-3 divide-y divide-line'>
          {topics.map((topic) => (
            <div
              key={topic.id}
              className='flex flex-wrap items-start justify-between gap-2 py-2 text-sm'
            >
              <dt className='min-w-0 break-words text-ink-2'>{topic.label}</dt>
              <dd className='tabular-nums text-ink'>
                {topic.totalDocuments === null
                  ? ui('Catalogue unavailable')
                  : ui('{cited} of {total} documents', {
                    cited: number(topic.citedDocuments ?? 0),
                    total: number(topic.totalDocuments),
                  })}
              </dd>
            </div>
          ))}
        </dl>
        {totals.topics === null && (
          <p className='mt-3 text-sm text-ink-3'>{ui('Records not held for this period.')}</p>
        )}
      </section>
      <section className='rp-card min-w-0 p-5 lg:p-6' data-usage-opens>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={headingLevel}
          title={ui('Reader opens')}
          description={ui(
            'Open rate is the share of cited answers and searches with results that received an open in this period. Opens count interactions, not unique readers.',
          )}
        />
        <dl className='mt-3 grid gap-3 sm:grid-cols-3'>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Opens')}</dt>
            <dd className='mt-1 text-xl tabular-nums text-ink'>{count(totals.opens)}</dd>
          </div>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Open rate')}</dt>
            <dd className='mt-1 text-xl tabular-nums text-ink'>
              {totals.openRate === null
                ? ui('Not reported')
                : number(totals.openRate, { style: 'percent', maximumFractionDigits: 1 })}
            </dd>
          </div>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Mean rank opened')}</dt>
            <dd className='mt-1 text-xl tabular-nums text-ink'>
              {totals.meanOpenRank === null
                ? ui('Not reported')
                : number(totals.meanOpenRank, { maximumFractionDigits: 1 })}
            </dd>
          </div>
        </dl>
      </section>
      <section className='rp-card min-w-0 p-5 lg:p-6' data-usage-consumption>
        <SectionHeader
          className='rp-manage-section-head'
          headingLevel={headingLevel}
          title={ui('Answer consumption and search latency')}
          description={ui(
            'Tokens reported by the provider for this portal’s research answers, including reported retries. Shared platform overhead and other operations are excluded. No prices are applied.',
          )}
        />
        <dl className='mt-3 grid gap-3 sm:grid-cols-2'>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Input tokens')}</dt>
            <dd className='mt-1 text-xl tabular-nums text-ink'>{count(totals.inputTokens)}</dd>
          </div>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Output tokens')}</dt>
            <dd className='mt-1 text-xl tabular-nums text-ink'>{count(totals.outputTokens)}</dd>
          </div>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Answers with token usage')}</dt>
            <dd className='mt-1 tabular-nums text-ink'>{count(totals.consumptionAnswers)}</dd>
          </div>
          <div>
            <dt className='text-xs text-ink-3'>{ui('Search time p50 / p90 / p95')}</dt>
            <dd className='mt-1 break-words tabular-nums text-ink'>
              {[totals.searchP50, totals.searchP90, totals.searchP95].map((s) =>
                s === null
                  ? ui('Not measured')
                  : ui('{count}s', { count: number(s, { minimumFractionDigits: 1 }) })
              ).join(' / ')}
            </dd>
          </div>
        </dl>
        <p className='mt-3 text-xs leading-relaxed text-ink-3'>
          {ui(
            'Search times run from server receipt to response preparation and exclude the reader’s network. These metrics are recorded from this release onwards.',
          )}
        </p>
      </section>
    </div>
  )
}
