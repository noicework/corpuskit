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
    expect(store.encryptionStatus()).toEqual({
      configured: false,
      required: true,
      writable: false,
      error: 'binding_key_missing',
      unavailable: 0,
    })
    const before = f.raw()
    expect(() => store.assertWritable()).toThrow('binding_key_missing')
    for (const slug of ['marine', 'new']) {
      await expect(store.set(slug, binding)).rejects.toThrow('binding_key_missing')
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
    expect(store.encryptionStatus()).toEqual({
      configured: true,
      required: true,
      writable: true,
      unavailable: 0,
    })
  } finally {
    f.cleanup()
  }
})

Deno.test('durable ciphertext failures withhold only that record, without rewrites or fallback', async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    await ciphertextFailures()
  } finally {
    console.warn = warn
  }
})

async function ciphertextFailures() {
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
      await store.initialize()
      expect(() => store.get('grains')).toThrow('binding_unavailable')
      expect(store.isDemo('grains')).toBe(false)
      expect(store.status('grains')).toEqual({
        slug: 'grains',
        status: 'unavailable',
        kbId: 'example',
      })
      // Other portals keep working, and nothing is sealed with a key that failed a record.
      expect(store.get('plaintext')?.token).toBe(TOKEN)
      expect(store.encryptionStatus().unavailable).toBe(1)
      expect(f.raw()).toBe(before)
    } finally {
      f.cleanup()
    }
  }
}

Deno.test('durable withheld bindings are recoverable by key restore, replacement or removal', async () => {
  const warn = console.warn
  console.warn = () => {}
  const f = fixture()
  try {
    const original = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    await original.initialize()
    await original.set('marine', binding)
    await original.set('grains', binding)
    const sealed = f.raw()

    const rotated = { BINDING_KEY: btoa('r'.repeat(32)) }
    const store = durableStores(f.state, rotated).bindings
    await store.initialize()
    expect(store.encryptionStatus()).toMatchObject({ writable: true, unavailable: 2 })
    expect(f.raw()).toBe(sealed)
    const restored = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    await restored.initialize()
    expect(restored.get('grains')?.token).toBe(TOKEN)

    await f.state.localMutations.run(
      input,
      new AbortController().signal,
      () => store.set('marine', { ...binding, token: 'test-only-replacement-token' }),
    )
    await f.state.localMutations.run(
      { ...input, scope: { kind: 'portal', slug: 'grains' } },
      new AbortController().signal,
      () => store.remove('grains'),
    )
    expect(store.encryptionStatus().unavailable).toBe(0)
    const restarted = new DurableBindingStore(f.state, rotated)
    await restarted.initialize()
    expect(restarted.get('marine')?.token).toBe('test-only-replacement-token')
    expect(restarted.status('grains').status).toBe('none')
    expect(f.raw()).not.toContain('test-only-replacement-token')
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('durable malformed binding key never throws at start-up and refuses writes', async () => {
  const warn = console.warn
  console.warn = () => {}
  const f = fixture()
  try {
    const original = new DurableBindingStore(f.state, { BINDING_KEY: KEY })
    await original.initialize()
    await original.set('marine', binding)
    const before = f.raw()
    const store = new DurableBindingStore(f.state, { BINDING_KEY: 'not-a-key' })
    await store.initialize()
    expect(() => store.get('marine')).toThrow('binding_unavailable')
    expect(store.encryptionStatus()).toEqual({
      configured: true,
      required: true,
      writable: false,
      error: 'binding_key_invalid',
      unavailable: 1,
    })
    expect(() => store.assertWritable()).toThrow('binding_key_invalid')
    await expect(store.set('marine', binding)).rejects.toThrow('binding_key_invalid')
    expect(f.raw()).toBe(before)
  } finally {
    console.warn = warn
    f.cleanup()
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

Deno.test('durable malformed binding JSON fails closed without logging credential fragments', async () => {
  const f = fixture()
  const logged: unknown[][] = []
  const log = console.error
  const warn = console.warn
  console.error = (...args) => {
    logged.push(args)
  }
  console.warn = (...args) => {
    logged.push(args)
  }
  try {
    const raw = `{"marine":{"token":"${TOKEN}",`
    f.sql.exec('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)', 'bindings', raw, 1)
    const store = new DurableBindingStore(f.state, {
      BINDING_KEY: KEY,
      ARAG_KB_GRAINS: 'environment',
      ARAG_KB_GRAINS_TOKEN: 'test-only-env-token',
    })
    await store.initialize()
    for (const slug of ['marine', 'grains']) {
      expect(() => store.get(slug)).toThrow('binding_storage_invalid')
      expect(store.status(slug)).toEqual({ slug, status: 'unavailable' })
    }
    expect(store.encryptionStatus()).toMatchObject({
      writable: false,
      error: 'binding_storage_invalid',
    })
    await expect(store.set('marine', binding)).rejects.toThrow('binding_storage_invalid')
    expect(() => store.remove('marine')).toThrow('binding_storage_invalid')
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(f.raw()).toContain(TOKEN)
  } finally {
    console.error = log
    console.warn = warn
    f.cleanup()
  }
})
