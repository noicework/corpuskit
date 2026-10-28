import {
  type DuplicateDecision,
  DuplicateDecisionSchema,
  type DuplicateItem,
  type DuplicateReport,
  type OverlapReport,
} from '@research-portal/core'
import { z } from 'zod'
import type { SqlExecutor } from './rbac-state.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'

const ReviewSchema = z.object({
  decision: DuplicateDecisionSchema,
  reviewedAt: z.string().datetime(),
}).strict()
type Review = z.infer<typeof ReviewSchema>

/** Same SQL schema on local DATA_DIR/rbac.sqlite and the managed Durable Object. */
export class DuplicateReviewStore {
  private readonly transient = new Map<string, Map<string, Review>>()
  /** Derived metadata only, expires after one day and is never persisted. */
  readonly cache = new Map<
    string,
    { report: DuplicateReport; items: DuplicateItem[]; expires: number }
  >()

  overlapCache?: { snapshots: { slug: string; report: DuplicateReport }[]; report: OverlapReport }

  constructor(
    private readonly database?: SqlExecutor,
    private readonly mutate: <T>(work: () => T) => T = (work) => work(),
  ) {
    database?.exec(`CREATE TABLE IF NOT EXISTS duplicate_reviews (
      slug TEXT NOT NULL, pair TEXT NOT NULL, review TEXT NOT NULL, PRIMARY KEY (slug,pair)
    )`)
  }

  reviews(slug: string): Record<string, Review> {
    KeyPortalSlugSchema.parse(slug)
    if (!this.database) return Object.fromEntries(this.transient.get(slug) ?? [])
    return Object.fromEntries(
      this.database.all<{ pair: string; review: string }>(
        'SELECT pair,review FROM duplicate_reviews WHERE slug = ?',
        slug,
      ).map((row) => [row.pair, ReviewSchema.parse(JSON.parse(row.review))]),
    )
  }

  decide(slug: string, pair: string, decision: DuplicateDecision): Review {
    KeyPortalSlugSchema.parse(slug)
    const review = ReviewSchema.parse({ decision, reviewedAt: new Date().toISOString() })
    return this.mutate(() => {
      if (this.database) {
        this.database.exec(
          'INSERT OR REPLACE INTO duplicate_reviews (slug,pair,review) VALUES (?,?,?)',
          slug,
          pair,
          JSON.stringify(review),
        )
      } else {
        const records = this.transient.get(slug) ?? new Map<string, Review>()
        records.set(pair, review)
        this.transient.set(slug, records)
      }
      return review
    })
  }

  erase(slug: string): number {
    KeyPortalSlugSchema.parse(slug)
    return this.mutate(() => {
      const count = this.database
        ? this.database.all<{ count: number }>(
          'SELECT COUNT(*) AS count FROM duplicate_reviews WHERE slug = ?',
          slug,
        )[0]!.count
        : this.transient.get(slug)?.size ?? 0
      this.database?.exec('DELETE FROM duplicate_reviews WHERE slug = ?', slug)
      this.transient.delete(slug)
      this.cache.delete(slug)
      this.overlapCache = undefined
      return count
    })
  }
}
