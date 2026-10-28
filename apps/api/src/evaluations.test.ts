import { expect } from '@std/expect'
import { EvaluationInputSchema, type EvaluationRun } from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import {
  captureEvaluationAnswer,
  evaluationCsv,
  scoreEvaluation,
  summariseEvaluation,
} from './evaluation-scoring.ts'

const input = EvaluationInputSchema.parse({
  name: 'Fisheries checks',
  topK: 1,
  questions: [
    {
      query: 'What evidence describes abalone populations?',
      expectedSources: ['res-1'],
      expectedFacts: ['marine heatwaves'],
    },
  ],
})
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('evaluation scoring keeps retrieval, citations, literal facts, declines and REMi separate', () => {
  const answer = {
    text:
      'Marine heatwaves [1], unexpected evidence [2], verified evidence [3], repeated [4] and unsupported marker [9].',
    refused: false,
    citations: [{ index: 1, resourceId: 'res-1' }, { index: 2, resourceId: 'unexpected' }, {
      index: 3,
      resourceId: 'verified-source',
    }, { index: 4, resourceId: 'res-1' }],
    verifiedIds: ['verified-source'],
    answerRelevance: 4,
    groundedness: null,
    contextRelevance: 3,
  }
  const result = scoreEvaluation(input.questions[0]!, ['other', 'res-1'], answer)
  expect(result.retrievalHit).toBe(true)
  expect(result.citationPrecision).toBe(2 / 3)
  const finalOnly = scoreEvaluation(input.questions[0]!, ['res-1'], {
    ...answer,
    text: 'Final evidence [1].',
  })
  expect(finalOnly.citationPrecision).toBe(1)
  expect(finalOnly.citedIds).toEqual(['res-1'])
  expect(result.factCoverage).toBe(1)
  expect(result.unresolvedMarkers).toBe(1)
  expect(result.declineCorrect).toBe(true)
  expect(summariseEvaluation([result])).toMatchObject({
    errors: 0,
    groundedness: null,
    answerRelevance: 4,
  })
  expect(summariseEvaluation([]).retrievalHitRate).toBeNull()
  const decline = scoreEvaluation(
    { query: 'Unanswerable?', shouldDecline: true, expectedSources: [], expectedFacts: [] },
    [],
    { ...answer, refused: true, citations: [] },
  )
  expect(decline.retrievalHit).toBeNull()
  expect(decline.citationPrecision).toBeNull()
  expect(decline.declineCorrect).toBe(true)
  expect(
    EvaluationInputSchema.safeParse({
      name: 'Invalid',
      questions: [{ query: 'No expected sources' }],
    }).success,
  ).toBe(false)
})

