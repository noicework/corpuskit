import { z } from 'zod'

export const DuplicateDecisionSchema = z.enum(['not-duplicate', 'keep-both'])
export type DuplicateDecision = z.infer<typeof DuplicateDecisionSchema>
export interface DuplicateItem {
  id: string
  title: string
  summary: string
  originUrl?: string
  sourceName?: string
  published?: string
}
export interface DuplicateCandidate {
  id: string
  left: DuplicateItem
  right: DuplicateItem
  score: number
  reasons: string[]
  signals: ('title' | 'url' | 'filename' | 'similarity')[]
  decision?: DuplicateDecision
  reviewedAt?: string
}
export interface DuplicateReport {
  page: number
  pageSize: number
  totalCandidates: number
  generatedAt: string
  resourceCount: number
  limited: boolean
  candidates: DuplicateCandidate[]
}
export interface OverlapRow {
  left: string
  right: string
  leftCount: number
  rightCount: number
  sharedTitles: number
  sharedUrls: number
  highSimilarity: number
  matchingPairs: number
  limited: boolean
  examples: DuplicateCandidate[]
}
export interface OverlapReport {
  page: number
  pageSize: number
  totalRows: number
  generatedAt: string
  rows: OverlapRow[]
}
