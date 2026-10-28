import { parseAnswerFeedback } from './stores.ts'
import { parseSiteFeedbackRecord } from './site-feedback.ts'
import { tenantRecord } from './tenants.ts'
import { redactExport } from './portal-export-redaction.ts'
import { z } from 'zod'
import {
  AnswerRecordRetentionSchema,
  AnswerRecordSchema,
  DuplicateDecisionSchema,
  EnrichmentSchema,
  EvaluationInputSchema,
  KgProposalSchema,
  PortalLifecycleSchema,
  PortalPromptsSchema,
  TenantConfigSchema,
} from '@research-portal/core'
import { type AuditEvent, validateAuditEvent } from './audit.ts'
import type { RbacDatabase } from './rbac-state.ts'
import { KeyPortalSlugSchema } from './scoped-key-record.ts'
import {
  decodeWatchCollection,
  encodeResearchOwner,
  encodeStorageIdentifier,
  readOwnedRecord,
} from './research-owner.ts'

export const BACKUP_KINDS = [
  'configuration',
  'lifecycle',
  'sessions',
  'investigations',
  'watches',
  'sources',
  'linkHealth',
  'insights',
  'feedback',
  'siteFeedback',
  'answerRecords',
  'suggestions',
  'enrichments',
  'kgProposals',
  'branding',
  'routing',
  'duplicates',
  'evaluationSets',
  'evaluationRuns',
  'evaluationSchedules',
] as const
export type BackupKind = typeof BACKUP_KINDS[number]
const RecordSchema = z.object({
  kind: z.enum(BACKUP_KINDS),
  key: z.string().max(2400),
  value: z.unknown(),
}).strict()
export const BackupSchema = z.object({
  version: z.literal(1),
  portal: KeyPortalSlugSchema,
  records: z.array(RecordSchema).max(50_000),
  audit: z.array(z.unknown()).max(20_000),
}).strict()
export type BackupRecord = z.infer<typeof RecordSchema>
export type PortalBackup = Omit<z.infer<typeof BackupSchema>, 'audit'> & { audit: AuditEvent[] }
export interface PortalBackupStore {
  capture(slug: string, includeFeedback: boolean): BackupRecord[]
  /** Completion, restored audit rows and the receipt commit with all records. */
  restore(slug: string, records: BackupRecord[], receipt: string, complete: () => void): void
}
export class ImportError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 | 413 = 400) {
    super(code)
  }
}

export function configurationRecord(
  tenant: unknown,
  prompts: unknown,
  disabled: boolean,
): BackupRecord {
  const { hostname: _hostname, ...config } = TenantConfigSchema.parse(tenant)
  return { kind: 'configuration', key: '', value: { tenant: config, prompts, disabled } }
}
/** Preserve destination routing metadata while replacing only source portal configuration. */
export function restoredTenantRegistry(
  raw: unknown,
  slug: string,
  value: unknown,
): Record<string, unknown> {
  const registry = tenantRecord(raw)
  const config = value as { tenant: Record<string, unknown>; prompts: unknown; disabled: boolean }
  const v2 = Object.hasOwn(registry, 'custom')
  const overrides = v2 && registry.overrides ? tenantRecord(registry.overrides) : {}
  const previous = Object.hasOwn(overrides, slug) ? tenantRecord(overrides[slug]) : {}
  return {
    ...(v2 ? registry : {}),
    custom: v2 ? tenantRecord(registry.custom) : registry,
    overrides: {
      ...overrides,
      [slug]: {
        ...config.tenant,
        slug: undefined,
        hostname: previous.hostname,
        prompts: config.prompts,
      },
    },
    disabled: [
      ...(Array.isArray(registry.disabled)
        ? registry.disabled.filter((s) => typeof s === 'string' && s !== slug)
        : []),
      ...(config.disabled ? [slug] : []),
    ],
  }
}

