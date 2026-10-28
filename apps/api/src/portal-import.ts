import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { appendAudit, type AuditActor, type AuditEvent, createAuditEvent } from './audit.ts'
import type { RbacState } from './rbac-state.ts'
import type { TenantStoreApi } from './tenants.ts'
import { declaredRoute } from './permissions.ts'
import {
  backupRecordCount,
  ImportError,
  parseBackup,
  type PortalBackupStore,
  remapBackup,
  restoreCounts,
} from './portal-backup.ts'
import { crcTable, sha256 } from './portal-export-zip.ts'
import { PORTAL_EXPORT_MAX_BYTES } from './portal-export.ts'

export const PORTAL_IMPORT_PATH = '/api/admin/t/:slug/import'

/** Accept only the bounded, store-only UTF-8 ZIP dialect the portal exporter writes. */
export async function validateImportZip(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ backup: ReturnType<typeof parseBackup>; digest: string }> {
  const invalid = () => new ImportError('invalid_import_bundle')
  if (bytes.length > PORTAL_EXPORT_MAX_BYTES) throw new ImportError('portal_import_too_large', 413)
  if (bytes.length < 22) throw invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const files = new Map<
    string,
    { text: string; bytes: number; hash: string; offset: number; crc: number }
  >()
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    if (
      files.size >= 32 || view.getUint16(offset + 6, true) !== 0x800 ||
      view.getUint16(offset + 8, true) !== 0 || view.getUint16(offset + 28, true) !== 0
    ) throw invalid()
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true)
    const start = offset + 30 + nameLength, end = start + size
    if (size !== view.getUint32(offset + 22, true) || end > bytes.length) throw invalid()
    const path = decoder.decode(bytes.subarray(offset + 30, start))
    if (!/^[a-z][a-z0-9-]*\.(json|csv)$/.test(path) || files.has(path)) throw invalid()
    const data = bytes.slice(start, end)
    let crc = 0xffffffff
    for (const b of data) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255]!
    crc = (crc ^ 0xffffffff) >>> 0
    if (crc !== view.getUint32(offset + 14, true)) throw invalid()
    files.set(path, {
      text: decoder.decode(data),
      bytes: size,
      hash: await sha256(data.buffer),
      offset,
      crc,
    })
    offset = end
  }
  const central = offset
  for (const [path, file] of files) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw invalid()
    const n = view.getUint16(offset + 28, true)
    if (
      view.getUint16(offset + 8, true) !== 0x800 || view.getUint16(offset + 10, true) !== 0 ||
      view.getUint32(offset + 16, true) !== file.crc ||
      view.getUint32(offset + 20, true) !== file.bytes ||
      view.getUint32(offset + 24, true) !== file.bytes || view.getUint16(offset + 30, true) !== 0 ||
      view.getUint16(offset + 32, true) !== 0 ||
      view.getUint32(offset + 42, true) !== file.offset ||
      decoder.decode(bytes.subarray(offset + 46, offset + 46 + n)) !== path
    ) throw invalid()
    offset += 46 + n
  }
  if (
    offset + 22 !== bytes.length || view.getUint32(offset, true) !== 0x06054b50 ||
    view.getUint32(offset + 4, true) !== 0 || view.getUint16(offset + 8, true) !== files.size ||
    view.getUint16(offset + 10, true) !== files.size ||
    view.getUint32(offset + 12, true) !== offset - central ||
    view.getUint32(offset + 16, true) !== central || view.getUint16(offset + 20, true) !== 0
  ) throw invalid()
  const manifest = z.object({
    schemaVersion: z.literal(1),
    restoreVersion: z.literal(1),
    portal: z.string(),
    complete: z.literal(true),
    counts: z.object({ restore: z.record(z.number().int().nonnegative()) }),
    files: z.array(
      z.object({ path: z.string(), bytes: z.number().optional(), sha256: z.string().optional() }),
    ),
  }).parse(JSON.parse(files.get('manifest.json')?.text ?? 'null'))
  if (
    manifest.files.length !== files.size ||
    new Set(manifest.files.map((f) => f.path)).size !== files.size
  ) throw invalid()
  for (const entry of manifest.files) {
    const file = files.get(entry.path)
    if (
      !file ||
      (entry.path !== 'manifest.json' && (file.bytes !== entry.bytes || file.hash !== entry.sha256))
    ) throw invalid()
  }
  const allowed = new Set([
    'manifest.json',
    'configuration.json',
    'resources.json',
    'labelsets.json',
    'mcp-keys.json',
    'audit.csv',
    'insights.json',
    'routing.json',
    'evaluations.json',
    'feedback.csv',
    'portal-records.json',
  ])
  if ([...files.keys()].some((path) => !allowed.has(path))) throw invalid()
  if (
    ['configuration.json', 'resources.json', 'labelsets.json', 'audit.csv', 'portal-records.json']
      .some((path) => !files.has(path))
  ) throw invalid()
  let backup: ReturnType<typeof parseBackup>
  try {
    backup = parseBackup(JSON.parse(files.get('portal-records.json')?.text ?? 'null'))
  } catch {
    throw invalid()
  }
  const counts = restoreCounts(backup)
  if (
    Object.keys(manifest.counts.restore).sort().join() !== Object.keys(counts).sort().join() ||
    Object.entries(counts).some(([kind, count]) => manifest.counts.restore[kind] !== count)
  ) throw invalid()
  if (backup.portal !== manifest.portal) throw invalid()
  return { backup, digest: await sha256(bytes.slice().buffer) }
}

