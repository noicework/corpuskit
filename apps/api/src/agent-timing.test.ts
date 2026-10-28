import { expect } from '@std/expect'
import type { AgentAskEvent } from '@research-portal/core'
import { measureAgentAnswer } from './agent-timing.ts'
import type { AskInsight, InsightsStoreApi } from './stores.ts'
import { createEnforcementFixture, sessionFor } from './enforcement-fixture.ts'

Deno.test('agent timing records server time, verified citations and failures in existing fields', async () => {
  for (const failure of [false, true]) {
    let now = 100
    const records: AskInsight[] = []
    const insights = { record: (_slug: string, value: AskInsight) => records.push(value) }
    const events = async function* (): AsyncGenerator<AgentAskEvent> {
      now = 350
      yield { type: 'delta', text: 'Early words.' }
      now = 450
      yield { type: 'citation', marker: '1', sourceId: 'a', chunkId: 'a/doc', title: 'Evidence' }
      now = 1000
      if (failure) throw new Error('upstream')
      yield { type: 'done', elapsedMs: 90_000, text: 'Checked words. [1]' }
    }
    try {
      for await (
        const _event of measureAgentAnswer(
          events(),
          'a',
          'Question',
          insights as unknown as InsightsStoreApi,
          () => now,
        )
      ) { /* consume */ }
    } catch { /* the failing provider is still measured */ }
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      firstTokenSec: 0.25,
      answerSec: 0.9,
      durationSec: null,
      answered: !failure,
      citations: 1,
    })
  }
})

Deno.test('agent ask response timings reach the existing usage report on the host portal', async () => {
  const f = createEnforcementFixture()
  try {
    f.advance(Date.now() - f.now())
    const response = await f.requestAs(sessionFor('viewer', 'a', f.now()), '/api/t/a/ask-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Abalone evidence #compose' }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"done"')
    const [record] = f.stores.insights.asksBetween('a', 0, Date.now() + 86_400_000).asks
    expect(record!.answered).toBe(true)
    expect(record!.firstTokenSec).toBeGreaterThanOrEqual(0)
    expect(record!.answerSec!).toBeGreaterThanOrEqual(record!.firstTokenSec!)
    const month = record!.ts.slice(0, 7)
    const report = await f.requestAs(
      sessionFor('portal-admin', 'a', f.now()),
      `/api/admin/t/a/insights/usage?month=${month}`,
    )
    expect(report.status).toBe(200)
    const usage = await report.json()
    expect(usage.days.some((day: { timedAnswers: number }) => day.timedAnswers === 1)).toBe(true)
  } finally {
    f.close()
  }
})
