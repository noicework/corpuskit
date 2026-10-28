import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BackupRecord,
  captureBackupTables,
  type PortalBackupStore,
  writeBackupTable,
} from './portal-backup.ts'
import type { RbacDatabase } from './rbac-state.ts'
import {
  decodeLegacyWatches,
  encodeResearchOwner,
  encodeStorageIdentifier,
  legacySegment,
  ownedRecord,
  readLegacyInvestigation,
  readLegacySession,
  storageIdentifierPath,
} from './research-owner.ts'
import { writeFileAtomic, writeJsonAtomic } from './persist.ts'
import { FileBrandingStore } from './branding-store.ts'
import type { BrandingKind } from './app.ts'

function read(path: string, fallback?: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e
  }
}
function files(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(root, e.name))
      : e.isFile() && e.name.endsWith('.json')
      ? [join(root, e.name)]
      : []
  )
}

/** A write-ahead file journal joins synchronous file replacement to the SQL receipt. */
export function localPortalBackup(
  directory: string,
  db: RbacDatabase,
  env: Record<string, string | undefined>,
  reload: () => void,
): PortalBackupStore {
  const journalPath = join(directory, 'portal-restore-journal.json')
  const recover = () => {
    const journal = read(journalPath) as {
      receipt: string
      before: { path: string; bytes: string | null }[]
    } | undefined
    if (!journal) return
    if (!db.all('SELECT id FROM audit_events WHERE id = ?', journal.receipt).length) {
      for (const file of journal.before) {
        if (file.bytes === null) rmSync(file.path, { force: true })
        else writeFileAtomic(file.path, Buffer.from(file.bytes, 'base64'))
      }
    }
    rmSync(journalPath)
  }
  recover()
  reload()
  const tenantPath = env.TENANTS_PATH ?? join(directory, 'tenants.json')
  const kgPath = env.KG_PROPOSALS_PATH ?? join(directory, 'kg-proposals.json')
  const brandingRoot = env.BRANDING_PATH ?? join(directory, 'branding')
  const researchRoot = (slug: string) =>
    join(directory, 'research-v2', storageIdentifierPath(encodeStorageIdentifier(slug)))
  const pathFor = (slug: string, row: BackupRecord): string => {
    if (row.kind === 'configuration') return tenantPath
    if (row.kind === 'lifecycle') {
      return join(directory, 'lifecycle', `portal-lifecycle-${slug}.json`)
    }
    if (row.kind === 'kgProposals') return kgPath
    if (row.kind === 'branding') return join(brandingRoot, 'assets', slug, `${row.key}.json`)
    if (row.kind === 'watches') return join(researchRoot(slug), 'watches.json')
    if (row.kind === 'sessions' || row.kind === 'investigations') {
      const [owner, id] = row.key.split(':')
      return join(
        researchRoot(slug),
        row.kind,
        storageIdentifierPath(owner!),
        storageIdentifierPath(id!),
        'record.json',
      )
    }
    if (row.kind === 'answerRecords') {
      return join(directory, 'answer-records', slug, `${row.key.replace('record:', '')}.json`)
    }
    const name = row.kind === 'siteFeedback' ? 'site-feedback' : row.kind
    return join(
      directory,
      name,
      `${slug}.${row.kind === 'insights' || row.kind === 'routing' ? 'jsonl' : 'json'}`,
    )
  }
  return {
    capture(slug, includeFeedback) {
      const rows = captureBackupTables(db, slug)
      const add = (kind: BackupRecord['kind'], key: string, value: unknown) => {
        if (value !== undefined) rows.push({ kind, key, value })
      }
      for (
        const kind of [
          'sources',
          'suggestions',
          'enrichments',
          'insights',
          'routing',
          ...(includeFeedback ? ['feedback', 'siteFeedback'] as const : []),
        ] as const
      ) {
        const path = pathFor(slug, { kind, key: '', value: null })
        if (!existsSync(path)) continue
        const value = kind === 'insights' || kind === 'routing'
          ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
          : read(path)
        add(kind, '', value)
      }
      const link =
        db.all<{ payload: string }>('SELECT payload FROM link_health WHERE slug = ?', slug)[0]
      if (link) add('linkHealth', '', JSON.parse(link.payload))
      for (const kind of ['sessions', 'investigations'] as const) {
        for (const path of files(join(researchRoot(slug), kind))) {
          const value = read(path) as {
            owner: Parameters<typeof encodeResearchOwner>[0]
            payload: { id: string }
          }
          add(
            kind,
            `${encodeResearchOwner(value.owner)}:${encodeStorageIdentifier(value.payload.id)}`,
            value,
          )
        }
      }
      for (
        const [kind, decode] of [['sessions', readLegacySession], [
          'investigations',
          readLegacyInvestigation,
        ]] as const
      ) {
        const root = join(directory, kind, slug)
        for (const path of files(root)) {
          const parts = path.slice(root.length + 1).split('/')
          if (parts.length !== 2 || !legacySegment(parts[0])) continue
          const id = parts[1]!.slice(0, -5), value = decode(read(path), id)
          if (!value || !legacySegment(id)) continue
          const owner = { kind: 'anonymous' as const, clientId: parts[0]! }
          const key = `${encodeResearchOwner(owner)}:${encodeStorageIdentifier(value.id)}`
          if (!rows.some((r) => r.kind === kind && r.key === key)) {
            add(kind, key, ownedRecord(slug, owner, value))
          }
        }
      }
      if (
        !existsSync(join(researchRoot(slug), 'watches.json')) &&
        existsSync(join(directory, 'watches', `${slug}.json`))
      ) {
        add('watches', '', {
          v: 2,
          slug,
          entries: decodeLegacyWatches(read(join(directory, 'watches', `${slug}.json`)), slug),
        })
      }
      add('watches', '', read(join(researchRoot(slug), 'watches.json')))
      for (const path of files(join(directory, 'answer-records', slug))) {
        const name = path.slice(path.lastIndexOf('/') + 1, -5)
        add('answerRecords', name === 'retention' ? name : `record:${name}`, read(path))
      }
      add('kgProposals', '', (read(kgPath, {}) as Record<string, unknown>)[slug])
      const assets = new FileBrandingStore(brandingRoot)
      for (
        const kind of [
          'logo',
          'logo-dark',
          'hero',
          'font-heading',
          'font-body',
          ...assets.images(slug).map((i) => `image-${i.name}`),
        ]
      ) {
        const asset = assets.get(slug, kind as BrandingKind)
        if (asset) {
          add('branding', kind, { ...asset, bytes: Buffer.from(asset.bytes).toString('base64') })
        }
      }
      return rows
    },
    restore(slug, records, receipt, complete) {
      const writes: { path: string; text: string }[] = []
      for (const row of records) {
        if (
          ['duplicates', 'evaluationSets', 'evaluationRuns', 'evaluationSchedules', 'linkHealth']
            .includes(row.kind)
        ) continue
        let value = row.value
        if (row.kind === 'configuration') {
          const config = row.value as {
            tenant: Record<string, unknown>
            prompts: unknown
            disabled: boolean
          }
          const registry = read(tenantPath, { custom: {}, overrides: {}, disabled: [] }) as {
            overrides: Record<string, unknown>
            disabled: string[]
          }
          registry.overrides ??= {}
          registry.overrides[slug] = {
            ...config.tenant,
            slug: undefined,
            hostname: undefined,
            prompts: config.prompts,
          }
          registry.disabled = [
            ...(registry.disabled ?? []).filter((s) => s !== slug),
            ...(config.disabled ? [slug] : []),
          ]
          value = registry
        } else if (row.kind === 'kgProposals') {
          value = { ...read(kgPath, {}) as object, [slug]: value }
        }
        writes.push({
          path: pathFor(slug, row),
          text: row.kind === 'insights' || row.kind === 'routing'
            ? (value as unknown[]).map((v) => JSON.stringify(v) + '\n').join('')
            : JSON.stringify(value),
        })
      }
      writeJsonAtomic(journalPath, {
        receipt,
        before: writes.map((w) => ({
          path: w.path,
          bytes: existsSync(w.path) ? readFileSync(w.path).toString('base64') : null,
        })),
      })
      try {
        db.transactionSync(() => {
          for (const row of records) {
            if (writeBackupTable(db, slug, row)) continue
            if (row.kind === 'linkHealth') {
              db.exec(
                'INSERT OR REPLACE INTO link_health(slug,payload) VALUES (?,?)',
                slug,
                JSON.stringify(row.value),
              )
            }
          }
          for (const write of writes) writeFileAtomic(write.path, write.text)
          complete()
        })
      } catch (e) {
        recover()
        reload()
        throw e
      }
      rmSync(journalPath)
      reload()
    },
  }
}
