import { expect } from '@std/expect'
import { startTestServer } from './support/test-server.ts'
import { readExportZip } from './support/portal-export-fixture.ts'
import { FeedbackStore, InsightsStore, RoutingLog } from '../apps/api/src/stores.ts'
import { openLocalRbac } from '../apps/api/src/rbac-local.ts'
import { createAuditEvent } from '../apps/api/src/audit.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

Deno.test('admin downloads a complete portal ZIP from local adapters, validates CRCs, CSV and privacy choices', async () => {
  const server = startTestServer({
    apiOnly: true,
    identity: { role: 'portal-admin', slug: 'marine' },
  })
  const db = openLocalRbac({ DATA_DIR: server.directory })
  try {
    server.tenants.patchBranding('marine', {
      organisation: 'Fisheries research',
      productName: 'Research discovery',
    })
    server.tenants.patch('marine', {
      prompts: { ask: 'Use the portal research evidence.', images: true },
    })
    const ts = new Date().toISOString(), learningId = 'e'.repeat(32)
    new InsightsStore(server.directory).record('marine', {
      ts,
      question: 'What is known about stock health?',
      answered: true,
      citations: 2,
      durationSec: 1,
      answerRelevance: 5,
      groundedness: 5,
      contextRelevance: 5,
      learningId,
    })
    new FeedbackStore(server.directory).record('marine', {
      learningId,
      good: false,
      ts,
      text: 'Personal reader message fixture',
    })
    new RoutingLog(server.directory).record('marine', {
      ts,
      questionHash: '1234abcd',
      questionLength: 35,
      intent: 'general',
      stage: 'default',
      confidence: 1,
      rationale: 'Default intent',
      configuration: 'portal-ask',
      latencyMs: 1,
    })
    // More than one audit page, with a separate portal that must never be exported.
    db.database.transactionSync(() => {
      for (let index = 0; index < 510; index++) {
        db.rbac.audit.append(
          createAuditEvent({
            requestId: `fixture-export-${index}`,
            actor: { kind: 'system' },
            action: 'maintenance.run',
            scope: { kind: 'portal', slug: 'marine' },
            target: { kind: 'portal', id: 'marine' },
            outcome: 'success',
            detail: { count: index },
          }),
        )
      }
      db.rbac.audit.append(
        createAuditEvent({
          requestId: 'other-portal-marker',
          actor: { kind: 'system' },
          action: 'maintenance.run',
          scope: { kind: 'portal', slug: 'grains' },
          target: { kind: 'portal', id: 'grains' },
          outcome: 'success',
        }),
      )
    })
    const response = await fetch(`${server.url}/api/admin/t/marine/export`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="portal-marine-export.zip"',
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
    const archive = `${server.directory}/portal-export.zip`
    await Deno.writeFile(archive, bytes)
    // The standard ZIP and CSV implementations validate independently of our fixture reader.
    const checked = await new Deno.Command('python3', {
      args: [
        '-c',
        'import csv,io,json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nm=json.loads(z.read("manifest.json"))\na=list(csv.DictReader(io.StringIO(z.read("audit.csv").decode())))\nassert len(a)==m["counts"]["auditEvents"]\nassert len(a)>=510\nassert all(r["scope_slug"]=="marine" for r in a)\nfor f in z.namelist():\n if f.endswith(".json"): json.loads(z.read(f))\n',
        archive,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    expect(new TextDecoder().decode(checked.stderr)).toBe('')
    expect(checked.success).toBe(true)
    const files = readExportZip(bytes), manifest = JSON.parse(files.get('manifest.json')!)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      complete: true,
      portal: 'marine',
      includeFeedback: false,
      counts: {
        resources: 2,
        fileLinks: 1,
        keys: 3,
        insightAsks: 1,
        routingRecords: 1,
        feedback: 0,
        evaluationSets: 0,
        evaluationResults: 0,
      },
    })
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual(
      [...files.keys()].sort(),
    )
    const config = JSON.parse(files.get('configuration.json')!)
    expect(config).toMatchObject({
      tenant: { slug: 'marine', branding: { organisation: 'Fisheries research' } },
      settings: { ask: 'Use the portal research evidence.', images: true },
    })
    expect(JSON.parse(files.get('resources.json')!)[0]).toMatchObject({
      resource: { id: 'res-1', originUrl: 'https://research.example.test/res-1' },
      labels: [{ labelset: 'topic', label: 'stock-assessment' }, {
        labelset: 'topic',
        label: 'marine-sustainability',
      }],
      files: [{ fieldId: 'file', url: '/api/t/marine/resources/res-1/file/file' }],
    })
    expect(JSON.parse(files.get('insights.json')!).totalAsks).toBe(1)
    expect(JSON.parse(files.get('evaluations.json')!)).toMatchObject({
      status: 'unavailable',
      sets: [],
      results: [],
    })
    expect(files.has('feedback.csv')).toBe(false)
    const all = [...files.values()].join('\n')
    for (
      const excluded of [
        'Personal reader message fixture',
        'other-portal-marker',
        '"hash"',
        '"prefix"',
        '"token"',
        '"creator"',
      ]
    ) expect(all).not.toContain(excluded)
    const included = await fetch(`${server.url}/api/admin/t/marine/export?includeFeedback=true`)
    expect(included.status).toBe(200)
    const selected = readExportZip(new Uint8Array(await included.arrayBuffer()))
    expect(selected.get('feedback.csv')).toContain('Personal reader message fixture')
    const events = db.rbac.audit.read({
      scope: { kind: 'portal', slug: 'marine' },
      action: 'portal.export.bundle',
      limit: 100,
    })
    expect(
      events.filter((event) => event.outcome === 'success').map((event) =>
        JSON.parse(event.detail_json).includeFeedback
      ).sort(),
    ).toEqual([false, true])
    server.setIdentity(fixtureSession({ oid: 'fixture-viewer' }))
    const denied = await fetch(`${server.url}/api/admin/t/marine/export`)
    expect(denied.status).toBe(403)
    expect(denied.headers.has('content-disposition')).toBe(false)
    await denied.body?.cancel()
  } finally {
    db.database.close()
    await server.close()
  }
})