export function parseBackup(value: unknown): PortalBackup {
  const parsed = BackupSchema.parse(value)
  const seen = new Set<string>()
  for (const row of parsed.records) {
    row.value = redactExport(row.value)
    const identity = `${row.kind}:${row.key}`
    if (seen.has(identity)) throw new ImportError('duplicate_restore_record')
    seen.add(identity)
    if (row.kind === 'configuration') {
      if (row.key !== '') throw new ImportError('invalid_restore_record')
      const config = z.object({
        tenant: TenantConfigSchema,
        prompts: PortalPromptsSchema,
        disabled: z.boolean(),
      }).strict().parse(row.value)
      row.value = config
      if (config.tenant.slug !== parsed.portal) throw new ImportError('portal_mismatch')
    } else if (row.kind === 'lifecycle') {
      if (row.key !== '') throw new ImportError('invalid_restore_record')
      z.object({
        v: z.literal(1),
        lifecycle: PortalLifecycleSchema,
        lastActivityAt: z.string().datetime().nullable(),
      }).strict().parse(row.value)
    } else if (row.kind === 'sessions' || row.kind === 'investigations') {
      const owned = row.value as {
        slug: string
        owner: Parameters<typeof encodeResearchOwner>[0]
        payload: { id: string }
      }
      readOwnedRecord(owned, parsed.portal, owned.owner, owned.payload.id)
      if (row.kind === 'sessions') {
        z.object({
          id: z.string(),
          title: z.string(),
          updatedAt: z.string(),
          messages: z.array(z.unknown()),
        }).parse(owned.payload)
      } else {z.object({
          id: z.string(),
          name: z.string(),
          question: z.string(),
          notes: z.string(),
          status: z.enum(['active', 'closed']),
          createdAt: z.string(),
          updatedAt: z.string(),
          evidence: z.array(z.unknown()),
          artefacts: z.array(z.unknown()),
        }).parse(owned.payload)}
      if (
        row.key !==
          `${encodeResearchOwner(owned.owner)}:${encodeStorageIdentifier(owned.payload.id)}`
      ) throw new ImportError('invalid_restore_record')
    } else if (row.kind === 'watches') {
      decodeWatchCollection(row.value, parsed.portal)
      if (row.key !== '') throw new ImportError('invalid_restore_record')
    } else if (row.kind === 'answerRecords') {
      if (!/^(retention|record:[A-Za-z0-9_-]{1,128})$/.test(row.key)) {
        throw new ImportError('invalid_restore_record')
      }
      if (row.key === 'retention') AnswerRecordRetentionSchema.parse(row.value)
      else {
        const answer = AnswerRecordSchema.parse(row.value)
        if (answer.portal !== parsed.portal || row.key !== `record:${answer.answerId}`) {
          throw new ImportError('invalid_restore_record')
        }
      }
    } else if (row.kind === 'branding') {
      if (
        !/^(logo|logo-dark|hero|font-heading|font-body|image-[a-z0-9][a-z0-9-]{0,39})$/.test(
          row.key,
        )
      ) throw new ImportError('invalid_restore_record')
      z.object({
        bytes: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
        contentType: z.enum([
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/svg+xml',
          'font/woff2',
          'font/woff',
          'font/ttf',
          'font/otf',
        ]),
        version: z.string().max(160),
      }).strict().parse(row.value)
    } else if (
      ['duplicates', 'evaluationSets', 'evaluationRuns', 'evaluationSchedules'].includes(row.kind)
    ) {
      if (
        row.kind === 'duplicates'
          ? row.key.length < 1 || row.key.length > 1024
          : !/^[A-Za-z0-9_-]{1,100}$/.test(row.key)
      ) {
        throw new ImportError('invalid_restore_record')
      }
      validateBackupTable(row, parsed.portal)
    } else {
      if (row.key !== '') throw new ImportError('invalid_restore_record')
      if (row.kind === 'enrichments') {
        const buckets = z.record(z.record(EnrichmentSchema)).parse(row.value)
        for (const [schema, bucket] of Object.entries(buckets)) {
          for (const item of Object.values(bucket)) {
            if (item.schemaId !== schema) {
              throw new ImportError('invalid_restore_record')
            }
          }
        }
      } else if (row.kind === 'kgProposals') KgProposalSchema.parse(row.value)
      else {
        const values = z.array(z.record(z.unknown())).max(
          row.kind === 'routing'
            ? 5000
            : ['feedback', 'siteFeedback'].includes(row.kind)
            ? 500
            : row.kind === 'linkHealth'
            ? 10_000
            : 50_000,
        ).parse(row.value)
        const identities = new Set<string>()
        for (const value of values) {
          if (row.kind === 'feedback' && !parseAnswerFeedback(value)) {
            throw new ImportError('invalid_restore_record')
          }
          if (
            row.kind === 'siteFeedback' &&
            (!parseSiteFeedbackRecord(value) || value.slug !== parsed.portal)
          ) throw new ImportError('invalid_restore_record')
          if (
            ['sources', 'linkHealth', 'suggestions', 'feedback', 'siteFeedback'].includes(row.kind)
          ) {
            const id = row.kind === 'feedback' ? value.learningId : value.id
            if (typeof id !== 'string' || !id.length || identities.has(id)) {
              throw new ImportError('duplicate_restore_record')
            }
            identities.add(id)
          }
        }
      }
    }
  }
  if (!seen.has('configuration:')) throw new ImportError('missing_restore_configuration')
  const audit = parsed.audit as AuditEvent[]
  const ids = new Set<string>()
  for (const event of audit) {
    validateAuditEvent(event)
    if (event.scope_kind !== 'portal' || event.scope_slug !== parsed.portal || ids.has(event.id)) {
      throw new ImportError('invalid_restore_audit')
    }
    ids.add(event.id)
  }
  return { ...parsed, audit }
}
export function backupRecordCount(row: BackupRecord): number {
  if (row.kind === 'evaluationSchedules') return 0
  if (Array.isArray(row.value)) return row.value.length
  if (row.kind === 'enrichments') {
    return Object.values(row.value as Record<string, object>).reduce(
      (n, bucket) => n + Object.keys(bucket).length,
      0,
    )
  }
  if (row.kind === 'watches') return (row.value as { entries: unknown[] }).entries.length
  return 1
}
export function restoreCounts(backup: PortalBackup): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    [...BACKUP_KINDS, 'auditEvents'].map((k) => [k, 0]),
  )
  for (const row of backup.records) counts[row.kind]! += backupRecordCount(row)
  counts.auditEvents = backup.audit.length
  return counts
}

