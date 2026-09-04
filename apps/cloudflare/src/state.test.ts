import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { DEFAULT_RESEARCH_ENRICHMENT, type Enrichment } from '@research-portal/core'
import {
  DurableEnrichmentStore,
  DurableState,
  DurableTenantStore,
  type SqlStorageLike,
} from './state.ts'
import type { McpKeyRecord } from '../../api/src/stores.ts'
import { DurableMcpKeyStore } from './state.ts'

class TestSqlStorage implements SqlStorageLike {
  readonly database = new DatabaseSync(':memory:')

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[]; one(): T } {
    let rows: T[] = []
    if (bindings.length === 0) {
      this.database.exec(query)
    } else {
      const statement = this.database.prepare(query)
      const values = bindings as SQLInputValue[]
      if (query.trimStart().toUpperCase().startsWith('SELECT')) {
        rows = statement.all(...values) as T[]
      } else {
        statement.run(...values)
      }
    }
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`Expected one row, received ${rows.length}`)
        return rows[0]!
      },
    }
  }
}

function enrichment(title: string): Enrichment {
  return {
    schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
    generatedAt: '2026-08-28T00:00:00.000Z',
    data: { title, summary: `${title} summary` },
  }
}

function durableStore() {
  const sql = new TestSqlStorage()
  const state = new DurableState(sql)
  state.migrate()
  return { sql, state, store: new DurableEnrichmentStore(state) }
}

Deno.test('DurableEnrichmentStore imports per-record rows and honours collision policy', () => {
  const { sql, store } = durableStore()
  const original = enrichment('Original')
  const first = store.importRecords('grains', {
    [DEFAULT_RESEARCH_ENRICHMENT.id]: {
      'resource-1': original,
      'resource-2': enrichment('Second'),
    },
  }, 'skip')

  expect(first).toEqual({
    imported: 2,
    skipped: 0,
    overwritten: 0,
    reasons: { existing: 0 },
  })
  expect(
    sql.database.prepare('SELECT COUNT(*) AS count FROM enrichment_records').get(),
  ).toEqual({ count: 2 })

  const skipped = store.importRecords('grains', {
    [DEFAULT_RESEARCH_ENRICHMENT.id]: {
      'resource-1': enrichment('Skipped replacement'),
    },
  }, 'skip')
  expect(skipped).toEqual({
    imported: 0,
    skipped: 1,
    overwritten: 0,
    reasons: { existing: 1 },
  })
  expect(store.get('grains', 'resource-1')).toEqual(original)

  const replacement = enrichment('Replacement')
  const overwritten = store.importRecords('grains', {
    [DEFAULT_RESEARCH_ENRICHMENT.id]: { 'resource-1': replacement },
  }, 'overwrite')
  expect(overwritten).toEqual({
    imported: 1,
    skipped: 0,
    overwritten: 1,
    reasons: { existing: 0 },
  })
  expect(store.exportRecords('grains')[DEFAULT_RESEARCH_ENRICHMENT.id]?.['resource-1']).toEqual(
    replacement,
  )
  expect(store.exportRecords('other')).toEqual({})
})

Deno.test('DurableEnrichmentStore migrates the previous tenant-wide state row', () => {
  const { state, store } = durableStore()
  const legacy = {
    [DEFAULT_RESEARCH_ENRICHMENT.id]: {
      'legacy-resource': enrichment('Legacy title'),
    },
  }
  state.put('enrichments:other', legacy)

  expect(store.exportRecords('other')).toEqual(legacy)
  expect(state.get('enrichments:other', null)).toBeNull()
  expect(store.get('other', 'legacy-resource')).toEqual(
    legacy[DEFAULT_RESEARCH_ENRICHMENT.id]!['legacy-resource'],
  )
})

Deno.test('DurableEnrichmentStore writes a production-sized 3.8 MB archive in SQL batches', () => {
  const { store } = durableStore()
  const bucket: Record<string, Enrichment> = {}
  for (let index = 0; index < 3163; index++) {
    bucket[`resource-${index}`] = {
      schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
      generatedAt: '2026-08-28T00:00:00.000Z',
      data: {
        title: `Restored resource ${index}`,
        summary: 'x'.repeat(1120),
      },
    }
  }
  const records = { [DEFAULT_RESEARCH_ENRICHMENT.id]: bucket }
  expect(new TextEncoder().encode(JSON.stringify(records)).byteLength).toBeGreaterThan(3_800_000)

  expect(store.importRecords('marine', records, 'skip')).toMatchObject({
    imported: 3163,
    skipped: 0,
  })
  expect(store.count('marine')).toBe(3163)
})
Deno.test('DurableMcpKeyStore mirrors tenant isolation and immediate revocation', () => {
  const values = new Map<string, unknown>()
  const state = {
    get<T>(key: string, fallback: T): T {
      return structuredClone((values.get(key) ?? fallback) as T)
    },
    put(key: string, value: unknown): void {
      values.set(key, structuredClone(value))
    },
  } as unknown as DurableState
  const store = new DurableMcpKeyStore(state)
  const record: McpKeyRecord = {
    id: 'key-1',
    tenant: 'marine',
    issuerUserId: 'user-1',
    label: 'Research client',
    prefix: 'ck_mcp_abcdefghijkl',
    hash: 'b'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
  }

  store.add(record)
  expect(store.findByPrefix('marine', record.prefix)?.issuerUserId).toBe('user-1')
  expect(store.findByPrefix('grains', record.prefix)).toBeUndefined()
  expect(store.revoke('marine', record.id, '2026-09-01T01:00:00.000Z')).toBe(true)
  expect(store.findByPrefix('marine', record.prefix)?.revokedAt).toBe(
    '2026-09-01T01:00:00.000Z',
  )
})

Deno.test('DurableTenantStore exposes hostnames for OPAX and successfully provisioned portals', () => {
  const sql = new TestSqlStorage()
  const state = new DurableState(sql)
  state.migrate()
  const store = new DurableTenantStore(state)

  expect(store.add({ name: 'OPAX' }).hostname).toBe('opax.corpuskit.org')
  store.add({ name: 'New portal' })
  store.patch('new-portal', { hostname: 'new-portal.corpuskit.org' })

  expect(store.get('new-portal')?.hostname).toBe('new-portal.corpuskit.org')
  expect(store.list().find((tenant) => tenant.slug === 'new-portal')?.hostname).toBe(
    'new-portal.corpuskit.org',
  )
})
