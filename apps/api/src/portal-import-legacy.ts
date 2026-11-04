import { PortalPromptsSchema } from '@research-portal/core'
import { z } from 'zod'
import type { AuditEvent } from './audit.ts'
import {
  type BackupRecord,
  configurationRecord,
  ImportError,
  parseBackup,
} from './portal-backup.ts'

/** Read the quoted, CRLF CSV dialect written by the portal, without evaluating spreadsheet cells. */
function csv(text: string): string[][] {
  const rows: string[][] = []
  let offset = 0
  while (offset < text.length) {
    const row: string[] = []
    for (;;) {
      if (text[offset++] !== '"') throw new ImportError('invalid_legacy_csv')
      let cell = ''
      for (;;) {
        if (offset >= text.length) throw new ImportError('invalid_legacy_csv')
        const char = text[offset++]!
        if (char !== '"') cell += char
        else if (text[offset] === '"') {
          cell += '"'
          offset++
        } else break
      }
      // Legacy CSV cannot distinguish a formula prefix from a literal apostrophe. Warn on import.
      row.push(/^'[\p{Cc}\p{Cf}]|^'[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(cell) ? cell.slice(1) : cell)
      if (text[offset] === ',') offset++
      else if (text.slice(offset, offset + 2) === '\r\n') {
        offset += 2
        break
      } else throw new ImportError('invalid_legacy_csv')
    }
    rows.push(row)
  }
  return rows
}

const auditColumns = [
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

/** Schema 1 inventory exports predate full backups. Recover only the actual exported records. */
export function legacyBackup(
  files: ReadonlyMap<string, { text: string }>,
  portal: string,
  includeFeedback: boolean,
  counts: Record<string, unknown>,
): { backup: ReturnType<typeof parseBackup>; warnings: string[] } {
  const read = (path: string): unknown => JSON.parse(files.get(path)?.text ?? 'null')
  const { tenant, settings } = z.object({
    tenant: z.unknown(),
    settings: z.object({ disabled: z.boolean(), lifecycle: z.unknown() }).passthrough(),
  }).parse(read('configuration.json'))
  const { disabled, lifecycle, ...promptFields } = settings
  const records: BackupRecord[] = [
    configurationRecord(tenant, PortalPromptsSchema.parse(promptFields), disabled),
  ]
  records.push({ kind: 'lifecycle', key: '', value: { v: 1, lifecycle, lastActivityAt: null } })
  const routing = z.array(z.record(z.unknown())).max(5000).parse(read('routing.json'))
  if (counts.routingRecords !== routing.length) throw new ImportError('invalid_legacy_counts')
  if (routing.length) records.push({ kind: 'routing', key: '', value: routing.reverse() })
  const [header, ...rows] = csv(files.get('audit.csv')!.text)
  if (header?.join() !== auditColumns.join() || counts.auditEvents !== rows.length) {
    throw new ImportError('invalid_legacy_csv')
  }
  const audit = rows.map((row) => {
    if (row.length !== auditColumns.length) throw new ImportError('invalid_legacy_csv')
    return Object.fromEntries(auditColumns.map((column, index) => [
      column,
      ['actor_id', 'actor_label', 'target_id'].includes(column) && row[index] === ''
        ? null
        : row[index],
    ])) as unknown as AuditEvent
  })
  if (includeFeedback) {
    const [header, ...rows] = csv(files.get('feedback.csv')!.text)
    if (header?.join() !== 'learningId,good,at,message' || counts.feedback !== rows.length) {
      throw new ImportError('invalid_legacy_csv')
    }
    records.push({
      kind: 'feedback',
      key: '',
      value: rows.map((row) => {
        if (row.length !== 4 || !['true', 'false'].includes(row[1]!)) {
          throw new ImportError('invalid_legacy_csv')
        }
        return { learningId: row[0], good: row[1] === 'true', ts: row[2], text: row[3] }
      }),
    })
  }
  z.object({
    status: z.literal('unavailable'),
    sets: z.tuple([]),
    results: z.tuple([]),
  }).parse(read('evaluations.json'))
  return {
    backup: parseBackup({ version: 1, portal, records, audit }),
    warnings: [
      'Legacy schemaVersion 1 inventory bundle: partial recovery only. SHA-256 hashes were optional; ZIP CRC and manifest byte lengths were checked.',
      'Sessions, investigations, watches, answer records and retention settings, evaluation definitions and runs, duplicate decisions, enrichments, suggestions, sources, link reviews, graph proposals and uploaded branding bytes were not exported and cannot be restored.',
      'The insights summary cannot reconstruct the retained usage log. Reader feedback is restored only when explicitly included; portal-team messages were not exported.',
      'Legacy CSV formula-protection apostrophes are removed when they match the exporter rule. A literal leading apostrophe in the same position cannot be distinguished or recovered exactly.',
      'Knowledge box content, bindings, credentials, keys, members and domains are never restored. Reconnect and verify them separately.',
    ],
  }
}
