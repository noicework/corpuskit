import type { Scope } from '@research-portal/core'
import type { Context, Hono } from 'hono'
import {
  type AuditEvent,
  AuditQueryError,
  type AuditQueryFilters,
  canonicalAuditFilters,
  validateAuditReadFilter,
} from './audit.ts'
import { AUDIT_MAX_RESPONSE_BYTES } from './audit-execution.ts'
import { declaredRoute } from './permissions.ts'
import type { AuditSnapshot, RbacState } from './rbac-state.ts'

export const AUDIT_PAGE_BYTES = Math.min(512 * 1024, AUDIT_MAX_RESPONSE_BYTES - 1)
const CURSOR_BYTES = 1024
const encoder = new TextEncoder()
interface Cursor {
  v: 1
  snapshotId: string
  last: { at: string; id: string }
}
const encodeCursor = (cursor: Cursor): string =>
  btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function decodeCursor(value: string, scope: Scope): Cursor {
  try {
    if (value.length > CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const cursor = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')))
    if (
      !cursor || Object.keys(cursor).sort().join(',') !== 'last,snapshotId,v' || cursor.v !== 1 ||
      typeof cursor.snapshotId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        cursor.snapshotId,
      )
    ) throw new Error()
    validateAuditReadFilter({ scope, cursor: cursor.last })
    if (!cursor.last || encodeCursor(cursor) !== value) throw new Error()
    return cursor
  } catch {
    throw new AuditQueryError('invalid_audit_query')
  }
}

const columns: readonly (keyof AuditEvent)[] = [
  'id',
  'at',
  'request_id',
  'actor_kind',
  'actor_id',
  'actor_label',
  'action',
  'scope_kind',
  'scope_slug',
  'target_kind',
  'target_id',
  'outcome',
  'detail_json',
]

/** Quote every cell, including headings, and neutralise spreadsheet expression prefixes. */
export function auditCsvCell(value: unknown): string {
  let text = value === null ? '' : String(value)
  if (/^[\p{Cc}\p{Cf}]|^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
const csvRow = (event: AuditEvent): string =>
  columns.map((key) => auditCsvCell(event[key])).join(',') + '\r\n'

interface AuditRouteServices {
  authorise(c: Context): Promise<unknown>
  state(): RbacState
}

/** All handlers remain inside the app's required intent/completion response boundary. */
export function registerAuditRoutes(app: Hono, services: AuditRouteServices): void {
  for (const domain of ['portal', 'platform'] as const) {
    const base = domain === 'portal' ? '/api/admin/t/:slug/audit' : '/api/admin/audit'
    for (const exporting of [false, true]) {
      app.get(declaredRoute('GET', base + (exporting ? '/export' : '')), async (c) => {
        await services.authorise(c)
        c.header('Cache-Control', 'private, no-store')
        const scope: Scope = domain === 'portal'
          ? { kind: 'portal', slug: c.req.param('slug')! }
          : { kind: 'platform' }
        try {
          const params = new URL(c.req.url).searchParams
          const allowed = [
            'actorKind',
            'actorId',
            'action',
            'outcome',
            'requestId',
            'from',
            'to',
            'limit',
            'cursor',
            ...(exporting ? ['format'] : []),
          ]
          for (const key of params.keys()) {
            if (!allowed.includes(key) || params.getAll(key).length !== 1) {
              throw new AuditQueryError('invalid_audit_query')
            }
          }
          const format = params.get('format') ?? 'json'
          if (!['json', 'csv'].includes(format)) throw new AuditQueryError('invalid_audit_query')
          const rawLimit = params.get('limit') ?? '100'
          if (!/^[1-9][0-9]{0,3}$/.test(rawLimit)) throw new AuditQueryError('invalid_audit_query')
          const limit = Number(rawLimit)
          const filters = canonicalAuditFilters(
            Object.fromEntries(
              [...params].filter(([key]) => !['limit', 'cursor', 'format'].includes(key)),
            ) as AuditQueryFilters,
          )
          validateAuditReadFilter({ scope, ...filters, limit })
          const cursor = params.has('cursor') ? decodeCursor(params.get('cursor')!, scope) : null
          const state = services.state()
          const snapshot: AuditSnapshot = cursor
            ? state.loadAuditSnapshot(cursor.snapshotId, scope, filters)
            : state.createAuditSnapshot(scope, filters)
          const query = { scope, ...filters, snapshotSequence: snapshot.watermark }
          const rows = state.audit.read({
            ...query,
            limit,
            ...(cursor ? { cursor: cursor.last } : {}),
          })
          const parts: string[] = []
          const items: AuditEvent[] = []
          const heading = columns.map(auditCsvCell).join(',') + '\r\n'
          // Reserve the bounded JSON envelope/cursor, or CSV metadata, before adding any row.
          let bytes = 1024 + (format === 'csv' ? encoder.encode(heading).byteLength : 0)
          for (const row of rows) {
            const part = format === 'csv' ? csvRow(row) : JSON.stringify(row)
            const size = encoder.encode(part).byteLength + (format === 'json' ? 1 : 0)
            if (bytes + size > AUDIT_PAGE_BYTES) {
              if (!items.length) return c.json({ error: 'audit_record_too_large' }, 413)
              break
            }
            bytes += size
            parts.push(part)
            items.push(row)
          }
          const last = items.at(-1)
          const more = items.length < rows.length || (last !== undefined && rows.length === limit &&
            state.audit.read({ ...query, limit: 1, cursor: { at: last.at, id: last.id } }).length >
              0)
          const nextCursor = more && last
            ? encodeCursor({ v: 1, snapshotId: snapshot.id, last: { at: last.at, id: last.id } })
            : null
          const info = { id: snapshot.id, expiresAt: snapshot.expiresAt }
          if (format === 'csv') {
            c.header('Content-Type', 'text/csv; charset=utf-8')
            c.header('Content-Disposition', 'attachment; filename="audit.csv"')
            c.header('X-Audit-Next-Cursor', nextCursor ?? '')
            c.header('X-Audit-Complete', String(!more))
            c.header('X-Audit-Snapshot-Id', snapshot.id)
            c.header('X-Audit-Snapshot-Expires-At', snapshot.expiresAt)
            return c.body(heading + parts.join(''))
          }
          // Rows were serialised and measured above; no unbounded streaming producer escapes.
          return c.json({ items, nextCursor, snapshot: info, complete: !more })
        } catch (error) {
          if (!(error instanceof AuditQueryError)) throw error
          return c.json(
            { error: error.code },
            error.code === 'snapshot_expired' ? 410 : error.code === 'snapshot_limit' ? 429 : 400,
          )
        }
      })
    }
  }
}
