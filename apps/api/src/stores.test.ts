import { checkOwnedStores, ownedMutationCases, seedOwned } from './owned-store-fixture.ts'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@std/expect'
import { migrateLegacyKeyRecord } from './scoped-key-record.ts'
import { openLocalRbac } from './rbac-local.ts'
import type { McpKeyRecord } from './stores.ts'
import { createAuditEvent } from './audit.ts'

function fileSnapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => {
        const path = join(entry.parentPath, entry.name)
        return [path.slice(root.length), Array.from(readFileSync(path)).join(',')]
      }),
  )
}

Deno.test('local owned mutations restore exact files after authoritative append and SQL commit failures', () => {
  for (const failure of ['append', 'commit']) {
    const dataDir = Deno.makeTempDirSync()
    const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir })
    const plain = {
      sessions: new SessionsStore(dataDir),
      watches: new WatchStore(dataDir),
      investigations: new InvestigationStore(dataDir),
    }
    const { watch, investigation, evidence } = seedOwned(plain)
    const before = fileSnapshot(join(dataDir, 'research-v2'))
    try {
      if (failure === 'commit') {
        database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE owner_parent (id INTEGER PRIMARY KEY); CREATE TABLE owner_child (id INTEGER REFERENCES owner_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_owned AFTER INSERT ON audit_events BEGIN INSERT INTO owner_child VALUES (1); END',
        )
      }
      const boundary = {
        database,
        complete: () => {
          rbac.audit.append(
            createAuditEvent({
              requestId: 'owned-test',
              actor: { kind: 'user', id: 'same' },
              action: 'local.mutation',
              scope: { kind: 'portal', slug: 'marine' },
              target: { kind: 'sessions' },
              outcome: 'success',
              detail: {},
            }),
          )
          if (failure === 'append') throw new Error('Authoritative append failed')
        },
      }
      const protectedStores = {
        sessions: new SessionsStore(dataDir, boundary),
        watches: new WatchStore(dataDir, boundary),
        investigations: new InvestigationStore(dataDir, boundary),
      }
      for (
        const mutate of ownedMutationCases(protectedStores, watch.id, investigation.id, evidence.id)
      ) {
        expect(mutate).toThrow()
        expect(fileSnapshot(join(dataDir, 'research-v2'))).toEqual(before)
        expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
      }
      const fresh = new SessionsStore(dataDir)
      expect(fresh.get('marine', { kind: 'user', tenantId: 'one', oid: 'same' }, 's')?.title).toBe(
        'original',
      )
    } finally {
      database.close()
      Deno.removeSync(dataDir, { recursive: true })
    }
  }
})

Deno.test('local history requires actual raw identity and portal evidence and never adopts signed ownership', () => {
  const dataDir = Deno.makeTempDirSync()
  const session = { id: 's', title: 'legacy', updatedAt: 'then', messages: [] }
  const legacy = {
    id: 'w',
    clientId: 'a/b',
    query: 'legacy',
    createdAt: 'then',
    lastRun: null,
    fingerprint: null,
    changed: false,
  }
  writeJsonAtomic(join(dataDir, 'sessions', 'marine', 'ab', 's.json'), session)
  writeJsonAtomic(join(dataDir, 'investigations', 'marine', 'ab', 'i.json'), {
    id: 'i',
    name: 'legacy',
  })
  writeJsonAtomic(join(dataDir, 'watches', 'marine.json'), [legacy, {
    ...legacy,
    id: 'proven',
    slug: 'marine',
  }])
  const original = fileSnapshot(dataDir)
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      const sessions = new SessionsStore(dataDir),
        investigations = new InvestigationStore(dataDir),
        watches = new WatchStore(dataDir)
      expect(sessions.get('marine', 'a/b', 's')).toBeNull()
      expect(sessions.get('marine', 'ab', 's')).toBeNull()
      expect(investigations.get('marine', 'ab', 'i')).toBeNull()
      expect(watches.list('marine', 'a/b').map((w) => w.id)).toEqual(['proven'])
      expect(watches.list('marine', 'ab')).toEqual([])
      expect(watches.list('marine', { kind: 'user', tenantId: 'one', oid: 'a/b' })).toEqual([])
      expect(watches.list('mar/ine', 'a/b')).toEqual([])
      expect(fileSnapshot(dataDir)).toEqual(original)
    }
    new WatchStore(dataDir).update('marine', 'proven', { changed: true }, 'a/b')
    const migrated = new WatchStore(dataDir)
    expect(migrated.list('marine', 'a/b')[0]?.changed).toBe(true)
    expect(migrated.list('marine', { kind: 'user', tenantId: 'one', oid: 'a/b' })).toEqual([])
    migrated.remove('marine', 'a/b', 'proven')
    expect(new WatchStore(dataDir).list('marine', 'a/b')).toEqual([])
    expect(readFileSync(join(dataDir, 'watches', 'marine.json'), 'utf8')).toContain('legacy')
    for (const [path, bytes] of Object.entries(original)) {
      expect(Array.from(readFileSync(dataDir + path)).join(',')).toBe(bytes)
    }
  } finally {
    Deno.removeSync(dataDir, { recursive: true })
  }
})

