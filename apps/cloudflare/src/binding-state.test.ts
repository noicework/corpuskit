import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { BindingCipher } from '../../api/src/binding-crypto.ts'
import type { AuditInput } from '../../api/src/audit.ts'
import { DurableBindingStore, DurableState, durableStores, type SqlStorageLike } from './state.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
const TOKEN = 'test-only-durable-binding-token'
const binding = { baseUrl: 'https://kb.example.test/api/v1/kb/example', token: TOKEN }
const storedBinding = { ...binding, connectedAt: '2026-01-01' }
const input: Omit<AuditInput, 'outcome'> = {
  requestId: 'binding-test',
  actor: { kind: 'user', id: 'test-user' },
  action: 'request.privileged',
  scope: { kind: 'portal', slug: 'marine' },
  target: { kind: 'bindings', id: 'marine' },
  detail: {},
}

class TestSqlStorage implements SqlStorageLike {
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
    } else if (!bindings.length) {
      this.database.exec(query)
    } else {
      this.database.prepare(query).run(...bindings as SQLInputValue[])
    }
    return { toArray: () => rows, one: () => rows[0]! }
  }
}

function fixture() {
  const sql = new TestSqlStorage()
  const state = new DurableState(sql, sql)
  state.migrate()
  return {
    sql,
    state,
    raw: () => JSON.stringify(sql.database.prepare('SELECT key,value FROM state').all()),
    cleanup: () => sql.database.close(),
  }
}

Deno.test('durable binding migration seals plaintext once while preserving encrypted rows and metadata', async () => {
  const f = fixture()
  try {
    const sealed = await new BindingCipher(KEY).seal('grains', 'test-only-already-encrypted')
    f.state.put('bindings', {
      marine: storedBinding,
      grains: { ...storedBinding, token: sealed },
    })
    const store = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    expect(() => store.get('marine')).toThrow('binding_not_initialized')
    await store.initialize()
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(store.get('grains')?.token).toBe('test-only-already-encrypted')
    const persisted = f.state.get('bindings', {} as Record<string, typeof storedBinding>)
    expect(persisted.marine?.connectedAt).toBe(storedBinding.connectedAt)
    expect(persisted.marine?.token).toMatch(/^enc:v1:/)
    expect(persisted.grains?.token).toBe(sealed)
    const before = f.raw()
    expect(before).not.toContain(TOKEN)
    await store.initialize()
    const restarted = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    await restarted.initialize()
    expect(f.raw()).toBe(before)
    expect(restarted.get('marine')?.token).toBe(TOKEN)
  } finally {
    f.cleanup()
  }
})

Deno.test('durable bindings without a key read existing plaintext and environment boxes but reject writes', async () => {
  const f = fixture()
  try {
    f.state.put('bindings', { marine: storedBinding })
    const store = new DurableBindingStore(f.state, {
      ARAG_ZONE: 'us1',
      ARAG_KB_GRAINS: 'environment',
      ARAG_KB_GRAINS_TOKEN: 'test-only-env-token',
    })
    await store.initialize()
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(store.get('grains')?.token).toBe('test-only-env-token')
    expect(store.isDemo('grains')).toBe(true)
    expect(store.encryptionStatus()).toEqual({ configured: false, required: true, writable: false })
    const before = f.raw()
    expect(() => store.assertWritable()).toThrow('binding_key_missing')
    for (const slug of ['marine', 'new']) {
      expect(() => store.set(slug, binding)).toThrow('binding_key_missing')
    }
    expect(f.raw()).toBe(before)
    store.remove('marine')
    expect(store.get('marine')).toBeUndefined()
  } finally {
    f.cleanup()
  }
})

Deno.test('durable binding inserts and replacements seal fresh values and preserve concurrent writes', async () => {
  const f = fixture()
  try {
    const store = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    await store.initialize()
    await Promise.all([store.set('marine', binding), store.set('grains', binding)])
    const before = f.state.get('bindings', {} as Record<string, typeof storedBinding>)
    expect(Object.keys(before).sort()).toEqual(['grains', 'marine'])
    expect(before.marine?.token).not.toBe(before.grains?.token)
    await store.set('marine', binding)
    expect(f.state.get('bindings', {} as Record<string, typeof storedBinding>).marine?.token)
      .not.toBe(before.marine?.token)
    expect(f.raw()).not.toContain(TOKEN)
    expect(store.get('marine')?.token).toBe(TOKEN)
    const returned = store.get('marine')!
    returned.token = 'modified-value'
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(JSON.stringify(store.status('marine'))).not.toContain(TOKEN)
    expect(store.encryptionStatus()).toEqual({ configured: true, required: true, writable: true })
  } finally {
    f.cleanup()
  }
})

