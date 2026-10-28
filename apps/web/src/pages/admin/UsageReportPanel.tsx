import { UsageAnalyticsCards } from './UsageAnalyticsCards.tsx'
import { USAGE_COLUMNS, type UsageCounts, type UsageReport } from '@research-portal/core'
import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getUsageCsv, getUsageReport } from '../../api/usage-report.ts'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { Download, FileText, Printer } from '../../components/icons.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'
import { type Locale, usePortalLocale } from '../../lib/portal-locale.tsx'

/**
 * The months a report can be read for, newest first: this month in the portal's timezone (UTC
 * when it states none it can use, as the server counts) and the `count - 1` before it.
 */
export function usageMonths(timezone: string | undefined, now: number, count = 24): string[] {
  let year: number
  let month: number
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now)
    year = Number(parts.find((part) => part.type === 'year')!.value)
    month = Number(parts.find((part) => part.type === 'month')!.value)
  } catch {
    const date = new Date(now)
    year = date.getUTCFullYear()
    month = date.getUTCMonth() + 1
  }
  return Array.from({ length: count }, (_, back) => {
    const index = year * 12 + month - 1 - back
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
  })
}

/** A calendar month as a reader names it: "October 2026". */
function monthName(month: string, date: Locale['date']): string {
  return date(`${month}-01T00:00:00Z`, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** A report day, which is already a date in the portal's timezone: never shifted again. */
function dayName(day: string, date: Locale['date'], options: Intl.DateTimeFormatOptions) {
  return date(`${day}T00:00:00Z`, { ...options, timeZone: 'UTC' })
}

/** The sentences saying which of the report's days each source no longer holds. */
function coverageNotes(report: UsageReport, ui: Locale['ui'], date: Locale['date']): string[] {
  const { asks, ratings, documents } = report.coverage
  const when = (day: string) => dayName(day, date, { day: 'numeric', month: 'long' })
  const none = (from: string | null): from is string => from !== null && from > report.through
  const notes: string[] = []
  if (asks.from) {
    notes.push(
      none(asks.from)
        ? ui(
          'The ask log no longer holds the questions from this month, so their counts are blank.',
        )
        : ui(
          'The ask log no longer holds questions from before {date}, so earlier days are blank.',
          {
            date: when(asks.from),
          },
        ),
    )
  }
  if (ratings.from) {
    const values = { days: ratings.retentionDays, kept: ratings.kept, date: when(ratings.from) }
    notes.push(
      none(ratings.from)
        ? ui(
          'Ratings are kept for {days} days, and at most {kept} per portal, so this month has no rating counts.',
          values,
        )
        : ui(
          'Ratings are kept for {days} days, and at most {kept} per portal, so days before {date} have no rating counts.',
          values,
        ),
    )
  }
  if (!documents.available) {
    notes.push(ui('The knowledge box could not be read, so documents added is blank.'))
  } else if (documents.from) {
    notes.push(
      none(documents.from)
        ? ui('The knowledge box could not be read back to this month, so documents added is blank.')
        : ui('The knowledge box was read back to {date} only, so earlier days have no count.', {
          date: when(documents.from),
        }),
    )
  }
  if (notes.length > 0) notes.push(ui('Totals add up the days that are held.'))
  return notes
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className='rp-usage-tile rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
      <dt className='rp-eyebrow text-2xs text-ink-3'>{label}</dt>
      <dd className='mt-1 text-2xl font-semibold tabular-nums text-ink'>{value}</dd>
      {detail && <dd className='mt-0.5 text-xs text-ink-3'>{detail}</dd>}
    </div>
  )
}

/** The month's response times as percentiles: what the portal measured and what it did not. */
function ResponseTimes({ report, month }: { report: UsageReport; month: string }) {
  const { ui, number } = usePortalLocale()
  const { totals } = report
  const rows = [
    {
      label: ui('Search time'),
      values: [totals.searchP50, totals.searchP90, totals.searchP95],
      count: totals.searches,
    },
    {
      label: ui('Time to first token'),
      values: [totals.firstTokenP50, totals.firstTokenP90, totals.firstTokenP95],
      count: totals.timedAnswers,
    },
    {
      label: ui('Answer time'),
      values: [totals.answerTimeP50, totals.answerTimeP90, totals.answerTimeP95],
      count: totals.timedAnswers,
    },
    {
      label: ui('Generation time (knowledge box)'),
      values: [totals.generationTimeP50, totals.generationTimeP90, totals.generationTimeP95],
      count: totals.generationTimed,
    },
  ]
  const seconds = (value: number | null) =>
    value === null
      ? (
        <>
          <span aria-hidden='true'>-</span>
          <span className='sr-only'>{ui('Not measured')}</span>
        </>
      )
      : ui('{count}s', { count: number(value, { minimumFractionDigits: 1 }) })
  return (
    <section className='rp-usage-times'>
      <h4 className='text-sm font-semibold text-ink'>{ui('Response times')}</h4>
      <p className='mt-1 max-w-prose text-sm leading-relaxed text-ink-2'>
        {ui(
          "Percentiles over the month's answered questions. The portal server measures time to first token and answer time from receiving each question; answers from before it measured them have none. Generation time is the knowledge box's own report. Search times run from server receipt to response preparation and exclude the reader’s network.",
        )}
      </p>
      <div
        className='rp-focus relative mt-3 overflow-x-auto'
        role='region'
        aria-label={ui('Response times')}
        tabIndex={0}
      >
        <table className='w-full min-w-[32rem] border-collapse text-sm'>
          <caption className='sr-only'>{ui('Response times for {month}', { month })}</caption>
          <thead>
            <tr className='border-b border-line text-xs text-ink-2'>
              <th scope='col' className='py-2 pr-3 text-left font-semibold'>{ui('Measure')}</th>
              {['p50', 'p90', 'p95'].map((name) => (
                <th key={name} scope='col' className='py-2 pr-3 text-right font-semibold'>
                  {name}
                </th>
              ))}
              <th scope='col' className='py-2 pr-3 text-right font-semibold'>
                {ui('Answers timed')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className='border-b border-line last:border-0'>
                <th scope='row' className='py-1.5 pr-3 text-left font-normal text-ink'>
                  {row.label}
                </th>
                {row.values.map((value, index) => (
                  <td key={index} className='py-1.5 pr-3 text-right tabular-nums text-ink-2'>
                    {seconds(value)}
                  </td>
                ))}
                <td className='py-1.5 pr-3 text-right tabular-nums text-ink-2'>
                  {row.count === null ? ui('Not held') : number(row.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * One month of a portal's usage as a document: the month's totals, which days each source no
 * longer holds, a row per day and what each column counts. The same markup is shown on the page
 * and printed.
 */
export function UsageReportDocument({ report, name }: { report: UsageReport; name: string }) {
  const { ui, number, date } = usePortalLocale()
  // Response times are the month's percentiles, in their own table below.
  const columns = USAGE_COLUMNS.filter((column) =>
    column.key !== 'date' && column.key !== 'notes' && column.key !== 'topics' && !column.timing
  )
  const notes = coverageNotes(report, ui, date)
  const month = monthName(report.month, date)
  const period = {
    from: dayName(report.days[0]?.date ?? report.through, date, { day: 'numeric', month: 'long' }),
    through: dayName(report.through, date, { day: 'numeric', month: 'long', year: 'numeric' }),
    timezone: report.timezone,
  }
  const blank = (label: string) => (
    <>
      <span aria-hidden='true'>-</span>
      <span className='sr-only'>{label}</span>
    </>
  )
  const cell = (counts: UsageCounts, key: keyof UsageCounts) => {
    const value = counts[key]
    if (value !== null && !Array.isArray(value)) {
      return key === 'averageGroundedness'
        ? number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : number(value)
    }
    // A day the ask log holds with no scored answer has no average: that is not a gap.
    return blank(
      key === 'averageGroundedness' && counts.questions !== null ? ui('No score') : ui('Not held'),
    )
  }
  const { totals } = report
  const stat = (value: number | null) => value === null ? ui('Not held') : number(value)
  const share = (part: number | null, whole: number | null) =>
    part === null || !whole ? undefined : ui('{share} of questions', {
      share: number(part / whole, { style: 'percent', maximumFractionDigits: 0 }),
    })
  return (
    <article className='rp-usage-report space-y-5' data-usage-report>
      <header>
        {/* The panel's own heading names the report on screen; the printed page needs it. */}
        <p className='rp-eyebrow rp-usage-eyebrow text-2xs text-ink-3'>
          {ui('Monthly usage report')}
        </p>
        <h3 className='rp-display mt-1 break-words text-xl font-semibold text-ink'>
          {ui('{portal}: {month}', { portal: name, month })}
        </h3>
        <p className='mt-1 text-sm text-ink-2'>
          {report.inProgress
            ? ui('{from} to {through}, month in progress. Days are counted in {timezone}.', period)
            : ui('{from} to {through}. Days are counted in {timezone}.', period)}
        </p>
        <p className='mt-0.5 text-xs text-ink-3'>
          {ui('Generated {when}', {
            when: date(report.generatedAt, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
          })}
        </p>
      </header>

      <dl className='grid grid-cols-[repeat(auto-fit,minmax(min(10rem,100%),1fr))] gap-3'>
        <Tile label={ui('Questions')} value={stat(totals.questions)} />
        <Tile
          label={ui('Answered')}
          value={stat(totals.answered)}
          detail={share(totals.answered, totals.questions)}
        />
        <Tile
          label={ui('Knowledge gaps')}
          value={stat(totals.knowledgeGaps)}
          detail={share(totals.knowledgeGaps, totals.questions)}
        />
        <Tile
          label={ui('Average groundedness')}
          value={totals.averageGroundedness === null
            ? ui('No score')
            : `${number(totals.averageGroundedness, { minimumFractionDigits: 1 })}/5`}
        />
        <Tile
          label={ui('Unhelpful ratings')}
          value={stat(totals.unhelpfulRatings)}
          detail={totals.ratings === null
            ? undefined
            : ui('of {count} ratings', { count: number(totals.ratings) })}
        />
        <Tile label={ui('Documents added')} value={stat(totals.documentsAdded)} />
      </dl>

      {notes.length > 0 && (
        <ul className='rp-usage-notes list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2'>
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}

      {/* Positioned, so the screen-reader text in its cells scrolls with it, not the page. */}
      <div
        className='rp-focus rp-usage-table relative overflow-x-auto'
        role='region'
        aria-label={ui('Usage by day')}
        tabIndex={0}
      >
        <table className='w-full min-w-[64rem] border-collapse text-sm'>
          <caption className='sr-only'>
            {ui('Usage by day for {month}, with the month total last', { month })}
          </caption>
          <thead>
            <tr className='border-b border-line text-xs text-ink-2'>
              <th scope='col' className='py-2 pr-3 text-left align-bottom font-semibold'>
                {ui('Date')}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope='col'
                  className='py-2 pr-3 text-right align-bottom font-semibold'
                >
                  {ui(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.days.map((day) => (
              <tr key={day.date} className='border-b border-line'>
                <th
                  scope='row'
                  className='whitespace-nowrap py-1.5 pr-3 text-left font-normal text-ink'
                >
                  {dayName(day.date, date, { weekday: 'short', day: 'numeric', month: 'short' })}
                </th>
                {columns.map((column) => (
                  <td key={column.key} className='py-1.5 pr-3 text-right tabular-nums text-ink-2'>
                    {cell(day, column.key as keyof UsageCounts)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className='border-t-2 border-line-2 font-semibold'>
              <th scope='row' className='py-2 pr-3 text-left text-ink'>{ui('Total')}</th>
              {columns.map((column) => (
                <td key={column.key} className='py-2 pr-3 text-right tabular-nums text-ink'>
                  {cell(totals, column.key as keyof UsageCounts)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <UsageAnalyticsCards totals={report.totals} headingLevel={4} />
      <ResponseTimes report={report} month={month} />

      <section className='rp-usage-definitions'>
        <h4 className='text-sm font-semibold text-ink'>{ui('What each column counts')}</h4>
        <dl className='mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(10rem,auto)_1fr]'>
          {USAGE_COLUMNS.filter((column) => column.key !== 'notes').map((column) => (
            <div key={column.key} className='contents'>
              <dt className='font-medium text-ink'>{ui(column.label)}</dt>
              <dd className='text-ink-2'>{ui(column.definition)}</dd>
            </div>
          ))}
        </dl>
        <p className='mt-3 text-sm text-ink-2'>
          {ui(
            'Topics of unanswered questions are not recorded, and the questions themselves are left out because they can hold personal data. Curators can read them under Knowledge gaps in Insights.',
          )}
        </p>
      </section>
    </article>
  )
}

/** The usage report's controls: a month, its CSV, and the printable report. */
function UsageReportContent(
  { slug, name, timezone }: { slug: string; name: string; timezone?: string },
) {
  const { ui, date, error: localError } = usePortalLocale()
  const { runExplicit, pending } = usePermissionAdminAccess('audit.export', {
    kind: 'portal',
    slug,
  })
  const authority = useAccess()
  const context = authority.controller.context
  const assertCurrent = () => authority.controller.assertCurrent(context)
  const months = useMemo(() => usageMonths(timezone, Date.now()), [timezone])
  // Monthly reporting is for the month just ended; this month is the next choice up.
  const [month, setMonth] = useState(months[1] ?? months[0]!)
  const [report, setReport] = useState<UsageReport>()
  const [busy, setBusy] = useState<'csv' | 'report'>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const [printing, setPrinting] = useState(false)
  const id = useId()

  const run = async (kind: 'csv' | 'report') => {
    setError(undefined)
    setStatus(undefined)
    setBusy(kind)
    try {
      if (kind === 'report') {
        const result = await runExplicit(
          ui('Read the usage report'),
          (access) => getUsageReport(slug, month, access),
        )
        assertCurrent()
        if (result === undefined) return
        setReport(result)
        setStatus(ui('Report for {month} ready below.', { month: monthName(month, date) }))
        return
      }
      const file = await runExplicit(
        ui('Download the usage report'),
        (access) => getUsageCsv(slug, month, access),
      )
      assertCurrent()
      if (file === undefined) return
      const url = URL.createObjectURL(file.blob)
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = file.filename
        document.body.append(link)
        link.click()
        link.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      setStatus(ui('Downloaded {file}.', { file: file.filename }))
    } catch (err) {
      if (context !== authority.controller.context) return
      setError(localError(err, 'Could not read the usage report.'))
    } finally {
      setBusy(undefined)
    }
  }

  // Print the report alone: a copy outside the app, shown only to the printer.
  useEffect(() => {
    if (!printing) return
    const root = document.documentElement
    const done = () => {
      root.classList.remove('rp-printing-usage')
      setPrinting(false)
    }
    root.classList.add('rp-printing-usage')
    addEventListener('afterprint', done, { once: true })
    const frame = requestAnimationFrame(() => globalThis.print())
    return () => {
      cancelAnimationFrame(frame)
      removeEventListener('afterprint', done)
      root.classList.remove('rp-printing-usage')
    }
  }, [printing])

  return (
    <section className='rp-card p-5 lg:p-6' data-usage-report-panel>
      <SectionHeader
        className='rp-manage-section-head'
        title={ui('Monthly usage report')}
        description={ui(
          'Questions, citation topics, evidence coverage, reader opens, response times and answer tokens for one month, by day in the portal’s timezone. Download CSV or view and print the report.',
        )}
      />
      <div className='mt-4 flex flex-wrap items-end gap-3'>
        <div className='min-w-0 max-w-full'>
          <label htmlFor={`${id}-month`} className='mb-2 block text-sm text-ink-2'>
            {ui('Month')}
          </label>
          <select
            id={`${id}-month`}
            className='rp-input rp-select rp-usage-control w-full min-w-0 sm:w-auto'
            value={month}
            // A result on its way belongs to the month it was asked for.
            disabled={busy !== undefined}
            onChange={(event) => {
              setMonth(event.target.value)
              setReport(undefined)
              setStatus(undefined)
              setError(undefined)
            }}
          >
            {months.map((value, index) => (
              <option key={value} value={value}>
                {index === 0
                  ? ui('{month} (in progress)', { month: monthName(value, date) })
                  : monthName(value, date)}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant='outline'
          leadingIcon={Download}
          className='rp-usage-control'
          disabled={pending || busy !== undefined}
          data-usage-download
          onClick={() => void run('csv')}
        >
          {busy === 'csv' ? ui('Preparing CSV…') : ui('Download CSV')}
        </Button>
        <Button
          variant='outline'
          leadingIcon={FileText}
          className='rp-usage-control'
          disabled={pending || busy !== undefined}
          data-usage-view
          onClick={() => void run('report')}
        >
          {busy === 'report' ? ui('Opening report…') : ui('View report')}
        </Button>
      </div>
      <p role='status' className='mt-3 min-h-5 text-sm text-ink-2' data-usage-status>
        {status}
      </p>
      {error && (
        <p role='alert' className='mt-1 text-sm text-[var(--rp-bad-ink)]'>
          {error}
        </p>
      )}
      {report && (
        <div className='mt-4 border-t border-line pt-5'>
          <div className='mb-4 flex flex-wrap justify-end gap-3'>
            <Button
              variant='outline'
              leadingIcon={Printer}
              className='rp-usage-control'
              data-usage-print-button
              onClick={() => setPrinting(true)}
            >
              {ui('Print report')}
            </Button>
          </div>
          <UsageReportDocument report={report} name={name} />
        </div>
      )}
      {printing && report && createPortal(
        <div className='rp-usage-print' data-usage-print>
          <UsageReportDocument report={report} name={name} />
        </div>,
        document.body,
      )}
    </section>
  )
}

/** Shown to portal administrators, and to emergency access where the deployment allows it. */
export function UsageReportPanel(props: { slug: string; name: string; timezone?: string }) {
  const authority = useAccess()
  const access = usePermissionAdminAccess('audit.export', { kind: 'portal', slug: props.slug })
  if (authority.state.status !== 'ready' || (!access.sessionAllowed && !access.breakGlassEnabled)) {
    return null
  }
  return <UsageReportContent key={`${props.slug}:${authority.generation}`} {...props} />
}
