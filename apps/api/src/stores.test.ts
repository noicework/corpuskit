import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@std/expect'

// DATA_DIR is read at module load, so point it at a temp dir before importing.
const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)
const { InsightsStore, McpKeyStore, SessionsStore, SourceStore, WatchStore } = await import(
  './stores.ts'
)
const { readJsonSafe, writeFileAtomic, writeJsonAtomic } = await import('./persist.ts')
const { BindingStore } = await import('./bindings.ts')

Deno.test('insights summary aggregates asks and surfaces gaps', () => {
  const store = new InsightsStore()
  const base = {
    ts: new Date().toISOString(),
    citations: 2,
    durationSec: 1.5,
    answerRelevance: 5,
    contextRelevance: 3,
  }
  store.record('t1', { ...base, question: 'What is X?', answered: true, groundedness: 5 })
  store.record('t1', { ...base, question: 'what is x', answered: true, groundedness: 4 })
  store.record('t1', {
    ...base,
    question: 'Unanswerable?',
    answered: false,
    citations: 0,
    groundedness: null,
  })
  const summary = store.summary('t1')
  expect(summary.totalAsks).toEqual(3)
  expect(summary.answered).toEqual(2)
  expect(summary.unanswered).toEqual(1)
  // Case and trailing punctuation collapse into one top question.
  expect(summary.topQuestions[0]!).toEqual({ question: 'what is x', count: 2 })
  expect(summary.gaps.length).toEqual(1)
  expect(summary.gaps[0]!.reason).toEqual('No answer found in the corpus')
  expect(summary.avgGroundedness).toEqual(4.5)
})

Deno.test('sessions are isolated per client and removable', () => {
  const store = new SessionsStore()
  const session = { id: 's1', title: 'Trail', updatedAt: '2026-01-01T00:00:00Z', messages: [] }
  store.put('t1', 'alice', session)
  expect(store.list('t1', 'alice').length).toEqual(1)
  expect(store.list('t1', 'bob').length).toEqual(0)
  expect(store.get('t1', 'bob', 's1')).toEqual(null)
  store.remove('t1', 'alice', 's1')
  expect(store.list('t1', 'alice').length).toEqual(0)
})

Deno.test('watches flag changes only after a baseline exists', () => {
  const store = new WatchStore()
  const watch = store.add('t1', 'alice', 'carp control')
  expect(store.list('t1', 'alice')[0]!.changed).toEqual(false)
  // First run establishes the baseline fingerprint.
  store.update('t1', watch.id, { fingerprint: 'a|b', changed: false })
  // A later differing fingerprint marks the watch changed until seen.
  const before = store.list('t1')[0]!
  store.update('t1', watch.id, {
    changed: before.fingerprint !== null && before.fingerprint !== 'a|c',
    fingerprint: 'a|c',
  })
  expect(store.list('t1', 'alice')[0]!.changed).toEqual(true)
  store.remove('t1', 'bob', watch.id)
  expect(store.list('t1', 'alice').length).toEqual(1)
  store.remove('t1', 'alice', watch.id)
  expect(store.list('t1', 'alice').length).toEqual(0)
})

Deno.test('sources dedupe by url and persist sync bookkeeping', () => {
  const store = new SourceStore()
  const source = store.add('t1', 'https://example.org', true)
  const duplicate = store.add('t1', 'https://example.org', true)
  expect(duplicate.id).toEqual(source.id)
  store.update('t1', source.id, { lastAdded: 5, synced: ['https://example.org/a'] })
  expect(store.list('t1')[0]!.lastAdded).toEqual(5)
  store.remove('t1', source.id)
  expect(store.list('t1').length).toEqual(0)
})

Deno.test('sources persist across a fresh store instance (read/write round-trip)', () => {
  new SourceStore().add('roundtrip', 'https://example.org/roundtrip', false)
  // A brand new instance has no in-memory state - this only passes if the
  // add() above actually reached disk and this instance reads it back.
  const reopened = new SourceStore().list('roundtrip')
  expect(reopened.length).toEqual(1)
  expect(reopened[0]!.url).toEqual('https://example.org/roundtrip')
})

