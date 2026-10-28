import { type AnswerRecord, AnswerRecordRetentionSchema } from '@research-portal/core'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { declaredRoute } from './permissions.ts'
import { auditCsvCell } from './audit-routes.ts'
import type { AnswerRecordStoreApi } from './answer-record-store.ts'

const BASE = '/api/admin/t/:slug/answer-records'
const PAGE_BYTES = 900 * 1024
const encoder = new TextEncoder()
const time = z.string().datetime().transform((v) => new Date(v).toISOString())
const querySchema = z.object({
  from: time.optional(),
  to: time.optional(),
  cursor: z.string().uuid().optional(),
  format: z.enum(['json', 'csv']).default('json'),
}).strict()
const columns = [
  'answerId',
  'at',
  'portal',
  'surface',
  'question',
  'status',
  'retrievalQueries',
  'retrieved',
  'cited',
  'verification',
  'generation',
  'quality',
  'timing',
  'calls',
  'truncated',
  'mode',
  'sources',
  'steps',
  'sourceQuestions',
  'citationDecisions',
  'failedSources',
  'truncatedFields',
] as const
const csvLine = (r: AnswerRecord) => {
  const row = {
    ...r,
    mode: r.agent?.mode ?? '',
    sources: r.agent?.sources ?? [],
    steps: r.agent?.steps ?? [],
    sourceQuestions: r.agent?.lookups ?? [],
    citationDecisions: r.agent?.citationDecisions ?? [],
    failedSources: r.agent?.failedSources ?? [],
    truncatedFields: r.truncatedFields ?? [],
  }
  return columns.map((key) =>
    auditCsvCell(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])
  )
    .join(',') + '\r\n'
}

export function registerAnswerRecordRoutes(app: Hono, services: {
  store: AnswerRecordStoreApi
  tenant(slug: string): unknown
  notFound(c: Context): Response
}): void {
  const { store } = services
  const exists = (c: Context) => services.tenant(c.req.param('slug')!)
  app.get(declaredRoute('GET', BASE + '/retention'), (c) => {
    if (!exists(c)) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json({ days: store.retention(c.req.param('slug')!) })
  })
  app.put(declaredRoute('PUT', BASE + '/retention'), async (c) => {
    if (!exists(c)) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = AnswerRecordRetentionSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    store.setRetention(c.req.param('slug')!, parsed.data.days)
    return c.json(parsed.data)
  })
  const exportRecords = (single: boolean) => (c: Context) => {
    if (!exists(c)) return c.json({ error: 'unknown_tenant' }, 404)
    const params = new URL(c.req.url).searchParams
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
      return c.json({ error: 'invalid_query' }, 400)
    }
    const parsed = querySchema.safeParse(Object.fromEntries(params))
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400)
    const { from, to, cursor, format } = parsed.data
    if ((from && to && from > to) || (single && (from || to || cursor))) {
      return c.json({ error: 'invalid_query' }, 400)
    }
    const slug = c.req.param('slug')!
    const record = single ? store.get(slug, c.req.param('id')!) : null
    if (single && !record) return services.notFound(c)
    if (cursor) {
      const previous = store.get(slug, cursor)
      if (!previous || (from && previous.at < from) || (to && previous.at > to)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
    }
    const records = single ? [record!] : store.iterate(slug, from, to, cursor)
    let more = false
    const parts: string[] = []
    const items: AnswerRecord[] = []
    const heading = columns.map(auditCsvCell).join(',') + '\r\n'
    let bytes = encoder.encode(heading).byteLength + 1024
    for (const record of records) {
      const part = format === 'csv' ? csvLine(record) : JSON.stringify(record)
      const size = encoder.encode(part).byteLength + 1
      if (bytes + size > PAGE_BYTES) {
        if (!parts.length) return c.json({ error: 'record_too_large' }, 413)
        more = true
        break
      }
      bytes += size
      parts.push(part)
      items.push(record)
    }
    const nextCursor = more ? items.at(-1)!.answerId : null
    c.header('Cache-Control', 'private, no-store')
    c.header('Content-Disposition', `attachment; filename="answer-records-${slug}.${format}"`)
    c.header('X-Content-Type-Options', 'nosniff')
    if (nextCursor) c.header('X-Answer-Records-Next', nextCursor)
    if (format === 'csv') {
      c.header('Content-Type', 'text/csv; charset=utf-8')
      return c.body(heading + parts.join(''))
    }
    return c.json({ records: items, nextCursor })
  }
  app.get(declaredRoute('GET', BASE + '/export'), exportRecords(false))
  app.get(declaredRoute('GET', BASE + '/records/:id/export'), exportRecords(true))
  app.get(declaredRoute('GET', BASE + '/records/:id'), (c) => {
    if (!exists(c)) return c.json({ error: 'unknown_tenant' }, 404)
    const record = store.get(c.req.param('slug')!, c.req.param('id')!)
    if (!record) return services.notFound(c)
    c.header('Cache-Control', 'private, no-store')
    return c.json(record)
  })
}
