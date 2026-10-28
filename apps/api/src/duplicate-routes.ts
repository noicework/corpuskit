import {
  DuplicateDecisionSchema,
  type DuplicateItem,
  type OverlapReport,
  type TenantConfig,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { findCandidates } from './duplicate-matching.ts'
import type { DuplicateReviewStore } from './duplicate-store.ts'
import { declaredRoute } from './permissions.ts'
import type { TenantStoreApi } from './tenants.ts'

const REVIEW_PATH = '/api/admin/t/:slug/duplicates/review'
const ReviewInput = z.object({
  pair: z.string().min(1).max(1024),
  decision: DuplicateDecisionSchema,
}).strict()
const PAGE_SIZE = 50
const DAY = 86_400_000

export interface DuplicateRouteServices {
  provider: RetrievalProvider
  tenants: TenantStoreApi
  duplicates: DuplicateReviewStore
  now?: () => number
  review(
    c: Context,
    slug: string,
    pair: string,
    decision: z.infer<typeof DuplicateDecisionSchema>,
  ): Promise<unknown>
}

/** Escape spreadsheet formulas as well as CSV delimiters, including user-authored titles. */
function cell(value: string | number | boolean): string {
  const text = String(value)
  return `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`
}

export function overlapCsv(report: OverlapReport): string {
  const rows: (string | number | boolean)[][] = [[
    'Collection A',
    'Collection B',
    'Items A',
    'Items B',
    'Shared title pairs',
    'Shared URL pairs',
    'High similarity pairs',
    'Matching pairs',
    'Limited',
    'Example titles',
  ]]
  for (const row of report.rows) {
    rows.push([
      row.left,
      row.right,
      row.leftCount,
      row.rightCount,
      row.sharedTitles,
      row.sharedUrls,
      row.highSimilarity,
      row.matchingPairs,
      row.limited,
      row.examples.map((pair) => `${pair.left.title} / ${pair.right.title}`).join('; '),
    ])
  }
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** Metadata-only reports. Cached per portal for a day; explicit refresh does no generation. */
export function registerDuplicateRoutes(app: Hono, services: DuplicateRouteServices): void {
  const { duplicates, provider, tenants } = services
  const now = services.now ?? Date.now
  const displayItem = (item: DuplicateItem): DuplicateItem => ({
    ...item,
    title: item.title.slice(0, 500),
    summary: item.summary.slice(0, 1000),
    originUrl: item.originUrl?.slice(0, 1024),
    sourceName: item.sourceName?.slice(0, 300),
  })
  const pageOf = (c: Context) =>
    Math.max(1, Math.min(100_000, Math.floor(Number(c.req.query('page')) || 1)))
  const reportFor = async (config: TenantConfig, refresh = false) => {
    const cached = duplicates.cache.get(config.slug)
    if (!refresh && cached && cached.expires > now()) return cached
    const listed = await provider.listResources(config)
    const metadata: DuplicateItem[] = listed.map((resource) => ({
      id: resource.id,
      title: resource.title,
      summary: resource.summary,
      ...(resource.sourceName ? { sourceName: resource.sourceName } : {}),
      ...(resource.originUrl ? { originUrl: resource.originUrl } : {}),
      ...(resource.published ? { published: resource.published } : {}),
    }))
    const report = {
      generatedAt: new Date(now()).toISOString(),
      resourceCount: listed.length,
      ...findCandidates(metadata),
      page: 1,
      pageSize: PAGE_SIZE,
      totalCandidates: 0,
    }
    report.totalCandidates = report.candidates.length
    const result = { report, items: metadata }
    // If a portal was deleted during the read, retain none of its metadata.
    if (tenants.get(config.slug)) {
      duplicates.cache.set(config.slug, { ...result, expires: now() + DAY })
    }
    return result
  }
  const readReview = async (
    config: TenantConfig,
    refresh = false,
    page = 1,
    includeReviewed = true,
  ) => {
    const { report } = await reportFor(config, refresh)
    const reviews = duplicates.reviews(config.slug)
    const candidates = report.candidates.map((pair) => ({ ...pair, ...reviews[pair.id] }))
      .filter((pair) => includeReviewed || !pair.decision)
    return {
      ...report,
      page,
      pageSize: PAGE_SIZE,
      totalCandidates: candidates.length,
      candidates: candidates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((pair) => ({
        ...pair,
        left: displayItem(pair.left),
        right: displayItem(pair.right),
      })),
    }
  }
  app.get(declaredRoute('GET', '/api/admin/t/:slug/duplicates'), async (c) => {
    const config = tenants.get(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    c.header('Cache-Control', 'private, no-store')
    return c.json(await readReview(config, false, pageOf(c), c.req.query('reviewed') !== 'false'))
  })
  app.post(declaredRoute('POST', '/api/admin/t/:slug/duplicates/refresh'), async (c) => {
    const config = tenants.get(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    c.header('Cache-Control', 'private, no-store')
    return c.json(await readReview(config, true, pageOf(c), c.req.query('reviewed') !== 'false'))
  })
  app.post(declaredRoute('POST', REVIEW_PATH), async (c) => {
    const config = tenants.get(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const input = ReviewInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'invalid_request' }, 400)
    const { report } = await reportFor(config)
    if (!report.candidates.some((pair) => pair.id === input.data.pair)) {
      return c.json({ error: 'unknown_pair' }, 404)
    }
    await services.review(c, config.slug, input.data.pair, input.data.decision)
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ok: true })
  })
  const overlap = async (refresh: boolean, page: number): Promise<OverlapReport> => {
    const all = tenants.list(true).map((summary) => tenants.get(summary.slug)!)
      .sort((a, b) => a.slug.localeCompare(b.slug))
    const totalRows = all.length * (all.length - 1) / 2
    const pairs: [TenantConfig, TenantConfig][] = []
    let ordinal = 0
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (ordinal >= (page - 1) * PAGE_SIZE && ordinal < page * PAGE_SIZE) {
          pairs.push([all[i]!, all[j]!])
        }
        ordinal++
      }
    }
    // A request computes only this page's pairs. List each participating portal once.
    const configs = [...new Map(pairs.flat().map((config) => [config.slug, config])).values()]
    const snapshots = new Map<string, Awaited<ReturnType<typeof reportFor>>>()
    for (const config of configs) snapshots.set(config.slug, await reportFor(config, refresh))
    const previous = duplicates.overlapCache
    if (
      previous && previous.report.page === page && previous.report.totalRows === totalRows &&
      previous.snapshots.length === configs.length &&
      previous.snapshots.every((entry, i) =>
        entry.slug === configs[i]!.slug && entry.report === snapshots.get(entry.slug)!.report
      )
    ) return previous.report
    const rows: OverlapReport['rows'] = []
    for (const [leftConfig, rightConfig] of pairs) {
      const left = snapshots.get(leftConfig.slug)!
      const right = snapshots.get(rightConfig.slug)!
      const found = findCandidates([...left.items, ...right.items], left.items.length)
      rows.push({
        left: leftConfig.slug,
        right: rightConfig.slug,
        leftCount: left.report.resourceCount,
        rightCount: right.report.resourceCount,
        sharedTitles: found.candidates.filter((p) => p.signals.includes('title')).length,
        sharedUrls: found.candidates.filter((p) => p.signals.includes('url')).length,
        highSimilarity: found.candidates.filter((p) => p.signals.includes('similarity')).length,
        matchingPairs: found.candidates.length,
        limited: found.limited,
        examples: found.candidates.slice(0, 5).map((pair) => ({
          ...pair,
          left: { id: pair.left.id, title: pair.left.title.slice(0, 500), summary: '' },
          right: { id: pair.right.id, title: pair.right.title.slice(0, 500), summary: '' },
        })),
      })
    }
    const report = {
      generatedAt: new Date(now()).toISOString(),
      rows,
      page,
      pageSize: PAGE_SIZE,
      totalRows,
    }
    duplicates.overlapCache = {
      report,
      snapshots: configs.map((config) => ({
        slug: config.slug,
        report: snapshots.get(config.slug)!.report,
      })),
    }
    return report
  }
  app.get(declaredRoute('GET', '/api/admin/overlap'), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    return c.json(await overlap(false, pageOf(c)))
  })
  app.post(declaredRoute('POST', '/api/admin/overlap/refresh'), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    return c.json(await overlap(true, pageOf(c)))
  })
  app.get(declaredRoute('GET', '/api/admin/overlap/export'), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    c.header('Content-Disposition', 'attachment; filename="collection-overlap.csv"')
    return c.body(overlapCsv(await overlap(false, pageOf(c))), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
    })
  })
}
