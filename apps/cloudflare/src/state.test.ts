import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from '@std/expect'
import { DEFAULT_RESEARCH_ENRICHMENT, type Enrichment } from '@research-portal/core'
import {
  DurableEnrichmentStore,
  DurableRoutingLog,
  DurableState,
  durableStores,
  DurableTenantStore,
  type SqlStorageLike,
} from './state.ts'
import type { McpKeyRecord, RoutingRecord } from '../../api/src/stores.ts'
import { DurableMcpKeyStore } from './state.ts'
import { buildApp } from '../../api/src/app.ts'
import type { AragProvider, RetrievalProvider } from '@research-portal/retrieval'
import { executeAudited, executeAuditedResponse } from '../../api/src/audit-execution.ts'
import type { AuditInput } from '../../api/src/audit.ts'
import { runSystemMaintenance } from '../../api/src/scheduler.ts'
import { executeMcpTool } from '../../api/src/mcp.ts'
import { SUGGESTED_QUESTIONS_SCHEMA_ID } from '../../api/src/suggested-questions.ts'
import { tenantConfig, type TenantPatch } from '../../api/src/tenants.ts'
import { checkAuditUpgrade } from '../../api/src/rbac-state.test.ts'
import { migrateLegacyKeyRecord } from '../../api/src/scoped-key-record.ts'
import { fixtureSession } from '../../api/src/rbac-integration-fixture.ts'

const legacyScopedKey: McpKeyRecord = {
  id: 'legacy-key',
  tenant: 'marine',
  issuerUserId: 'unproven-user',
  label: 'Original label',
  prefix: 'ck_mcp_abcdefghijkl',
  hash: 'd'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  revokedAt: '2026-09-02T00:00:00.000Z',
}
const verifiedScopedKey = {
  ...migrateLegacyKeyRecord(legacyScopedKey),
  id: 'new-key',
  prefix: 'new-prefix',
  hash: 'e'.repeat(64),
  creator: { tenantId: 'entra-tenant', oid: 'creator' },
  provenance: 'verified-session' as const,
  role: 'curator' as const,
  expiresAt: '2027-01-01T00:00:00.000Z',
  revokedAt: null,
}