Deno.test('evaluation capture rejects broken streams, retains final text and does not invent REMi', async () => {
  const response = (events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
  const answer = await captureEvaluationAnswer(response([
    { type: 'delta', text: 'Provisional' },
    { type: 'verified', resourceId: 'source-1' },
    { type: 'quality', answerRelevance: 4.5, groundedness: 99, contextRelevance: null },
    { type: 'done', text: 'Final answer', refused: false },
  ]))
  expect(answer.text).toBe('Final answer')
  expect(answer.verifiedIds).toEqual(['source-1'])
  expect(answer.groundedness).toBeNull()
  expect(answer.answerRelevance).toBe(4.5)
  await expect(captureEvaluationAnswer(response([{ type: 'delta', text: 'Partial' }]))).rejects
    .toThrow('did not complete')
  await expect(captureEvaluationAnswer(response([{ type: 'error' }, { type: 'done' }]))).rejects
    .toThrow('did not complete')
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`evaluation ${adapter}: permissions, confirmation, actual paths, quota, CSV and erasure`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const admin = f.sessionFor('portal-admin')
      const root = '/api/admin/t/a/evaluations'
      for (const role of ['viewer', 'analyst', 'curator'] as const) {
        expect((await f.requestAs(f.sessionFor(role), root)).status).toBe(403)
      }
      expect((await f.requestAs(f.sessionFor('portal-admin', 'b'), root)).status).toBe(403)
      expect((await f.requestAs(null, root)).status).toBe(401)
      f.assertNoProtectedDispatch()
      const saved = await f.requestAs(admin, `${root}/checks`, json('PUT', input))
      expect(saved.status).toBe(200)
      const set = await saved.json()
      expect(f.stores.evaluations.get('b', 'checks')).toBeNull()
      const confirmation = { confirmedAsks: 1, updatedAt: set.updatedAt }
      expect((await f.requestAs(admin, `${root}/checks/runs`, json('POST', {}))).status).toBe(409)
      expect(
        (await f.requestAs(
          admin,
          `${root}/checks/runs`,
          json('POST', { ...confirmation, updatedAt: 'old' }),
        )).status,
      ).toBe(409)
      f.assertNoProtectedDispatch()
      f.stores.lifecycle.set('a', { status: 'active', limits: { asksPerDay: 1 } }, f.now())
      const response = await f.requestAs(admin, `${root}/checks/runs`, json('POST', confirmation))
      const run = await response.json() as EvaluationRun
      expect(response.status, JSON.stringify(run)).toBe(200)
      expect(run.status, JSON.stringify(run)).toBe('completed')
      expect(run.summary.retrievalHitRate).toBe(1)
      expect(run.summary.citationPrecision).toBe(1)
      expect(run.summary.groundedness).toBe(4.5)
      expect(f.providerCalls.some((c) => c.method === 'search')).toBe(true)
      expect(f.providerCalls.some((c) => c.method === 'ask')).toBe(true)
      expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
      const history = await (await f.requestAs(admin, `${root}/checks/runs`)).json()
      expect(history[0].id).toBe(run.id)
      const csv = await f.requestAs(admin, `${root}/checks/runs/${run.id}/csv`)
      expect(csv.headers.get('content-type')).toContain('text/csv')
      expect(await csv.text()).toContain('citationPrecision')
      expect((await f.requestAs(admin, `${root}/checks/runs`, json('POST', confirmation))).status)
        .toBe(429)
      expect(f.stores.evaluations.runs('a', 'checks')).toHaveLength(1)
      const events = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } })
      expect(events.some((e) => JSON.parse(e.detail_json).mutation === 'evaluations.finish')).toBe(
        true,
      )
      expect(JSON.stringify(events)).not.toContain(input.questions[0]!.query)
      f.stores.lifecycle.set('a', { status: 'read_only', limits: null }, f.now())
      expect((await f.requestAs(admin, `${root}/checks/runs`, json('POST', confirmation))).status)
        .toBe(423)
      expect((await f.requestAs(admin, `${root}/checks`, json('PUT', input))).status).toBe(423)
      expect((await f.requestAs(admin, root)).status).toBe(200)
      f.stores.lifecycle.set('a', { status: 'suspended', limits: null }, f.now())
      expect((await f.requestAs(admin, root)).status).toBe(423)
      expect(f.stores.evaluations.erase('a')).toBe(2)
      expect(f.stores.evaluations.erase('a')).toBe(0)
      // An in-flight completion cannot recreate an erased run.
      f.stores.evaluations.finish('a', run)
      expect(f.stores.evaluations.run('a', run.id)).toBeNull()
    } finally {
      f.close()
    }
  })
  Deno.test(`evaluation ${adapter}: audit failure rolls back definition and run writes`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const admin = f.sessionFor('portal-admin')
      f.database.exec(`CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON audit_events
        WHEN NEW.action = 'local.mutation' AND NEW.target_kind = 'evaluations'
        BEGIN SELECT RAISE(ABORT, 'fixture mutation audit failure'); END`)
      expect(
        (await f.requestAs(admin, '/api/admin/t/a/evaluations/checks', json('PUT', input))).status,
      ).toBe(500)
      f.recoverAudit()
      expect(f.stores.evaluations.get('a', 'checks')).toBeNull()
    } finally {
      f.close()
    }
  })
}

