import { expect } from '@std/expect'
import { join } from 'node:path'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { DurableFeedbackStore } from '../../cloudflare/src/state.ts'
import { buildApp as buildRawApp } from './app.ts'
import { BindingStore } from './bindings.ts'
import { EnrichmentStore } from './enrichments.ts'
import { runSystemMaintenance } from './scheduler.ts'
import { createEnforcementFixture, matrixManagement } from './enforcement-fixture.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { fixtureSession } from './rbac-integration-fixture.ts'
import { openLocalRbac } from './rbac-local.ts'
import {
  ANSWER_FEEDBACK_DAYS,
  ANSWER_FEEDBACK_KEEP,
  ANSWER_FEEDBACK_TEXT_MAX,
  type AnswerFeedback,
  answerFeedback,
  FeedbackStore,
  type FeedbackStoreApi,
  feedbackSummary,
  FLAGGED_ANSWERS_SHOWN,
  InsightsStore,
  type InsightsStoreApi,
  parseAnswerFeedback,
  RoutingLog,
  SourceStore,
} from './stores.ts'

const LEARNING = 'learning-first-answer'
const DAY = 86_400_000

/** The double, with the platform's learning id on each answer as the real provider sends it. */
class LearningProvider extends DoubleProvider {
  override async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    yield { type: 'learning', id: LEARNING }
    yield* super.ask(tenant, query)
  }
}

/** The management surface, recording what reaches the platform's feedback endpoint. */
function platform() {
  const forwarded: unknown[] = []
  let failing = false
  const management = new Proxy(matrixManagement([]), {
    get: (target, name) =>
      name === 'feedback'
        ? (_config: unknown, body: unknown) => {
          forwarded.push(body)
          return failing ? Promise.reject(new Error('platform unavailable')) : Promise.resolve()
        }
        : Reflect.get(target, name),
  }) as AragProvider
  return { management, forwarded, fail: (on: boolean) => failing = on }
}

type Role = 'viewer' | 'curator' | 'unassigned'

interface Stack {
  name: string
  slug: string
  as(role: Role, path: string, init?: RequestInit): Promise<Response>
  feedback: FeedbackStoreApi
  insights: InsightsStoreApi
  close(): void
}

/** The Durable Object stack, through the same middleware the Worker runs. */
function durableStack(management: AragProvider): Stack {
  const f = createEnforcementFixture({ management, provider: new LearningProvider() })
  return {
    name: 'Durable Object',
    slug: 'a',
    as: (role, path, init) =>
      f.requestAs(role === 'unassigned' ? f.unassigned : f.sessionFor(role), path, init),
    feedback: f.stores.feedback,
    insights: f.stores.insights,
    close: () => f.close(),
  }
}

