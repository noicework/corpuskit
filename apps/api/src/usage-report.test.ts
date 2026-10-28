import { expect } from '@std/expect'
import { USAGE_COLUMNS, UsageReportSchema } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { tenantConfig } from './tenants.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import {
  ANSWER_FEEDBACK_DAYS,
  ANSWER_FEEDBACK_KEEP,
  type AskInsight,
  type FeedbackRating,
  InsightsStore,
} from './stores.ts'
import { DURABLE_ASKS_KEPT } from '../../cloudflare/src/state.ts'
import {
  buildUsageReport,
  percentile,
  ratingsKeptSince,
  usageCoverageNotes,
  usagePeriod,
  usageReportCsv,
  type UsageSources,
} from './usage-report.ts'

const DAY = 86_400_000
const MELBOURNE = 'Australia/Melbourne'
/** 28 October 2026, 14:00 in Melbourne (daylight time, UTC+11). */
const NOW = Date.parse('2026-10-28T03:00:00Z')

function ask(ts: string, overrides: Partial<AskInsight> = {}): AskInsight {
  return {
    ts,
    question: 'Which stocks declined after the heatwave?',
    answered: true,
    citations: 2,
    durationSec: 4,
    answerRelevance: 4,
    groundedness: 4,
    contextRelevance: 3,
    ...overrides,
  }
}

function rating(ts: string, learningId: string, good: boolean): FeedbackRating {
  return { ts, learningId, good }
}

const none: UsageSources = {
  asks: { asks: [], keptSince: null },
  ratings: { records: [], matched: new Set() },
  documents: { created: [], readBackTo: null },
}

Deno.test('a period counts calendar days in the portal timezone, not in UTC', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  expect(period.timezone).toBe(MELBOURNE)
  expect(period.inProgress).toBe(true)
  expect(period.days[0]).toBe('2026-10-01')
  // The month in progress ends today, 28 October in Melbourne.
  expect(period.days.at(-1)).toBe('2026-10-28')
  // Midnight on 1 October is 14:00 UTC the day before (standard time, UTC+10).
  expect(period.localDate(Date.parse('2026-09-30T13:59:59.999Z'))).toBe('2026-09-30')
  expect(period.localDate(Date.parse('2026-09-30T14:00:00Z'))).toBe('2026-10-01')
  // Daylight time starts on 4 October: from 5 October a day begins at 13:00 UTC.
  expect(period.localDate(Date.parse('2026-10-04T12:59:59Z'))).toBe('2026-10-04')
  expect(period.localDate(Date.parse('2026-10-04T13:00:00Z'))).toBe('2026-10-05')

  const september = usagePeriod('2026-09', MELBOURNE, NOW)!
  expect(september.inProgress).toBe(false)
  expect(september.days).toHaveLength(30)
  // The window round the month is wide enough for any offset.
  expect(september.from).toBeLessThanOrEqual(Date.parse('2026-08-31T14:00:00Z'))
  expect(september.to).toBeGreaterThan(Date.parse('2026-09-30T13:59:59Z'))
  expect(usagePeriod('2028-02', 'UTC', Date.parse('2028-03-01T00:00:00Z'))!.days).toHaveLength(29)
})

Deno.test('a period refuses later months and anything that is not a month', () => {
  expect(usagePeriod('2026-11', MELBOURNE, NOW)).toBeNull()
  // 1 November has begun in Melbourne while it is still 31 October in UTC.
  expect(usagePeriod('2026-11', MELBOURNE, Date.parse('2026-10-31T13:30:00Z'))).not.toBeNull()
  expect(usagePeriod('2026-11', 'UTC', Date.parse('2026-10-31T13:30:00Z'))).toBeNull()
  for (const month of ['', '2026-1', '2026-13', '2026-00', '26-10', '2026-10-01', 'October']) {
    expect(usagePeriod(month, MELBOURNE, NOW)).toBeNull()
  }
})

Deno.test('a portal without a recognised timezone is counted in UTC', () => {
  for (const timezone of [undefined, '', 'Not/AZone']) {
    const period = usagePeriod('2026-10', timezone, NOW)!
    expect(period.timezone).toBe('UTC')
    expect(period.localDate(Date.parse('2026-09-30T23:59:59Z'))).toBe('2026-09-30')
  }
})

