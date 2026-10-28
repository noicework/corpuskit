import {
  LabelsetSchema,
  type ResourceSummary,
  ResourceSummarySchema,
  TenantConfigSchema,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import type { Context, Hono } from 'hono'
import type { AuditEvent } from './audit.ts'
import { materialisedBlobResponse } from './audit-execution.ts'
import { auditCsvCell } from './audit-routes.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import { declaredRoute } from './permissions.ts'
import { redactExport, redactExportText } from './portal-export-redaction.ts'
import { ExportLimitError, ExportZip } from './portal-export-zip.ts'
import { rateLimited, SlidingWindowLimiter } from './rate-limit.ts'
import type { RbacState } from './rbac-state.ts'
import type { FeedbackStoreApi, InsightsStoreApi, McpKeyStoreApi, RoutingLogApi } from './stores.ts'
import type { TenantStoreApi } from './tenants.ts'

export const PORTAL_EXPORT_PATH = '/api/admin/t/:slug/export'
export const PORTAL_EXPORT_MAX_BYTES = 8 * 1024 * 1024
export const PORTAL_EXPORT_MAX_RESOURCES = 10_000
export const PORTAL_EXPORT_MAX_AUDIT_EVENTS = 20_000
export const PORTAL_EXPORT_MAX_ROUTING_RECORDS = 5_000

interface ExportServices {
  provider: RetrievalProvider
  tenants: TenantStoreApi
  insights: InsightsStoreApi
  feedback: FeedbackStoreApi
  keys: McpKeyStoreApi
  routing: RoutingLogApi
  lifecycle: PortalLifecycleStore
  state(): RbacState
  configuration(slug: string): unknown
  resource(slug: string, resource: ResourceSummary): ResourceSummary
  audited(
    c: Context,
    includeFeedback: boolean,
    run: (signal: AbortSignal) => Promise<Response>,
  ): Promise<Response>
}

const json = (value: unknown): string => JSON.stringify(redactExport(value)) + '\n'
function* jsonArray(rows: Iterable<unknown>): Generator<string> {
  yield '['
  let first = true
  for (const row of rows) {
    yield (first ? '' : ',') + json(row)
    first = false
  }
  yield ']\n'
}
const auditColumns: readonly (keyof AuditEvent)[] = [
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

/** One bounded download, with no export job, stored copy, token or extra retention surface. */
export function registerPortalExport(app: Hono, services: ExportServices): void {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 })
  const active = new Set<string>()
  app.get(declaredRoute('GET', PORTAL_EXPORT_PATH), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const params = new URL(c.req.url).searchParams
    if (
      [...params.keys()].some((key) => key !== 'includeFeedback') ||
      params.getAll('includeFeedback').length > 1 ||
      (params.has('includeFeedback') && !['true', 'false'].includes(params.get('includeFeedback')!))
    ) return c.json({ error: 'invalid_export_options' }, 400)
    const slug = c.req.param('slug')!
    const tenant = services.tenants.get(slug)
    if (!tenant) return c.json({ error: 'unknown_tenant' }, 404)
    if (!services.provider.exportResources) {
      return c.json({ error: 'provider_export_unavailable' }, 501)
    }
    if (active.has(slug)) {
      c.header('Retry-After', '5')
      return c.json({ error: 'export_in_progress' }, 409)
    }
    // Bound spool memory across tenants sharing the managed object or local process.
    if (active.size >= 2) return rateLimited(c, 5)
    const admission = limiter.check(slug)
    if (!admission.allowed) return rateLimited(c, admission.retryAfterSec)
    active.add(slug)
    try {
      return await services.audited(c, params.get('includeFeedback') === 'true', async (signal) => {
        try {
          const zip = new ExportZip(PORTAL_EXPORT_MAX_BYTES, signal)
          const startedAt = new Date().toISOString()
          const scope = { kind: 'portal' as const, slug }
          const state = services.state()
          const snapshot = state.createAuditSnapshot(scope, {})
          const counts = {
            resources: 0,
            fileLinks: 0,
            labelsets: 0,
            keys: 0,
            auditEvents: 0,
            insightAsks: 0,
            routingRecords: 0,
            feedback: 0,
            evaluationSets: 0,
            evaluationResults: 0,
          }
          // Validate known configuration, never serialise a registry or binding record wholesale.
          const config = TenantConfigSchema.parse(services.configuration(slug))
          const prompts = services.tenants.promptsFor(slug)
          await zip.add('configuration.json', [json({
            tenant: config,
            settings: {
              ask: prompts.ask,
              images: prompts.images,
              uncitedAnswers: prompts.uncitedAnswers,
              guardrails: prompts.guardrails,
              disabled: services.tenants.isDisabled(slug),
              lifecycle: services.lifecycle.get(slug),
            },
          })])
          const labels = (await services.provider.labelsets(tenant)).map((row) =>
            LabelsetSchema.parse(row)
          )
          counts.labelsets = labels.length
          await zip.add('labelsets.json', jsonArray(labels))
          const includeFeedback = params.get('includeFeedback') === 'true'
          const keys = services.keys.list(slug).map((row) => ({
            id: row.id,
            label: row.label,
            role: row.role,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            legacy: row.provenance === 'legacy-unproven',
          }))
          counts.keys = keys.length
          await zip.add('mcp-keys.json', jsonArray(keys))
          const insights = services.insights.summary(slug)
          counts.insightAsks = insights.totalAsks
          await zip.add('insights.json', [json({ windowDays: 90, ...insights })])
          // Routing is the existing operational tuning log, not a curated evaluation suite.
          const routing = services.routing.recent(slug, PORTAL_EXPORT_MAX_ROUTING_RECORDS + 1)
          if (routing.length > PORTAL_EXPORT_MAX_ROUTING_RECORDS) throw new ExportLimitError()
          counts.routingRecords = routing.length
          await zip.add('routing.json', jsonArray(routing))
          if (includeFeedback) {
            const ratings = services.feedback.ratings(slug)
            const comments = services.feedback.comments(slug, ratings.map((r) => r.learningId))
            counts.feedback = ratings.length
            await zip.add(
              'feedback.csv',
              (function* () {
                yield '"learningId","good","at","message"\r\n'
                for (const row of ratings) {
                  yield [row.learningId, row.good, row.ts, comments[row.learningId] ?? '']
                    .map((value) => auditCsvCell(redactExportText(String(value)))).join(',') +
                    '\r\n'
                }
              })(),
            )
          }
          await zip.add(
            'resources.json',
            (async function* () {
              yield '['
              for await (const row of services.provider.exportResources!(tenant, signal)) {
                if (++counts.resources > PORTAL_EXPORT_MAX_RESOURCES) throw new ExportLimitError()
                const resource = ResourceSummarySchema.parse(services.resource(slug, row.resource))
                counts.fileLinks += row.files.length
                yield (counts.resources === 1 ? '' : ',') + json({
                  resource,
                  metadata: row.metadata,
                  labels: row.labels.map(({ labelset, label }) => ({ labelset, label })),
                  created: row.created,
                  modified: row.modified,
                  status: row.status,
                  portalUrl: `/t/${encodeURIComponent(slug)}/library/${
                    encodeURIComponent(resource.id)
                  }`,
                  files: row.files.map(({ fieldId, contentType }) => ({
                    fieldId,
                    contentType,
                    url: `/api/t/${encodeURIComponent(slug)}/resources/${
                      encodeURIComponent(resource.id)
                    }/file/${encodeURIComponent(fieldId)}`,
                  })),
                })
              }
              yield ']\n'
            })(),
          )
          await zip.add(
            'audit.csv',
            (function* () {
              yield auditColumns.map(auditCsvCell).join(',') + '\r\n'
              let cursor: { at: string; id: string } | undefined
              for (;;) {
                signal.throwIfAborted()
                const rows = state.audit.read({
                  scope,
                  snapshotSequence: snapshot.watermark,
                  cursor,
                  limit: 500,
                })
                for (const row of rows) {
                  if (
                    ++counts.auditEvents > PORTAL_EXPORT_MAX_AUDIT_EVENTS
                  ) throw new ExportLimitError()
                  const safe = { ...row, detail_json: json(JSON.parse(row.detail_json)).trim() }
                  yield auditColumns.map((column) =>
                    auditCsvCell(redactExportText(String(safe[column] ?? '')))
                  ).join(',') + '\r\n'
                }
                if (rows.length < 500) break
                const last = rows.at(-1)!
                cursor = { at: last.at, id: last.id }
              }
            })(),
          )
          const evaluationNote =
            'No persisted evaluation set or evaluation result store is available in this version. Routing decisions are supplied separately in routing.json.'
          await zip.add('evaluations.json', [
            json({ status: 'unavailable', sets: [], results: [], note: evaluationNote }),
          ])
          await zip.add('manifest.json', [json({
            schemaVersion: 1,
            portal: slug,
            startedAt,
            completedAt: new Date().toISOString(),
            complete: true,
            counts,
            includeFeedback,
            auditSnapshot: { id: snapshot.id, expiresAt: snapshot.expiresAt },
            files: [...zip.entries, { path: 'manifest.json' }],
            limits: {
              bytes: PORTAL_EXPORT_MAX_BYTES,
              resources: PORTAL_EXPORT_MAX_RESOURCES,
              auditEvents: PORTAL_EXPORT_MAX_AUDIT_EVENTS,
              routingRecords: PORTAL_EXPORT_MAX_ROUTING_RECORDS,
            },
            notes: [
              evaluationNote,
              'File and branding links require portal access. Original binary files are not embedded.',
              'Usage insights are the 90-day management summary, with the latest 25 asks and 30 gaps.',
              'Audit rows are fixed at the snapshot before resource retrieval; this export completion is recorded after bundle preparation.',
              'Provider pages and local stores are read during the export, not as one atomic cross-system snapshot.',
              ...(includeFeedback
                ? ['Reader feedback messages contain personal data.']
                : ['Reader feedback messages and ratings were excluded.']),
            ],
          })])
          const bundle = zip.finish()
          const headers = new Headers(c.res.headers)
          headers.set('Content-Type', 'application/zip')
          headers.set('Content-Length', String(bundle.size))
          headers.set('Content-Disposition', `attachment; filename="portal-${slug}-export.zip"`)
          // A bounded Blob records materialised provenance; the audit middleware stages it before release.
          return materialisedBlobResponse(bundle, { headers })
        } catch (error) {
          if (error instanceof ExportLimitError) {
            return c.json({ error: 'portal_export_too_large' }, 413)
          }
          throw error
        }
      })
    } finally {
      active.delete(slug)
    }
  })
}
