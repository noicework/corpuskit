import type {
  EvaluationQuestion,
  EvaluationResult,
  EvaluationRun,
  EvaluationSummary,
} from '@research-portal/core'
import { citationIntegrity, sseEvents } from '../scripts/lib/ask-stream.ts'

export interface EvaluationAnswer {
  text: string
  refused: boolean
  citations: { index: number; resourceId: string }[]
  verifiedIds: string[]
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}

/** Capture final prose and the existing ask path's REMi and verified-source signals. */
export async function captureEvaluationAnswer(
  response: Response,
  signal?: AbortSignal,
): Promise<EvaluationAnswer> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Ask returned HTTP ${response.status}`)
  }
  const answer: EvaluationAnswer = {
    text: '',
    refused: false,
    citations: [],
    verifiedIds: [],
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
  }
  let done = false
  let error = false
  for await (const event of sseEvents(response, signal)) {
    if (event.type === 'delta' && typeof event.text === 'string') answer.text += event.text
    if (event.type === 'citation') {
      const c = event.citation as { index: number; resourceId: string }
      if (Number.isInteger(c?.index) && typeof c?.resourceId === 'string') answer.citations.push(c)
    }
    if (event.type === 'verified' && typeof event.resourceId === 'string') {
      answer.verifiedIds.push(event.resourceId)
    }
    if (event.type === 'quality') {
      for (const key of ['answerRelevance', 'groundedness', 'contextRelevance'] as const) {
        const value = event[key]
        answer[key] =
          typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5
            ? value
            : null
      }
    }
    if (event.type === 'error') error = true
    if (event.type === 'done') {
      done = true
      answer.refused = event.refused === true
      if (typeof event.text === 'string') answer.text = event.text
    }
  }
  if (!done || error) throw new Error('Ask did not complete successfully')
  return answer
}

/** Null means not measured, never a successful zero-denominator score. */
export function scoreEvaluation(
  question: EvaluationQuestion,
  retrievedIds: string[],
  answer: EvaluationAnswer,
): EvaluationResult {
  const integrity = citationIntegrity(answer.text, new Set(answer.citations.map((c) => c.index)))
  const finalIndices = new Set(integrity.markers)
  const citedIds = [
    ...new Set(answer.citations.filter((c) => finalIndices.has(c.index)).map((c) => c.resourceId)),
  ]
  const accepted = new Set([...question.expectedSources, ...answer.verifiedIds])
  const normalise = (text: string) => text.toLocaleLowerCase('en-AU').replace(/\s+/g, ' ').trim()
  return {
    question,
    ok: true,
    retrievalOk: true,
    askOk: true,
    detail: null,
    retrievedIds,
    citedIds,
    retrievalHit: question.expectedSources.length
      ? retrievedIds.some((id) => question.expectedSources.includes(id))
      : null,
    citationPrecision: citedIds.length
      ? citedIds.filter((id) => accepted.has(id)).length / citedIds.length
      : null,
    citationMarkers: integrity.markers.length,
    unresolvedMarkers: integrity.unresolved.length,
    factCoverage: question.expectedFacts.length
      ? question.expectedFacts.filter((fact) => normalise(answer.text).includes(normalise(fact)))
        .length /
        question.expectedFacts.length
      : null,
    declineCorrect: answer.refused === question.shouldDecline,
    refused: answer.refused,
    answerRelevance: answer.answerRelevance,
    groundedness: answer.groundedness,
    contextRelevance: answer.contextRelevance,
  }
}

export function failedEvaluation(question: EvaluationQuestion, error: string): EvaluationResult {
  return {
    question,
    ok: false,
    retrievalOk: false,
    askOk: false,
    detail: error,
    retrievedIds: [],
    citedIds: [],
    retrievalHit: null,
    citationPrecision: null,
    citationMarkers: 0,
    unresolvedMarkers: 0,
    factCoverage: null,
    declineCorrect: null,
    refused: null,
    answerRelevance: null,
    groundedness: null,
    contextRelevance: null,
  }
}
export function summariseEvaluation(results: EvaluationResult[]): EvaluationSummary {
  const mean = (values: (number | boolean | null)[]) => {
    const measured = values.filter((v) => v !== null).map(Number)
    return measured.length ? measured.reduce((sum, v) => sum + v, 0) / measured.length : null
  }
  return {
    errors: results.filter((r) => !r.ok).length,
    retrievalHitRate: mean(results.map((r) => r.retrievalHit)),
    citationPrecision: mean(results.map((r) => r.citationPrecision)),
    factCoverage: mean(results.map((r) => r.factCoverage)),
    declineCorrectness: mean(results.map((r) => r.declineCorrect)),
    answerRelevance: mean(results.map((r) => r.answerRelevance)),
    groundedness: mean(results.map((r) => r.groundedness)),
    contextRelevance: mean(results.map((r) => r.contextRelevance)),
  }
}

/** Spreadsheet-safe cells, including user-authored questions and source identifiers. */
export function evaluationCsv(run: EvaluationRun): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value)
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  const keys = [
    'retrievalHit',
    'citationPrecision',
    'factCoverage',
    'declineCorrect',
    'answerRelevance',
    'groundedness',
    'contextRelevance',
    'citationMarkers',
    'unresolvedMarkers',
  ] as const
  return [
    [
      'run_id',
      'set_name',
      'started_at',
      'top_k',
      'question',
      'should_decline',
      'ok',
      'retrieval_ok',
      'ask_ok',
      'error',
      'expected_sources',
      'retrieved_sources',
      'cited_sources',
      ...keys,
    ],
    ...run.results.map((
      r,
    ) => [
      run.id,
      run.definition.name,
      run.startedAt,
      run.definition.topK,
      r.question.query,
      r.question.shouldDecline,
      r.ok,
      r.retrievalOk,
      r.askOk,
      r.detail,
      r.question.expectedSources.join(';'),
      r.retrievedIds.join(';'),
      r.citedIds.join(';'),
      ...keys.map((key) => r[key]),
    ]),
  ].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
