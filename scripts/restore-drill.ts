/** Isolated recovery evidence. Uses the real local HTTP app and DoubleProvider, never live services. */
import { startTestServer } from '../e2e/support/test-server.ts'
import { readExportZip } from '../e2e/support/portal-export-fixture.ts'
import { RoutingLog, SessionsStore } from '../apps/api/src/stores.ts'
import { AnswerRecordStore, FileAnswerRecordState } from '../apps/api/src/answer-record-store.ts'
import { answerRecordFixture } from '../apps/api/src/answer-record-fixture.ts'
import { EvaluationStore } from '../apps/api/src/evaluation-store.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import {
  parseBackup,
  type PortalBackup,
  remapBackup,
  restoreCounts,
} from '../apps/api/src/portal-backup.ts'
import { sha256 } from '../apps/api/src/portal-export-zip.ts'

const start = performance.now()
async function timed<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const at = performance.now()
  const result = await work()
  console.log(`${name}: ${Math.round(performance.now() - at)} ms`)
  return result
}
function requireThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
async function checksum(value: unknown): Promise<string> {
  return await sha256(new TextEncoder().encode(JSON.stringify(canonical(value))).buffer)
}
function records(backup: PortalBackup) {
  return [...backup.records].sort((a, b) =>
    `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)
  )
}

// Reserve a unique loopback port for this drill, separate from other workers' servers.
const socket = Deno.listen({ hostname: '127.0.0.1', port: 0 })
Deno.env.set('DS_PORT_BASE', String(socket.addr.port))
socket.close()
const operatorKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const headers = { authorization: `Operator ${operatorKey}` }
const server = startTestServer({
  apiOnly: true,
  identity: { role: 'owner' },
  loginEnv: {
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'recovery-drill',
    MAX_PORTAL_ALIASES: '0',
    BINDING_KEY: btoa('f'.repeat(32)),
  },
})
const { database, rbac } = openLocalRbac({ DATA_DIR: server.directory })
const sessions = new SessionsStore(server.directory)
const routing = new RoutingLog(server.directory)
const answers = new AnswerRecordStore(new FileAnswerRecordState(server.directory))
const evaluations = new EvaluationStore(database)
const owner = { kind: 'anonymous' as const, clientId: 'drill-reader' }
async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${server.url}${path}`, init)
  requireThat(response.status === 200, `HTTP ${response.status} during recovery drill`)
  return response
}
async function exported(slug: string) {
  const response = await request(`/api/admin/t/${slug}/export`, { headers })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const files = readExportZip(bytes)
  requireThat(JSON.parse(files.get('manifest.json')!).restoreVersion === 1, 'Expected full backup')
  return { bytes, backup: parseBackup(JSON.parse(files.get('portal-records.json')!)) }
}
try {
  const source = await timed('create and seed', () => {
    const source = server.tenants.add({ name: 'Soil Research Hub' })
    server.tenants.patch(source.slug, { portalRestore: true })
    const at = new Date().toISOString()
    for (let i = 0; i < 25; i++) {
      sessions.put(source.slug, owner, {
        id: `trail-${i}`,
        title: `Evidence trail ${i}`,
        updatedAt: at,
        messages: [{ role: 'user', text: 'How is soil health measured?' }],
      })
      answers.record(source.slug, answerRecordFixture(source.slug))
    }
    for (let i = 0; i < 100; i++) {
      routing.record(source.slug, {
        ts: at,
        questionHash: `fixture-${i}`,
        questionLength: 28,
        intent: 'general',
        stage: 'default',
        confidence: 1,
        rationale: 'Default intent',
        configuration: 'portal-ask',
        latencyMs: 1,
      })
    }
    const definition = evaluations.put(source.slug, 'evidence', {
      name: 'Evidence checks',
      topK: 5,
      questions: [{
        query: 'Soil health?',
        expectedSources: ['res-1'],
        expectedFacts: [],
        shouldDecline: false,
      }],
    })
    evaluations.start(source.slug, {
      id: 'retained-run',
      slug: source.slug,
      setId: definition.id,
      definition,
      startedAt: at,
      completedAt: at,
      status: 'completed',
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
    return source
  })
  const original = await timed('export', () => exported(source.slug))
  console.log(`bundle: ${original.bytes.length} bytes`)
  await timed('delete and erase', async () => {
    const deleted = await request(`/api/admin/tenants/${source.slug}`, { method: 'DELETE' })
    await deleted.body?.cancel()
    const erased = await (await request(`/api/admin/tenants/${source.slug}/erase`, {
      method: 'POST',
      headers,
    })).json()
    requireThat(
      erased.erased.sessions === 25 && erased.erased.answerRecords === 25 &&
        erased.erased.evaluations >= 2 && erased.erased.routing > 0,
      'Erasure counts did not match',
    )
    requireThat(
      !server.tenants.get(source.slug) && sessions.list(source.slug, owner).length === 0 &&
        answers.list(source.slug).length === 0 && evaluations.list(source.slug).length === 0 &&
        routing.recent(source.slug, 100).length === 0,
      'Source records survived erasure',
    )
  })
  const target = await timed('create destination', () => {
    const target = server.tenants.add({ name: 'Recovered Soil Hub' })
    server.tenants.patch(target.slug, { portalRestore: true })
    return target
  })
  const imported = await timed('restore', async () => {
    return await (await request(`/api/admin/t/${target.slug}/import?targetSlug=${target.slug}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/zip' },
      body: original.bytes,
    })).json()
  })
  await timed('compare counts and checksums', async () => {
    const expected = remapBackup(original.backup, target.slug)
    requireThat(
      await checksum(imported.counts) === await checksum(restoreCounts(expected)),
      'Import counts did not match the backup',
    )
    requireThat(
      imported.warnings.length === 0 && !imported.knowledgeBoxRestored,
      'Unexpected recovery scope',
    )
    const recovered = await exported(target.slug)
    const expectedHash = await checksum(records(expected)),
      actualHash = await checksum(records(recovered.backup))
    requireThat(expectedHash === actualHash, 'Restored record checksums did not match')
    const history = rbac.audit.read({ scope: { kind: 'portal', slug: target.slug }, limit: 1000 })
      .filter((event) => JSON.parse(event.detail_json).originalEventId)
    const auditHash = await checksum(expected.audit)
    const actualAuditHash = await checksum(expected.audit.map((original) => {
      const restored = history.find((row) =>
        JSON.parse(row.detail_json).originalEventId === original.id
      )
      requireThat(!!restored, 'A restored audit event is missing')
      const { restored: marker, bundleId, originalEventId, restoredFromPortal, ...detail } = JSON
        .parse(restored.detail_json)
      requireThat(
        marker === true && typeof bundleId === 'string' && originalEventId === original.id &&
          restoredFromPortal === source.slug,
        'Audit provenance is missing',
      )
      return { ...restored, id: original.id, detail_json: JSON.stringify(detail) }
    }))
    requireThat(auditHash === actualAuditHash, 'Restored audit checksums did not match')
    console.log(`counts: ${JSON.stringify(imported.counts)}`)
    console.log(`records SHA-256: ${actualHash} (match)`)
    console.log(`audit SHA-256: ${actualAuditHash} (match)`)
    requireThat(
      server.providerCalls.every((method) => ['exportResources', 'labelsets'].includes(method)),
      'Unexpected provider operation',
    )
  })
  console.log(
    `PASS, total: ${
      Math.round(performance.now() - start)
    } ms; local DATA_DIR and SQLite, DoubleProvider`,
  )
} finally {
  database.close()
  await server.close()
}