Deno.test('each day and the month total count asks on their local day', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  const report = buildUsageReport('marine', period, {
    ...none,
    asks: {
      keptSince: null,
      asks: [
        // 30 September in Melbourne: not in October.
        ask('2026-09-30T13:30:00Z'),
        // 1 October in Melbourne, though 30 September in UTC.
        ask('2026-09-30T14:00:00Z', { groundedness: 5 }),
        ask('2026-09-30T20:00:00Z', { groundedness: 2 }),
        ask('2026-10-01T05:00:00Z', { answered: false, citations: 0, groundedness: null }),
        ask('2026-10-01T06:00:00Z', { groundedness: null }),
        // 5 October, the first full day of daylight time.
        ask('2026-10-04T13:00:00Z', { groundedness: 3 }),
        // 1 November in Melbourne: not in October.
        ask('2026-10-31T13:00:00Z'),
      ],
    },
  }, NOW)
  expect(UsageReportSchema.parse(report)).toEqual(report)
  expect(report.days).toHaveLength(28)
  expect(report.days[0]).toMatchObject({
    date: '2026-10-01',
    questions: 4,
    answered: 3,
    unanswered: 1,
    weaklyGrounded: 1,
    knowledgeGaps: 2,
    scoredAnswers: 2,
    averageGroundedness: 3.5,
    ratings: 0,
    unhelpfulRatings: 0,
    documentsAdded: 0,
  })
  expect(report.days[3]).toMatchObject({ date: '2026-10-04', questions: 0, scoredAnswers: 0 })
  expect(report.days[3]!.averageGroundedness).toBeNull()
  expect(report.days[4]).toMatchObject({ date: '2026-10-05', questions: 1, answered: 1 })
  // The total's average is over every scored answer, not an average of daily averages.
  expect(report.totals).toMatchObject({
    questions: 5,
    answered: 4,
    unanswered: 1,
    weaklyGrounded: 1,
    knowledgeGaps: 2,
    scoredAnswers: 3,
    averageGroundedness: 3.3,
    ratings: 0,
    unhelpfulRatings: 0,
    documentsAdded: 0,
  })
  expect(report.coverage).toEqual({
    asks: { from: null },
    ratings: { from: null, retentionDays: ANSWER_FEEDBACK_DAYS, kept: ANSWER_FEEDBACK_KEEP },
    documents: { from: null, available: true },
  })
  // The report carries counts only: no question leaves in it.
  expect(JSON.stringify(report)).not.toContain('heatwave')
  expect(usageReportCsv(report)).not.toContain('heatwave')
})

Deno.test('percentiles are nearest-rank, to one decimal place', () => {
  const sorted = [0.6, 1.2, 1.9, 2.4, 3.05, 3.5, 4.2, 4.8, 7.1, 12.34]
  expect(percentile(sorted, 50)).toBe(3.1)
  expect(percentile(sorted, 90)).toBe(7.1)
  expect(percentile(sorted, 95)).toBe(12.3)
  expect(percentile([2.25], 95)).toBe(2.3)
  expect(percentile([], 50)).toBeNull()
})

