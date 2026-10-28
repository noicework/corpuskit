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
  sourceId: z.string().optional(),
  stepId: z.string().optional(),
  chunkId: z.string().optional(),
  peerId: z.string().optional(),
  url: z.string().optional(),
  marker: z.string().optional(),
})

export const AnswerRecordSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  portal: z.string().optional(),
  peerId: z.string().optional(),
  // Older agent drivers may not report either field. Do not invent their topology.
  kind: z.enum(['hosted', 'peer']).nullable(),
  transport: z.enum(['kb', 'mcp']).nullable(),
  storeId: z.string().nullable().optional(),
  endpoint: z.string().optional(),
})

export const AnswerRecordCitationDecisionSchema = z.object({
  marker: z.string(),
  sourceId: z.string().optional(),
  chunkId: z.string().optional(),
  finalMarker: z.string().optional(),
  sentenceIndex: z.number().int().nonnegative().optional(),
  outcome: z.enum(['kept', 'dropped']),
})

export const AnswerRecordAgentSchema = z.object({
  mode: z.enum(['agent', 'orchestrated']).nullable(),
  sources: AnswerRecordSourceSchema.array(),
  steps: z.object({
    id: z.string(),
    module: z.string(),
    title: z.string(),
    status: z.enum(['started', 'completed', 'failed']),
    durationMs: z.number().nonnegative().nullable(),
    reason: z.string().optional(),
  }).array(),
  lookups: z.object({
    stepId: z.string(),
    sourceId: z.string(),
    question: z.string(),
  }).array(),
  failedSources: z.object({
    sourceId: z.string(),
    reason: z.enum(['timeout', 'unauthorised', 'error']),
  }).array(),
  citationCheck: z.enum(['checked', 'not_reported']),
  citationDecisions: AnswerRecordCitationDecisionSchema.array(),
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
  agent: AnswerRecordAgentSchema.optional(),
  /** Fields shortened or omitted by recorder bounds. Older records only have truncated. */
  truncatedFields: z.string().array().optional(),
  /** True if the bounded recorder could not retain every item or complete text. */
  truncated: z.boolean(),
})
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>
export type AnswerRecordPassage = z.infer<typeof AnswerRecordPassageSchema>
export type AnswerRecordCall = z.infer<typeof AnswerRecordCallSchema>