interface Services {
  store?: PortalBackupStore
  tenants: TenantStoreApi
  state(): RbacState
  context(c: Context): { requestId: string; actor: AuditActor }
  invalidate(slug: string): void
}
export function registerPortalImport(app: Hono, services: Services): void {
  const active = new Set<string>()
  app.post(declaredRoute('POST', PORTAL_IMPORT_PATH), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const slug = c.req.param('slug')!
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    if (!services.store) return c.json({ error: 'portal_restore_unavailable' }, 501)
    const params = new URL(c.req.url).searchParams
    if (
      [...params.keys()].some((k) => k !== 'targetSlug') ||
      params.getAll('targetSlug').length > 1 ||
      (params.has('targetSlug') && params.get('targetSlug') !== slug)
    ) return c.json({ error: 'invalid_import_options' }, 400)
    if (c.req.header('content-type')?.split(';')[0] !== 'application/zip') {
      return c.json({ error: 'expected_zip_bundle' }, 415)
    }
    if (active.has(slug) || active.size >= 2) {
      c.header('Retry-After', '5')
      return c.json({ error: 'import_in_progress' }, 409)
    }
    active.add(slug)
    try {
      const reader = c.req.raw.body?.getReader()
      if (!reader) throw new ImportError('invalid_import_bundle')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.length
          if (size > PORTAL_EXPORT_MAX_BYTES) throw new ImportError('portal_import_too_large', 413)
          chunks.push(next.value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const part of chunks) {
        bytes.set(part, offset)
        offset += part.length
      }
      const validated = await validateImportZip(bytes)
      if (validated.backup.portal !== slug && !params.has('targetSlug')) {
        throw new ImportError('portal_slug_mismatch')
      }
      const backup = remapBackup(validated.backup, slug)
      const receipt = `restore:${slug}:${validated.digest}`
      const state = services.state()
      const restored: AuditEvent[] = []
      for (const event of backup.audit) {
        const id = `restored-${await sha256(
          new TextEncoder().encode(`${slug}:${validated.digest}:${event.id}`).buffer,
        )}`
        restored.push({
          ...event,
          id,
          detail_json: JSON.stringify({
            ...JSON.parse(event.detail_json),
            restored: true,
            bundleId: validated.digest,
            originalEventId: JSON.parse(event.detail_json).originalEventId ?? event.id,
            restoredFromPortal: JSON.parse(event.detail_json).restoredFromPortal ??
              validated.backup.portal,
          }),
        })
      }
      const prior = state.audit.read({
        scope: { kind: 'portal', slug },
        action: 'portal.import.bundle',
        requestId: receipt,
        limit: 1,
      })
      const counts = restoreCounts(backup)
      if (prior.length) {
        return c.json({
          slug,
          alreadyImported: true,
          counts: Object.fromEntries(Object.keys(counts).map((k) => [k, 0])),
          knowledgeBoxRestored: false,
        })
      }
      // Refuse merging research state into an occupied target. Audit and provisioning configuration are allowed.
      if (
        services.store.capture(slug, true).some((r) =>
          !['configuration', 'lifecycle'].includes(r.kind) &&
          !(r.kind === 'answerRecords' && r.key === 'retention') && backupRecordCount(r) > 0
        )
      ) throw new ImportError('portal_not_empty', 409)
      const context = services.context(c)
      services.store.restore(slug, backup.records, receipt, () => {
        for (const event of restored) appendAudit(state.audit, event)
        appendAudit(
          state.audit,
          createAuditEvent(
            {
              requestId: receipt,
              actor: context.actor,
              action: 'portal.import.bundle',
              scope: { kind: 'portal', slug },
              target: { kind: 'portal', id: slug },
              outcome: 'success',
              detail: { bundleId: validated.digest, count: backup.records.length, restored: true },
            },
            Date.now,
            () => receipt,
          ),
        )
      })
      services.invalidate(slug)
      return c.json({
        slug,
        alreadyImported: false,
        counts,
        knowledgeBoxRestored: false,
        note:
          'Knowledge box content and provider-managed taxonomy are not restored. Keep or reconnect the retrieval provider separately.',
      })
    } catch (e) {
      if (e instanceof ImportError) return c.json({ error: e.code }, e.status)
      if (
        e instanceof z.ZodError || e instanceof SyntaxError || e instanceof RangeError ||
        e instanceof TypeError
      ) return c.json({ error: 'invalid_import_bundle' }, 400)
      throw e
    } finally {
      active.delete(slug)
    }
  })
}
