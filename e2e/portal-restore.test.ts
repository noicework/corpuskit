import { createEnforcementFixture } from '../apps/api/src/enforcement-fixture.ts'
import { expect } from '@std/expect'
import { startTestServer } from './support/test-server.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import {
  InsightsStore,
  InvestigationStore,
  RoutingLog,
  SessionsStore,
  WatchStore,
} from '../apps/api/src/stores.ts'
import { EnrichmentStore } from '../apps/api/src/enrichments.ts'
import { AnswerRecordStore, FileAnswerRecordState } from '../apps/api/src/answer-record-store.ts'
import { answerRecordFixture } from '../apps/api/src/answer-record-fixture.ts'
import { EvaluationStore } from '../apps/api/src/evaluation-store.ts'
import { DuplicateReviewStore } from '../apps/api/src/duplicate-store.ts'
import { readExportZip } from './support/portal-export-fixture.ts'
import { localPortalBackup } from '../apps/api/src/portal-backup-local.ts'
import { parseBackup, restoreCounts } from '../apps/api/src/portal-backup.ts'

const operatorKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const headers = { authorization: `Operator ${operatorKey}` }
Deno.test('local operator exports, resets and restores realistic portal records over HTTP', async () => {
  const server = startTestServer({
    apiOnly: true,
    loginEnv: { OPERATOR_API_KEY: operatorKey, OPERATOR_ID: 'backup-automation' },
  })
  const { database, rbac } = openLocalRbac({ DATA_DIR: server.directory })
  const slug = 'marine', owner = { kind: 'anonymous' as const, clientId: 'fixture-researcher' }
  const sessions = new SessionsStore(server.directory),
    investigations = new InvestigationStore(server.directory)
  const insights = new InsightsStore(server.directory), routing = new RoutingLog(server.directory)
  const enrichments = new EnrichmentStore(server.directory)
  const answers = new AnswerRecordStore(new FileAnswerRecordState(server.directory))
  const evaluations = new EvaluationStore(database), duplicates = new DuplicateReviewStore(database)
  try {
    server.tenants.patchBranding(slug, {
      organisation: 'Fisheries research',
      productName: 'Research discovery',
    })
    server.tenants.patch(slug, {
      prompts: { ask: 'Use the research evidence.' },
      topics: [{ id: 'stocks', label: 'Stock health' }],
    })
    for (let i = 0; i < 100; i++) {
      sessions.put(slug, owner, {
        id: `session-${i}`,
        title: `Evidence trail ${i}`,
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'user', text: 'What does the research show?' }],
      })
      investigations.create(slug, owner, {
        name: `Evidence review ${i}`,
        question: 'What does the research show?',
      })
      answers.record(slug, answerRecordFixture(slug))
    }
    for (let i = 0; i < 1000; i++) {
      enrichments.put(slug, `resource-${i}`, {
        schemaId: 'suggested-questions',
        generatedAt: new Date().toISOString(),
        data: {
          questions: ['How is stock health measured?', 'Which findings need more research?'],
        },
      })
    }
    for (let i = 0; i < 500; i++) {
      insights.record(slug, {
        ts: new Date().toISOString(),
        question: `Evidence question ${i}?`,
        answered: true,
        citations: 2,
        durationSec: 1,
        answerRelevance: 5,
        groundedness: 5,
        contextRelevance: 5,
      })
      routing.record(slug, {
        ts: new Date().toISOString(),
        questionHash: `fixture-${i}`,
        questionLength: 20,
        intent: 'general',
        stage: 'default',
        confidence: 1,
        rationale: 'Default intent',
        configuration: 'portal-ask',
        latencyMs: 1,
      })
    }
    for (let i = 0; i < 20; i++) duplicates.decide(slug, `resource-${i}/copy-${i}`, 'keep-both')
    evaluations.put(slug, 'quality', {
      name: 'Evidence checks',
      topK: 5,
      questions: [{
        query: 'Stock health?',
        expectedSources: ['res-1'],
        expectedFacts: [],
        shouldDecline: false,
      }],
    })
    const exported = await fetch(`${server.url}/api/admin/t/${slug}/export`, { headers })
    expect(exported.status).toBe(200)
    const bytes = new Uint8Array(await exported.arrayBuffer())
    const payload = parseBackup(JSON.parse(readExportZip(bytes).get('portal-records.json')!))
    const expected = restoreCounts(payload)
    const beforeSessions = sessions.list(slug, owner),
      beforeInvestigations = investigations.list(slug, owner)
    const beforeReviews = duplicates.reviews(slug)
    sessions.erase(slug)
    investigations.erase(slug)
    new WatchStore(server.directory).erase(slug)
    insights.erase(slug)
    routing.erase(slug)
    enrichments.erase(slug)
    answers.erase(slug)
    evaluations.erase(slug)
    duplicates.erase(slug)
    server.tenants.patchBranding(slug, { organisation: 'Empty portal' })
    server.tenants.patch(slug, { prompts: { ask: 'Reset' }, topics: [] })
    const started = performance.now()
    const response = await fetch(`${server.url}/api/admin/t/${slug}/import`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/zip' },
      body: bytes,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json()
    const milliseconds = performance.now() - started
    expect(result).toMatchObject({
      alreadyImported: false,
      counts: expected,
      knowledgeBoxRestored: false,
    })
    expect(server.tenants.get(slug)!.branding.organisation).toBe('Fisheries research')
    expect(server.tenants.get(slug)!.topics).toEqual([{ id: 'stocks', label: 'Stock health' }])
    expect(server.tenants.promptsFor(slug).ask).toBe('Use the research evidence.')
    expect(sessions.list(slug, owner)).toEqual(beforeSessions)
    expect(investigations.list(slug, owner)).toEqual(beforeInvestigations)
    expect(duplicates.reviews(slug)).toEqual(beforeReviews)
    expect(new EnrichmentStore(server.directory).count(slug, 'suggested-questions')).toBe(1000)
    expect(answers.list(slug)).toHaveLength(100)
    expect(evaluations.list(slug)).toHaveLength(1)
    expect(insights.summary(slug).totalAsks).toBe(500)
    const repeated = await fetch(`${server.url}/api/admin/t/${slug}/import`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/zip' },
      body: bytes,
    })
    expect(await repeated.json()).toMatchObject({ alreadyImported: true })
    const events = rbac.audit.read({
      scope: { kind: 'portal', slug },
      action: 'portal.export.bundle',
      limit: 100,
    })
    expect(events.some((e) => e.actor_kind === 'operator' && e.outcome === 'success')).toBe(true)
    expect(server.providerCalls.filter((c) => c === 'exportResources')).toHaveLength(1)
    const managed = createEnforcementFixture()
    try {
      const imported = await managed.requestAs(
        managed.sessionFor('platform-admin'),
        '/api/admin/t/b/import?targetSlug=b',
        { method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes },
      )
      expect(imported.status, await imported.clone().text()).toBe(200)
      expect((await imported.json()).counts).toEqual(expected)
      expect(managed.stores.sessions.list('b', owner)).toEqual(beforeSessions)
      expect(managed.stores.answerRecords.list('b')).toHaveLength(100)
      expect(managed.stores.answerRecords.list('b').every((r) => r.portal === 'b')).toBe(true)
      expect(managed.stores.enrichments.count('b', 'suggested-questions')).toBe(1000)
      expect(managed.stores.evaluations.list('b')[0]!.slug).toBe('b')
      const managedExport = await managed.requestAs(
        managed.sessionFor('platform-admin'),
        '/api/admin/t/b/export',
      )
      expect(managedExport.status).toBe(200)
      const managedBytes = new Uint8Array(await managedExport.arrayBuffer())
      const localImport = await fetch(`${server.url}/api/admin/t/grains/import?targetSlug=grains`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/zip' },
        body: managedBytes,
      })
      expect(localImport.status, await localImport.clone().text()).toBe(200)
      expect((await localImport.json()).counts.sessions).toBe(100)
      expect(sessions.list('grains', owner)).toEqual(beforeSessions)
      expect(answers.list('grains').every((r) => r.portal === 'grains')).toBe(true)
    } finally {
      managed.close()
    }
    console.log(
      JSON.stringify({
        fixture: 'portal-restore',
        runtime: 'local',
        bytes: bytes.length,
        records: expected,
        restoreMilliseconds: Math.round(milliseconds),
      }),
    )
    // The adapter writes no retained backup or receipt store beyond the existing audit history.
    const adapter = localPortalBackup(server.directory, database, {
      TENANTS_PATH: `${server.directory}/tenants.json`,
    }, () => {})
    expect(adapter.capture(slug, false).filter((r) => r.kind === 'sessions')).toHaveLength(100)
  } finally {
    database.close()
    await server.close()
  }
})
