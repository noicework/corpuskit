import { z } from 'zod'

export const ANSWER_RECORD_RETENTION_DAYS = 90
export const AnswerRecordRetentionSchema = z.object({
  days: z.number().int().min(1).max(365),
}).strict()

export const AnswerRecordPassageSchema = z.object({
  resourceId: z.string(),
  title: z.string(),
  text: z.string(),
  page: z.number().int().positive().nullable(),
  /** Resource relevance when a paragraph-level score is unavailable. */
  score: z.number().finite().nullable(),
  scoreScope: z.enum(['resource', 'passage', 'unknown']),
  citationIndex: z.number().int().positive().optional(),
})

export const AnswerRecordCallSchema = z.object({
  source: z.string(),
  storeId: z.string().nullable(),
  operation: z.string(),
  status: z.enum(['ok', 'error', 'cancelled']),
  durationMs: z.number().nonnegative(),
})

/** Personal data: question, retrieval queries and passages follow the portal's retention. */
export const AnswerRecordSchema = z.object({
  version: z.literal(1),
  answerId: z.string().uuid(),
  at: z.string().datetime(),
  portal: z.string(),
  surface: z.enum(['ask', 'document', 'agent', 'composed', 'docs']),
  question: z.string(),
  status: z.enum(['answered', 'refused', 'error', 'cancelled']),
  retrievalQueries: z.string().array(),
  retrieved: AnswerRecordPassageSchema.array(),
  cited: AnswerRecordPassageSchema.array(),
  verification: z.object({
    citationsSeen: z.number().int().nonnegative(),
    citationsDropped: z.number().int().nonnegative(),
    sentencesChecked: z.number().int().nonnegative().nullable(),
    sentencesCited: z.number().int().nonnegative().nullable(),
    sentencesDropped: z.number().int().nonnegative(),
    figuresDropped: z.string().array(),
    unsupportedFigures: z.string().array(),
    unsupportedYears: z.string().array(),
    unsupportedContraindications: z.string().array(),
    outcome: z.enum(['checked', 'not_reported']),
  }),
  generation: z.object({
    modelId: z.string().nullable(),
    buildId: z.string().nullable(),
    configurationIds: z.string().array(),
    promptHashes: z.string().array(),
    depth: z.enum(['default', 'deep']),
    images: z.boolean(),
    topK: z.number().nullable(),
    maxTokens: z.number().nullable(),
  }),
  quality: z.object({
    answerRelevance: z.number().finite().nullable(),
    groundedness: z.number().finite().nullable(),
    contextRelevance: z.number().finite().nullable(),
  }),
  timing: z.object({
    durationMs: z.number().nonnegative(),
    providerTotalSec: z.number().nonnegative().nullable(),
    firstChunkSec: z.number().nonnegative().nullable(),
    inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(),
  }),
  calls: AnswerRecordCallSchema.array(),
  /** True if the bounded recorder could not retain every item or complete text. */
  truncated: z.boolean(),
})
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>
export type AnswerRecordPassage = z.infer<typeof AnswerRecordPassageSchema>
export type AnswerRecordCall = z.infer<typeof AnswerRecordCallSchema>
