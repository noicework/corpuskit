import { Buffer } from 'node:buffer'
import type { DurableState } from './state.ts'
import {
  type BackupRecord,
  captureBackupTables,
  type PortalBackupStore,
  restoredTenantRegistry,
  writeBackupTable,
} from '../../api/src/portal-backup.ts'
import {
  decodeLegacyWatches,
  encodeResearchOwner,
  encodeStorageIdentifier,
  legacySegment,
  ownedRecord,
  readLegacyInvestigation,
  readLegacySession,
} from '../../api/src/research-owner.ts'

export function durablePortalBackup(state: DurableState): PortalBackupStore {
  return {
    capture(slug, includeFeedback) {
      const records = captureBackupTables(state.rbacDatabase, slug)
      const add = (kind: BackupRecord['kind'], key: string, value: unknown) =>
        records.push({ kind, key, value })
      for (
        const kind of ['sources', 'linkHealth', 'insights', 'suggestions', 'enrichments'] as const
      ) {
        if (state.has(`${kind}:${slug}`)) add(kind, '', state.get(`${kind}:${slug}`, null))
      }
      const enrichments = state.enrichmentRecords(slug)
      if (Object.keys(enrichments).length) {
        const prior = records.find((r) => r.kind === 'enrichments')
        const merged = (prior?.value ?? {}) as Record<string, object>
        for (const [id, bucket] of Object.entries(enrichments)) {
          merged[id] = { ...merged[id], ...bucket }
        }
        if (prior) prior.value = merged
        else add('enrichments', '', merged)
      }
      const prefix = `research-v2:${encodeStorageIdentifier(slug)}:`
      for (const kind of ['sessions', 'investigations'] as const) {
        for (const row of state.list<unknown>(`${prefix}${kind}:`)) {
          add(kind, row.key.slice(`${prefix}${kind}:`.length), row.value)
        }
      }
      for (
        const [legacy, kind, decode] of [['session', 'sessions', readLegacySession], [
          'investigation',
          'investigations',
          readLegacyInvestigation,
        ]] as const
      ) {
        for (const row of state.list<unknown>(`${legacy}:${slug}:`)) {
          const parts = row.key.slice(`${legacy}:${slug}:`.length).split(':')
          if (parts.length !== 2 || !legacySegment(parts[0]) || !legacySegment(parts[1])) continue
          const value = decode(row.value, parts[1])
          if (!value) continue
          const owner = { kind: 'anonymous' as const, clientId: parts[0]! }
          const key = `${encodeResearchOwner(owner)}:${encodeStorageIdentifier(value.id)}`
          if (!records.some((r) => r.kind === kind && r.key === key)) {
            add(kind, key, ownedRecord(slug, owner, value))
          }
        }
      }
      if (!state.has(prefix + 'watches') && state.has(`watches:${slug}`)) {
        add('watches', '', {
          v: 2,
          slug,
          entries: decodeLegacyWatches(state.get(`watches:${slug}`, []), slug),
        })
      }
      if (state.has(prefix + 'watches')) add('watches', '', state.get(prefix + 'watches', null))
      for (const row of state.list<unknown>(`answer-records:${slug}:`)) {
        add('answerRecords', row.key.slice(`answer-records:${slug}:`.length), row.value)
      }
      const proposal = state.get<Record<string, unknown>>('kg-proposals', {})[slug]
      if (proposal !== undefined) add('kgProposals', '', proposal)
      const routing = state.routingRecords(slug, 5001).reverse()
      if (routing.length) add('routing', '', routing)
      if (includeFeedback) {
        const ratings = state.feedbackRatings(slug, 0, 501)
        const comments = state.feedbackComments(slug, ratings.map((r) => r.learningId), 0)
        if (ratings.length) {
          add('feedback', '', ratings.map((r) => ({ ...r, text: comments[r.learningId] })))
        }
        const messages = state.siteFeedbackRecords(slug, 0, 501)
        if (messages.length) add('siteFeedback', '', messages)
      }
      for (const { key } of state.assetVersions(`branding:${slug}:`)) {
        const asset = state.getAsset(key)!
        add('branding', key.slice(`branding:${slug}:`.length), {
          ...asset,
          bytes: Buffer.from(asset.bytes).toString('base64'),
        })
      }
      return records
    },
    restore(slug, records, _receipt, complete) {
      state.atomically('restore.apply', [slug], () => {
        for (const row of records) {
          if (writeBackupTable(state.rbacDatabase, slug, row)) continue
          if (row.kind === 'configuration') {
            state.put('tenants', restoredTenantRegistry(state.get('tenants', {}), slug, row.value))
          } else if (row.kind === 'lifecycle') {
            state.put(`portal-lifecycle:${slug}`, row.value)
          } else if (
            row.kind === 'sessions' || row.kind === 'investigations' || row.kind === 'watches'
          ) {
            state.put(
              `research-v2:${encodeStorageIdentifier(slug)}:${row.kind}${
                row.kind === 'watches' ? '' : ':' + row.key
              }`,
              row.value,
            )
          } else if (row.kind === 'answerRecords') {
            state.put(`answer-records:${slug}:${row.key}`, row.value)
          } else if (row.kind === 'kgProposals') {
            state.put('kg-proposals', { ...state.get('kg-proposals', {}), [slug]: row.value })
          } else if (row.kind === 'branding') {
            const value = row.value as { bytes: string; contentType: string; version: string }
            state.putAsset(`branding:${slug}:${row.key}`, {
              ...value,
              bytes: Uint8Array.from(Buffer.from(value.bytes, 'base64')),
            })
          } else if (row.kind === 'routing') {
            for (const value of row.value as unknown[]) state.appendRouting(slug, value, 5000)
          } else if (row.kind === 'feedback') {
            for (const value of row.value as Parameters<DurableState['putFeedback']>[1][]) {
              state.putFeedback(slug, value, 500, 0)
            }
          } else if (row.kind === 'siteFeedback') {
            for (const value of row.value as Parameters<DurableState['putSiteFeedback']>[1][]) {
              state.putSiteFeedback(slug, value, 500, 0)
            }
          } else state.put(`${row.kind}:${slug}`, row.value)
        }
        complete()
      })
    },
  }
}
