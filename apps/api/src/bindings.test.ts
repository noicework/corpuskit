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
    expect(store.encryptionStatus()).toEqual({
      configured: true,
      required: false,
      writable: true,
      unavailable: 0,
    })
    store.remove('marine')
    expect(store.get('marine')).toBeUndefined()
    expect(JSON.parse(f.raw())).toEqual({})
  } finally {
    f.cleanup()
  }
})

Deno.test('local bindings allow plaintext writes without a key and warn without credentials', async () => {
  const f = fixture()
  const messages: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => {
    messages.push(args)
  }
  try {
    const store = new BindingStore({ BINDINGS_PATH: f.path })
    const pending = store.set('marine', binding)
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(store.get('marine')?.token).toBe(TOKEN)
    await store.initialize()
    expect(JSON.parse(f.raw()).marine.token).toBe(TOKEN)
    expect(store.encryptionStatus()).toEqual({
      configured: false,
      required: false,
      writable: true,
      unavailable: 0,
    })
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain('BINDING_KEY')
    expect(JSON.stringify(messages)).not.toContain(TOKEN)
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('local corrupt ciphertext is withheld without environment fallback or migration', async () => {
  const f = fixture()
  const warn = console.warn
  console.warn = () => {}
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
    await store.initialize()
    // Nothing is sealed with a key that could not open every stored record.
    expect(f.raw()).toBe(before)
    expect(() => store.get('grains')).toThrow('binding_unavailable')
    expect(store.isDemo('grains')).toBe(false)
    expect(store.status('grains')).toEqual({
      slug: 'grains',
      status: 'unavailable',
      kbId: 'example',
    })
    expect(store.get('marine')?.token).toBe(TOKEN)
    expect(store.encryptionStatus()).toMatchObject({ writable: true, unavailable: 1 })
    expect(store.encryptionStatus().error).toBeUndefined()
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('local encrypted bindings are withheld, not lost, when the key is removed or changed', async () => {
  const f = fixture()
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => {
    warnings.push(args)
  }
  try {
    const store = new BindingStore(f.env)
    await store.initialize()
    await store.set('marine', binding)
    const before = f.raw()
    for (const BINDING_KEY of [undefined, btoa('x'.repeat(32))]) {
      const restarted = new BindingStore({ BINDINGS_PATH: f.path, BINDING_KEY })
      await restarted.initialize()
      expect(() => restarted.get('marine')).toThrow('binding_unavailable')
      expect(restarted.status('marine').status).toBe('unavailable')
      expect(restarted.encryptionStatus()).toMatchObject({
        unavailable: 1,
        ...(BINDING_KEY ? {} : { error: 'binding_key_missing' }),
      })
      expect(f.raw()).toBe(before)
    }
    // Restoring the right key recovers the stored credential unchanged.
    const restored = new BindingStore(f.env)
    await restored.initialize()
    expect(restored.get('marine')?.token).toBe(TOKEN)
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('local withheld bindings can be replaced or removed under a new key', async () => {
  const f = fixture()
  const warn = console.warn
  console.warn = () => {}
  try {
    const original = new BindingStore(f.env)
    await original.initialize()
    await original.set('marine', binding)
    await original.set('grains', binding)
    const rotated = { BINDINGS_PATH: f.path, BINDING_KEY: btoa('r'.repeat(32)) }
    const store = new BindingStore(rotated)
    await store.initialize()
    await store.set('marine', { ...binding, token: 'test-only-replacement-token' })
    store.remove('grains')
    expect(store.encryptionStatus().unavailable).toBe(0)
    expect(Object.keys(JSON.parse(f.raw()))).toEqual(['marine'])
    const restarted = new BindingStore(rotated)
    await restarted.initialize()
    expect(restarted.get('marine')?.token).toBe('test-only-replacement-token')
    expect(restarted.get('grains')).toBeUndefined()
  } finally {
    console.warn = warn
    f.cleanup()
  }
})

Deno.test('local malformed binding key withholds sealed records and refuses writes', async () => {
  const f = fixture()
  const warn = console.warn
  console.warn = () => {}
  try {
    const store = new BindingStore(f.env)
    await store.initialize()
    await store.set('marine', binding)
    const before = f.raw()
    const broken = new BindingStore({ BINDINGS_PATH: f.path, BINDING_KEY: 'not-a-key' })
    expect(() => broken.get('marine')).toThrow('binding_unavailable')
    expect(broken.encryptionStatus()).toEqual({
      configured: true,
      required: false,
      writable: false,
      error: 'binding_key_invalid',
      unavailable: 1,
    })
    await expect(broken.set('grains', binding)).rejects.toThrow('binding_key_invalid')
    expect(f.raw()).toBe(before)
  } finally {
    console.warn = warn
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

Deno.test('local malformed credential JSON and records are withheld without logging secret fragments', async () => {
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
    const unreadable = `{"marine":"${TOKEN}",`
    Deno.writeTextFileSync(f.path, unreadable)
    const store = new BindingStore({
      ...f.env,
      ARAG_KB_GRAINS: 'environment',
      ARAG_KB_GRAINS_TOKEN: 'test-only-environment-token',
    })
    await store.initialize()
    // Unreadable storage could hide any portal's record, so no environment box stands in.
    for (const slug of ['marine', 'grains']) {
      expect(() => store.get(slug)).toThrow('binding_storage_invalid')
      expect(store.status(slug)).toEqual({ slug, status: 'unavailable' })
    }
    await expect(store.set('marine', binding)).rejects.toThrow('binding_storage_invalid')
    expect(() => store.remove('marine')).toThrow('binding_storage_invalid')
    expect(store.encryptionStatus()).toMatchObject({
      writable: false,
      error: 'binding_storage_invalid',
    })
    expect(f.raw()).toBe(unreadable)

    const shapeless = JSON.stringify({ marine: { token: TOKEN }, grains: { ...binding } })
    Deno.writeTextFileSync(f.path, shapeless)
    const partial = new BindingStore(f.env)
    await partial.initialize()
    expect(() => partial.get('marine')).toThrow('binding_unavailable')
    expect(partial.status('marine')).toEqual({ slug: 'marine', status: 'unavailable' })
    expect(partial.get('grains')?.token).toBe(TOKEN)
    // The bad record blocks automatic sealing but can still be removed.
    expect(f.raw()).toBe(shapeless)
    partial.remove('marine')
    expect(Object.keys(JSON.parse(f.raw()))).toEqual(['grains'])
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
  } finally {
    console.error = log
    console.warn = warn
    f.cleanup()
  }
})
