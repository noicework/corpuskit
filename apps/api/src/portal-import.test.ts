import { EnrichmentStore } from './enrichments.ts'
import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { validateImportZip } from './portal-import.ts'
import { answerRecordFixture } from './answer-record-fixture.ts'
import { ExportZip } from './portal-export-zip.ts'
import { readExportZip } from '../../../e2e/support/portal-export-fixture.ts'
import { parseBackup, remapBackup, restoreCounts } from './portal-backup.ts'
import { createAuditEvent } from './audit.ts'

const owner = { kind: 'anonymous' as const, clientId: 'restore-reader' }

/** Rebuild an inventory after deliberate fixture edits, so deeper validation is exercised. */
async function bundle(
  files: Map<string, string>,
  legacy = false,
): Promise<Uint8Array<ArrayBuffer>> {
  const manifest = JSON.parse(files.get('manifest.json')!)
  const zip = new ExportZip(8 * 1024 * 1024, new AbortController().signal)
  for (const [name, text] of files) if (name !== 'manifest.json') await zip.add(name, [text])
  manifest.files = [
    ...zip.entries.map(({ path, bytes, sha256 }) =>
      legacy ? { path, bytes } : { path, bytes, sha256 }
    ),
    { path: 'manifest.json' },
  ]
  await zip.add('manifest.json', [JSON.stringify(manifest)])
  return new Uint8Array(await zip.finish().arrayBuffer())
}

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter} legacy inventory restores only present records with compatibility warnings`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const admin = f.sessionFor('platform-admin')
      // Default-off export is the same shape as current public main, without portable records.
      const instructions = 'Use evidence. '.repeat(100)
      f.stores.tenants.patch('a', { prompts: { ask: instructions } })
      f.stores.routing.record('a', {
        ts: new Date().toISOString(),
        questionHash: 'fixture',
        questionLength: 12,
        intent: 'general',
        stage: 'default',
        confidence: 1,
        rationale: 'Default intent',
        configuration: 'portal-ask',
        latencyMs: 1,
      })
      f.stores.feedback.record('a', {
        learningId: 'a'.repeat(32),
        good: false,
        ts: new Date().toISOString(),
        text: '=Research, "feedback"\r\nSecond line',
      })
      const response = await f.requestAs(admin, '/api/admin/t/a/export?includeFeedback=true')
      expect(response.status).toBe(200)
      const files = readExportZip(new Uint8Array(await response.arrayBuffer()))
      expect(files.has('portal-records.json')).toBe(false)
      expect(JSON.parse(files.get('manifest.json')!).restoreVersion).toBeUndefined()
      const bytes = await bundle(files, true)
      const legacy = await validateImportZip(bytes)
      expect(legacy.warnings.join(' ')).toContain('partial recovery')
      f.stores.tenants.patch('b', { portalRestore: true })
      const since = f.providerCalls.length
      const imported = await f.requestAs(admin, '/api/admin/t/b/import?targetSlug=b', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: bytes,
      })
      expect(imported.status, await imported.clone().text()).toBe(200)
      expect(await imported.json()).toMatchObject({
        counts: { configuration: 1, routing: 1, feedback: 1, sessions: 0, answerRecords: 0 },
        warnings: legacy.warnings,
      })
      expect(f.stores.tenants.get('b')!.portalRestore).toBe(true)
      // The local owned-store fixture retains a durable registry; inspect its file adapter write.
      const prompts = adapter === 'local'
        ? JSON.parse(Deno.readTextFileSync(`${f.directory}/tenants.json`)).overrides.b.prompts
        : f.stores.tenants.promptsFor('b')
      expect(prompts.ask).toBe(instructions)
      expect(f.stores.routing.recent('b', 10)).toEqual(f.stores.routing.recent('a', 10))
      expect(f.stores.feedback.comments('b', ['a'.repeat(32)])['a'.repeat(32)]).toBe(
        '=Research, "feedback"\r\nSecond line',
      )
      const restored = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'b' }, limit: 100 })
        .filter((e) => JSON.parse(e.detail_json).originalEventId)
      expect(restored).toHaveLength(legacy.backup.audit.length)
      expect(restored.every((e) => JSON.parse(e.detail_json).restored === true)).toBe(true)
      f.assertNoProtectedDispatch(since)
      const malformed = new Map(files)
      malformed.set('audit.csv', malformed.get('audit.csv')!.replace('"user"', '"invalid-actor"'))
      expect(malformed.get('audit.csv')).not.toBe(files.get('audit.csv'))
      const rejected = await f.requestAs(admin, '/api/admin/t/b/import?targetSlug=b', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: await bundle(malformed, true),
      })
      expect(rejected.status).toBe(400)
      // Updating the ZIP CRC alone cannot bypass the legacy manifest byte lengths.
      await expect(
        validateImportZip(
          await rewrite(
            bytes,
            (f) => f.set('configuration.json', f.get('configuration.json')! + ' '),
          ),
        ),
      )
        .rejects.toBeDefined()
    } finally {
      f.close()
    }
  })
}

Deno.test('restore opt-in is per portal, audited, and defaults off without changing exports', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('platform-admin')
    expect((await f.requestAs(admin, '/api/admin/t/a/import', { method: 'POST' })).status).toBe(404)
    const enabled = await f.requestAs(admin, '/api/admin/tenants/a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ portalRestore: true }),
    })
    expect(enabled.status).toBe(200)
    expect(
      f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' }, limit: 100 })
        .some((e) =>
          e.action === 'tenant.behaviour.update' &&
          JSON.parse(e.detail_json).changedFields === 'portalRestore'
        ),
    ).toBe(true)
    const enabledExport = await f.requestAs(admin, '/api/admin/t/a/export')
    const files = readExportZip(new Uint8Array(await enabledExport.arrayBuffer()))
    expect(JSON.parse(files.get('manifest.json')!).restoreVersion).toBe(1)
    expect((await validateImportZip(await bundle(files))).warnings).toEqual([])
    expect((await f.requestAs(admin, '/api/admin/t/b/import', { method: 'POST' })).status).toBe(404)
  } finally {
    f.close()
  }
})

Deno.test('restore rejects unsupported versions, authority records, unsafe paths and ZIP bombs', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.tenants.patch('a', { portalRestore: true })
    const response = await f.requestAs(f.sessionFor('platform-admin'), '/api/admin/t/a/export')
    const bytes = new Uint8Array(await response.arrayBuffer())
    for (const field of ['restoreVersion', 'schemaVersion']) {
      const files = readExportZip(bytes), manifest = JSON.parse(files.get('manifest.json')!)
      manifest[field] = 99
      files.set('manifest.json', JSON.stringify(manifest))
      await expect(validateImportZip(await bundle(files))).rejects.toBeDefined()
    }
    for (const change of ['count', 'hash'] as const) {
      const files = readExportZip(bytes), manifest = JSON.parse(files.get('manifest.json')!)
      if (change === 'count') manifest.counts.restore.configuration++
      else {delete manifest.files.find((entry: { path: string }) =>
          entry.path === 'configuration.json'
        ).sha256}
      files.set('manifest.json', JSON.stringify(manifest))
      // Keep the deliberately missing hash, rather than rebuilding its inventory.
      const altered = change === 'count'
        ? await bundle(files)
        : await rewrite(bytes, (f) => f.set('manifest.json', JSON.stringify(manifest)))
      await expect(validateImportZip(altered)).rejects.toBeDefined()
    }
    for (const kind of ['bindings', 'mcpKeys', 'assignments', 'aliases', 'resources', 'domains']) {
      const files = readExportZip(bytes), backup = JSON.parse(files.get('portal-records.json')!)
      backup.records.push({ kind, key: '', value: {} })
      files.set('portal-records.json', JSON.stringify(backup))
      await expect(validateImportZip(await bundle(files))).rejects.toBeDefined()
    }
    for (const [offset, value] of [[6, 0x801], [8, 8]] as const) {
      const altered = bytes.slice()
      new DataView(altered.buffer).setUint16(offset, value, true)
      await expect(validateImportZip(altered)).rejects.toBeDefined()
    }
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1)
    await expect(validateImportZip(oversized)).rejects.toMatchObject({ status: 413 })
    const send = (body: Uint8Array<ArrayBuffer>) =>
      f.requestAs(f.sessionFor('platform-admin'), '/api/admin/t/a/import', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body,
      })
    expect((await send(oversized)).status).toBe(413)
    const zip = new ExportZip(1024, new AbortController().signal)
    await zip.add('../tenants.json', ['{}'])
    await expect(validateImportZip(new Uint8Array(await zip.finish().arrayBuffer())))
      .rejects.toBeDefined()
    const missingVersion = readExportZip(bytes),
      manifest = JSON.parse(missingVersion.get('manifest.json')!)
    delete manifest.restoreVersion
    missingVersion.set('manifest.json', JSON.stringify(manifest))
    await expect(validateImportZip(await bundle(missingVersion))).rejects.toBeDefined()
  } finally {
    f.close()
  }
})

Deno.test('slug remapping preserves prose, owners and provider ids and remaps portal audit targets', () => {
  const f = createEnforcementFixture()
  try {
    const source = f.stores.tenants.get('a')!
    const original = parseBackup({
      version: 1,
      portal: 'a',
      records: [{
        kind: 'configuration',
        key: '',
        value: { tenant: source, prompts: {}, disabled: false },
      }, {
        kind: 'routing',
        key: '',
        value: [{
          question: '/t/a/research is a literal message',
          url: '/t/a/research',
          resourceId: 'a',
        }],
      }],
      audit: [
        createAuditEvent({
          requestId: 'fixture-remap',
          actor: { kind: 'system' },
          action: 'maintenance.run',
          scope: { kind: 'portal', slug: 'a' },
          target: { kind: 'portal', id: 'a' },
          outcome: 'success',
        }),
      ],
    })
    const remapped = remapBackup(original, 'b')
    expect(remapped.records[1]!.value).toEqual([{
      question: '/t/a/research is a literal message',
      url: '/t/b/research',
      resourceId: 'a',
    }])
    expect(remapped.audit[0]).toMatchObject({ scope_slug: 'b', target_id: 'b' })
    expect(original.audit[0]!.scope_slug).toBe('a')
  } finally {
    f.close()
  }
})
async function rewrite(
  bytes: Uint8Array,
  modify: (files: Map<string, string>) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const files = readExportZip(bytes)
  modify(files)
  const zip = new ExportZip(8 * 1024 * 1024, new AbortController().signal)
  for (const [name, text] of files) await zip.add(name, [text])
  return new Uint8Array(await zip.finish().arrayBuffer())
}

Deno.test('restore validates manifest, hashes, CRC, duplicate records and per-kind counts', async () => {
  const f = createEnforcementFixture()
  try {
    for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { portalRestore: true })
    const response = await f.requestAs(f.sessionFor('platform-admin'), '/api/admin/t/a/export')
    const bytes = new Uint8Array(await response.arrayBuffer())
    const validated = await validateImportZip(bytes)
    expect(restoreCounts(validated.backup).configuration).toBe(1)
    const corrupt = bytes.slice()
    corrupt[50] = corrupt[50]! ^ 1
    await expect(validateImportZip(corrupt)).rejects.toBeDefined()
    for (
      const change of [
        (files: Map<string, string>) =>
          files.set(
            'manifest.json',
            files.get('manifest.json')!.replace('"schemaVersion":1', '"schemaVersion":99'),
          ),
        (files: Map<string, string>) =>
          files.set('portal-records.json', files.get('portal-records.json')! + ' '),
        (files: Map<string, string>) => files.delete('configuration.json'),
      ]
    ) await expect(validateImportZip(await rewrite(bytes, change))).rejects.toBeDefined()
    const backup = validated.backup
    await expect(
      Promise.resolve().then(() =>
        parseBackup({ ...backup, records: [...backup.records, backup.records[0]] })
      ),
    ).rejects.toBeDefined()
  } finally {
    f.close()
  }
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter} restore round trip, isolation, idempotency and audit rollback`, async () => {
    // Both fixtures use the real runtime stores and real SQLite transactions.
    const f = createEnforcementFixture({}, adapter)
    try {
      for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { portalRestore: true })
      const admin = f.sessionFor('platform-admin')
      const source = 'a', target = 'b'
      f.stores.sessions.put(source, owner, {
        id: 'restore-session',
        title: 'Evidence trail',
        updatedAt: new Date().toISOString(),
        messages: [],
      })
      const investigation = f.stores.investigations.create(source, owner, {
        name: 'Fisheries research',
      })
      f.stores.answerRecords.record(source, answerRecordFixture(source))
      f.stores.duplicates.decide(source, 'res-1/res-copy', 'keep-both')
      f.stores.evaluations.put(source, 'quality', {
        name: 'Evidence checks',
        topK: 5,
        questions: [{
          query: 'Stock health?',
          expectedSources: ['res-1'],
          expectedFacts: [],
          shouldDecline: false,
        }],
      })
      const enrichmentStore = adapter === 'local'
        ? new EnrichmentStore(f.directory)
        : f.stores.enrichments
      enrichmentStore.put(source, 'res-1', {
        schemaId: 'suggested-questions',
        generatedAt: new Date().toISOString(),
        data: { questions: ['How is stock health measured?'] },
      })
      f.stores.insights.record(source, {
        ts: new Date().toISOString(),
        question: 'Stock health?',
        answered: true,
        citations: 1,
        durationSec: 1,
        answerRelevance: null,
        groundedness: null,
        contextRelevance: null,
      })
      f.stores.branding.put(source, 'logo', {
        bytes: new TextEncoder().encode('fixture image'),
        contentType: 'image/png',
        version: 'fixture',
      })
      const exported = await f.requestAs(admin, '/api/admin/t/a/export')
      expect(exported.status).toBe(200)
      const bytes = new Uint8Array(await exported.arrayBuffer())
      const send = (slug = target, query = '?targetSlug=b') =>
        f.requestAs(admin, `/api/admin/t/${slug}/import${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: bytes,
        })
      expect((await send(target, '')).status).toBe(400)
      // Fail after records have been written. The whole import must roll back.
      f.database.exec(
        "CREATE TRIGGER fixture_restore_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'portal.import.bundle' BEGIN SELECT RAISE(ABORT, 'fixture restore failure'); END",
      )
      expect((await send()).status).toBe(500)
      expect(f.stores.sessions.list(target, owner)).toEqual([])
      expect(f.stores.evaluations.list(target)).toEqual([])
      f.database.exec('DROP TRIGGER fixture_restore_failure')
      const restored = await send()
      expect(restored.status, await restored.clone().text()).toBe(200)
      const result = await restored.json()
      expect(result).toMatchObject({
        alreadyImported: false,
        knowledgeBoxRestored: false,
        counts: {
          sessions: 1,
          investigations: 1,
          answerRecords: 1,
          duplicates: 1,
          evaluationSets: 1,
          enrichments: 1,
          insights: 1,
          branding: 1,
        },
      })
      expect(f.stores.sessions.list(target, owner)).toEqual(f.stores.sessions.list(source, owner))
      expect(f.stores.investigations.get(target, owner, investigation.id)).toEqual(investigation)
      expect(f.stores.duplicates.reviews(target)).toEqual(f.stores.duplicates.reviews(source))
      expect(f.stores.evaluations.list(target)[0]!.slug).toBe(target)
      expect(f.stores.branding.get(target, 'logo')!.bytes).toEqual(
        new TextEncoder().encode('fixture image'),
      )
      const second = await send()
      expect(second.status).toBe(200)
      const repeated = await second.json()
      expect(repeated.alreadyImported).toBe(true)
      expect(Object.values(repeated.counts).every((n) => n === 0)).toBe(true)
      const restoredAudit = f.rbac.audit.read({
        scope: { kind: 'portal', slug: target },
        limit: 1000,
      }).filter((e) => JSON.parse(e.detail_json).restored)
      expect(restoredAudit.length).toBeGreaterThan(1)
      const occupied = await send(source, '')
      expect(occupied.status).toBe(409)
    } finally {
      f.close()
    }
  })
}

Deno.test('platform restore remains available for suspended and read-only destinations', async () => {
  const f = createEnforcementFixture()
  try {
    for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { portalRestore: true })
    const admin = f.sessionFor('platform-admin')
    const exported = await f.requestAs(admin, '/api/admin/t/a/export')
    const bytes = new Uint8Array(await exported.arrayBuffer())
    const since = f.providerCalls.length
    for (const status of ['read_only', 'suspended'] as const) {
      f.stores.lifecycle.set('b', { status, limits: null })
      const response = await f.requestAs(admin, '/api/admin/t/b/import?targetSlug=b', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: bytes,
      })
      expect(response.status, await response.clone().text()).toBe(200)
      await response.body?.cancel()
    }
    f.assertNoProtectedDispatch(since)
  } finally {
    f.close()
  }
})

Deno.test('import refuses portal roles and MCP keys and accepts platform authority', async () => {
  const f = createEnforcementFixture()
  try {
    for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { portalRestore: true })
    for (
      const role of [
        'viewer',
        'analyst',
        'curator',
        'portal-admin',
        'platform-admin',
        'owner',
      ] as const
    ) {
      const response = await f.requestAs(f.sessionFor(role), '/api/admin/t/a/import', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: new Uint8Array(),
      })
      expect(response.status, role).toBe(['owner', 'platform-admin'].includes(role) ? 400 : 403)
    }
    expect((await f.requestAs(null, '/api/admin/t/a/import', { method: 'POST' })).status).toBe(401)
    const minted = await f.requestAs(f.creator, '/api/t/a/mcp/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Restore fixture', role: 'portal-admin' }),
    })
    const key = (await minted.json()).key
    expect(
      (await f.requestAs(null, '/api/admin/t/a/import', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      })).status,
    ).toBe(401)
  } finally {
    f.close()
  }
})

Deno.test('registry restore preserves destination host routing and handles legacy registry records', async () => {
  const { restoredTenantRegistry } = await import('./portal-backup.ts')
  const value = {
    tenant: { slug: 'source', branding: { productName: 'Evidence' } },
    prompts: { ask: 'Use research.' },
    disabled: false,
  }
  const restored = restoredTenantRegistry(
    {
      custom: { target: { slug: 'target' } },
      overrides: { target: { hostname: 'soil.example.test' }, other: { siteFeedback: true } },
      disabled: ['target'],
      aliases: [{ slug: 'target', hostname: 'soil.example.test' }],
    },
    'target',
    value,
  )
  expect(restored).toMatchObject({
    overrides: { target: { hostname: 'soil.example.test' }, other: { siteFeedback: true } },
    disabled: [],
    aliases: [{ slug: 'target', hostname: 'soil.example.test' }],
  })
  expect(restoredTenantRegistry({ target: { slug: 'target' } }, 'target', value)).toMatchObject({
    custom: { target: { slug: 'target' } },
    disabled: [],
  })
  expect(restoredTenantRegistry(
    {
      custom: { target: { slug: 'target', hostname: 'soil.example.test', portalRestore: true } },
      overrides: {},
    },
    'target',
    { ...value, tenant: { ...value.tenant, hostname: 'source.example.test' } },
  ))
    .toMatchObject({
      overrides: { target: { hostname: 'soil.example.test', portalRestore: true } },
    })
})

Deno.test('restore counts and reads every additional portal record collection without replaying scheduling authority', async () => {
  const f = createEnforcementFixture()
  try {
    for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { portalRestore: true })
    const slug = 'a', target = 'b', at = new Date().toISOString()
    const watch = f.stores.watches.add(slug, owner, 'Stock health')
    f.stores.sources.add(slug, 'https://research.example.test/news', false)
    f.stores.linkHealth.put(slug, {
      id: 'link',
      url: 'https://research.example.test/page',
      title: 'Evidence',
      status: 'broken',
      firstFailed: at,
      lastChecked: at,
      attempts: 1,
      ignored: true,
    })
    f.stores.suggestions.replacePending(slug, [{
      id: 'taxonomy',
      kind: 'labelset',
      title: 'Topics',
      detail: 'Research labels',
      status: 'pending',
      createdAt: at,
      labelset: { id: 'topic', title: 'Topics', paragraphs: false, labels: ['Stock health'] },
    }])
    f.stores.kgProposals.set(slug, {
      rationale: 'Research graph',
      entityTypes: [],
      resourceLabels: [],
      chunkLabels: [],
      examples: [],
    })
    f.stores.feedback.record(slug, {
      learningId: 'a'.repeat(32),
      good: false,
      ts: at,
      text: 'Research message',
    })
    f.stores.siteFeedback.save(slug, {
      id: '00000000-0000-4000-8000-000000000001',
      slug,
      createdAt: at,
      category: 'general',
      message: 'Research portal message',
      pageUrl: 'https://research.example.test/t/a/library',
      delivery: 'sent',
    })
    const definition = f.stores.evaluations.put(slug, 'checks', {
      name: 'Evidence checks',
      topK: 5,
      questions: [{
        query: 'Stock health?',
        expectedSources: ['res-1'],
        expectedFacts: [],
        shouldDecline: false,
      }],
    })
    f.stores.evaluations.schedule(slug, 'checks', {
      slug,
      setId: 'checks',
      everyDays: 1,
      nextAt: Date.now() + 86_400_000,
      confirmedAsks: 1,
      updatedAt: definition.updatedAt,
      owner: { tenantId: 'tenant-1', oid: 'fixture-reviewer' },
    })
    f.stores.evaluations.start(slug, {
      id: 'retained-run',
      slug,
      setId: 'checks',
      definition,
      startedAt: at,
      completedAt: null,
      status: 'running',
      results: [],
      summary: {
        errors: 0,
        retrievalHitRate: null,
        citationPrecision: null,
        factCoverage: null,
        declineCorrectness: null,
        answerRelevance: null,
        groundedness: null,
        contextRelevance: null,
      },
    })
    const admin = f.sessionFor('platform-admin')
    const exported = await f.requestAs(admin, '/api/admin/t/a/export?includeFeedback=true')
    expect(exported.status).toBe(200)
    const bytes = new Uint8Array(await exported.arrayBuffer())
    const response = await f.requestAs(admin, '/api/admin/t/b/import?targetSlug=b', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: bytes,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json()).counts).toMatchObject({
      watches: 1,
      sources: 1,
      linkHealth: 1,
      suggestions: 1,
      kgProposals: 1,
      feedback: 1,
      siteFeedback: 1,
      evaluationSets: 1,
      evaluationRuns: 1,
      evaluationSchedules: 0,
    })
    expect(f.stores.watches.list(target, owner)[0]!.id).toBe(watch.id)
    expect(f.stores.sources.list(target)[0]!.url).toBe('https://research.example.test/news')
    expect(f.stores.linkHealth.list(target)[0]!.ignored).toBe(true)
    expect(f.stores.suggestions.list(target)[0]!.labelset!.labels).toEqual(['Stock health'])
    expect(f.stores.kgProposals.get(target)!.rationale).toBe('Research graph')
    expect(f.stores.feedback.comments(target, ['a'.repeat(32)])['a'.repeat(32)]).toBe(
      'Research message',
    )
    expect(f.stores.siteFeedback.recent(target, 10)[0]!.slug).toBe(target)
    expect(f.stores.evaluations.schedules(target)).toEqual([])
    expect(f.stores.evaluations.runs(target, 'checks')[0]!.status).toBe('failed')
    expect(f.stores.evaluations.runs(target, 'checks')[0]!.definition.slug).toBe(target)
  } finally {
    f.close()
  }
})