Deno.test('response times are percentiles over the timed answers of each day and the month', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  const timed = (ts: string, firstTokenSec: number | null, answerSec: number) =>
    ask(ts, { firstTokenSec, answerSec, durationSec: answerSec - 1 })
  const report = buildUsageReport('marine', period, {
    ...none,
    asks: {
      keptSince: null,
      asks: [
        timed('2026-10-01T01:00:00Z', 1.1, 5),
        timed('2026-10-01T02:00:00Z', 1.5, 7),
        timed('2026-10-01T03:00:00Z', 3.2, 12),
        // No words reached the reader: an answer time, but no time to first token.
        timed('2026-10-02T01:00:00Z', null, 9),
        // A decline is fast, and says nothing about answering.
        ask('2026-10-02T02:00:00Z', {
          answered: false,
          firstTokenSec: 0.2,
          answerSec: 0.4,
          durationSec: null,
        }),
        // Recorded before the portal measured times: the knowledge box's time only.
        ask('2026-10-03T01:00:00Z', { durationSec: 6 }),
      ],
    },
  }, NOW)
  expect(report.days[0]).toMatchObject({
    timedAnswers: 3,
    firstTokenP50: 1.5,
    firstTokenP95: 3.2,
    answerTimeP50: 7,
    answerTimeP90: 12,
    generationTimed: 3,
    generationTimeP50: 6,
  })
  expect(report.days[1]).toMatchObject({ timedAnswers: 1, firstTokenP50: null, answerTimeP50: 9 })
  expect(report.days[2]).toMatchObject({
    timedAnswers: 0,
    answerTimeP50: null,
    generationTimed: 1,
    generationTimeP50: 6,
  })
  // A day with no answers has counts of zero and no times.
  expect(report.days[3]).toMatchObject({ timedAnswers: 0, firstTokenP50: null })
  // The month's percentiles are over every timed answer, not an average of the days'.
  expect(report.totals).toMatchObject({
    timedAnswers: 4,
    firstTokenP50: 1.5,
    firstTokenP90: 3.2,
    answerTimeP50: 7,
    answerTimeP90: 12,
    answerTimeP95: 12,
    generationTimed: 5,
    generationTimeP50: 6,
  })
  const csv = usageReportCsv(report)
  expect(csv).toContain('# timed_answers: ')
  expect(csv).toContain('search times are not measured')
})

Deno.test('ratings count on the day they were given, and only for answers the ask log holds', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  const report = buildUsageReport('marine', period, {
    ...none,
    ratings: {
      records: [
        rating('2026-10-02T01:00:00Z', 'answer-1', false),
        rating('2026-10-02T02:00:00Z', 'answer-2', true),
        // 3 October in Melbourne.
        rating('2026-10-02T14:30:00Z', 'answer-3', false),
        // A rating of an answer the portal never gave is not counted, as in Insights.
        rating('2026-10-02T03:00:00Z', 'made-up-answer', false),
      ],
      matched: new Set(['answer-1', 'answer-2', 'answer-3']),
    },
  }, NOW)
  expect(report.days[1]).toMatchObject({ date: '2026-10-02', ratings: 2, unhelpfulRatings: 1 })
  expect(report.days[2]).toMatchObject({ date: '2026-10-03', ratings: 1, unhelpfulRatings: 1 })
  expect(report.totals).toMatchObject({ ratings: 3, unhelpfulRatings: 2 })
})

Deno.test('documents added count on their local day', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  const report = buildUsageReport('marine', period, {
    ...none,
    documents: {
      created: ['2026-09-30T13:00:00.000Z', '2026-09-30T14:00:00.000Z', '2026-10-27T13:00:00.000Z'],
      readBackTo: null,
    },
  }, NOW)
  expect(report.days[0]!.documentsAdded).toBe(1)
  expect(report.days[27]).toMatchObject({ date: '2026-10-28', documentsAdded: 1 })
  expect(report.totals.documentsAdded).toBe(2)
})

Deno.test('ratings past their retention are reported as not held, never as zero', () => {
  // Reported on 28 October, ratings from before 30 July have aged out.
  const july = buildUsageReport('marine', usagePeriod('2026-07', MELBOURNE, NOW)!, none, NOW)
  expect(july.coverage.ratings.from).toBe('2026-07-31')
  expect(july.days[29]).toMatchObject({ date: '2026-07-30', ratings: null, unhelpfulRatings: null })
  expect(july.days[30]).toMatchObject({ date: '2026-07-31', ratings: 0, unhelpfulRatings: 0 })
  // The other sources still hold the month.
  expect(july.days[0]).toMatchObject({ questions: 0, documentsAdded: 0 })
  // A partial total covers the days held, and says so.
  expect(july.totals.ratings).toBe(0)
  const csv = usageReportCsv(july)
  expect(csv).toContain(
    '# Ratings: kept for 90 days and at most 500 per portal; held from 2026-07-31',
  )
  expect(csv).toContain(
    '"2026-07-30","0","0","0","0","0","0","","","","0","0","","","","","","","0","","","","ratings past retention"',
  )
  expect(csv).toContain('"rating totals from 2026-07-31"')

  const june = buildUsageReport('marine', usagePeriod('2026-06', MELBOURNE, NOW)!, none, NOW)
  expect(june.days.every((day) => day.ratings === null)).toBe(true)
  expect(june.totals.ratings).toBeNull()
  expect(usageCoverageNotes(june)[1]).toContain('not held for any day of the month')
})