Deno.test('local corrupt owned metadata and JSON fail closed without quarantine or overwrite', () => {
  const dataDir = Deno.makeTempDirSync()
  const owner = { kind: 'user' as const, tenantId: 'one', oid: 'same' }
  try {
    const stores = {
      sessions: new SessionsStore(dataDir),
      watches: new WatchStore(dataDir),
      investigations: new InvestigationStore(dataDir),
    }
    seedOwned(stores)
    const root = join(dataDir, 'research-v2')
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((f) =>
      f.isFile()
    )
    for (const file of files) {
      const path = join(file.parentPath, file.name)
      const original = readFileSync(path, 'utf8')
      const value = JSON.parse(original)
      for (
        const raw of [
          '{broken',
          JSON.stringify(
            file.name === 'watches.json'
              ? {
                ...value,
                entries: value.entries.map((w: Record<string, unknown>) => ({
                  ...w,
                  owner: 'same',
                })),
              }
              : { ...value, owner: { kind: 'anonymous', clientId: 'same' } },
          ),
        ]
      ) {
        writeFileSync(path, raw)
        if (file.name === 'watches.json') {
          expect(() => stores.watches.list('marine', owner)).toThrow()
          expect(() => stores.watches.add('marine', owner, 'other')).toThrow()
        } else if (path.includes('/sessions/')) {
          expect(() => stores.sessions.get('marine', owner, 's')).toThrow()
          expect(() => stores.sessions.remove('marine', owner, 's')).toThrow()
        } else expect(() => stores.investigations.list('marine', owner)).toThrow()
        expect(readFileSync(path, 'utf8')).toBe(raw)
      }
      writeFileSync(path, original)
    }
    for (const max of ['x'.repeat(128), '"'.repeat(64), '\\'.repeat(64)]) {
      stores.sessions.put(max, { kind: 'user', tenantId: max, oid: max }, {
        id: max,
        title: 'long',
        updatedAt: 'now',
        messages: [],
      })
      expect(
        new SessionsStore(dataDir).get(max, { kind: 'user', tenantId: max, oid: max }, max)?.title,
      ).toBe('long')
    }
    expect(() => new SessionsStore('/' + 'a'.repeat(1000)).get('marine', owner, 's')).toThrow(
      'Owned storage path too long',
    )
  } finally {
    Deno.removeSync(dataDir, { recursive: true })
  }
})

Deno.test('local owned stores isolate exact typed owners across all operations', () => {
  checkOwnedStores({
    sessions: new SessionsStore(),
    watches: new WatchStore(),
    investigations: new InvestigationStore(),
  })
})

const oldKey: McpKeyRecord = {
  id: 'legacy-key',
  tenant: 'marine',
  issuerUserId: 'unproven-user',
  label: 'Original label',
  prefix: 'ck_mcp_abcdefghijkl',
  hash: 'd'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  revokedAt: '2026-09-02T00:00:00.000Z',
}
const newKey = {
  ...migrateLegacyKeyRecord(oldKey),
  id: 'new-key',
  prefix: 'new-prefix',
  hash: 'e'.repeat(64),
  creator: { tenantId: 'entra-tenant', oid: 'creator' },
  provenance: 'verified-session' as const,
  role: 'curator' as const,
  expiresAt: '2027-01-01T00:00:00.000Z',
  revokedAt: null,
}