Deno.test('evaluation storage bounds history, refuses overlap and preserves definition snapshots', () => {
  const f = createEnforcementFixture()
  try {
    const store = f.stores.evaluations
    const definition = store.put('a', 'checks', input, f.now())
    const run: EvaluationRun = {
      id: 'first',
      slug: 'a',
      setId: definition.id,
      definition,
      startedAt: definition.updatedAt,
      completedAt: null,
      status: 'running',
      results: [],
      summary: summariseEvaluation([]),
    }
    expect(store.start('a', run)).toBe(true)
    expect(store.start('a', { ...run, id: 'second' })).toBe(false)
    store.put('a', 'checks', { ...input, name: 'Updated definition' }, f.now() + 1)
    expect(store.run('a', 'first')?.definition.name).toBe('Fisheries checks')
    for (let i = 0; i < 105; i++) {
      store.finish('a', { ...run, id: i ? String(i - 1) : 'first', status: 'completed' })
      store.start('a', { ...run, id: String(i), startedAt: new Date(f.now() + i).toISOString() })
    }
    expect(store.runs('a', 'checks')).toHaveLength(100)
    expect(() => store.start('b', run)).toThrow('Portal mismatch')
    const csv = evaluationCsv({
      ...run,
      results: [
        scoreEvaluation({ ...input.questions[0]!, query: '=SUM(1,2)\nquoted "value"' }, [], {
          text: '',
          refused: true,
          citations: [],
          verifiedIds: [],
          answerRelevance: null,
          groundedness: null,
          contextRelevance: null,
        }),
      ],
    })
    expect(csv).toContain("'=SUM(1,2)")
    expect(csv).toContain('""value""')
  } finally {
    f.close()
  }
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`evaluation ${adapter}: schedules require local grants, consume asks and pause after edits or revocation`, async () => {
    const { runScheduledEvaluations } = await import('./evaluation-schedule.ts')
    const f = createEnforcementFixture({}, adapter)
    try {
      const admin = f.sessionFor('portal-admin')
      const root = '/api/admin/t/a/evaluations/checks'
      const definition = await (await f.requestAs(admin, root, json('PUT', input))).json()
      const schedule = { everyDays: 1, confirmedAsks: 1, updatedAt: definition.updatedAt }
      expect((await f.requestAs(admin, `${root}/schedule`, json('PUT', schedule))).status).toBe(200)
      expect(f.stores.evaluations.schedules('a')).toHaveLength(1)
      const listing = await (await f.requestAs(admin, '/api/admin/t/a/evaluations')).json()
      expect(listing.schedules[0].owner).toBeUndefined()
      f.advance(86_400_000)
      // Schedules do not depend on the original sign-in surviving until the next day.
      await Promise.all([runScheduledEvaluations(f.app), runScheduledEvaluations(f.app)])
      expect(f.stores.evaluations.runs('a', 'checks')).toHaveLength(1)
      expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
      const events = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } })
      expect(
        events.some((e) => e.action === 'maintenance.evaluation.run' && e.outcome === 'success'),
      ).toBe(true)
      f.advance(86_400_000)
      f.stores.evaluations.put('a', 'checks', { ...input, name: 'Edited questions' }, f.now())
      await runScheduledEvaluations(f.app)
      expect(f.stores.evaluations.runs('a', 'checks')).toHaveLength(1)
      const edited = f.stores.evaluations.get('a', 'checks')!
      f.stores.evaluations.schedule('a', 'checks', {
        slug: 'a',
        setId: 'checks',
        everyDays: 1,
        nextAt: f.now(),
        confirmedAsks: 1,
        updatedAt: edited.updatedAt,
        owner: { tenantId: admin.tenantId, oid: admin.oid },
      })
      f.stores.lifecycle.set('a', { status: 'suspended', limits: null }, f.now())
      await runScheduledEvaluations(f.app)
      expect(f.stores.evaluations.runs('a', 'checks')).toHaveLength(1)
      f.stores.lifecycle.set('a', { status: 'active', limits: null }, f.now())
      const service = f.rbac.assignmentService(f.tenantId, f.audience)
      const assignment = service.list().find((r) => r.subjectId === admin.oid)!
      service.remove(assignment.id, { requestId: 'revoke', actor: { kind: 'system' } })
      await runScheduledEvaluations(f.app)
      expect(f.stores.evaluations.runs('a', 'checks')).toHaveLength(1)
    } finally {
      f.close()
    }
  })
}

