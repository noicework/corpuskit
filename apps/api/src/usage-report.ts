import {
  USAGE_COLUMNS,
  type UsageCounts,
  type UsageDay,
  UsageMonthSchema,
  type UsageReport,
} from '@research-portal/core'
import { auditCsvCell } from './audit-routes.ts'
import {
  ANSWER_FEEDBACK_DAYS,
  ANSWER_FEEDBACK_KEEP,
  type AskInsight,
  type AskWindow,
  type FeedbackRating,
  WEAK_GROUNDEDNESS,
} from './stores.ts'

// ---------------------------------------------------------------------------
// The monthly usage report (docs/USAGE-REPORTS.md): a portal's questions, answers, ratings and
// added documents for each day of one calendar month in its timezone, from the records the portal
// keeps. A day a record no longer covers is reported as not held, never as zero.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000
/** Wider than any UTC offset, so a window this far round a month holds every instant of it. */
const OFFSET_MARGIN_MS = 15 * 3600 * 1000

/** The days of one month a report covers, in a portal's timezone. */
export interface UsagePeriod {
  month: string
  /** The IANA timezone the days are counted in. */
  timezone: string
  /** Each day, `YYYY-MM-DD`, up to today while the month is in progress. */
  days: string[]
  inProgress: boolean
  /** Epoch milliseconds: every instant on one of `days` lies from `from` up to `to`. */
  from: number
  to: number
  /** The day an instant falls on in the timezone. */
  localDate: (at: number) => string
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * The period a report for `month` covers, or null for anything but a calendar month no later
 * than the current one. An unrecognised timezone counts in UTC, as the portal's other dates do.
 */
export function usagePeriod(
  month: string,
  timezone: string | undefined,
  now: number,
): UsagePeriod | null {
  if (!UsageMonthSchema.safeParse(month).success) return null
  let format = dayFormatter('UTC')
  if (timezone) {
    try {
      format = dayFormatter(timezone)
    } catch {
      // An unrecognised zone: UTC, as above.
    }
  }
  const localDate = (at: number) => {
    const parts = format.formatToParts(at)
    return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)!.value)
      .join('-')
  }
  const today = localDate(now)
  if (month > today.slice(0, 7)) return null
  const [year, index] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, index, 0)).getUTCDate()
  const days: string[] = []
  for (let day = 1; day <= length; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    if (date > today) break
    days.push(date)
  }
  return {
    month,
    timezone: format.resolvedOptions().timeZone,
    days,
    inProgress: today.startsWith(month),
    from: Date.UTC(year, index - 1, 1) - OFFSET_MARGIN_MS,
    to: Date.UTC(year, index, 1) + OFFSET_MARGIN_MS,
    localDate,
  }
}

/**
 * From when a portal's kept ratings are complete: the retention window, or, once the store holds
 * as many as it keeps, its oldest rating, since older ones may have been dropped for newer.
 */
export function ratingsKeptSince(ratings: readonly FeedbackRating[], now: number): number {
  const window = now - ANSWER_FEEDBACK_DAYS * DAY_MS
  if (ratings.length < ANSWER_FEEDBACK_KEEP) return window
  return Math.max(window, Math.min(...ratings.map((rating) => Date.parse(rating.ts))))
}

/** What a usage report is counted from. */
export interface UsageSources {
  asks: AskWindow
  /** Every rating the portal keeps, and the answers among them its ask log holds. */
  ratings: { records: readonly FeedbackRating[]; matched: ReadonlySet<string> }
  /**
   * When each document added in the period was added (see `AragProvider.addedBetween`), and
   * where the read stopped short; null when the knowledge box could not be read.
   */
  documents: { created: readonly string[]; readBackTo: string | null } | null
}

type AskCounts = Omit<UsageCounts, 'ratings' | 'unhelpfulRatings' | 'documentsAdded'>
type RatingCounts = Pick<UsageCounts, 'ratings' | 'unhelpfulRatings'>

