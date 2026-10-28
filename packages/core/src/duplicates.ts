import { z } from 'zod'

export const DuplicateDecisionSchema = z.enum(['not-duplicate', 'keep-both'])
export type DuplicateDecision = z.infer<typeof DuplicateDecisionSchema>
export const DuplicateItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  originUrl: z.string().optional(),
  sourceName: z.string().optional(),
  published: z.string().optional(),
})
export type DuplicateItem = z.infer<typeof DuplicateItemSchema>
export const DuplicateCandidateSchema = z.object({
  id: z.string().min(1),
  left: DuplicateItemSchema,
  right: DuplicateItemSchema,
  score: z.number().min(0).max(1),
  reasons: z.string().array().min(1),
  signals: z.enum(['title', 'url', 'filename', 'similarity']).array().min(1),
  decision: DuplicateDecisionSchema.optional(),
  reviewedAt: z.string().datetime().optional(),
})
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>
const Page = {
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  generatedAt: z.string().datetime(),
}
export const DuplicateReportSchema = z.object({
  ...Page,
  totalCandidates: z.number().int().nonnegative(),
  resourceCount: z.number().int().nonnegative(),
  limited: z.boolean(),
  candidates: DuplicateCandidateSchema.array().max(50),
})
export type DuplicateReport = z.infer<typeof DuplicateReportSchema>
export const OverlapRowSchema = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  leftCount: z.number().int().nonnegative(),
  rightCount: z.number().int().nonnegative(),
  sharedTitles: z.number().int().nonnegative(),
  sharedUrls: z.number().int().nonnegative(),
  highSimilarity: z.number().int().nonnegative(),
  matchingPairs: z.number().int().nonnegative(),
  limited: z.boolean(),
  examples: DuplicateCandidateSchema.array().max(5),
})
export type OverlapRow = z.infer<typeof OverlapRowSchema>
export const OverlapReportSchema = z.object({
  ...Page,
  totalRows: z.number().int().nonnegative(),
  rows: OverlapRowSchema.array().max(50),
})
export type OverlapReport = z.infer<typeof OverlapReportSchema>
export const DuplicateReviewResultSchema = z.object({ ok: z.literal(true) })
