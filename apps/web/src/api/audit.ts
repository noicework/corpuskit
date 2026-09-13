import { type Scope, ScopeSchema } from '@research-portal/core'
import { z } from 'zod'
import { currentAuthority, type RequestContext } from './access-lifecycle.ts'
import { assertResponseCurrent, authorityFetch, finishResponse } from './break-glass.ts'

export const AUDIT_PAGE_BYTES = 512 * 1024
export const AUDIT_ACTORS = [
  'anonymous',
  'user',
  'break-glass',
  'key',
  'legacy-key',
  'system',
] as const
export const AUDIT_OUTCOMES = ['intent', 'success', 'denied', 'failure', 'uncertain'] as const
// Display/query catalogue only. These names never grant authority.
export const AUDIT_ACTIONS = [
  'local.mutation',
  'assignment.create',
  'assignment.update',
  'assignment.delete',
  'assignment.activate',
  'assignment.denied',
  'migration.admin_emails',
  'request.denied',
  'request.privileged',
  'resource.questions.generate',
  'resource.questions.cache',
  'tenant.appearance.update',
  'tenant.behaviour.update',
  'tenant.access.update',
  'tenant.domain.attach',
  'tenant.domain.detach',
  'suggestion.graph.write',
  'suggestion.taxonomy.write',
  'suggestion.content.write',
  'break_glass.used',
  'break_glass.failed',
  'break_glass.locked',
  'audit.retention',
  'maintenance.run',
  'maintenance.source.sync',
  'maintenance.watch.run',
  'maintenance.enrichment.run',
  'maintenance.questions.run',
] as const
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/).refine((v) =>
  !v.includes('://')
)
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((v) =>
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
)
const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
)
const cursorSchema = z.object({
  v: z.literal(1),
  snapshotId: uuid,
  last: z.object({ at: time, id: identifier }).strict(),
}).strict()
export function parseAuditCursor(value: string) {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const result = cursorSchema.parse(
      JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))),
    )
    if (
      btoa(JSON.stringify(result)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !==
        value
    ) throw new Error()
    return result
  } catch {
    throw new AuditError(400)
  }
}
const querySchema = z.object({
  actorKind: z.enum(AUDIT_ACTORS).optional(),
  actorId: identifier.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  requestId: identifier.optional(),
  from: time.optional(),
  to: time.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
}).strict()
export type AuditQuery = z.infer<typeof querySchema>
export function auditQuery(value: AuditQuery): URLSearchParams {
  try {
    const query = querySchema.parse(value)
    if (query.from && query.to && query.from > query.to) throw new Error()
    if (query.cursor !== undefined) parseAuditCursor(query.cursor)
    const result = new URLSearchParams()
    for (
      const key of [
        'actorKind',
        'actorId',
        'action',
        'outcome',
        'requestId',
        'from',
        'to',
        'limit',
        'cursor',
      ] as const
    ) {
      if (query[key] !== undefined) result.set(key, String(query[key]))
    }
    if (!result.has('limit')) result.set('limit', '100')
    return result
  } catch {
    throw new AuditError(400)
  }
}
const eventSchema = z.object({
  id: identifier,
  at: time,
  request_id: identifier,
  actor_kind: z.enum(AUDIT_ACTORS),
  actor_id: identifier.nullable(),
  actor_label: z.string().max(160).regex(/^[\p{L}\p{N} .,'@()_-]+$/u).nullable(),
  action: z.enum(AUDIT_ACTIONS),
  scope_kind: z.enum(['platform', 'portal']),
  scope_slug: identifier.nullable(),
  target_kind: identifier,
  target_id: identifier.nullable(),
  outcome: z.enum(AUDIT_OUTCOMES),
  detail_json: z.string().max(4096).refine((v) => {
    try {
      const detail = JSON.parse(v)
      return !!detail && typeof detail === 'object' && !Array.isArray(detail) &&
        Object.values(detail).every((value) =>
          ['string', 'boolean'].includes(typeof value) ||
          (typeof value === 'number' && Number.isFinite(value))
        )
    } catch {
      return false
    }
  }),
}).strict()
export type AuditEvent = z.infer<typeof eventSchema>
const pageSchema = z.object({
  items: z.array(eventSchema).max(1000),
  nextCursor: z.string().nullable(),
  snapshot: z.object({ id: uuid, expiresAt: time }).strict(),
  complete: z.boolean(),
}).strict()
export type AuditPage = z.infer<typeof pageSchema>
export type AuditFormat = 'csv' | 'json'
export type AuditExportPage = Pick<AuditPage, 'nextCursor' | 'snapshot' | 'complete'> & {
  bytes: Uint8Array
  contentType: string
}
export class AuditError extends Error {
  constructor(readonly status = 0) {
    super(
      status === 400
        ? 'Check the filters, identifiers and UTC time range, then apply again.'
        : status === 410
        ? 'This event snapshot has expired. Restart to load a new snapshot.'
        : status === 429
        ? 'Too many event snapshots are open. Wait before trying again.'
        : 'Could not load audit events. Try again.',
    )
    this.name = 'AuditError'
  }
}
function fixedScope(scope: Scope): Scope {
  const parsed = ScopeSchema.safeParse(scope)
  if (
    !parsed.success ||
    Object.keys(scope).sort().join(',') !== (scope.kind === 'portal' ? 'kind,slug' : 'kind')
  ) throw new AuditError()
  return Object.freeze(parsed.data)
}
export function parseAuditPage(
  value: unknown,
  suppliedScope: Scope,
  query: AuditQuery = {},
): AuditPage {
  try {
    const scope = fixedScope(suppliedScope)
    auditQuery(query)
    const page = pageSchema.parse(value)
    if (
      page.items.length > (query.limit ?? 100) || page.complete !== (page.nextCursor === null) ||
      new Set(page.items.map((row) => row.id)).size !== page.items.length
    ) throw new Error()
    if (query.cursor && parseAuditCursor(query.cursor).snapshotId !== page.snapshot.id) {
      throw new Error()
    }
    if (page.nextCursor) {
      const next = parseAuditCursor(page.nextCursor), last = page.items.at(-1)
      if (
        !last || next.snapshotId !== page.snapshot.id || next.last.at !== last.at ||
        next.last.id !== last.id || page.nextCursor === query.cursor
      ) throw new Error()
    }
    let previous = query.cursor ? parseAuditCursor(query.cursor).last : null
    for (const row of page.items) {
      if (row.scope_kind === 'platform' ? row.scope_slug !== null : row.scope_slug === null) {
        throw new Error()
      }
      if (
        scope.kind === 'portal' && (row.scope_kind !== 'portal' || row.scope_slug !== scope.slug)
      ) throw new Error()
      if (previous && (row.at > previous.at || (row.at === previous.at && row.id >= previous.id))) {
        throw new Error()
      }
      previous = row
      if (
        (query.actorKind && row.actor_kind !== query.actorKind) ||
        (query.actorId && row.actor_id !== query.actorId) ||
        (query.action && row.action !== query.action) ||
        (query.outcome && row.outcome !== query.outcome) ||
        (query.requestId && row.request_id !== query.requestId) ||
        (query.from && row.at < query.from) || (query.to && row.at > query.to)
      ) throw new Error()
    }
    return page
  } catch {
    throw new AuditError()
  }
}
/** Bound bytes before parsing, including chunked responses without Content-Length. */
export async function readAuditBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new AuditError()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > AUDIT_PAGE_BYTES) throw new AuditError()
    for (;;) {
      const chunk = await reader.read()
      assertResponseCurrent(response)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > AUDIT_PAGE_BYTES) throw new AuditError()
      chunks.push(chunk.value)
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export async function listAudit(
  suppliedScope: Scope,
  query: AuditQuery = {},
  options: RequestContext = {},
): Promise<AuditPage> {
  query = Object.freeze({ ...query })
  const scope = fixedScope(suppliedScope), params = auditQuery(query)
  const authority = options.authority ?? currentAuthority()
  if (options.context) authority?.assertCurrent(options.context)
  if (!authority?.session?.user || !authority.can('audit.read', scope)) throw new AuditError()
  let response: Response | undefined
  try {
    response = await authorityFetch(
      `${
        scope.kind === 'platform'
          ? '/api/admin/audit'
          : `/api/admin/t/${encodeURIComponent(scope.slug)}/audit`
      }?${params}`,
      { cache: 'no-store', headers: { accept: 'application/json' } },
      options,
    )
    if (!response.ok) throw new AuditError(response.status)
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new AuditError()
    }
    const bytes = await readAuditBytes(response)
    const result = parseAuditPage(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      scope,
      query,
    )
    assertResponseCurrent(response)
    return result
  } catch (error) {
    if (error instanceof AuditError || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    throw new AuditError()
  } finally {
    if (response) {
      await response.body?.cancel().catch(() => {})
      finishResponse(response)
    }
  }
}

/** Preserve the server's serialisation; a page is never an aggregate export. */
export async function exportAuditPage(
  suppliedScope: Scope,
  filters: Omit<AuditQuery, 'cursor'>,
  format: AuditFormat,
  cursor?: string,
  options: RequestContext = {},
): Promise<AuditExportPage> {
  const scope = fixedScope(suppliedScope)
  const query = Object.freeze({ ...filters, ...(cursor === undefined ? {} : { cursor }) })
  const params = auditQuery(query)
  if (!['csv', 'json'].includes(format) || 'cursor' in filters) throw new AuditError(400)
  params.set('format', format)
  const authority = options.authority ?? currentAuthority()
  if (options.context) authority?.assertCurrent(options.context)
  if (!authority?.session?.user || !authority.can('audit.export', scope)) throw new AuditError()
  let response: Response | undefined
  try {
    response = await authorityFetch(
      `${
        scope.kind === 'platform'
          ? '/api/admin/audit'
          : `/api/admin/t/${encodeURIComponent(scope.slug)}/audit`
      }/export?${params}`,
      {
        cache: 'no-store',
        headers: { accept: format === 'csv' ? 'text/csv' : 'application/json' },
      },
      options,
    )
    if (response.status !== 200) throw new AuditError(response.status)
    const contentType = format === 'csv' ? 'text/csv' : 'application/json'
    if (response.headers.get('content-type')?.split(';')[0]?.toLowerCase() !== contentType) {
      throw new AuditError()
    }
    const bytes = await readAuditBytes(response)
    let metadata: Pick<AuditPage, 'nextCursor' | 'snapshot' | 'complete'>
    if (format === 'json') {
      const page = parseAuditPage(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        scope,
        query,
      )
      metadata = { nextCursor: page.nextCursor, snapshot: page.snapshot, complete: page.complete }
    } else {
      const complete = response.headers.get('x-audit-complete')
      const next = response.headers.get('x-audit-next-cursor')
      if (
        !['true', 'false'].includes(complete ?? '') || next === null ||
        (complete === 'true') !== (next === '')
      ) throw new AuditError()
      const snapshot = pageSchema.shape.snapshot.parse({
        id: response.headers.get('x-audit-snapshot-id'),
        expiresAt: response.headers.get('x-audit-snapshot-expires-at'),
      })
      if (cursor && parseAuditCursor(cursor).snapshotId !== snapshot.id) throw new AuditError()
      if (next && (parseAuditCursor(next).snapshotId !== snapshot.id || next === cursor)) {
        throw new AuditError()
      }
      if (!bytes.byteLength) throw new AuditError()
      metadata = { nextCursor: next || null, snapshot, complete: complete === 'true' }
    }
    assertResponseCurrent(response)
    if (!authority.can('audit.export', scope)) throw new AuditError()
    return { bytes, contentType, ...metadata }
  } catch (error) {
    if (error instanceof AuditError || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    throw new AuditError()
  } finally {
    if (response) {
      await response.body?.cancel().catch(() => {})
      finishResponse(response)
    }
  }
}