Deno.test('MCP keys persist only hashes and stay isolated by tenant', () => {
  const store = new McpKeyStore(dir)
  const record = {
    id: 'key-1',
    tenant: 'marine',
    issuerUserId: 'user-1',
    label: 'Research client',
    prefix: 'ck_mcp_abcdefghijkl',
    hash: 'a'.repeat(64),
    createdAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
  }
  store.add(record)

  expect(new McpKeyStore(dir).findByPrefix('marine', record.prefix)?.hash).toBe(record.hash)
  expect(store.findByPrefix('grains', record.prefix)).toBeUndefined()
  expect(readFileSync(join(dir, 'mcp-keys', 'marine.json'), 'utf8')).not.toContain(
    'a-working-secret',
  )
  expect(store.revoke('marine', record.id, '2026-09-01T01:00:00.000Z')).toBe(true)
  expect(store.list('marine')[0]?.revokedAt).toBe('2026-09-01T01:00:00.000Z')
})

// --- Atomic write helper (persist.ts) ---------------------------------------

Deno.test('writeFileAtomic writes the exact content and leaves no .tmp file behind', async () => {
  const target = join(await Deno.makeTempDir(), 'nested', 'file.json')
  writeFileAtomic(target, '{"ok":true}')
  expect(readFileSync(target, 'utf8')).toEqual('{"ok":true}')
  expect(existsSync(`${target}.tmp`)).toEqual(false)
})

Deno.test('writeJsonAtomic round-trips through readJsonSafe', async () => {
  const target = join(await Deno.makeTempDir(), 'value.json')
  writeJsonAtomic(target, { a: 1, b: ['x', 'y'] })
  expect(readJsonSafe(target, null)).toEqual({ a: 1, b: ['x', 'y'] })
})

Deno.test('readJsonSafe returns the fallback without quarantining a missing file', async () => {
  const target = join(await Deno.makeTempDir(), 'missing.json')
  expect(readJsonSafe(target, { fallback: true })).toEqual({ fallback: true })
  expect(existsSync(target)).toEqual(false)
})

Deno.test('readJsonSafe quarantines a corrupted file and returns the fallback', async () => {
  const tmp = await Deno.makeTempDir()
  const target = join(tmp, 'bindings.json')
  writeFileSync(target, '{"not valid json"')
  const result = readJsonSafe(target, { fallback: true })
  expect(result).toEqual({ fallback: true })
  // The corrupt file is moved aside, not left in place or deleted outright.
  expect(existsSync(target)).toEqual(false)
  const quarantined = [...Deno.readDirSync(tmp)].find((e) =>
    e.name.startsWith('bindings.json.corrupt-')
  )
  expect(quarantined).toBeDefined()
  expect(readFileSync(join(tmp, quarantined!.name), 'utf8')).toEqual('{"not valid json"')
})

// --- Corruption handling at the store level (BindingStore) ------------------

Deno.test('BindingStore quarantines a corrupted bindings file and falls back to demo bindings', () => {
  const tmp = Deno.makeTempDirSync()
  const bindingsPath = join(tmp, 'bindings.json')
  writeFileSync(bindingsPath, '{"grains": truncated')
  const store = new BindingStore({
    ARAG_ZONE: 'us1',
    ARAG_KB_GRAINS: 'demo-kb-id',
    ARAG_KB_GRAINS_TOKEN: 'demo-token',
    BINDINGS_PATH: bindingsPath,
  })
  // Reverts to the seeded demo binding rather than throwing or losing state.
  expect(store.isDemo('grains')).toEqual(true)
  expect(store.get('grains')?.kbId).toEqual('demo-kb-id')
  // The truncated file was moved aside, not silently overwritten in place.
  expect(existsSync(bindingsPath)).toEqual(false)
  const quarantined = [...Deno.readDirSync(tmp)].find((e) =>
    e.name.startsWith('bindings.json.corrupt-')
  )
  expect(quarantined).toBeDefined()
})
