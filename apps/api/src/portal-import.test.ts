import { EnrichmentStore } from './enrichments.ts'
import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { validateImportZip } from './portal-import.ts'
import { answerRecordFixture } from './answer-record-fixture.ts'
import { ExportZip } from './portal-export-zip.ts'
import { readExportZip } from '../../../e2e/support/portal-export-fixture.ts'
import { parseBackup, restoreCounts } from './portal-backup.ts'

const owner = { kind: 'anonymous' as const, clientId: 'restore-reader' }
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

Deno.test('import refuses portal roles and MCP keys and accepts platform authority', async () => {
  const f = createEnforcementFixture()
  try {
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
