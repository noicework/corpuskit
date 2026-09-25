import { expect } from '@std/expect'
import { BindingCipher } from './binding-crypto.ts'
import { BindingStore } from './bindings.ts'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
const TOKEN = 'test-only-local-binding-token'
const binding = { baseUrl: 'https://kb.example.test/api/v1/kb/example', token: TOKEN }

function fixture() {
  const directory = Deno.makeTempDirSync()
  const path = `${directory}/bindings.json`
  return {
    path,
    env: { BINDING_KEY: KEY, BINDINGS_PATH: path },
    raw: () => Deno.readTextFileSync(path),
    cleanup: () => Deno.removeSync(directory, { recursive: true }),
  }
}

Deno.test('local bindings migrate mixed plaintext and encrypted rows once, preserving metadata', async () => {
  const f = fixture()
  try {
    const sealed = await new BindingCipher(KEY).seal('grains', 'test-only-existing-token')
    Deno.writeTextFileSync(
      f.path,
      JSON.stringify({
        marine: { ...binding, connectedAt: '2026-01-01' },
        grains: { ...binding, token: sealed, connectedAt: '2026-02-01' },
      }),
    )
    const store = new BindingStore(f.env)
    expect(() => store.get('marine')).toThrow('binding_not_initialized')
    await store.initialize()
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(store.get('grains')?.token).toBe('test-only-existing-token')
    const migrated = f.raw()
    expect(migrated).not.toContain(TOKEN)
    expect(JSON.parse(migrated).marine.connectedAt).toBe('2026-01-01')
    expect(JSON.parse(migrated).grains.token).toBe(sealed)
    await store.initialize()
    expect(f.raw()).toBe(migrated)
    const restarted = new BindingStore(f.env)
    await restarted.initialize()
    expect(f.raw()).toBe(migrated)
    expect(restarted.get('marine')?.token).toBe(TOKEN)
  } finally {
    f.cleanup()
  }
})

Deno.test('local bindings seal every insert and replacement and never disclose tokens in status', async () => {
  const f = fixture()
  try {
    const store = new BindingStore(f.env)
    await store.initialize()
    await store.set('marine', binding)
    const first = JSON.parse(f.raw()).marine.token
    await store.set('marine', binding)
    expect(JSON.parse(f.raw()).marine.token).not.toBe(first)
    expect(f.raw()).not.toContain(TOKEN)
    expect(store.get('marine')?.token).toBe(TOKEN)
    const returned = store.get('marine')!
    returned.token = 'modified-return-value'
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(JSON.stringify(store.status('marine'))).not.toContain(TOKEN)
    expect(store.encryptionStatus()).toEqual({ configured: true, required: false, writable: true })
    store.remove('marine')
    expect(store.get('marine')).toBeUndefined()
    expect(JSON.parse(f.raw())).toEqual({})
  } finally {
    f.cleanup()
  }
})

Deno.test('local bindings allow synchronous plaintext writes without a key and warn without credentials', async () => {
  const f = fixture()
  const messages: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => {
    messages.push(args)
  }
  try {
    const store = new BindingStore({ BINDINGS_PATH: f.path })
    expect(store.set('marine', binding)).toBeUndefined()
    expect(store.get('marine')?.token).toBe(TOKEN)
    await store.initialize()
    expect(JSON.parse(f.raw()).marine.token).toBe(TOKEN)
    expect(store.encryptionStatus()).toEqual({ configured: false, required: false, writable: true })
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain('BINDING_KEY')
    expect(JSON.stringify(messages)).not.toContain(TOKEN)
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('local binding migration is atomic and rejects corrupt ciphertext without environment fallback', async () => {
  const f = fixture()
  try {
    Deno.writeTextFileSync(
      f.path,
      JSON.stringify({
        marine: { ...binding, connectedAt: 'then' },
        grains: { ...binding, token: 'enc:v1:broken:token', connectedAt: 'then' },
      }),
    )
    const before = f.raw()
    const store = new BindingStore({
      ...f.env,
      ARAG_ZONE: 'us1',
      ARAG_KB_GRAINS: 'environment',
      ARAG_KB_GRAINS_TOKEN: 'test-only-environment-token',
    })
    await expect(store.initialize()).rejects.toThrow('binding_decryption_failed')
    expect(f.raw()).toBe(before)
    expect(() => store.get('grains')).toThrow('binding_not_initialized')
  } finally {
    f.cleanup()
  }
})

Deno.test('local encrypted bindings fail closed when the key is removed or changed', async () => {
  const f = fixture()
  try {
    const store = new BindingStore(f.env)
    await store.initialize()
    await store.set('marine', binding)
    const before = f.raw()
    for (const BINDING_KEY of [undefined, btoa('x'.repeat(32))]) {
      const restarted = new BindingStore({ BINDINGS_PATH: f.path, BINDING_KEY })
      await expect(restarted.initialize()).rejects.toThrow(
        BINDING_KEY ? 'binding_decryption_failed' : 'binding_key_missing',
      )
      expect(() => restarted.get('marine')).toThrow('binding_not_initialized')
      expect(f.raw()).toBe(before)
    }
  } finally {
    f.cleanup()
  }
})

Deno.test('local legacy KB identifiers are normalized during encrypted migration', async () => {
  const f = fixture()
  try {
    Deno.writeTextFileSync(f.path, JSON.stringify({ marine: { kbId: 'legacy', token: TOKEN } }))
    const store = new BindingStore({ ...f.env, ARAG_ZONE: 'us1' })
    await store.initialize()
    expect(store.get('marine')?.baseUrl).toBe('https://us1.rag.progress.cloud/api/v1/kb/legacy')
    expect(f.raw()).not.toContain(TOKEN)
  } finally {
    f.cleanup()
  }
})

Deno.test('local malformed credential JSON and records fail without logging secret fragments', () => {
  const f = fixture()
  const logged: unknown[][] = []
  const log = console.error
  console.error = (...args) => {
    logged.push(args)
  }
  try {
    for (const raw of [`{"marine":"${TOKEN}",`, JSON.stringify({ marine: { token: TOKEN } })]) {
      Deno.writeTextFileSync(f.path, raw)
      expect(() => new BindingStore(f.env)).toThrow('binding_storage_invalid')
      expect(f.raw()).toBe(raw)
    }
    expect(logged).toEqual([])
  } finally {
    console.error = log
    f.cleanup()
  }
})