Deno.test('Durable key startup migrates mixed metadata once with system audit and read-only lookup', () => {
  const sql = new TestSqlStorage()
  try {
    const seed = new DurableState(sql, sql)
    seed.migrate()
    seed.put('mcp-keys:marine', [legacyScopedKey, verifiedScopedKey])
    for (let repeat = 0; repeat < 2; repeat++) {
      const state = new DurableState(sql, sql)
      state.migrate()
      const keys = durableStores(state, {}).mcpKeys
      expect(keys.findByHash('marine', legacyScopedKey.hash)).toEqual(
        migrateLegacyKeyRecord(legacyScopedKey),
      )
      expect(keys.findByHash('marine', verifiedScopedKey.hash)).toEqual(verifiedScopedKey)
      expect(keys.findByHash('grains', verifiedScopedKey.hash)).toBeUndefined()
      expect(state.get('mcp-keys:marine', [])).toEqual([
        migrateLegacyKeyRecord(legacyScopedKey),
        verifiedScopedKey,
      ])
      const events = state.rbac.audit.read({ scope: { kind: 'platform' } })
      expect(events).toHaveLength(1)
      expect(events[0]?.actor_kind).toBe('system')
      expect(JSON.stringify(events)).not.toContain(legacyScopedKey.hash)
    }
    seed.put('mcp-keys:marine', [legacyScopedKey])
    expect(new DurableMcpKeyStore(seed).list('marine')).toEqual([
      migrateLegacyKeyRecord(legacyScopedKey),
    ])
    expect(seed.get('mcp-keys:marine', [])).toEqual([legacyScopedKey])
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable key corruption survives migration, reads and rejected writes', () => {
  const sql = new TestSqlStorage()
  try {
    const state = new DurableState(sql, sql)
    state.migrate()
    const keys = new DurableMcpKeyStore(state)
    for (
      const value of [
        '{broken',
        'null',
        '{}',
        JSON.stringify([legacyScopedKey, {}]),
        JSON.stringify([legacyScopedKey, legacyScopedKey]),
        JSON.stringify([{ ...legacyScopedKey, tenant: 'grains' }]),
      ]
    ) {
      sql.database.prepare('INSERT OR REPLACE INTO state VALUES (?,?,?)').run(
        'mcp-keys:marine',
        value,
        1,
      )
      expect(() => new DurableState(sql, sql).migrate()).toThrow()
      expect(() => keys.list('marine')).toThrow()
      expect(() => keys.add(verifiedScopedKey)).toThrow()
      expect(() => keys.revoke('marine', legacyScopedKey.id, legacyScopedKey.createdAt)).toThrow()
      expect(
        sql.database.prepare('SELECT value FROM state WHERE key = ?').get('mcp-keys:marine')?.value,
      ).toBe(value)
    }
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable key migration rolls back rewrite, audit append and commit failures', () => {
  for (const failure of ['write', 'append', 'commit']) {
    const sql = new TestSqlStorage()
    try {
      const state = new DurableState(sql, sql)
      state.migrate()
      state.put('mcp-keys:marine', [legacyScopedKey])
      const original = sql.database.prepare('SELECT * FROM state WHERE key = ?').get(
        'mcp-keys:marine',
      )
      if (failure === 'write') {
        sql.database.exec(
          "CREATE TRIGGER fail_keys BEFORE UPDATE ON state WHEN NEW.key = 'mcp-keys:marine' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
        )
      }
      if (failure === 'append') {
        sql.database.exec(
          "CREATE TRIGGER fail_keys BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'append failed'); END",
        )
      }
      if (failure === 'commit') {
        sql.database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE parent_key (id INTEGER PRIMARY KEY); CREATE TABLE child_key (id INTEGER REFERENCES parent_key(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_keys AFTER UPDATE ON state BEGIN INSERT INTO child_key VALUES (1); END',
        )
      }
      expect(() => new DurableState(sql, sql).migrate()).toThrow()
      expect(sql.database.prepare('SELECT * FROM state WHERE key = ?').get('mcp-keys:marine'))
        .toEqual(original)
      expect(state.rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
      sql.database.exec('DROP TRIGGER fail_keys')
      new DurableState(sql, sql).migrate()
      expect(new DurableMcpKeyStore(state).findByHash('marine', legacyScopedKey.hash)).toEqual(
        migrateLegacyKeyRecord(legacyScopedKey),
      )
    } finally {
      sql.database.close()
    }
  }
})

Deno.test('Durable key ordinary writes retain caller audit and roll back failed append', async () => {
  const sql = new TestSqlStorage()
  try {
    const state = new DurableState(sql, sql)
    state.migrate()
    const keys = durableStores(state, {}).mcpKeys
    const input = {
      requestId: 'key-test',
      actor: { kind: 'user' as const, id: 'creator' },
      action: 'request.privileged' as const,
      scope: { kind: 'portal' as const, slug: 'marine' },
      target: { kind: 'key', id: verifiedScopedKey.id },
    }
    const signal = new AbortController().signal
    sql.database.exec(
      "CREATE TRIGGER fail_keys BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'append failed'); END",
    )
    await expect(state.localMutations.run(input, signal, () => keys.add(verifiedScopedKey))).rejects
      .toThrow()
    expect(keys.list('marine')).toEqual([])
    sql.database.exec('DROP TRIGGER fail_keys')
    await state.localMutations.run(input, signal, () => keys.add(verifiedScopedKey))
    for (
      const patch of [{ id: 'other', prefix: 'other' }, { id: 'other', hash: 'f'.repeat(64) }, {
        prefix: 'other',
        hash: 'f'.repeat(64),
      }, { token: 'ck_secret' }]
    ) {
      expect(() => keys.add({ ...verifiedScopedKey, ...patch })).toThrow()
    }
    expect(() => keys.revoke('marine', verifiedScopedKey.id, 'bad')).toThrow()
    expect(() => keys.list('../marine')).toThrow()
    sql.database.exec(
      "CREATE TRIGGER fail_keys BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'append failed'); END",
    )
    await expect(
      state.localMutations.run(
        input,
        signal,
        () => keys.revoke('marine', verifiedScopedKey.id, legacyScopedKey.createdAt),
      ),
    ).rejects.toThrow()
    expect(keys.findByHash('marine', verifiedScopedKey.hash)?.revokedAt).toBeNull()
    sql.database.exec('DROP TRIGGER fail_keys')
    await state.localMutations.run(
      input,
      signal,
      () => keys.revoke('marine', verifiedScopedKey.id, legacyScopedKey.createdAt),
    )
    expect(keys.findByHash('marine', verifiedScopedKey.hash)?.revokedAt).toBe(
      legacyScopedKey.createdAt,
    )
    expect(
      state.rbac.audit.read({ scope: { kind: 'platform' } }).every((event) =>
        event.actor_kind === 'user'
      ),
    ).toBe(true)
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable audit upgrade preserves history and rolls back copy, marker, append and commit failures', () => {
  const sql = new TestSqlStorage()
  try {
    checkAuditUpgrade(new DurableState(sql, sql).rbacDatabase)
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable portal policy survives reload and repeated migration for seed and custom portals', () => {
  const sql = new TestSqlStorage()
  try {
    let state = new DurableState(sql, sql)
    state.migrate()
    let store = new DurableTenantStore(state)
    state.put('tenants', {
      custom: { legacy: { ...tenantConfig('marine'), slug: 'legacy', accessMode: undefined } },
      overrides: { marine: { searchPlaceholder: 'Legacy seed' } },
    })
    expect(store.get('legacy')?.accessMode).toBe('public')
    expect(store.get('marine')?.accessMode).toBe('public')
    expect(store.get('marine')?.searchPlaceholder).toBe('Legacy seed')
    store.add({ name: 'Custom' })
    expect(store.get('custom')?.accessMode).toBe('public')
    for (const slug of ['marine', 'custom']) {
      for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
        store.patch(slug, { accessMode })
        store.setDisabled(slug, true)
        const branding = store.get(slug)?.branding
        for (let repeat = 0; repeat < 2; repeat++) {
          state = new DurableState(sql, sql)
          state.migrate()
          store = new DurableTenantStore(state)
          expect(store.get(slug)?.accessMode).toBe(accessMode)
          expect(store.get(slug)?.branding).toEqual(branding)
          expect(store.isDisabled(slug)).toBe(true)
          expect(store.list().some((item) => item.slug === slug)).toBe(false)
          expect(store.list(true).some((item) => item.slug === slug)).toBe(true)
        }
      }
    }
    for (const patch of [{ accessMode: null }, { accessMode: 'private' }, null, []]) {
      expect(() => store.patch('marine', patch as unknown as TenantPatch)).toThrow()
      expect(store.get('marine')?.accessMode).toBe('restricted')
    }
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable corrupt policy never exposes seed fallback and survives unrelated writes', () => {
  const sql = new TestSqlStorage()
  try {
    const state = new DurableState(sql, sql)
    state.migrate()
    for (const value of [null, 'private', false, {}, []]) {
      for (
        const raw of [
          { custom: { marine: { ...tenantConfig('marine'), accessMode: value } }, overrides: {} },
          { custom: {}, overrides: { marine: { accessMode: value } } },
          ...(value && typeof value === 'object' && !Array.isArray(value)
            ? []
            : [{ custom: {}, overrides: { marine: value } }]),
        ]
      ) {
        state.put('tenants', raw)
        for (let repeat = 0; repeat < 2; repeat++) {
          const restart = new DurableState(sql, sql)
          restart.migrate()
          const store = new DurableTenantStore(restart)
          expect(() => store.get('marine')).toThrow()
          expect(store.list(true).some((item) => item.slug === 'marine')).toBe(false)
          expect(store.get('grains')?.accessMode).toBe('public')
          store.patch('grains', { searchPlaceholder: 'Still available' })
        }
      }
    }
    for (const raw of [null, [], { custom: null }, { custom: {}, overrides: [] }]) {
      state.put('tenants', raw)
      expect(() => new DurableTenantStore(state).get('marine')).toThrow()
      expect(() => new DurableTenantStore(state).list()).toThrow()
    }
    sql.database.prepare('UPDATE state SET value = ? WHERE key = ?').run('{broken', 'tenants')
    for (let repeat = 0; repeat < 2; repeat++) {
      const restarted = new DurableState(sql, sql)
      restarted.migrate()
      expect(() => new DurableTenantStore(restarted).get('marine')).toThrow()
    }
  } finally {
    sql.database.close()
  }
})

function mutationFixture(management?: AragProvider) {
  const sql = new TestSqlStorage()
  const state = new DurableState(sql, sql)
  state.migrate()
  const stores = durableStores(state, {})
  const session = fixtureSession({ oid: 'writer', tenantId: 'directory' })
  const assignments = state.rbac.assignmentService('directory', 'corpuskit')
  expect(assignments.observeSession(session)).toBe(true)
  expect(
    assignments.create({
      subjectKind: 'active-oid',
      subjectId: session.oid,
      scope: { kind: 'platform' },
      role: 'owner',
    }, { requestId: 'seed-writer', actor: { kind: 'system' } }).ok,
  ).toBe(true)
  const app = buildApp({
    ...stores,
    configuredTenantId: 'directory',
    audience: 'corpuskit',
    breakGlass: state.rbac.breakGlassService({ environment: 'production' }),
    provider: {
      resource: async () => ({ id: 'doc', title: 'Research', summary: '' }),
    } as unknown as RetrievalProvider,
    management,
    requestContext: () => {
      const grant = assignments.list().find((row) =>
        row.subjectKind === 'active-oid' && row.subjectId === session.oid &&
        row.scope.kind === 'platform'
      )
      const platformRole = grant?.role === 'owner' || grant?.role === 'platform-admin'
        ? grant.role
        : undefined
      return {
        requestId: crypto.randomUUID(),
        session,
        coarseAdminEligible: platformRole !== undefined,
        effectiveRoles: { platformRole, portalRoles: [] },
        actor: { kind: 'user', id: 'writer' },
      }
    },
  })
  return {
    sql,
    state,
    stores,
    app,
    fail: (condition = "NEW.action = 'local.mutation'") =>
      sql.database.exec(
        `CREATE TRIGGER fail_local BEFORE INSERT ON audit_events WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
      ),
    recover: () => sql.database.exec('DROP TRIGGER fail_local'),
    snapshot: () => sql.database.prepare('SELECT key, value FROM state ORDER BY key').all(),
    request: (path: string, method = 'POST', body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-rp-client': 'client' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  }
}

const mutationInput: Omit<AuditInput, 'outcome'> = {
  requestId: 'local-test',
  actor: { kind: 'user', id: 'writer' },
  action: 'request.privileged',
  scope: { kind: 'portal', slug: 'marine' },
  target: { kind: 'portal', id: 'marine' },
  detail: { permission: 'behaviour.write', operation: 'POST /api/admin/t/:slug/disable' },
}

Deno.test('Durable HTTP prompts, keys, watches and research writes roll back on local audit failure', async (t) => {
  const fixture = mutationFixture()
  const { stores, request, fail, recover, snapshot, sql } = fixture
  try {
    const watch = stores.watches.add('marine', 'client', 'Research')
    const investigation = stores.investigations.create('marine', 'client', { name: 'Original' })
    const evidence = stores.investigations.addEvidence('marine', 'client', investigation.id, {
      passage: 'Original passage',
      resourceId: 'doc',
      resourceTitle: 'Research',
      score: null,
      question: '',
      verdict: null,
      aiRelevance: null,
      note: '',
      tags: [],
    })!
    const issuedResponse = await request('/api/t/marine/mcp/keys', 'POST', {
      label: 'Existing key',
    })
    expect(issuedResponse.status).toBe(201)
    const issued = await issuedResponse.json()
    const research = `/api/t/marine/investigations/${investigation.id}`
    const cases: [string, string, unknown?][] = [
      ['/api/admin/t/marine/prompts', 'PUT', { ask: 'Override' }],
      ['/api/t/marine/mcp/keys', 'POST', { label: 'New key' }],
      [`/api/t/marine/mcp/keys/${issued.credential.id}`, 'DELETE'],
      ['/api/t/marine/watches', 'POST', { query: 'New research' }],
      [`/api/t/marine/watches/${watch.id}/seen`, 'POST'],
      [`/api/t/marine/watches/${watch.id}`, 'DELETE'],
      ['/api/t/marine/investigations', 'POST', { name: 'New project' }],
      [research, 'PATCH', { name: 'Updated project' }],
      [research, 'DELETE'],
      [`${research}/evidence`, 'POST', {
        passage: 'New passage',
        resourceId: 'doc2',
        resourceTitle: 'New research',
      }],
      [`${research}/evidence/${evidence.id}`, 'PATCH', { note: 'Updated note' }],
      [`${research}/evidence/${evidence.id}`, 'DELETE'],
      [`${research}/artefacts`, 'POST', {
        kind: 'brief',
        title: 'Research brief',
        data: { text: 'Private content' },
      }],
    ]
    for (const [path, method, body] of cases) {
      await t.step(`${method} ${path}`, async () => {
        const before = snapshot()
        fail()
        expect((await request(path, method, body)).status).toBe(500)
        expect(snapshot()).toEqual(before)
        recover()
      })
    }
    const rpc = await appRpc(fixture.app, issued.key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(rpc.status).toBe(200)
    expect(stores.mcpKeys.list('marine')).toHaveLength(1)
    expect(stores.mcpKeys.list('marine')[0]!.revokedAt).toBeNull()
    expect((await request(`/api/t/marine/mcp/keys/${issued.credential.id}`, 'DELETE')).status).toBe(
      200,
    )
    const local = stores.audit.read({ scope: { kind: 'portal', slug: 'marine' }, limit: 200 })
      .filter((event) => event.action === 'local.mutation')
    expect(local).toHaveLength(2)
    expect(local.every((event) => event.target_id === issued.credential.id)).toBe(true)
    expect(JSON.stringify(local)).not.toContain(issued.key)
  } finally {
    sql.database.close()
  }
})

function appRpc(app: ReturnType<typeof buildApp>, key: string, body: unknown) {
  return app.request('/api/t/marine/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
}

Deno.test('Durable HTTP local writes commit their intended changes and one matching audit per method', async () => {
  const fixture = mutationFixture()
  const { stores, request } = fixture
  const local = () =>
    stores.audit.read({ scope: { kind: 'portal', slug: 'marine' }, limit: 200 })
      .filter((event) => event.action === 'local.mutation')
  const change = async (mutation: string, path: string, method: string, body?: unknown) => {
    const before = local().length
    const response = await request(path, method, body)
    expect(response.status).toBe(200)
    const records = local()
    expect(records).toHaveLength(before + 1)
    expect(records.filter((event) => JSON.parse(event.detail_json).mutation === mutation)).not
      .toHaveLength(0)
    expect(records.every((event) => event.outcome === 'success' && event.actor_id === 'writer'))
      .toBe(true)
    return await response.json()
  }
  try {
    await change('tenants.patch', '/api/admin/t/marine/prompts', 'PUT', { ask: 'Override' })
    expect(stores.tenants.promptsFor('marine')).toEqual({ ask: 'Override' })
    const watch = await change('watches.add', '/api/t/marine/watches', 'POST', {
      query: 'Research',
    })
    expect(stores.watches.list('marine', 'client')[0]!.id).toBe(watch.id)
    stores.watches.update('marine', watch.id, { changed: true })
    await change('watches.update', `/api/t/marine/watches/${watch.id}/seen`, 'POST')
    expect(stores.watches.list('marine', 'client')[0]!.changed).toBe(false)
    await change('watches.remove', `/api/t/marine/watches/${watch.id}`, 'DELETE')
    expect(stores.watches.list('marine', 'client')).toEqual([])
    const research = await change('investigations.create', '/api/t/marine/investigations', 'POST', {
      name: 'Original',
    })
    const path = `/api/t/marine/investigations/${research.id}`
    const get = () => stores.investigations.get('marine', 'client', research.id)
    expect(get()!.name).toBe('Original')
    await change('investigations.update', path, 'PATCH', { name: 'Updated' })
    expect(get()!.name).toBe('Updated')
    const evidence = await change('investigations.addEvidence', `${path}/evidence`, 'POST', {
      passage: 'Evidence passage',
      resourceId: 'doc',
      resourceTitle: 'Research',
    })
    expect(get()!.evidence[0]!.id).toBe(evidence.id)
    await change('investigations.updateEvidence', `${path}/evidence/${evidence.id}`, 'PATCH', {
      note: 'Updated note',
    })
    expect(get()!.evidence[0]!.note).toBe('Updated note')
    const artefact = await change('investigations.addArtefact', `${path}/artefacts`, 'POST', {
      kind: 'brief',
      title: 'Research brief',
      data: { text: 'Private content' },
    })
    expect(get()!.artefacts[0]!.id).toBe(artefact.id)
    await change('investigations.removeEvidence', `${path}/evidence/${evidence.id}`, 'DELETE')
    expect(get()!.evidence).toEqual([])
    await change('investigations.remove', path, 'DELETE')
    expect(get()).toBeNull()
    expect(local()).toHaveLength(11)
    expect(JSON.stringify(local())).not.toContain('Private content')
    expect(JSON.stringify(local())).not.toContain('Updated note')
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable cold question cache and audit remain unchanged on generation or local audit failure', async (t) => {
  for (const later of [false, true]) {
    await t.step(later ? 'overall result failure' : 'local audit failure', async () => {
      let remoteCalls = 0
      const fixture = mutationFixture({
        resourceContent: async () => {
          remoteCalls++
          return null
        },
      } as unknown as AragProvider)
      try {
        fixture.fail(
          later
            ? "NEW.action = 'resource.questions.generate' AND NEW.outcome = 'success'"
            : undefined,
        )
        expect((await fixture.app.request('/api/t/marine/resources/doc/questions')).status).toBe(
          500,
        )
        expect(remoteCalls).toBe(1)
        const cached = fixture.stores.enrichments.get(
          'marine',
          'doc',
          SUGGESTED_QUESTIONS_SCHEMA_ID,
        )
        expect(cached).toBeUndefined()
        const local = fixture.stores.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
          .filter((e) => e.action === 'local.mutation')
        expect(local).toHaveLength(0)
        fixture.recover()
        expect((await fixture.app.request('/api/t/marine/resources/doc/questions')).status).toBe(
          200,
        )
        expect(remoteCalls).toBe(2)
        expect(
          fixture.stores.audit.read({ scope: { kind: 'portal', slug: 'marine' } }).filter((e) =>
            e.action === 'local.mutation'
          ),
        ).toHaveLength(1)
      } finally {
        fixture.sql.database.close()
      }
    })
  }
})

Deno.test('Durable scheduled watch update rolls back after remote search and preserves system attribution', async () => {
  const fixture = mutationFixture()
  let searches = 0
  const management = {
    search: async () => {
      searches++
      return { resources: [{ id: 'doc' }] }
    },
  } as unknown as AragProvider
  try {
    fixture.stores.watches.add('marine', 'client', 'Research')
    const before = fixture.snapshot()
    fixture.fail()
    await expect(runSystemMaintenance(management, fixture.stores, undefined, ['watch'], false))
      .rejects.toThrow()
    expect(fixture.snapshot()).toEqual(before)
    expect(searches).toBe(1)
    fixture.recover()
    await runSystemMaintenance(management, fixture.stores, undefined, ['watch'], false)
    const local = fixture.stores.audit.read({ scope: { kind: 'portal', slug: 'marine' } }).find((
      e,
    ) => e.action === 'local.mutation')!
    expect(local.actor_kind).toBe('system')
    expect(local.target_id).toBe(fixture.stores.watches.list('marine')[0]!.id)
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable scheduled question workers cannot swallow a failed local cache audit', async () => {
  const fixture = mutationFixture()
  let contentCalls = 0
  const management = {
    listResources: async () => [{ id: 'doc', title: 'Research', summary: '' }],
    invalidate: () => {},
    resourceContent: async () => {
      contentCalls++
      return null
    },
  } as unknown as AragProvider
  try {
    fixture.stores.enrichments.put('marine', 'doc', enrichment('Existing'))
    const before = fixture.state.enrichmentRecords('marine')
    fixture.fail()
    await expect(runSystemMaintenance(management, fixture.stores, undefined, ['enrichment'], false))
      .rejects.toThrow()
    expect(contentCalls).toBe(1)
    expect(fixture.state.enrichmentRecords('marine')).toEqual(before)
    expect(
      fixture.stores.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
        .filter((e) => e.action === 'maintenance.questions.run' && e.outcome === 'success'),
    ).toHaveLength(0)
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable synthesis returns 500 when its caught local audit fails after generation', async () => {
  let generations = 0
  const fixture = mutationFixture({
    askStructured: async () => {
      generations++
      return { object: { summary: 'A result [1].' } }
    },
  } as unknown as AragProvider)
  try {
    const investigation = fixture.stores.investigations.create('marine', 'client', {
      name: 'Research',
    })
    fixture.stores.investigations.addEvidence('marine', 'client', investigation.id, {
      passage: 'Original passage',
      resourceId: 'doc',
      resourceTitle: 'Research',
      score: null,
      question: '',
      verdict: null,
      aiRelevance: null,
      note: '',
      tags: [],
    })
    const before = fixture.snapshot()
    fixture.fail()
    const response = await fixture.request(
      `/api/t/marine/investigations/${investigation.id}/synthesise`,
    )
    expect(response.status).toBe(500)
    expect(generations).toBe(1)
    expect(fixture.snapshot()).toEqual(before)
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable asynchronous scopes keep actors and portal targets isolated', async () => {
  const fixture = mutationFixture()
  const first = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  try {
    const held = executeAudited({
      ...fixture.stores,
      input: mutationInput,
      run: async () => {
        ready.resolve()
        await first.promise
        fixture.stores.enrichments.put('marine', 'first-doc', enrichment('First'))
      },
    })
    await ready.promise
    await executeAudited({
      ...fixture.stores,
      input: { ...mutationInput, requestId: 'second', actor: { kind: 'user', id: 'second-actor' } },
      run: () => fixture.stores.enrichments.put('grains', 'second-doc', enrichment('Second')),
    })
    first.resolve()
    await held
    for (
      const [slug, actor, target] of [['marine', 'writer', 'first-doc'], [
        'grains',
        'second-actor',
        'second-doc',
      ]]
    ) {
      const local = fixture.stores.audit.read({ scope: { kind: 'portal', slug: slug! } }).find((
        e,
      ) => e.action === 'local.mutation')!
      expect(local.actor_id).toBe(actor)
      expect(local.target_id).toBe(target)
    }
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable raw JSON, cache, routing and asset writes require an audited transaction in privileged scopes', async () => {
  const fixture = mutationFixture()
  try {
    const writes = [
      () => fixture.state.put('unguarded', true),
      () => fixture.state.delete('unguarded'),
      () => fixture.state.putEnrichment('marine', 'doc', enrichment('New')),
      () => fixture.state.importEnrichments('marine', {}, 'skip'),
      () => fixture.state.appendRouting('marine', {}, 5),
      () =>
        fixture.state.putAsset('asset', {
          bytes: new Uint8Array([1]),
          contentType: 'image/png',
          version: '1',
        }),
    ]
    for (const run of writes) {
      await expect(executeAudited({ ...fixture.stores, input: mutationInput, run })).rejects
        .toThrow()
    }
    expect(fixture.state.get('unguarded', null)).toBeNull()
    expect(fixture.state.enrichmentCount('marine', DEFAULT_RESEARCH_ENRICHMENT.id)).toBe(0)
    expect(fixture.state.routingRecords('marine', 5)).toEqual([])
    expect(fixture.state.getAsset('asset')).toBeNull()
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable nested legacy cache migration and writes roll back together and can be retried', async (t) => {
  for (const method of ['get', 'put', 'import'] as const) {
    await t.step(method, async () => {
      const fixture = mutationFixture()
      const legacy = { [DEFAULT_RESEARCH_ENRICHMENT.id]: { old: enrichment('Old') } }
      try {
        fixture.state.put('enrichments:marine', legacy)
        const run = () =>
          method === 'get'
            ? fixture.stores.enrichments.get('marine', 'old')
            : method === 'put'
            ? fixture.stores.enrichments.put('marine', 'new', enrichment('New'))
            : fixture.stores.enrichments.importRecords('marine', {
              [DEFAULT_RESEARCH_ENRICHMENT.id]: { new: enrichment('New') },
            }, 'skip')
        fixture.fail()
        if (method === 'get') {
          expect(await executeAudited({ ...fixture.stores, input: mutationInput, run })).toEqual(
            enrichment('Old'),
          )
          expect(fixture.state.get('enrichments:marine', null)).toEqual(legacy)
          expect(fixture.state.enrichmentCount('marine', DEFAULT_RESEARCH_ENRICHMENT.id)).toBe(0)
          return
        }
        await expect(executeAudited({ ...fixture.stores, input: mutationInput, run })).rejects
          .toThrow()
        expect(fixture.state.get('enrichments:marine', null)).toEqual(legacy)
        expect(fixture.state.enrichmentCount('marine', DEFAULT_RESEARCH_ENRICHMENT.id)).toBe(0)
        fixture.recover()
        await executeAudited({ ...fixture.stores, input: mutationInput, run })
        expect(fixture.state.get('enrichments:marine', null)).toBeNull()
        expect(fixture.stores.enrichments.get('marine', 'old')).toEqual(enrichment('Old'))
        expect(fixture.state.enrichmentCount('marine', DEFAULT_RESEARCH_ENRICHMENT.id)).toBe(
          2,
        )
        expect(
          fixture.stores.audit.read({ scope: mutationInput.scope }).filter((e) =>
            e.action === 'local.mutation'
          ),
        ).toHaveLength(1)
      } finally {
        fixture.sql.database.close()
      }
    })
  }
})

Deno.test('Durable scope preserves mandatory failure through caught nested errors and rejects undeclared writes', async () => {
  const fixture = mutationFixture()
  try {
    for (const raw of [false, true]) {
      if (!raw) fixture.fail()
      const response = await executeAuditedResponse({
        privileged: true,
        ...fixture.stores,
        input: mutationInput,
        run: async () => {
          try {
            await executeAudited({
              ...fixture.stores,
              input: mutationInput,
              run: () => {
                if (raw) fixture.state.put('unclassified', true)
                else fixture.stores.tenants.setDisabled('marine', true)
              },
            })
          } catch { /* Simulate a handler which turns provider errors into a response. */ }
          return Response.json({ ok: true })
        },
      })
      expect(response.status).toBe(500)
      expect(fixture.stores.tenants.isDisabled('marine')).toBe(false)
      expect(fixture.state.get('unclassified', null)).toBeNull()
      if (!raw) fixture.recover()
    }
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable privileged MCP tools inherit local rollback even if their SDK result catches the error', async () => {
  const fixture = mutationFixture()
  try {
    fixture.fail()
    const context = {
      requestId: 'mcp-local',
      actor: { kind: 'legacy-key' as const, id: 'key-id' },
      slug: 'marine',
    }
    await expect(
      executeMcpTool(
        {
          kind: 'mcp',
          method: 'MCP',
          path: 'future_mutation',
          action: 'request.privileged',
          target: { kind: 'tool' },
          permission: 'content.write',
          scope: 'portal',
        },
        context,
        fixture.stores.audit,
        async () => {
          try {
            fixture.stores.tenants.setDisabled('marine', true)
          } catch { /* SDK protocol result. */ }
          return { content: [], isError: false }
        },
        fixture.stores.localMutations,
      ),
    ).rejects.toThrow()
    expect(fixture.stores.tenants.isDisabled('marine')).toBe(false)
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('Durable local scope prevents late writes after deadline, client abort and successful completion', async (t) => {
  for (const reason of ['deadline', 'abort', 'complete'] as const) {
    await t.step(reason, async () => {
      const fixture = mutationFixture()
      const gate = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      const controller = new AbortController()
      let expire!: () => void
      let rejected = false
      try {
        const late = async () => {
          ready.resolve()
          await gate.promise
          try {
            fixture.stores.tenants.setDisabled('marine', true)
          } catch {
            rejected = true
          } finally {
            finished.resolve()
          }
        }
        const pending = executeAudited({
          ...fixture.stores,
          input: mutationInput,
          signal: controller.signal,
          schedule: (callback) => {
            expire = callback
            return () => {}
          },
          run: () => {
            const job = late()
            return reason === 'complete' ? undefined : job
          },
        })
        await ready.promise
        if (reason === 'complete') {
          await pending
        } else {
          if (reason === 'deadline') expire()
          else controller.abort()
          await expect(pending).rejects.toThrow()
        }
        gate.resolve()
        await finished.promise
        expect(rejected).toBe(true)
        expect(fixture.stores.tenants.isDisabled('marine')).toBe(false)
        expect(
          fixture.stores.audit.read({ scope: mutationInput.scope }).filter((e) =>
            e.action === 'local.mutation'
          ),
        ).toHaveLength(0)
      } finally {
        fixture.sql.database.close()
      }
    })
  }
})

Deno.test('Durable detached nested scope cannot write after its parent completes', async () => {
  const fixture = mutationFixture()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let child!: Promise<void>
  try {
    await executeAudited({
      ...fixture.stores,
      input: mutationInput,
      run: async () => {
        child = executeAudited({
          ...fixture.stores,
          input: mutationInput,
          run: async () => {
            ready.resolve()
            await release.promise
            fixture.stores.tenants.setDisabled('marine', true)
          },
        })
        await ready.promise
      },
    })
    release.resolve()
    await expect(child).rejects.toThrow()
    expect(fixture.stores.tenants.isDisabled('marine')).toBe(false)
    expect(
      fixture.stores.audit.read({ scope: mutationInput.scope }).filter((e) =>
        e.action === 'local.mutation'
      ),
    ).toHaveLength(0)
  } finally {
    fixture.sql.database.close()
  }
})

Deno.test('actual Durable HTTP local mutation rolls back when its authoritative audit fails', async () => {
  const { sql, stores, app } = mutationFixture()
  try {
    sql.database.exec(
      "CREATE TRIGGER fail_local BEFORE INSERT ON audit_events WHEN NEW.action = 'local.mutation' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    const response = await app.request('/api/admin/t/marine/disable', { method: 'POST' })
    expect(response.status).toBe(500)
    expect(stores.tenants.isDisabled('marine')).toBe(false)
    sql.database.exec('DROP TRIGGER fail_local')
    expect((await app.request('/api/admin/t/marine/disable', { method: 'POST' })).status).toBe(200)
    expect(stores.tenants.isDisabled('marine')).toBe(true)
    const records = stores.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
    expect(records.filter((e) => e.action === 'local.mutation')).toHaveLength(1)
  } finally {
    sql.database.close()
  }
})

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
    if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK)\b/i.test(query)) {
      throw new Error('Manual transactions are forbidden in Durable SQL')
    }
    if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
      rows = this.database.prepare(query).all(...bindings as SQLInputValue[]) as T[]
    } else if (bindings.length === 0) {
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

Deno.test('Durable RBAC migrates additively and rolls back rows with failed audit', () => {
  const sql = new TestSqlStorage()
  const state = new DurableState(sql, sql, () => 1000)
  try {
    state.migrate()
    state.put('tenant:existing', { slug: 'existing' })
    state.migrate()
    const stores = durableStores(state, {})
    expect(stores.assignments.list('tenant-1')).toEqual([])
    expect(stores.locks.lockedUntil('ip')).toBeNull()
    expect(state.get('tenant:existing', null)).toEqual({ slug: 'existing' })
    expect(state.rbacDatabase.all('SELECT count(*) AS n FROM rbac_migrations')).toEqual([{ n: 2 }])
    expect(() =>
      state.rbacDatabase.transactionSync(() => {
        state.rbacDatabase.exec('INSERT INTO break_glass_locks VALUES (?,?)', 'ip', 2000)
        stores.audit.append({} as never)
      })
    ).toThrow()
    expect(stores.locks.lockedUntil('ip')).toBeNull()
    state.rbacDatabase.transactionSync(() => {
      state.rbacDatabase.exec('INSERT INTO break_glass_locks VALUES (?,?)', 'ip', 2000)
    })
    expect(new DurableState(sql, sql).rbac.locks.lockedUntil('ip')).toBe(2000)
    expect(() => state.rbacDatabase.transactionSync(async () => {})).toThrow('synchronous')
    expect(() => state.rbacDatabase.transactionSync(() => Promise.resolve())).toThrow('synchronous')
  } finally {
    sql.database.close()
  }
})

Deno.test('Durable RBAC refuses mutation without an injected transaction capability', () => {
  const sql = new TestSqlStorage()
  try {
    const state = new DurableState(sql)
    state.migrate()
    state.put('legacy', true)
    expect(state.get('legacy', false)).toBe(true)
    expect(() => state.rbac.migrate()).toThrow('transaction capability')
    expect(() => state.rbacDatabase.exec('CREATE TABLE forbidden (id TEXT)')).toThrow(
      'transaction capability',
    )
  } finally {
    sql.database.close()
  }
})

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

Deno.test('DurableEnrichmentStore reads legacy rows without migration and migrates on write', () => {
  const { state, store } = durableStore()
  const legacy = {
    [DEFAULT_RESEARCH_ENRICHMENT.id]: {
      'legacy-resource': enrichment('Legacy title'),
    },
  }
  state.put('enrichments:other', legacy)

  expect(store.exportRecords('other')).toEqual(legacy)
  expect(state.get('enrichments:other', null)).toEqual(legacy)
  expect(store.get('other', 'legacy-resource')).toEqual(
    legacy[DEFAULT_RESEARCH_ENRICHMENT.id]!['legacy-resource'],
  )
  store.put('other', 'new-resource', enrichment('New title'))
  expect(state.get('enrichments:other', null)).toBeNull()
  expect(store.count('other')).toBe(2)
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

Deno.test('DurableRoutingLog appends per decision, trims to its cap and keeps tenants apart', () => {
  const state = new DurableState(new TestSqlStorage())
  state.migrate()
  const log = new DurableRoutingLog(state, 3)
  const decision = (n: number, intent: string): RoutingRecord => ({
    ts: `2026-09-07T00:00:0${n}.000Z`,
    questionHash: `h${n}`,
    questionLength: 20 + n,
    intent,
    stage: n % 2 === 0 ? 'rule' : 'classifier',
    confidence: 0.9,
    rationale: 'test',
    configuration: `portal-intent-${intent}`,
    latencyMs: n,
  })
  for (let n = 1; n <= 5; n++) log.record('marine', decision(n, n < 4 ? 'general' : 'review'))
  log.record('grains', decision(9, 'lookup'))

  const recent = log.recent('marine', 10)
  expect(recent.map((r) => r.questionHash)).toEqual(['h5', 'h4', 'h3'])
  expect(log.recent('marine', 2).map((r) => r.questionHash)).toEqual(['h5', 'h4'])
  expect(log.summary('marine')).toEqual({
    total: 3,
    byIntent: { general: 1, review: 2 },
    byStage: { classifier: 2, rule: 1 },
  })
  expect(log.summary('grains').total).toBe(1)
  expect(log.recent('opax')).toEqual([])
})

Deno.test('public investigation reads return all 140 passages without audit staging', async () => {
  const sql = new TestSqlStorage()
  try {
    const state = new DurableState(sql, sql)
    state.migrate()
    const stores = durableStores(state, {})
    const investigation = stores.investigations.create('marine', 'reader', { name: 'Research' })
    for (let index = 0; index < 140; index++) {
      expect(stores.investigations.addEvidence('marine', 'reader', investigation.id, {
        passage: 'x'.repeat(8000),
        resourceId: `document-${index}`,
        resourceTitle: 'Research passage',
        score: null,
        question: '',
        verdict: null,
        aiRelevance: null,
        note: '',
        tags: [],
      })).not.toBeNull()
    }
    const expected = stores.investigations.get('marine', 'reader', investigation.id)
    const app = buildApp({ ...stores, provider: {} as RetrievalProvider })
    const response = await app.request(`/api/t/marine/investigations/${investigation.id}`, {
      headers: { 'x-rp-client': 'reader' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
    expect(stores.audit.read({ scope: { kind: 'platform' } })).toHaveLength(0)
    const stranger = await app.request(`/api/t/marine/investigations/${investigation.id}`, {
      headers: { 'x-rp-client': 'stranger' },
    })
    expect(stranger.status).toBe(404)
    await stranger.text()
  } finally {
    sql.database.close()
  }
})