/** The question and answer counts of some asks; all null when they are not held. */
function askCounts(asks: readonly AskInsight[] | null): AskCounts {
  if (!asks) {
    return {
      questions: null,
      answered: null,
      unanswered: null,
      weaklyGrounded: null,
      knowledgeGaps: null,
      scoredAnswers: null,
      averageGroundedness: null,
      timedAnswers: null,
      firstTokenP50: null,
      firstTokenP90: null,
      firstTokenP95: null,
      answerTimeP50: null,
      answerTimeP90: null,
      answerTimeP95: null,
      generationTimed: null,
      generationTimeP50: null,
      generationTimeP90: null,
      generationTimeP95: null,
    }
  }
  const answered = asks.filter((ask) => ask.answered)
  // A score outside the platform's 0 to 5 range is not one.
  const scores = answered.map((ask) => ask.groundedness).filter((score): score is number =>
    typeof score === 'number' && score >= 0 && score <= 5
  )
  const weak = scores.filter((score) => score <= WEAK_GROUNDEDNESS).length
  // Response times of answered questions only: a decline's speed says nothing about answering.
  const firstToken = timesOf(answered.map((ask) => ask.firstTokenSec))
  const answerTime = timesOf(answered.map((ask) => ask.answerSec))
  const generation = timesOf(answered.map((ask) => ask.durationSec))
  return {
    questions: asks.length,
    answered: answered.length,
    unanswered: asks.length - answered.length,
    weaklyGrounded: weak,
    knowledgeGaps: asks.length - answered.length + weak,
    scoredAnswers: scores.length,
    averageGroundedness: scores.length
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
      : null,
    timedAnswers: answerTime.length,
    firstTokenP50: percentile(firstToken, 50),
    firstTokenP90: percentile(firstToken, 90),
    firstTokenP95: percentile(firstToken, 95),
    answerTimeP50: percentile(answerTime, 50),
    answerTimeP90: percentile(answerTime, 90),
    answerTimeP95: percentile(answerTime, 95),
    generationTimed: generation.length,
    generationTimeP50: percentile(generation, 50),
    generationTimeP90: percentile(generation, 90),
    generationTimeP95: percentile(generation, 95),
  }
}

/** The measured times among some values, in ascending order. */
function timesOf(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  ).sort((a, b) => a - b)
}

/**
 * The nearest-rank percentile of ascending values, to one decimal place: the smallest value at or
 * above `p` per cent of them. Null when there are none.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return Math.round(sorted[rank - 1]! * 10) / 10
}

function ratingCounts(ratings: readonly FeedbackRating[] | null): RatingCounts {
  return ratings
    ? { ratings: ratings.length, unhelpfulRatings: ratings.filter((r) => !r.good).length }
    : { ratings: null, unhelpfulRatings: null }
}

function grouped<T>(items: Iterable<T>, day: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = day(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}

/**
 * A portal's usage for the period: each day's counts and the month's. A source's counts are
 * null on the days it does not hold in full: before the ask log's oldest kept ask, past the
 * ratings' retention, or before the knowledge box was read back to.
 */
export function buildUsageReport(
  slug: string,
  period: UsagePeriod,
  sources: UsageSources,
  now: number,
): UsageReport {
  const first = period.days[0]!
  /** The first day wholly after `since`, when that is later than the period's first day. */
  const heldFrom = (since: number | null): string | null => {
    if (since === null) return null
    // A start that cannot be read is no promise of completeness: nothing before now is held.
    const date = period.localDate(Number.isFinite(since) ? since : now)
    const after = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
    return after > first ? after : null
  }
  const asksSince = sources.asks.keptSince === null ? null : Date.parse(sources.asks.keptSince)
  const asksFrom = heldFrom(asksSince)
  // A rating counts only while the ask log holds the answer it rates.
  const ratingsFrom = heldFrom(
    Math.max(ratingsKeptSince(sources.ratings.records, now), asksSince ?? -Infinity),
  )
  const documents = sources.documents
  const documentsFrom = documents?.readBackTo ? heldFrom(Date.parse(documents.readBackTo)) : null
  const held = (from: string | null, date: string) => from === null || date >= from

  const inPeriod = (at: number) => at >= period.from && at < period.to
  const asks = grouped(
    sources.asks.asks.filter((ask) => inPeriod(Date.parse(ask.ts))),
    (ask) => period.localDate(Date.parse(ask.ts)),
  )
  const ratings = grouped(
    sources.ratings.records.filter((rating) =>
      sources.ratings.matched.has(rating.learningId) && inPeriod(Date.parse(rating.ts))
    ),
    (rating) => period.localDate(Date.parse(rating.ts)),
  )
  const added = grouped(
    (documents?.created ?? []).filter((at) => inPeriod(Date.parse(at))),
    (at) => period.localDate(Date.parse(at)),
  )

  const days: UsageDay[] = period.days.map((date) => ({
    date,
    ...askCounts(held(asksFrom, date) ? asks.get(date) ?? [] : null),
    ...ratingCounts(held(ratingsFrom, date) ? ratings.get(date) ?? [] : null),
    documentsAdded: documents && held(documentsFrom, date) ? added.get(date)?.length ?? 0 : null,
  }))
  /** One source's records over the days it holds, or null when it holds none. */
  const across = <T>(from: string | null, groups: Map<string, T[]>): T[] | null => {
    const kept = period.days.filter((date) => held(from, date))
    return kept.length ? kept.flatMap((date) => groups.get(date) ?? []) : null
  }
  const documentsHeld = documents ? across(documentsFrom, added) : null
  return {
    slug,
    month: period.month,
    timezone: period.timezone,
    generatedAt: new Date(now).toISOString(),
    through: period.days.at(-1)!,
    inProgress: period.inProgress,
    days,
    totals: {
      ...askCounts(across(asksFrom, asks)),
      ...ratingCounts(across(ratingsFrom, ratings)),
      documentsAdded: documentsHeld ? documentsHeld.length : null,
    },
    coverage: {
      asks: { from: asksFrom },
      ratings: {
        from: ratingsFrom,
        retentionDays: ANSWER_FEEDBACK_DAYS,
        kept: ANSWER_FEEDBACK_KEEP,
      },
      documents: { from: documents ? documentsFrom : null, available: documents !== null },
    },
  }
}