/** The local server's stack, built the way `server.ts` builds it, in a scratch directory. */
function localStack(management: AragProvider): Stack {
  const directory = Deno.makeTempDirSync({ prefix: 'answer-feedback-' })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: join(directory, 'tenants.json'),
    ENTRA_TENANT_ID: 'tenant-1',
    WORKER_NAME: 'corpuskit',
  }
  const { database, rbac } = openLocalRbac(env)
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  tenants.patch('marine', { accessMode: 'restricted' })
  const ingress = new LocalIngress({ rbac, tenants, env })
  const feedback = new FeedbackStore(directory)
  const insights = new InsightsStore(directory)
  const app = buildRawApp({
    ...owned,
    rbac,
    tenants,
    provider: new LearningProvider(),
    management,
    bindings: new BindingStore({ BINDINGS_PATH: join(directory, 'bindings.json') }),
    feedback,
    insights,
    routing: new RoutingLog(directory),
    sources: new SourceStore(directory),
    audit: rbac.audit,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    rateLimitAskPerMin: 0,
    rateLimitEstatePerMin: 0,
    rateLimitMcpAuthPerMin: 0,
  })
  const service = rbac.assignmentService('tenant-1', 'corpuskit')
  for (const role of ['viewer', 'curator'] as const) {
    const created = service.create({
      subjectKind: 'active-oid',
      subjectId: `local-${role}`,
      scope: { kind: 'portal', slug: 'marine' },
      role,
    }, { requestId: 'fixture', actor: { kind: 'system' } })
    if (!created.ok) throw new Error('Fixture assignment failed')
  }
  return {
    name: 'local server',
    slug: 'marine',
    as: (role, path, init) =>
      ingress.handle(
        new Request(`http://localhost${path}`, init),
        (request) => app.fetch(request),
        undefined,
        fixtureSession({ oid: `local-${role}` }),
      ),
    feedback,
    insights,
    close: () => {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

for (
  const [adapter, build] of [['Durable Object', durableStack], [
    'local server',
    localStack,
  ]] as const
) {
  Deno.test(`answer feedback is kept for curators and forwarded unchanged (${adapter})`, async () => {
    const { management, forwarded, fail } = platform()
    const s = build(management)
    try {
      // The ask log keeps the answer's learning id beside its question.
      const asked = await s.as('viewer', `/api/t/${s.slug}/ask`, post({ query: 'Abalone decline' }))
      expect(asked.status).toBe(200)
      expect(await asked.text()).toContain(LEARNING)
      expect(s.insights.questions(s.slug, [LEARNING])[LEARNING]?.question).toBe('Abalone decline')

      // A thumbs-down, then the reader's comment on the same answer: one record, the latest.
      const comment = `The year is wrong. ${'x'.repeat(1_500)}`
      for (
        const body of [{ learningId: LEARNING, good: false }, {
          learningId: LEARNING,
          good: false,
          text: comment,
        }]
      ) {
        const response = await s.as('viewer', `/api/t/${s.slug}/feedback`, post(body))
        expect(response.status).toBe(200)
      }
      // The platform receives exactly what the reader sent, the whole comment included.
      expect(forwarded).toEqual([
        { learningId: LEARNING, good: false },
        { learningId: LEARNING, good: false, text: comment },
      ])
      const kept = s.feedback.ratings(s.slug)
      expect(kept).toHaveLength(1)
      expect(kept[0]!.good).toBe(false)
      // Ratings are read without their comments; a comment is read only for an answer shown.
      expect(kept[0]).not.toHaveProperty('text')
      const said = s.feedback.comments(s.slug, [LEARNING])[LEARNING]!
      expect(said).toHaveLength(ANSWER_FEEDBACK_TEXT_MAX)
      expect(said.startsWith('The year is wrong.')).toBe(true)

      // Curators see it in Insights, joined to the question; the ask log's ids stay private.
      const insights = await s.as('curator', `/api/admin/t/${s.slug}/insights`)
      expect(insights.status).toBe(200)
      const summary = await insights.json()
      expect(summary.feedback.helpful).toBe(0)
      expect(summary.feedback.unhelpful).toBe(1)
      expect(summary.feedback.flagged).toEqual([{
        question: 'Abalone decline',
        askedAt: expect.any(String),
        ratedAt: kept[0]!.ts,
        comment: said,
      }])
      expect(JSON.stringify(summary.recent)).not.toContain(LEARNING)
      // Only the roles that can see Insights see readers' comments.
      expect((await s.as('viewer', `/api/admin/t/${s.slug}/insights`)).status).toBe(403)

      // A failed forward keeps the local record; a failed local save still forwards.
      fail(true)
      const unforwarded = await s.as(
        'viewer',
        `/api/t/${s.slug}/feedback`,
        post({ learningId: 'learning-second-answer', good: true }),
      )
      expect(unforwarded.status).toBe(502)
      expect(s.feedback.ratings(s.slug).map((r) => r.learningId)).toContain(
        'learning-second-answer',
      )
      fail(false)
      const store = s.feedback as { record: FeedbackStoreApi['record'] }
      store.record = () => {
        throw new Error('storage unavailable')
      }
      const unsaved = await s.as(
        'viewer',
        `/api/t/${s.slug}/feedback`,
        post({ learningId: 'learning-third-answer', good: false }),
      )
      expect(unsaved.status).toBe(200)
      expect(forwarded.at(-1)).toEqual({ learningId: 'learning-third-answer', good: false })
      delete (store as { record?: unknown }).record

      // Someone the portal does not admit records nothing and forwards nothing.
      const before = forwarded.length
      const refused = await s.as(
        'unassigned',
        `/api/t/${s.slug}/feedback`,
        post({ learningId: 'learning-outsider', good: false, text: 'spam' }),
      )
      expect(refused.status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect(s.feedback.ratings(s.slug).map((r) => r.learningId)).not.toContain(
        'learning-outsider',
      )
    } finally {
      s.close()
    }
  })
}

for (
  const [adapter, build] of [['Durable Object', durableStack], [
    'local server',
    localStack,
  ]] as const
) {
  Deno.test(`a learning id outside the platform's shape is refused, and nothing is kept (${adapter})`, async () => {
    const { management, forwarded } = platform()
    const s = build(management)
    try {
      for (
        const learningId of [
          'L'.repeat(129),
          'L'.repeat(1_000_000),
          'learning id with spaces',
          'learning<script>',
          'short',
        ]
      ) {
        const response = await s.as(
          'viewer',
          `/api/t/${s.slug}/feedback`,
          post({ learningId, good: false, text: 'Kept?' }),
        )
        expect([learningId.slice(0, 24), response.status]).toEqual([learningId.slice(0, 24), 400])
        await response.body?.cancel()
      }
      expect(forwarded).toEqual([])
      expect(s.feedback.ratings(s.slug)).toEqual([])
      // The longest id the platform could issue is still accepted.
      const longest = 'a'.repeat(128)
      const accepted = await s.as(
        'viewer',
        `/api/t/${s.slug}/feedback`,
        post({ learningId: longest, good: true }),
      )
      expect(accepted.status).toBe(200)
      expect(s.feedback.ratings(s.slug).map((r) => r.learningId)).toEqual([longest])
    } finally {
      s.close()
    }
  })
}

for (
  const [adapter, build] of [['Durable Object', durableStack], [
    'local server',
    localStack,
  ]] as const
) {
  Deno.test(`ratings are limited per address and portal (${adapter})`, async () => {
    const { management } = platform()
    const s = build(management)
    try {
      const rate = (address: string, index: number) =>
        s.as('viewer', `/api/t/${s.slug}/feedback`, {
          ...post({
            learningId: `learning-${address.replaceAll('.', '-')}-${
              String(index).padStart(4, '0')
            }`,
            good: true,
          }),
          headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
        })
      for (let index = 0; index < 30; index++) {
        const response = await rate('192.0.2.10', index)
        expect(response.status).toBe(200)
        await response.body?.cancel()
      }
      const limited = await rate('192.0.2.10', 30)
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      await limited.body?.cancel()
      // Another address is not held back by the first one's limit.
      const other = await rate('192.0.2.11', 0)
      expect(other.status).toBe(200)
      await other.body?.cancel()
    } finally {
      s.close()
    }
  })

  Deno.test(`made-up ratings neither push out a genuine one nor count (${adapter})`, async () => {
    const { management } = platform()
    const s = build(management)
    try {
      // Read to the end: the ask log records the answer once the stream completes.
      const asked = await s.as('viewer', `/api/t/${s.slug}/ask`, post({ query: 'Abalone decline' }))
      expect(await asked.text()).toContain(LEARNING)
      const genuine = await s.as(
        'viewer',
        `/api/t/${s.slug}/feedback`,
        post({ learningId: LEARNING, good: false, text: 'The cohort size is wrong' }),
      )
      expect(genuine.status).toBe(200)
      // More made-up ratings than the portal keeps, from enough addresses to pass the limit.
      for (let index = 0; index < ANSWER_FEEDBACK_KEEP + 10; index++) {
        const response = await s.as('viewer', `/api/t/${s.slug}/feedback`, {
          ...post({ learningId: `forged-${String(index).padStart(6, '0')}`, good: true }),
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${index % 250}`,
          },
        })
        expect(response.status).toBe(200)
        await response.body?.cancel()
      }
      const kept = s.feedback.ratings(s.slug)
      expect(kept).toHaveLength(ANSWER_FEEDBACK_KEEP)
      expect(kept.some((rating) => rating.learningId === LEARNING)).toBe(true)
      const summary = await (await s.as('curator', `/api/admin/t/${s.slug}/insights`)).json()
      // Only the answer this portal gave is counted and listed.
      expect(summary.feedback.helpful).toBe(0)
      expect(summary.feedback.unhelpful).toBe(1)
      expect(summary.feedback.flagged.map((item: { comment: string }) => item.comment)).toEqual([
        'The cohort size is wrong',
      ])
    } finally {
      s.close()
    }
  })
}

Deno.test('a stored rating outside the bounds is never read (local server)', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'answer-feedback-stored-' })
  try {
    const now = Date.now()
    Deno.mkdirSync(join(directory, 'feedback'))
    Deno.writeTextFileSync(
      join(directory, 'feedback', 'a.json'),
      JSON.stringify([
        { ts: new Date(now).toISOString(), learningId: 'L'.repeat(10_000), good: false },
        {
          ts: new Date(now).toISOString(),
          learningId: 'learning-ok',
          good: false,
          text: 'x'.repeat(5_000),
        },
        { ts: new Date(now).toISOString(), learningId: 'learning-fine', good: true },
      ]),
    )
    const store = new FeedbackStore(directory, () => now)
    expect(store.ratings('a').map((r) => r.learningId)).toEqual(['learning-fine'])
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a stored rating outside the bounds is never read (Durable Object)', () => {
  const f = createEnforcementFixture()
  try {
    const now = Date.now()
    f.database.exec(
      'INSERT INTO answer_feedback (tenant_slug, learning_id, good, comment, rated_at) VALUES (?, ?, ?, ?, ?)',
      'a',
      'L'.repeat(10_000),
      0,
      null,
      now,
    )
    const store = new DurableFeedbackStore(f.state, () => now)
    store.record('a', { ts: new Date(now).toISOString(), learningId: 'learning-fine', good: true })
    expect(store.ratings('a').map((r) => r.learningId)).toEqual(['learning-fine'])
    expect(store.comments('a', ['L'.repeat(10_000)])).toEqual({})
  } finally {
    f.close()
  }
})

Deno.test('a long comment is cut by character, never through one', () => {
  const shell = '\u{1F41A}'
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (
    const text of [
      shell.repeat(1_500),
      // Where cutting by UTF-16 unit would leave half of the shell behind.
      `${'a'.repeat(ANSWER_FEEDBACK_TEXT_MAX - 2)}${shell}${'b'.repeat(10)}`,
    ]
  ) {
    const kept = answerFeedback({ learningId: 'learning-emoji', good: false, text }, Date.now())
    const characters = Array.from(kept.text!)
    expect(characters).toHaveLength(ANSWER_FEEDBACK_TEXT_MAX)
    expect(characters.at(-1)).toBe('…')
    expect(characters.at(-2)).toBe(shell)
    expect(lone.test(kept.text!)).toBe(false)
    // What was kept is read back as it was written.
    expect(parseAnswerFeedback(kept)).toEqual(kept)
  }
})

Deno.test('Insights reads comments only for the unhelpful answers it lists', () => {
  const ratings = Array.from({ length: 120 }, (_, index) => ({
    learningId: `learning-${String(index).padStart(3, '0')}`,
    good: false,
    ts: new Date(Date.UTC(2026, 8, 12) - index * 1_000).toISOString(),
  }))
  const commentReads: string[][] = []
  const summary = feedbackSummary(
    ratings,
    (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { question: `Q ${id}`, ts: '2026-09-12T00:00:00Z' }]),
      ),
    (ids) => {
      commentReads.push(ids)
      return Object.fromEntries(ids.map((id) => [id, `Comment on ${id}`]))
    },
  )
  expect(summary.flagged).toHaveLength(FLAGGED_ANSWERS_SHOWN)
  expect(commentReads).toHaveLength(1)
  expect(commentReads[0]).toHaveLength(FLAGGED_ANSWERS_SHOWN)
  expect(summary.flagged[0]!.comment).toBe('Comment on learning-000')
})

Deno.test('the daily maintenance pass removes expired ratings (Durable Object)', async () => {
  const f = createEnforcementFixture()
  try {
    const now = Date.now()
    for (
      const [slug, learningId, days] of [
        ['a', 'learning-expired', ANSWER_FEEDBACK_DAYS + 1],
        ['a', 'learning-recent', 1],
        ['b', 'learning-long-gone', ANSWER_FEEDBACK_DAYS + 400],
      ] as const
    ) {
      f.database.exec(
        'INSERT INTO answer_feedback (tenant_slug, learning_id, good, comment, rated_at) VALUES (?, ?, ?, ?, ?)',
        slug,
        learningId,
        0,
        'reader@example.org says the year is wrong',
        now - days * DAY,
      )
    }
    // The stores the Worker's maintenance pass is given.
    await runSystemMaintenance(matrixManagement([]), f.stores, undefined, [])
    expect(
      f.database.all('SELECT tenant_slug, learning_id FROM answer_feedback ORDER BY learning_id'),
    ).toEqual([{ tenant_slug: 'a', learning_id: 'learning-recent' }])
  } finally {
    f.close()
  }
})

Deno.test('the daily maintenance pass removes expired ratings (local server)', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'answer-feedback-purge-' })
  const env = { DATA_DIR: directory, TENANTS_PATH: join(directory, 'tenants.json') }
  const { database, rbac } = openLocalRbac(env)
  try {
    const owned = localOwnedStores(directory, database, rbac.audit, env)
    const now = Date.now()
    const rated = (learningId: string, days: number) => ({
      ts: new Date(now - days * DAY).toISOString(),
      learningId,
      good: false,
      text: 'reader@example.org says the year is wrong',
    })
    Deno.mkdirSync(join(directory, 'feedback'))
    Deno.writeTextFileSync(
      join(directory, 'feedback', 'a.json'),
      JSON.stringify([
        rated('learning-recent', 1),
        rated('learning-expired', ANSWER_FEEDBACK_DAYS + 1),
      ]),
    )
    Deno.writeTextFileSync(
      join(directory, 'feedback', 'b.json'),
      JSON.stringify([rated('learning-long-gone', ANSWER_FEEDBACK_DAYS + 400)]),
    )
    await runSystemMaintenance(
      matrixManagement([]),
      {
        rbac,
        tenants: owned.tenants!,
        sources: new SourceStore(directory),
        watches: owned.watches,
        enrichments: new EnrichmentStore(directory),
        feedback: new FeedbackStore(directory),
      },
      undefined,
      [],
    )
    expect(
      JSON.parse(Deno.readTextFileSync(join(directory, 'feedback', 'a.json')))
        .map((r: AnswerFeedback) => r.learningId),
    ).toEqual(['learning-recent'])
    // A portal with nothing left keeps no file.
    expect(() => Deno.statSync(join(directory, 'feedback', 'b.json'))).toThrow(Deno.errors.NotFound)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a privileged rating passes the Durable Object audit boundary as a declared mutation', async () => {
  const { management, forwarded } = platform()
  const f = createEnforcementFixture({ management })
  try {
    const app = buildRawApp({
      ...f.stores,
      provider: f.provider,
      management,
      now: f.now,
      configuredTenantId: f.tenantId,
      audience: f.audience,
      breakGlass: f.rbac.breakGlassService({
        environment: 'development',
        passcode: 'fixture-passcode',
      }),
      requestContext: () => ({
        requestId: crypto.randomUUID(),
        session: null,
        clientIp: '192.0.2.1',
        coarseAdminEligible: false,
      }),
      rateLimitAskPerMin: 0,
    })
    const response = await app.request('/api/t/a/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-passcode': 'fixture-passcode' },
      body: JSON.stringify({ learningId: LEARNING, good: false, text: 'Wrong cohort' }),
    })
    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(1)
    expect(f.stores.feedback.comments('a', [LEARNING])).toEqual({ [LEARNING]: 'Wrong cohort' })
    const mutation = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' }, limit: 1000 })
      .find((event) => event.action === 'local.mutation')
    expect(JSON.parse(mutation!.detail_json).mutation).toBe('feedback.record')
  } finally {
    f.close()
  }
})

/** A rating given `daysAgo` before the store's clock. */
function rating(learningId: string, now: number, daysAgo: number, good = false): AnswerFeedback {
  return { ts: new Date(now - daysAgo * DAY).toISOString(), learningId, good }
}

for (
  const [name, open] of [
    ['local server', (now: () => number) => {
      const directory = Deno.makeTempDirSync({ prefix: 'answer-feedback-bounds-' })
      return {
        store: new FeedbackStore(directory, now),
        close: () => Deno.removeSync(directory, { recursive: true }),
      }
    }],
    ['Durable Object', (now: () => number) => {
      const f = createEnforcementFixture()
      return { store: new DurableFeedbackStore(f.state, now), close: () => f.close() }
    }],
  ] as const
) {
  Deno.test(`answer feedback stays bounded and ages out (${name})`, () => {
    let clock = Date.UTC(2026, 8, 12)
    const { store, close } = open(() => clock)
    try {
      // One record per answer, the newest first.
      store.record('a', rating('learning-1', clock, 1))
      store.record('a', rating('learning-2', clock, 0))
      store.record('a', { ...rating('learning-1', clock + 1_000, 0), good: true })
      expect(store.ratings('a').map((r) => [r.learningId, r.good])).toEqual([
        ['learning-1', true],
        ['learning-2', false],
      ])
      // Other portals keep their own.
      store.record('b', rating('learning-b', clock, 0))
      expect(store.ratings('b').map((r) => r.learningId)).toEqual(['learning-b'])

      // Never more than the cap per portal: the oldest go first.
      for (let index = 0; index < ANSWER_FEEDBACK_KEEP + 5; index++) {
        store.record('a', rating(`learning-cap-${index}`, clock + index * 1_000, 0))
      }
      const capped = store.ratings('a')
      expect(capped).toHaveLength(ANSWER_FEEDBACK_KEEP)
      expect(capped[0]!.learningId).toBe(`learning-cap-${ANSWER_FEEDBACK_KEEP + 4}`)
      expect(capped.some((r) => r.learningId === 'learning-2')).toBe(false)

      // Past the cap, a rating of an answer the ask log holds outlasts newer made-up ones.
      const genuine = 'learning-cap-5'
      const matched = (ids: string[]) => new Set(ids.filter((id) => id === genuine))
      for (let index = 0; index < 10; index++) {
        store.record('a', rating(`learning-forged-${index}`, clock + 600_000 + index, 0), matched)
      }
      const afterFlood = store.ratings('a').map((r) => r.learningId)
      expect(afterFlood).toHaveLength(ANSWER_FEEDBACK_KEEP)
      expect(afterFlood).toContain(genuine)
      expect(afterFlood).toContain('learning-forged-9')

      // Past the window a rating is no longer listed, and the next write removes it.
      clock += (ANSWER_FEEDBACK_DAYS + 1) * DAY
      expect(store.ratings('a')).toEqual([])
      store.record('a', rating('learning-fresh', clock, 0))
      expect(store.ratings('a').map((r) => r.learningId)).toEqual(['learning-fresh'])
      expect(store.erase('a')).toBeGreaterThan(0)
      expect(store.ratings('a')).toEqual([])
      expect(store.ratings('b')).toEqual([])
    } finally {
      close()
    }
  })
}
