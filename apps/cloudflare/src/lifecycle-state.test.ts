import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { DurableState, durableStores, type SqlStorageLike } from './state.ts'
import type { AuditInput } from '../../api/src/audit.ts'

class LifecycleSqlStorage implements SqlStorageLike {
  readonly database = new DatabaseSync(':memory:')

  transactionSync<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[]; one(): T } {
    let rows: T[] = []
    if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
      rows = this.database.prepare(query).all(...bindings as SQLInputValue[]) as T[]
    } else if (bindings.length === 0) this.database.exec(query)
    else this.database.prepare(query).run(...bindings as SQLInputValue[])
    return { toArray: () => rows, one: () => rows[0]! }
  }
}

function fixture() {
  const sql = new LifecycleSqlStorage()
  const state = new DurableState(sql, sql)
  state.migrate()
  return { sql, state, stores: durableStores(state, {}) }
}

const auditInput: Omit<AuditInput, 'outcome'> = {
  requestId: 'lifecycle-durable',
  actor: { kind: 'user', id: 'admin' },
  action: 'portal.lifecycle.update',
  scope: { kind: 'platform' },
  target: { kind: 'lifecycle', id: 'marine' },
  detail: { permission: 'portal.create', lifecycleStatus: 'suspended', note: 'Pause maintenance' },
}

Deno.test('durable lifecycle, ask usage and capacity reservations survive object restart', () => {
  const { sql, stores } = fixture()
  try {
    const now = Date.parse('2026-09-25T00:00:00Z')
    stores.lifecycle.set('marine', {
      status: 'read_only',
      limits: { asksPerDay: 1, maxResources: 2 },
    })
    stores.lifecycle.consumeAsk('marine', 'Australia/Melbourne', now)
    const admission = stores.lifecycle.reserveAdd('marine', { observed: 1, bytes: 5 })
    stores.lifecycle.settleAdd('marine', (admission as { admitted: string }).admitted, {
      created: true,
      id: 'resource-1',
    })
    const restarted = durableStores(new DurableState(sql, sql), {}).lifecycle
    expect(restarted.get('marine').status).toBe('read_only')
    expect(restarted.consumeAsk('marine', 'Australia/Melbourne', now)?.limit).toBe(1)
    expect(restarted.reserveAdd('marine', { observed: 1, bytes: 1 })).toEqual({
      limit: 'maxResources',
      value: 3,
      max: 2,
    })
    // The one resource that predates the ledger has no known size.
    expect(restarted.bytesUsed('marine', 2)).toBeNull()
    expect(restarted.usage('marine', 'Australia/Melbourne', now)).toEqual({
      asksToday: 1,
      asks30d: 1,
      lastActivityAt: '2026-09-25T00:00:00.000Z',
    })
    expect(restarted.get('grains')).toEqual({ status: 'active', limits: null, updatedAt: null })
    expect(restarted.usage('grains', 'UTC', now).asksToday).toBe(0)
  } finally {
    sql.database.close()
  }
})

Deno.test('durable quota admission is atomic across concurrent promise callers', async () => {
  const { sql, stores } = fixture()
  try {
    stores.lifecycle.set('marine', { status: 'active', limits: { asksPerDay: 2 } })
    const now = Date.parse('2026-09-25T00:00:00Z')
    const results = await Promise.all(Array.from({ length: 20 }, async () => {
      return await stores.lifecycle.consumeAsk('marine', 'UTC', now)
    }))
    expect(results.filter((result) => result === null).length).toBe(2)
    expect(stores.lifecycle.usage('marine', 'UTC', now).asksToday).toBe(2)
  } finally {
    sql.database.close()
  }
})

Deno.test('durable lifecycle writes and named audit completion commit together', async () => {
  const { sql, state, stores } = fixture()
  try {
    await state.localMutations.run(auditInput, new AbortController().signal, async () => {
      stores.lifecycle.set('marine', { status: 'suspended', limits: null })
    })
    const events = stores.audit.read({ scope: { kind: 'platform' } })
    expect(events.map((event) => event.action).sort()).toEqual([
      'local.mutation',
      'portal.lifecycle.update',
    ])
    expect(stores.lifecycle.get('marine').status).toBe('suspended')
    expect(
      JSON.parse(events.find((event) => event.action === 'portal.lifecycle.update')!.detail_json),
    )
      .toEqual({
        permission: 'portal.create',
        lifecycleStatus: 'suspended',
        note: 'Pause maintenance',
      })
  } finally {
    sql.database.close()
  }
})

Deno.test('durable lifecycle changes roll back audit append, named completion and commit failure', async () => {
  for (const failure of ['append', 'named', 'commit']) {
    const { sql, state, stores } = fixture()
    try {
      stores.lifecycle.set('marine', { status: 'read_only', limits: { asksPerDay: 1 } })
      const before = stores.lifecycle.get('marine')
      if (failure === 'commit') {
        sql.database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE lifecycle_parent (id INTEGER PRIMARY KEY); CREATE TABLE lifecycle_child (id INTEGER REFERENCES lifecycle_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_lifecycle AFTER INSERT ON audit_events BEGIN INSERT INTO lifecycle_child VALUES (1); END',
        )
      } else {
        sql.database.exec(
          `CREATE TRIGGER fail_lifecycle BEFORE INSERT ON audit_events ${
            failure === 'named' ? "WHEN NEW.action = 'portal.lifecycle.update'" : ''
          } BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END`,
        )
      }
      await expect(state.localMutations.run(
        auditInput,
        new AbortController().signal,
        async () => stores.lifecycle.set('marine', { status: 'suspended', limits: null }),
      )).rejects.toThrow()
      expect(stores.lifecycle.get('marine')).toEqual(before)
      expect(durableStores(new DurableState(sql, sql), {}).lifecycle.get('marine')).toEqual(before)
      expect(stores.audit.read({ scope: { kind: 'platform' } })).toEqual([])
    } finally {
      sql.database.close()
    }
  }
})

Deno.test('durable malformed lifecycle JSON never downgrades a portal to active or unlimited', () => {
  const { sql, stores } = fixture()
  try {
    sql.database.prepare('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)').run(
      'portal-lifecycle:marine',
      '{broken',
      1,
    )
    for (
      const operation of [
        () => stores.lifecycle.get('marine'),
        () => stores.lifecycle.consumeAsk('marine'),
        () => stores.lifecycle.set('marine', { status: 'active', limits: null }),
      ]
    ) expect(operation).toThrow('Invalid persisted portal lifecycle')
    expect(
      sql.database.prepare('SELECT value FROM state WHERE key = ?').get(
        'portal-lifecycle:marine',
      )?.value,
    ).toBe('{broken')
    // Usage and capacity records fail closed the same way.
    for (const key of ['portal-asks:grains', 'portal-capacity:grains']) {
      sql.database.prepare('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)').run(
        key,
        '{broken',
        1,
      )
    }
    expect(() => stores.lifecycle.consumeAsk('grains')).toThrow(
      'Invalid persisted portal lifecycle',
    )
    expect(() => stores.lifecycle.reserveAdd('grains', { observed: 0, bytes: 0 })).toThrow(
      'Invalid persisted portal lifecycle',
    )
  } finally {
    sql.database.close()
  }
})
