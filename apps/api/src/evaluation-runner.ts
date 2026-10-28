import type { EvaluationQuestion, EvaluationResult } from '@research-portal/core'
import {
  captureEvaluationAnswer,
  type EvaluationAnswer,
  failedEvaluation,
  scoreEvaluation,
} from './evaluation-scoring.ts'

/** Keep independently measured retrieval and answer results even when one path fails. */
export async function evaluateQuestion(
  question: EvaluationQuestion,
  topK: number,
  request: (path: string, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<EvaluationResult> {
  let retrievedIds: string[] | null = null
  let answer: EvaluationAnswer | null = null
  const details: string[] = []
  const attempt = async (work: () => Promise<void>) => {
    try {
      signal.throwIfAborted()
      await work()
    } catch (error) {
      details.push(error instanceof Error ? error.message : 'Evaluation request failed')
    }
  }
  await attempt(async () => {
    const response = await request(`/search?q=${encodeURIComponent(question.query)}`, { signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Search returned HTTP ${response.status}`)
    }
    const found = await response.json() as { resources: { id: string }[] }
    retrievedIds = found.resources.slice(0, topK).map((r) => r.id)
  })
  await attempt(async () => {
    answer = await captureEvaluationAnswer(
      await request('/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: question.query }),
        signal,
      }),
      signal,
    )
  })
  const result = answer
    ? scoreEvaluation(question, retrievedIds ?? [], answer)
    : failedEvaluation(question, details.join('; '))
  result.retrievalOk = retrievedIds !== null
  result.askOk = answer !== null
  result.retrievedIds = retrievedIds ?? []
  result.retrievalHit = retrievedIds !== null && question.expectedSources.length
    ? result.retrievedIds.some((id) => question.expectedSources.includes(id))
    : null
  result.ok = result.retrievalOk && result.askOk
  result.detail = details.length ? details.join('; ') : null
  return result
}

/** Abort a pending in-process request as well as its stream; no later question waits on it. */
export async function evaluationRequest(
  request: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted()
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([request(), cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