Deno.test('a ratings store at its cap is complete only from its oldest rating', () => {
  const ratings = Array.from(
    { length: ANSWER_FEEDBACK_KEEP },
    (_, index) => rating(new Date(NOW - index * 3_600_000).toISOString(), `answer-${index}`, true),
  )
  const since = ratingsKeptSince(ratings, NOW)
  expect(since).toBe(NOW - (ANSWER_FEEDBACK_KEEP - 1) * 3_600_000)
  expect(ratingsKeptSince(ratings.slice(1), NOW)).toBe(NOW - ANSWER_FEEDBACK_DAYS * DAY)
  const report = buildUsageReport('marine', usagePeriod('2026-10', MELBOURNE, NOW)!, {
    ...none,
    ratings: { records: ratings, matched: new Set(ratings.map((r) => r.learningId)) },
  }, NOW)
  // 499 hours before 03:00 UTC on 28 October is 08:00 UTC on 7 October, 19:00 in Melbourne.
  expect(report.coverage.ratings.from).toBe('2026-10-08')
  expect(report.days[6]!.ratings).toBeNull()
  expect(report.days[7]!.ratings).toBeGreaterThan(0)
})

Deno.test('asks the log no longer holds, and days the knowledge box was not read for, are blank', () => {
  const period = usagePeriod('2026-10', MELBOURNE, NOW)!
  const trimmed = buildUsageReport('marine', period, {
    ...none,
    asks: { asks: [ask('2026-10-11T00:00:00Z')], keptSince: '2026-10-10T03:00:00Z' },
    documents: { created: [], readBackTo: '2026-10-20T00:00:00.000Z' },
  }, NOW)
  expect(trimmed.coverage.asks.from).toBe('2026-10-11')
  // A rating is matched through the ask log, so ratings are no more complete than it.
  expect(trimmed.coverage.ratings.from).toBe('2026-10-11')
  expect(trimmed.coverage.documents).toEqual({ from: '2026-10-21', available: true })
  expect(trimmed.days[9]).toMatchObject({ questions: null, ratings: null, documentsAdded: null })
  expect(trimmed.days[10]).toMatchObject({ questions: 1, ratings: 0, documentsAdded: null })
  expect(trimmed.days[20]).toMatchObject({ questions: 0, documentsAdded: 0 })
  expect(trimmed.totals.questions).toBe(1)

  const unavailable = buildUsageReport('marine', period, { ...none, documents: null }, NOW)
  expect(unavailable.coverage.documents).toEqual({ from: null, available: false })
  expect(unavailable.days.every((day) => day.documentsAdded === null)).toBe(true)
  expect(unavailable.totals.documentsAdded).toBeNull()
  const csv = usageReportCsv(unavailable)
  expect(csv).toContain(
    '# Documents added: the knowledge box could not be read; the column is blank',
  )
  expect(csv).toContain('"documents unavailable"')
})