Deno.test('evaluation preserves retrieval when ask fails and answer quality when search fails', async () => {
  const { evaluateQuestion } = await import('./evaluation-runner.ts')
  const success = new Response(
    'data: {"type":"quality","groundedness":4,"answerRelevance":3,"contextRelevance":2}\n\ndata: {"type":"done","text":"Evidence","refused":false}\n\n',
  )
  const retrievalOnly = await evaluateQuestion(input.questions[0]!, 1, (path) =>
    Promise.resolve(
      path.startsWith('/search')
        ? Response.json({ resources: [{ id: 'res-1' }] })
        : new Response('', { status: 503 }),
    ), new AbortController().signal)
  expect(retrievalOnly.ok).toBe(false)
  expect(retrievalOnly.retrievalHit).toBe(true)
  expect(retrievalOnly.askOk).toBe(false)
  const answerOnly = await evaluateQuestion(input.questions[0]!, 1, (path) =>
    Promise.resolve(
      path.startsWith('/search') ? new Response('', { status: 503 }) : success,
    ), new AbortController().signal)
  expect(answerOnly.ok).toBe(false)
  expect(answerOnly.retrievalHit).toBeNull()
  expect(answerOnly.groundedness).toBe(4)
  expect(answerOnly.askOk).toBe(true)
})

Deno.test('reseeded managed demo portals discard retained evaluation definitions, runs and delegations', () => {
  const f = createEnforcementFixture()
  try {
    const config = f.stores.tenants.get('a')!
    const definition = f.stores.evaluations.put('a', 'checks', input, f.now())
    f.stores.evaluations.start('a', {
      id: 'old-run',
      slug: 'a',
      setId: 'checks',
      definition,
      startedAt: definition.updatedAt,
      completedAt: null,
      status: 'running',
      results: [],
      summary: summariseEvaluation([]),
    })
    f.stores.evaluations.schedule('a', 'checks', {
      slug: 'a',
      setId: 'checks',
      everyDays: 1,
      nextAt: f.now(),
      confirmedAsks: 1,
      updatedAt: definition.updatedAt,
      owner: { tenantId: 'tenant-1', oid: 'portal-admin-a' },
    })
    f.stores.tenants.remove('a')
    f.stores.tenants.seed(config)
    expect(f.stores.evaluations.list('a')).toEqual([])
    expect(f.stores.evaluations.run('a', 'old-run')).toBeNull()
    expect(f.stores.evaluations.schedules('a')).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('evaluation stops paid asks when its initiating administrator is downgraded during retrieval', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin')
    const definition = f.stores.evaluations.put('a', 'checks', input, f.now())
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const assignment = service.list().find((r) => r.subjectId === admin.oid)!
    const search = f.provider.search.bind(f.provider)
    f.provider.search = (tenant, query) => {
      service.change(assignment.id, { role: 'viewer' }, {
        requestId: 'downgrade',
        actor: { kind: 'system' },
      })
      return search(tenant, query)
    }
    const response = await f.requestAs(
      admin,
      '/api/admin/t/a/evaluations/checks/runs',
      json('POST', {
        confirmedAsks: 1,
        updatedAt: definition.updatedAt,
      }),
    )
    expect(response.status).toBe(200)
    const run = await response.json() as EvaluationRun
    expect(run.status).toBe('failed')
    expect(run.results[0]?.retrievalHit).toBe(true)
    expect(run.results[0]?.askOk).toBe(false)
    expect(f.providerCalls.some((call) => call.method === 'ask')).toBe(false)
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
  } finally {
    f.close()
  }
})