/** The days of the report a source holds none of: every day from `from` on is past `through`. */
const holdsNone = (from: string | null, report: UsageReport) =>
  from !== null && from > report.through

/** One sentence per source on which of the report's days it holds, for the CSV's header. */
export function usageCoverageNotes(report: UsageReport): string[] {
  const { asks, ratings, documents } = report.coverage
  const span = (from: string | null) =>
    from === null
      ? 'held for every day'
      : holdsNone(from, report)
      ? 'not held for any day of the month; the column is blank'
      : `held from ${from}; earlier days are blank`
  return [
    `Questions and answers: ${span(asks.from)}`,
    `Ratings: kept for ${ratings.retentionDays} days and at most ${ratings.kept} per portal; ${
      span(ratings.from)
    }`,
    documents.available
      ? `Documents added: ${
        documents.from === null
          ? 'read for every day'
          : holdsNone(documents.from, report)
          ? 'could not be read back to this month; the column is blank'
          : `read back to ${documents.from}; earlier days are blank`
      }`
      : 'Documents added: the knowledge box could not be read; the column is blank',
    "Response times: time to first token and answer time are measured by the portal server for each answered question and recorded from this release on; generation time is the knowledge box's own report; search times are not measured; percentiles are nearest-rank",
    'Topics of unanswered questions are not recorded; question text is left out because it can hold personal data',
  ]
}

/** Why a row's cells are blank, or why its totals cover only part of the month. */
function rowNotes(report: UsageReport, date: string | null): string {
  const { asks, ratings, documents } = report.coverage
  const notes: string[] = []
  const note = (from: string | null, missing: string, partial: string) => {
    if (from === null) return
    if (date === null) notes.push(holdsNone(from, report) ? missing : `${partial} from ${from}`)
    else if (date < from) notes.push(missing)
  }
  note(asks.from, 'questions not held', 'question totals')
  note(ratings.from, 'ratings past retention', 'rating totals')
  if (!documents.available) notes.push('documents unavailable')
  else note(documents.from, 'documents not read back this far', 'document totals')
  return notes.join('; ')
}

/** A `#` comment line: no commas or quotes, so it stays one cell and CSV readers can skip it. */
const comment = (text: string) => `# ${text.replace(/[,"\r\n]/g, ' ')}`.trimEnd()

function cell(value: string | number | null, key: string): string {
  if (value === null) return auditCsvCell('')
  // Scores and seconds keep their one decimal place: 4.0, not 4.
  return auditCsvCell(
    key === 'averageGroundedness' || /P(?:50|90|95)$/.test(key) ? Number(value).toFixed(1) : value,
  )
}

/**
 * The report as CSV: `#` comment lines saying what it covers and what each column counts, the
 * heading row, a row per day and a `total` row. Every cell is quoted and spreadsheet formula
 * prefixes are neutralised, as in the audit export.
 */
export function usageReportCsv(report: UsageReport): string {
  const lines = [
    comment('CorpusKit usage report'),
    comment(`Portal: ${report.slug}`),
    comment(
      `Month: ${report.month}${report.inProgress ? ` (in progress: to ${report.through})` : ''}`,
    ),
    comment(`Timezone: ${report.timezone}`),
    comment(`Generated: ${report.generatedAt}`),
    ...usageCoverageNotes(report).map(comment),
    comment(''),
    comment('Columns'),
    ...USAGE_COLUMNS.map((column) => comment(`${column.heading}: ${column.definition}`)),
    USAGE_COLUMNS.map((column) => auditCsvCell(column.heading)).join(','),
  ]
  const row = (counts: UsageCounts, date: string | null) =>
    USAGE_COLUMNS.map((column) =>
      column.key === 'date'
        ? auditCsvCell(date ?? 'total')
        : column.key === 'notes'
        ? auditCsvCell(rowNotes(report, date))
        : cell(counts[column.key], column.key)
    ).join(',')
  for (const day of report.days) lines.push(row(day, day.date))
  lines.push(row(report.totals, null))
  return lines.join('\r\n') + '\r\n'
}
