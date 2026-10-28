import type { AgentAskEvent } from '@research-portal/core'
import type { InsightsStoreApi } from './stores.ts'

/** The same server-clock fields ordinary Ask writes, retained by the existing insights stores. */
export async function* measureAgentAnswer(
  events: AsyncIterable<AgentAskEvent>,
  host: string,
  question: string,
  insights: InsightsStoreApi,
  now: () => number = () => performance.now(),
): AsyncGenerator<AgentAskEvent> {
  const received = now()
  let firstWordsAt: number | undefined
  let finished = false
  const citations = new Set<string>()
  try {
    for await (const event of events) {
      if (event.type === 'delta' && event.text.trim()) firstWordsAt ??= now()
      if (event.type === 'citation') citations.add(event.marker)
      if (event.type === 'done') finished = true
      yield event
    }
  } finally {
    try {
      insights.record(host, {
        ts: new Date().toISOString(),
        question: question.slice(0, 500),
        answered: finished && citations.size > 0,
        citations: citations.size,
        // The composer does not report provider usage. Do not substitute server time for it.
        durationSec: null,
        answerRelevance: null,
        groundedness: null,
        contextRelevance: null,
        firstTokenSec: firstWordsAt === undefined
          ? null
          : Math.max(0, firstWordsAt - received) / 1000,
        answerSec: Math.max(0, now() - received) / 1000,
      })
    } catch {
      // As on ordinary Ask, insights are best-effort and never fail the answer.
    }
  }
}
