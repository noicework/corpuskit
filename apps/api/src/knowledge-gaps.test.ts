import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { GAP_QUESTION_MAX, knowledgeGaps } from './knowledge-gaps.ts'
import type { AskInsight } from './stores.ts'
import { usagePeriod } from './usage-report.ts'

const NOW = Date.parse('2026-10-28T03:00:00Z')

function ask(ts: string, question: string, overrides: Partial<AskInsight> = {}): AskInsight {
  return {
    ts,
    question,
    answered: false,
    citations: 0,
    durationSec: null,
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
    ...overrides,
  }
}

Deno.test("this month's knowledge gaps are the questions answered worst, most asked first", () => {
  const period = usagePeriod('2026-10', 'Australia/Melbourne', NOW)!
  const long = `Which ${'very '.repeat(60)}long question?`
  const gaps = knowledgeGaps([
    // 30 September in Melbourne: last month.
    ask('2026-09-30T13:00:00Z', 'Where are the oyster leases?'),
    ask('2026-10-01T01:00:00Z', 'where are the oyster leases'),
    ask('2026-10-02T01:00:00Z', 'Where are the  oyster leases?', {
      answered: true,
      citations: 1,
      groundedness: 2,
    }),
    // Answered well: not a gap.
    ask('2026-10-02T02:00:00Z', 'What is a stock assessment?', {
      answered: true,
      citations: 3,
      groundedness: 5,
    }),
    ask('2026-10-03T01:00:00Z', long),
    ask('2026-10-04T01:00:00Z', 'What did the 2019 survey find?'),
  ], period)
  expect(gaps.month).toBe('2026-10')
  // The ask log cannot be mapped to topics.
  expect(gaps.topics).toBeNull()
  expect(gaps.questions).toHaveLength(3)
  expect(gaps.questions[0]).toEqual({
    question: 'Where are the oyster leases?',
    asks: 2,
    unanswered: 1,
    weaklyGrounded: 1,
    lastAsked: '2026-10-02T01:00:00Z',
  })
  // Equal counts: the most recently asked first.
  expect(gaps.questions[1]!.question).toBe('What did the 2019 survey find?')
  const shortened = gaps.questions[2]!.question
  expect(Array.from(shortened)).toHaveLength(GAP_QUESTION_MAX)
  expect(shortened.endsWith('…')).toBe(true)
  expect(knowledgeGaps([], period).questions).toEqual([])
})

Deno.test('Insights lists the gaps to curators; the export never carries question text', async () => {
  const f = createEnforcementFixture()
  try {
    // The fixture's clock is 12 September 2026; portal "a" counts in UTC.
    f.stores.insights.record('a', ask('2026-09-03T00:00:00Z', 'Which reefs bleached in 2024?'))
    const curator = f.sessionFor('curator')
    const insights = await (await f.requestAs(curator, '/api/admin/t/a/insights')).json()
    expect(insights.knowledgeGaps).toEqual({
      month: '2026-09',
      questions: [{
        question: 'Which reefs bleached in 2024?',
        asks: 1,
        unanswered: 1,
        weaklyGrounded: 0,
        lastAsked: '2026-09-03T00:00:00Z',
      }],
      topics: null,
    })
    expect((await f.requestAs(f.sessionFor('viewer'), '/api/admin/t/a/insights')).status).toBe(
      403,
    )
    const admin = f.sessionFor('portal-admin')
    for (const format of ['json', 'csv']) {
      const response = await f.requestAs(
        admin,
        `/api/admin/t/a/insights/usage?month=2026-09&format=${format}`,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('reefs')
    }
  } finally {
    f.close()
  }
})

Deno.test('an answer records the response times the portal server measured', async () => {
  const f = createEnforcementFixture()
  try {
    const response = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Abalone evidence' }),
    })
    expect(response.status).toBe(200)
    await response.text()
    const [recorded] = f.stores.insights.asksBetween('a', 0, Date.now() + 86_400_000).asks
    expect(recorded!.answered).toBe(true)
    expect(typeof recorded!.answerSec).toBe('number')
    expect(recorded!.answerSec).toBeGreaterThanOrEqual(0)
    expect(typeof recorded!.firstTokenSec).toBe('number')
    expect(recorded!.firstTokenSec!).toBeLessThanOrEqual(recorded!.answerSec!)
  } finally {
    f.close()
  }
})