Deno.test('the CSV quotes every cell, neutralises formulas and keeps its comments to one cell', () => {
  const period = usagePeriod('2026-09', 'UTC', NOW)!
  const report = buildUsageReport('marine', period, {
    ...none,
    asks: { asks: [ask('2026-09-03T00:00:00Z', { groundedness: 4 })], keptSince: null },
  }, NOW)
  const csv = usageReportCsv(report)
  expect(csv.endsWith('\r\n')).toBe(true)
  const lines = csv.split('\r\n').slice(0, -1)
  const comments = lines.filter((line) => line.startsWith('#'))
  const rows = lines.filter((line) => !line.startsWith('#'))
  // A comment never splits into cells or opens a quoted field.
  for (const line of comments) expect(line).not.toMatch(/[,"]/)
  expect(comments).toContain('# Portal: marine')
  expect(comments).toContain('# Month: 2026-09')
  expect(comments).toContain('# Timezone: UTC')
  for (const column of USAGE_COLUMNS) {
    expect(comments).toContain(`# ${column.heading}: ${column.definition}`)
  }
  expect(rows[0]).toBe(USAGE_COLUMNS.map((column) => `"${column.heading}"`).join(','))
  expect(rows).toHaveLength(1 + 30 + 1)
  // The answer has a generation time from the knowledge box, but no portal server timings.
  const cells =
    '"1","1","0","0","0","1","4.0","0","0","0","0","","","","","","","1","4.0","4.0","4.0",""'
  expect(rows[3]).toBe(`"2026-09-03",${cells}`)
  expect(rows.at(-1)).toBe(`"total",${cells}`)
  for (const row of rows) {
    expect(row.split(',').every((cell) => /^"[^"]*"$/.test(cell))).toBe(true)
  }

  // Values are never read as spreadsheet formulas, and quotes and commas stay inside their cell.
  const hostile = usageReportCsv({
    ...report,
    slug: 'a,b"c',
    days: [{ ...report.days[0]!, date: '=HYPERLINK("http://example.test")' }],
  })
  expect(hostile).toContain('# Portal: a b c')
  expect(hostile).toContain('"\'=HYPERLINK(""http://example.test"")"')
})

Deno.test('the local ask log reads a window and is never trimmed', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'usage-asks-' })
  try {
    const store = new InsightsStore(directory)
    for (const ts of ['2026-09-30T23:00:00Z', '2026-10-01T01:00:00Z', '2026-11-01T00:00:00Z']) {
      store.record('marine', ask(ts))
    }
    const window = store.asksBetween(
      'marine',
      Date.parse('2026-10-01T00:00:00Z'),
      Date.parse('2026-11-01T00:00:00Z'),
    )
    expect(window.asks.map((item) => item.ts)).toEqual(['2026-10-01T01:00:00Z'])
    expect(window.keptSince).toBeNull()
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('the Durable Object ask log says where its record begins once it is full', () => {
  const f = createEnforcementFixture()
  try {
    const start = Date.parse('2026-09-01T00:00:00Z')
    const asks = Array.from(
      { length: DURABLE_ASKS_KEPT },
      (_, index) => ask(new Date(start + index * 60_000).toISOString()),
    )
    f.state.put('insights:a', asks.slice(1))
    expect(f.stores.insights.asksBetween('a', start, start + DAY).keptSince).toBeNull()
    f.state.put('insights:a', asks)
    const window = f.stores.insights.asksBetween('a', start, start + DAY)
    expect(window.keptSince).toBe('2026-09-01T00:00:00.000Z')
    expect(window.asks).toHaveLength(24 * 60)
  } finally {
    f.close()
  }
})

/** A management surface that answers `addedBetween`, recording each call. */
function knowledgeBox(result: () => Promise<{ created: string[]; readBackTo: string | null }>) {
  const calls: unknown[][] = []
  const management = new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => {
      if (name !== 'addedBetween') return Promise.reject(new Error(`Unexpected ${String(name)}`))
      calls.push(args)
      return result()
    },
  }) as AragProvider
  return { management, calls }
}

Deno.test('the usage route is for portal administrators only', async () => {
  const box = knowledgeBox(() => Promise.resolve({ created: [], readBackTo: null }))
  const f = createEnforcementFixture({ management: box.management })
  try {
    const path = (slug: string) => `/api/admin/t/${slug}/insights/usage?month=2026-09`
    for (const role of ['portal-admin', 'platform-admin', 'owner'] as const) {
      expect((await f.requestAs(f.sessionFor(role), path('a'))).status, role).toBe(200)
    }
    const calls = box.calls.length
    for (const role of ['viewer', 'analyst', 'curator'] as const) {
      expect((await f.requestAs(f.sessionFor(role), path('a'))).status, role).toBe(403)
    }
    // An administrator of another portal, an unassigned person and an anonymous visitor.
    expect((await f.requestAs(f.sessionFor('portal-admin', 'b'), path('a'))).status).toBe(403)
    expect((await f.requestAs(f.unassigned, path('a'))).status).toBe(403)
    for (const slug of ['a', 'public-a']) {
      expect([401, 403]).toContain((await f.requestAs(null, path(slug))).status)
    }
    expect(box.calls.length).toBe(calls)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('the usage route counts the portal month in its timezone, as JSON or a CSV download', async () => {
  const box = knowledgeBox(() =>
    Promise.resolve({ created: ['2026-08-31T15:00:00.000Z'], readBackTo: null })
  )
  const f = createEnforcementFixture({ management: box.management })
  try {
    f.stores.tenants.seed({
      ...tenantConfig('marine')!,
      slug: 'usage',
      accessMode: 'restricted',
      timezone: MELBOURNE,
    })
    // 1 September in Melbourne, though 31 August in UTC.
    f.stores.insights.record('usage', ask('2026-08-31T15:00:00Z', { learningId: 'answer-1' }))
    f.stores.insights.record('usage', ask('2026-08-31T13:00:00Z'))
    f.stores.feedback.record('usage', {
      ts: '2026-09-11T00:00:00.000Z',
      learningId: 'answer-1',
      good: false,
      text: 'The figures are from the wrong year.',
    })
    const admin = f.sessionFor('portal-admin', 'usage')
    const json = await f.requestAs(admin, '/api/admin/t/usage/insights/usage?month=2026-09')
    expect(json.status).toBe(200)
    expect(json.headers.get('cache-control')).toBe('private, no-store')
    const report = UsageReportSchema.parse(await json.json())
    expect(report).toMatchObject({
      slug: 'usage',
      month: '2026-09',
      timezone: MELBOURNE,
      through: '2026-09-12',
      inProgress: true,
    })
    expect(report.days[0]).toMatchObject({ questions: 1, documentsAdded: 1 })
    expect(report.days[10]).toMatchObject({ date: '2026-09-11', ratings: 1, unhelpfulRatings: 1 })
    expect(report.totals).toMatchObject({ questions: 1, unhelpfulRatings: 1, documentsAdded: 1 })
    // The knowledge box is read for the window round the month.
    expect(box.calls[0]![1]).toBe('2026-08-31T09:00:00.000Z')
    expect(box.calls[0]![2]).toBe('2026-10-01T15:00:00.000Z')

    const csv = await f.requestAs(
      admin,
      '/api/admin/t/usage/insights/usage?month=2026-09&format=csv',
    )
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="usage-usage-2026-09.csv"',
    )
    const body = await csv.text()
    expect(body).toContain('# Timezone: Australia/Melbourne')
    expect(body).toContain('"2026-09-01","1","1"')
    // Neither the question nor the reader's comment is exported.
    expect(body).not.toContain('heatwave')
    expect(body).not.toContain('wrong year')
    const events = f.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
    expect(
      events.some((event) =>
        event.action === 'request.privileged' && event.outcome === 'success' &&
        event.scope_slug === 'usage'
      ),
    ).toBe(true)
  } finally {
    f.close()
  }
})

Deno.test('the usage route refuses bad months and parameters, and reports an unreadable box', async () => {
  const box = knowledgeBox(() => Promise.reject(new Error('knowledge box unavailable')))
  const f = createEnforcementFixture({ management: box.management })
  try {
    const admin = f.sessionFor('portal-admin')
    for (
      const query of [
        '',
        '?month=2026-10',
        '?month=2026-9',
        '?month=2026-09&format=xlsx',
        '?month=2026-09&month=2026-08',
        '?month=2026-09&slug=b',
      ]
    ) {
      const response = await f.requestAs(admin, `/api/admin/t/a/insights/usage${query}`)
      expect(response.status, query).toBe(400)
      expect((await response.json()).error).toBe('invalid_request')
    }
    expect(box.calls).toHaveLength(0)
    const report = await (await f.requestAs(admin, '/api/admin/t/a/insights/usage?month=2026-09'))
      .json()
    expect(report.coverage.documents).toEqual({ from: null, available: false })
    expect(report.totals.documentsAdded).toBeNull()
    expect((await f.requestAs(admin, '/api/admin/t/missing/insights/usage?month=2026-09')).status)
      .toBe(403)
  } finally {
    f.close()
  }
})
