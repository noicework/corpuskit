import { z } from 'zod'

const ResourceId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
export const EvaluationQuestionSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  expectedSources: ResourceId.array().max(50).default([]),
  expectedFacts: z.string().trim().min(1).max(500).array().max(20).default([]),
  shouldDecline: z.boolean().default(false),
}).strict().refine((q) => q.shouldDecline || q.expectedSources.length > 0, {
  message: 'Answerable questions need at least one expected source.',
})
export const EvaluationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  topK: z.number().int().min(1).max(50).default(5),
  questions: EvaluationQuestionSchema.array().min(1).max(20),
}).strict()
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>
export type EvaluationQuestion = z.infer<typeof EvaluationQuestionSchema>
export interface EvaluationSet extends EvaluationInput {
  id: string
  slug: string
  updatedAt: string
}
export interface EvaluationResult {
  question: EvaluationQuestion
  ok: boolean
  retrievalOk: boolean
  askOk: boolean
  detail: string | null
  retrievedIds: string[]
  citedIds: string[]
  retrievalHit: boolean | null
  citationPrecision: number | null
  citationMarkers: number
  unresolvedMarkers: number
  factCoverage: number | null
  declineCorrect: boolean | null
  refused: boolean | null
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}
export interface EvaluationSummary {
  errors: number
  retrievalHitRate: number | null
  citationPrecision: number | null
  factCoverage: number | null
  declineCorrectness: number | null
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}
export interface EvaluationRun {
  id: string
  slug: string
  setId: string
  definition: EvaluationSet
  startedAt: string
  completedAt: string | null
  status: 'running' | 'completed' | 'failed'
  results: EvaluationResult[]
  summary: EvaluationSummary
}

export interface EvaluationSchedule {
  slug: string
  setId: string
  everyDays: 1 | 7
  nextAt: number
  confirmedAsks: number
  updatedAt: string
  /** Persisted delegation to current local assignments only; no tokens or directory claims. */
  owner: { tenantId: string; oid: string }
}