export const BACKUP_TABLES = {
  duplicates: { table: 'duplicate_reviews', id: 'pair', columns: ['pair', 'review'] },
  evaluationSets: { table: 'evaluation_sets', id: 'id', columns: ['id', 'json'] },
  evaluationRuns: {
    table: 'evaluation_runs',
    id: 'id',
    columns: ['id', 'set_id', 'started_at', 'status', 'json'],
  },
  evaluationSchedules: { table: 'evaluation_schedules', id: 'set_id', columns: ['set_id', 'json'] },
} as const
export function captureBackupTables(db: RbacDatabase, slug: string): BackupRecord[] {
  return Object.entries(BACKUP_TABLES).flatMap(([kind, spec]) =>
    db.all<Record<string, string>>(
      `SELECT ${spec.columns.join(',')} FROM ${spec.table} WHERE slug = ? ORDER BY ${spec.id}`,
      slug,
    ).map((value) => ({ kind: kind as BackupKind, key: value[spec.id]!, value }))
  )
}
export function validateBackupTable(row: BackupRecord, portal: string): void {
  const spec = BACKUP_TABLES[row.kind as keyof typeof BACKUP_TABLES]
  const data = z.record(z.string()).parse(row.value)
  if (
    Object.keys(data).sort().join() !== [...spec.columns].sort().join() || data[spec.id] !== row.key
  ) throw new ImportError('invalid_restore_table')
  if (row.kind === 'duplicates') {
    z.object({ decision: DuplicateDecisionSchema, reviewedAt: z.string().datetime() }).strict()
      .parse(JSON.parse(data.review!))
  } else {
    const value = JSON.parse(data.json!)
    if (value.slug !== portal) throw new ImportError('portal_mismatch')
    if (row.kind === 'evaluationSets') {
      EvaluationInputSchema.parse({
        name: value.name,
        topK: value.topK,
        questions: value.questions,
      })
      if (value.id !== row.key) throw new ImportError('invalid_restore_table')
    } else if (
      row.kind === 'evaluationRuns' &&
      (value.id !== row.key || value.setId !== data.set_id || value.startedAt !== data.started_at ||
        value.status !== data.status ||
        !['running', 'completed', 'failed'].includes(value.status) ||
        value.definition?.slug !== portal)
    ) throw new ImportError('invalid_restore_table')
    else if (row.kind === 'evaluationSchedules' && value.setId !== row.key) {
      throw new ImportError('invalid_restore_table')
    }
  }
}

export function writeBackupTable(db: RbacDatabase, slug: string, row: BackupRecord): boolean {
  const spec = BACKUP_TABLES[row.kind as keyof typeof BACKUP_TABLES]
  if (!spec) return false
  const data = z.record(z.string()).parse(row.value)
  if (
    Object.keys(data).sort().join() !== [...spec.columns].sort().join() || data[spec.id] !== row.key
  ) throw new ImportError('invalid_restore_table')
  // Restore scheduling definitions for review, but never replay delegated authority or an in-flight run.
  if (row.kind === 'evaluationSchedules') return true
  if (row.kind === 'evaluationRuns' && data.status === 'running') {
    data.status = 'failed'
    data.json = JSON.stringify({
      ...JSON.parse(data.json!),
      status: 'failed',
      completedAt: new Date().toISOString(),
    })
  }
  db.exec(
    `INSERT OR REPLACE INTO ${spec.table}(slug,${spec.columns.join(',')}) VALUES (?,${
      spec.columns.map(() => '?').join(',')
    })`,
    slug,
    ...spec.columns.map((c) => data[c]!),
  )
  return true
}

/** Remap structured scope fields and portal-relative asset links, never arbitrary prose. */
export function remapBackup(backup: PortalBackup, target: string): PortalBackup {
  const visit = (value: unknown, field = ''): unknown => {
    if (typeof value === 'string') {
      if (['slug', 'tenant', 'scope_slug', 'portal'].includes(field) && value === backup.portal) {
        return target
      }
      if (
        value.startsWith(`/api/t/${backup.portal}/`) || value.startsWith(`/t/${backup.portal}/`)
      ) return value.replace(`/${backup.portal}/`, `/${target}/`)
      return value
    }
    if (Array.isArray(value)) return value.map((v) => visit(v))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]))
    }
    return value
  }
  return {
    ...backup,
    portal: target,
    records: backup.records.map((r) => ({
      ...r,
      value: r.kind.startsWith('evaluation')
        ? {
          ...(r.value as object),
          json: JSON.stringify(visit(JSON.parse((r.value as { json: string }).json))),
        }
        : visit(r.value),
    })),
    audit: backup.audit.map((e) => ({ ...e, scope_slug: target })),
  }
}
