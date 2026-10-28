import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { USAGE_COLUMNS, type UsageReport } from '@research-portal/core'
import { createPortalLocale, PortalLocaleContext } from '../../lib/portal-locale.tsx'
import { missingPortalMessages } from '../../lib/locale-messages.ts'
import { usageMonths, UsageReportDocument } from './UsageReportPanel.tsx'

const counts = {
  topics: [],
  searches: 0,
  searchP50: null,
  searchP90: null,
  searchP95: null,
  opens: 0,
  openRate: null,
  meanOpenRank: null,
  consumptionAnswers: 0,
  inputTokens: null,
  outputTokens: null,
  questions: 3,
  answered: 2,
  unanswered: 1,
  weaklyGrounded: 0,
  knowledgeGaps: 1,
  scoredAnswers: 2,
  averageGroundedness: 4.5,
  ratings: null,
  unhelpfulRatings: null,
  documentsAdded: 2,
  timedAnswers: 2,
  firstTokenP50: 1.2,
  firstTokenP90: 2.5,
  firstTokenP95: 2.5,
  answerTimeP50: 6.4,
  answerTimeP90: 9,
  answerTimeP95: 9,
  generationTimed: 0,
  generationTimeP50: null,
  generationTimeP90: null,
  generationTimeP95: null,
}

const report: UsageReport = {
  slug: 'marine',
  month: '2026-07',
  timezone: 'Australia/Melbourne',
  generatedAt: '2026-10-28T03:00:00.000Z',
  through: '2026-07-31',
  inProgress: false,
  days: [
    { date: '2026-07-30', ...counts },
    {
      date: '2026-07-31',
      ...counts,
      questions: 0,
      answered: 0,
      unanswered: 0,
      knowledgeGaps: 0,
      scoredAnswers: 0,
      averageGroundedness: null,
      ratings: 1,
      unhelpfulRatings: 1,
    },
  ],
  totals: { ...counts, ratings: 1, unhelpfulRatings: 1, documentsAdded: 4 },
  coverage: {
    asks: { from: null },
    ratings: { from: '2026-07-31', retentionDays: 90, kept: 500 },
    documents: { from: null, available: true },
  },
}

function render(value: UsageReport, language: 'en' | 'ja' = 'en'): string {
  return renderToStaticMarkup(
    <PortalLocaleContext.Provider value={createPortalLocale(language)}>
      <UsageReportDocument report={value} name='Southern Waters <Research>' />
    </PortalLocaleContext.Provider>,
  )
}

describe('Usage report', () => {
  it('offers this month in the portal timezone and the 23 before it, newest first', () => {
    // 1 November has begun in Melbourne while it is still 31 October in UTC.
    const now = Date.parse('2026-10-31T13:30:00Z')
    const months = usageMonths('Australia/Melbourne', now)
    expect(months).toHaveLength(24)
    expect(months.slice(0, 3)).toEqual(['2026-11', '2026-10', '2026-09'])
    expect(months.at(-1)).toBe('2024-12')
    expect(usageMonths(undefined, now)[0]).toBe('2026-10')
    expect(usageMonths('Not/AZone', now)[0]).toBe('2026-10')
  })

  it('is a table with column and row headers, a caption and a total row', () => {
    const markup = render(report)
    expect(markup).toContain('<caption class="sr-only">Usage by day for July 2026')
    const daily = USAGE_COLUMNS.filter((c) => c.key !== 'notes' && c.key !== 'topics' && !c.timing)
    // The daily table's columns, then the response times table's measure, p50 to p95 and count.
    expect(markup.match(/<th scope="col"/g)).toHaveLength(daily.length + 5)
    // One row header per day and one for the total, then one per response time.
    expect(markup.match(/<th scope="row"/g)).toHaveLength(3 + 4)
    expect(markup).toMatch(/<tfoot>.*<th scope="row"[^>]*>Total<\/th>/)
    expect(markup).toContain('role="region"')
    expect(markup).toContain('aria-label="Usage by day"')
    expect(markup).toContain('tabindex="0"')
    // Authored names are text, never markup.
    expect(markup).toContain('Southern Waters &lt;Research&gt;: July 2026')
  })

  it('marks counts that are not held, rather than showing zero, and says why', () => {
    const markup = render(report)
    expect(markup).toContain(
      '<span aria-hidden="true">-</span><span class="sr-only">Not held</span>',
    )
    // A held day with no scored answer has no average: that is not missing data.
    expect(markup).toContain('<span class="sr-only">No score</span>')
    expect(markup).toContain(
      'Ratings are kept for 90 days, and at most 500 per portal, so days before 31 July have no rating counts.',
    )
    expect(markup).toContain('Totals add up the days that are held.')
    expect(markup).toContain('4.5/5')
    expect(markup).toContain('67% of questions')
    for (const column of USAGE_COLUMNS.filter((c) => c.key !== 'notes')) {
      expect(markup).toContain(column.definition.replaceAll("'", '&#x27;'))
    }
  })

  it('gives the month response times as percentiles, and says what is not measured', () => {
    const markup = render(report)
    expect(markup).toContain('<caption class="sr-only">Response times for July 2026</caption>')
    expect(markup).toMatch(/Time to first token<\/th><td[^>]*>1\.2s<\/td><td[^>]*>2\.5s<\/td>/)
    expect(markup).toMatch(/Answer time<\/th><td[^>]*>6\.4s<\/td><td[^>]*>9\.0s<\/td>/)
    // No generation time was reported: not measured, not zero.
    expect(markup).toContain('<span class="sr-only">Not measured</span>')
    expect(markup).toContain('Search times run from server receipt to response preparation')
  })

  it('says so when the knowledge box could not be read', () => {
    const markup = render({
      ...report,
      coverage: { ...report.coverage, documents: { from: null, available: false } },
    })
    expect(markup).toContain('The knowledge box could not be read, so documents added is blank.')
  })

  it('is translated, column definitions included', () => {
    expect(
      missingPortalMessages(
        USAGE_COLUMNS.filter((c) => c.key !== 'notes').flatMap((c) => [c.label, c.definition]),
      ),
    ).toEqual([])
    const markup = render(report, 'ja')
    expect(markup).toContain('月次利用レポート')
    expect(markup).toContain('日別の利用状況')
    expect(markup).not.toContain('What each column counts')
  })
})
