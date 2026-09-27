import { expect } from '@std/expect'
import { join } from 'node:path'
import type { AskEvent, TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { DurableFeedbackStore } from '../../cloudflare/src/state.ts'
import { buildApp as buildRawApp } from './app.ts'
import { BindingStore } from './bindings.ts'
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
  FeedbackStore,
  type FeedbackStoreApi,
  InsightsStore,
  type InsightsStoreApi,
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

for (const build of [durableStack, localStack]) {
  Deno.test(`answer feedback is kept for curators and forwarded unchanged (${build.name})`, async () => {
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
      const kept = s.feedback.list(s.slug)
      expect(kept).toHaveLength(1)
      expect(kept[0]!.good).toBe(false)
      expect(kept[0]!.text).toHaveLength(ANSWER_FEEDBACK_TEXT_MAX)
      expect(kept[0]!.text!.startsWith('The year is wrong.')).toBe(true)

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
        comment: kept[0]!.text,
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
      expect(s.feedback.list(s.slug).map((r) => r.learningId)).toContain('learning-second-answer')
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
      expect(s.feedback.list(s.slug).map((r) => r.learningId)).not.toContain('learning-outsider')
    } finally {
      s.close()
    }
  })
}

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
    expect(f.stores.feedback.list('a').map((r) => r.text)).toEqual(['Wrong cohort'])
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
      expect(store.list('a').map((r) => [r.learningId, r.good])).toEqual([
        ['learning-1', true],
        ['learning-2', false],
      ])
      // Other portals keep their own.
      store.record('b', rating('learning-b', clock, 0))
      expect(store.list('b').map((r) => r.learningId)).toEqual(['learning-b'])

      // Never more than the cap per portal: the oldest go first.
      for (let index = 0; index < ANSWER_FEEDBACK_KEEP + 5; index++) {
        store.record('a', rating(`learning-cap-${index}`, clock + index * 1_000, 0))
      }
      const capped = store.list('a')
      expect(capped).toHaveLength(ANSWER_FEEDBACK_KEEP)
      expect(capped[0]!.learningId).toBe(`learning-cap-${ANSWER_FEEDBACK_KEEP + 4}`)
      expect(capped.some((r) => r.learningId === 'learning-2')).toBe(false)

      // Past the window a rating is no longer listed, and the next write removes it.
      clock += (ANSWER_FEEDBACK_DAYS + 1) * DAY
      expect(store.list('a')).toEqual([])
      store.record('a', rating('learning-fresh', clock, 0))
      expect(store.list('a').map((r) => r.learningId)).toEqual(['learning-fresh'])
      expect(store.erase('a')).toBeGreaterThan(0)
      expect(store.list('a')).toEqual([])
      expect(store.list('b')).toEqual([])
    } finally {
      close()
    }
  })
}