Deno.test('local key startup upgrades mixed records once and read-only decoding never audits', () => {
  const dataDir = Deno.makeTempDirSync()
  const path = join(dataDir, 'mcp-keys', 'marine.json')
  writeJsonAtomic(path, [oldKey, newKey])
  const original = readFileSync(path, 'utf8')
  expect(() => new McpKeyStore(dataDir)).toThrow('startup audit storage')
  expect(readFileSync(path, 'utf8')).toBe(original)
  const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir })
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      const store = new McpKeyStore(dataDir, { database, audit: rbac.audit })
      expect(store.findByHash('marine', oldKey.hash)).toEqual(migrateLegacyKeyRecord(oldKey))
      expect(store.findByHash('marine', newKey.hash)).toEqual(newKey)
      expect(store.findByHash('grains', newKey.hash)).toBeUndefined()
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
        migrateLegacyKeyRecord(oldKey),
        newKey,
      ])
      expect(rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(1)
    }
    const events = rbac.audit.read({ scope: { kind: 'platform' } })
    expect(events[0]?.actor_kind).toBe('system')
    expect(JSON.stringify(events)).not.toContain(oldKey.hash)
    const store = new McpKeyStore(dataDir, { database, audit: rbac.audit })
    writeJsonAtomic(path, [oldKey])
    const before = readFileSync(path, 'utf8')
    expect(store.list('marine')).toEqual([migrateLegacyKeyRecord(oldKey)])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(1)
  } finally {
    database.close()
    Deno.removeSync(dataDir, { recursive: true })
  }
})

Deno.test('local key corruption is retained across startup, reads and rejected writes', () => {
  const dataDir = Deno.makeTempDirSync()
  const path = join(dataDir, 'mcp-keys', 'marine.json')
  const store = new McpKeyStore(dataDir)
  for (
    const value of [
      '{broken',
      'null',
      '{}',
      JSON.stringify([oldKey, {}]),
      JSON.stringify([{ ...oldKey, tenant: 'grains' }]),
      JSON.stringify([oldKey, oldKey]),
    ]
  ) {
    writeFileAtomic(path, value)
    expect(() => new McpKeyStore(dataDir)).toThrow()
    expect(() => store.list('marine')).toThrow()
    expect(() => store.add(newKey)).toThrow()
    expect(() => store.revoke('marine', oldKey.id, oldKey.createdAt)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(value)
  }
  Deno.removeSync(dataDir, { recursive: true })
})

Deno.test('local key reads reject malformed UTF-8 without replacing original bytes', () => {
  const dataDir = Deno.makeTempDirSync()
  const path = join(dataDir, 'mcp-keys', 'marine.json')
  const store = new McpKeyStore(dataDir)
  const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir })
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([{ ...oldKey, label: 'X' }]))
    bytes[bytes.indexOf('X'.charCodeAt(0))] = 255
    Deno.mkdirSync(join(dataDir, 'mcp-keys'))
    writeFileSync(path, bytes)
    expect(() => new McpKeyStore(dataDir, { database, audit: rbac.audit })).toThrow()
    expect(() => store.list('marine')).toThrow()
    expect(() => store.add(newKey)).toThrow()
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
    expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
  } finally {
    database.close()
    Deno.removeSync(dataDir, { recursive: true })
  }
})