Deno.test('durable ciphertext failures never rewrite state or fall back to an environment token', async () => {
  for (const kind of ['malformed', 'wrong-key', 'wrong-slug', 'missing-key']) {
    const f = fixture()
    try {
      const sealed = await new BindingCipher(KEY).seal('marine', TOKEN)
      f.state.put('bindings', {
        plaintext: storedBinding,
        grains: { ...storedBinding, token: kind === 'malformed' ? 'enc:v1:bad:bad' : sealed },
      })
      const before = f.raw()
      const store = new DurableBindingStore(f.state, {
        BINDING_KEY: kind === 'missing-key'
          ? undefined
          : kind === 'wrong-key'
          ? btoa('x'.repeat(32))
          : KEY,
        ARAG_ZONE: 'us1',
        ARAG_KB_GRAINS: 'environment',
        ARAG_KB_GRAINS_TOKEN: 'test-only-env-token',
      })
      await expect(store.initialize()).rejects.toThrow(
        kind === 'missing-key' ? 'binding_key_missing' : 'binding_decryption_failed',
      )
      expect(() => store.get('grains')).toThrow('binding_not_initialized')
      expect(f.raw()).toBe(before)
    } finally {
      f.cleanup()
    }
  }
})

Deno.test('durable binding writes commit ciphertext and audit together after encryption', async () => {
  const f = fixture()
  try {
    const store = durableStores(f.state, { BINDING_KEY: KEY }).bindings
    await store.initialize()
    await f.state.localMutations.run(
      input,
      new AbortController().signal,
      () => store.set('marine', binding),
    )
    expect(store.get('marine')?.token).toBe(TOKEN)
    const events = f.state.rbac.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.action).toBe('local.mutation')
    expect(JSON.parse(events[0]!.detail_json).mutation).toBe('bindings.set')
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    await f.state.localMutations.run(
      input,
      new AbortController().signal,
      () => store.remove('marine'),
    )
    expect(store.get('marine')).toBeUndefined()
    expect(f.state.rbac.audit.read({ scope: { kind: 'portal', slug: 'marine' } })).toHaveLength(2)
  } finally {
    f.cleanup()
  }
})

Deno.test('durable binding caches and ciphertext roll back on audit append and SQL commit failure', async () => {
  for (const failure of ['append', 'commit']) {
    const f = fixture()
    try {
      const store = durableStores(f.state, { BINDING_KEY: KEY }).bindings
      await store.initialize()
      await store.set('marine', binding)
      const before = f.raw()
      if (failure === 'append') {
        f.sql.database.exec(
          "CREATE TRIGGER fail_binding BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
        )
      } else {
        f.sql.database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_binding AFTER INSERT ON audit_events BEGIN INSERT INTO child VALUES (1); END',
        )
      }
      for (
        const mutate of [
          () => store.set('marine', { ...binding, token: 'test-only-replacement-token' }),
          () => store.remove('marine'),
        ]
      ) {
        await expect(f.state.localMutations.run(input, new AbortController().signal, mutate))
          .rejects.toThrow()
        expect(f.raw()).toBe(before)
        expect(store.get('marine')?.token).toBe(TOKEN)
        expect(f.state.rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
      }
    } finally {
      f.cleanup()
    }
  }
})

Deno.test('durable binding encryption cannot commit after the audit scope is cancelled', async () => {
  const f = fixture()
  try {
    const store = durableStores(f.state, { BINDING_KEY: KEY }).bindings
    await store.initialize()
    const controller = new AbortController()
    await expect(f.state.localMutations.run(input, controller.signal, async () => {
      const pending = store.set('marine', binding)
      controller.abort()
      await pending
    })).rejects.toThrow()
    expect(store.get('marine')).toBeUndefined()
    expect(f.state.get('bindings', {})).toEqual({})
    expect(f.state.rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
  } finally {
    f.cleanup()
  }
})

Deno.test('durable malformed binding JSON fails closed without logging credential fragments', () => {
  const f = fixture()
  const logged: unknown[][] = []
  const log = console.error
  console.error = (...args) => {
    logged.push(args)
  }
  try {
    const raw = `{"marine":{"token":"${TOKEN}",`
    f.sql.exec('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)', 'bindings', raw, 1)
    expect(() => new DurableBindingStore(f.state, {})).toThrow('binding_storage_invalid')
    expect(logged).toEqual([])
    expect(f.raw()).toContain(TOKEN)
  } finally {
    console.error = log
    f.cleanup()
  }
})