Deno.test('local key migration restores original bytes on write, append and commit failure', () => {
  for (const failure of ['write', 'append', 'commit']) {
    const dataDir = Deno.makeTempDirSync()
    const path = join(dataDir, 'mcp-keys', 'marine.json')
    const original = JSON.stringify([oldKey], null, 4)
    writeFileAtomic(path, original)
    const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir })
    try {
      if (failure === 'write') Deno.mkdirSync(`${path}.tmp`)
      if (failure === 'commit') {
        database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE parent_key (id INTEGER PRIMARY KEY); CREATE TABLE child_key (id INTEGER REFERENCES parent_key(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_keys AFTER INSERT ON audit_events BEGIN INSERT INTO child_key VALUES (1); END',
        )
      }
      const migration = {
        database,
        audit: {
          ...rbac.audit,
          append: (event: Parameters<typeof rbac.audit.append>[0]) => {
            rbac.audit.append(event)
            if (failure === 'append') throw new Error('append failed')
          },
        },
      }
      expect(() => new McpKeyStore(dataDir, migration)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
      if (failure === 'write') Deno.removeSync(`${path}.tmp`)
      if (failure === 'commit') database.exec('DROP TRIGGER fail_keys')
      expect(new McpKeyStore(dataDir, { database, audit: rbac.audit }).list('marine')).toEqual([
        migrateLegacyKeyRecord(oldKey),
      ])
      expect(rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(1)
    } finally {
      database.close()
      Deno.removeSync(dataDir, { recursive: true })
    }
  }
})

Deno.test('local key writes validate all metadata and reject digest, prefix and ID collisions', () => {
  const dataDir = Deno.makeTempDirSync()
  try {
    const store = new McpKeyStore(dataDir)
    store.add(newKey)
    const before = readFileSync(join(dataDir, 'mcp-keys', 'marine.json'), 'utf8')
    for (
      const change of [
        { id: 'other', prefix: 'other' },
        { id: 'other', hash: 'f'.repeat(64) },
        { prefix: 'other', hash: 'f'.repeat(64) },
        { hash: 'invalid' },
        { token: 'ck_secret' },
      ]
    ) expect(() => store.add({ ...newKey, ...change })).toThrow()
    expect(() => store.revoke('marine', newKey.id, 'invalid')).toThrow()
    expect(() => store.list('../marine')).toThrow()
    expect(readFileSync(join(dataDir, 'mcp-keys', 'marine.json'), 'utf8')).toBe(before)
    expect(store.revoke('marine', newKey.id, oldKey.createdAt)).toBe(true)
    expect(store.revoke('marine', newKey.id, oldKey.revokedAt!)).toBe(true)
    expect(store.findByHash('marine', newKey.hash)?.revokedAt).toBe(oldKey.createdAt)
  } finally {
    Deno.removeSync(dataDir, { recursive: true })
  }
})

Deno.test('local key migration restores earlier portal files when a later write fails', () => {
  const dataDir = Deno.makeTempDirSync()
  const paths = ['grains', 'marine'].map((slug) => join(dataDir, 'mcp-keys', `${slug}.json`))
  const originals = ['grains', 'marine'].map((tenant) => JSON.stringify([{ ...oldKey, tenant }]))
  paths.forEach((path, index) => writeFileAtomic(path, originals[index]!))
  const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir })
  try {
    Deno.mkdirSync(`${paths[1]}.tmp`)
    expect(() => new McpKeyStore(dataDir, { database, audit: rbac.audit })).toThrow()
    paths.forEach((path, index) => expect(readFileSync(path, 'utf8')).toBe(originals[index]))
    expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
    Deno.removeSync(`${paths[1]}.tmp`)
    new McpKeyStore(dataDir, { database, audit: rbac.audit })
  } finally {
    database.close()
  }
  const reopened = openLocalRbac({ DATA_DIR: dataDir })
  try {
    const store = new McpKeyStore(dataDir, {
      database: reopened.database,
      audit: reopened.rbac.audit,
    })
    expect(store.findByHash('marine', oldKey.hash)?.creator).toBeNull()
    expect(reopened.rbac.audit.read({ scope: { kind: 'platform' } })).toHaveLength(2)
  } finally {
    reopened.database.close()
    Deno.removeSync(dataDir, { recursive: true })
  }
})

// DATA_DIR is read at module load, so point it at a temp dir before importing.
const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)
const { InsightsStore, InvestigationStore, McpKeyStore, SessionsStore, SourceStore, WatchStore } =
  await import(
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
