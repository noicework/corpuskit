import { EvaluationInputSchema, type EvaluationRun } from '@research-portal/core'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { EvaluationStore } from './evaluation-store.ts'
import type { TenantStoreApi } from './tenants.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import { declaredRoute } from './permissions.ts'
import { evaluationCsv, summariseEvaluation } from './evaluation-scoring.ts'
import { evaluateQuestion, evaluationRequest } from './evaluation-runner.ts'

export interface EvaluationServices {
  store?: EvaluationStore
  tenants: TenantStoreApi
  lifecycle: PortalLifecycleStore
  now?: () => number
  request(c: Context, slug: string, path: string, init?: RequestInit): Promise<Response>
  scheduleOwner(c: Context, slug: string): Promise<{ tenantId: string; oid: string } | null>
  notFound(c: Context): Response
}

export function registerEvaluationRoutes(app: Hono, services: EvaluationServices): void {
  const { store, tenants, lifecycle } = services
  const root = '/api/admin/t/:slug/evaluations'
  app.get(declaredRoute('GET', root), (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    const config = tenants.get(slug)
    if (!config) return services.notFound(c)
    const usage = lifecycle.usage(slug, config.timezone ?? 'UTC', services.now?.())
    c.header('Cache-Control', 'private, no-store')
    return c.json({
      sets: store.list(slug),
      schedules: store.schedules(slug).map(({ owner: _owner, ...schedule }) => schedule),
      asksToday: usage.asksToday,
      asksPerDay: lifecycle.get(slug).limits?.asksPerDay ?? null,
    })
  })
  app.put(declaredRoute('PUT', `${root}/:id`), async (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    if (!tenants.get(slug)) return services.notFound(c)
    const parsed = EvaluationInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || !/^[A-Za-z0-9_-]{1,100}$/.test(c.req.param('id'))) {
      return c.json({
        error: 'invalid_evaluation',
        message: parsed.success ? 'Invalid evaluation id.' : parsed.error.issues[0]?.message,
      }, 400)
    }
    return c.json(store.put(slug, c.req.param('id'), parsed.data, services.now?.()))
  })
  app.put(declaredRoute('PUT', `${root}/:id/schedule`), async (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    const set = store.get(slug, c.req.param('id'))
    if (!set) return services.notFound(c)
    const parsed = z.object({
      everyDays: z.union([z.literal(1), z.literal(7), z.null()]),
      confirmedAsks: z.number().int(),
      updatedAt: z.string(),
    }).strict().safeParse(await c.req.json().catch(() => null))
    if (
      !parsed.success || parsed.data.confirmedAsks !== set.questions.length ||
      parsed.data.updatedAt !== set.updatedAt
    ) {
      return c.json({ error: 'confirmation_required' }, 409)
    }
    if (parsed.data.everyDays === null) {
      store.schedule(slug, set.id, null)
      return c.json({ ok: true })
    }
    const owner = await services.scheduleOwner(c, slug)
    if (!owner) {
      return c.json({
        error: 'local_admin_assignment_required',
        message:
          'Scheduling requires a signed-in administrator with a current local role assignment.',
      }, 403)
    }
    store.schedule(slug, set.id, {
      slug,
      setId: set.id,
      owner,
      everyDays: parsed.data.everyDays,
      confirmedAsks: set.questions.length,
      updatedAt: set.updatedAt,
      nextAt: (services.now?.() ?? Date.now()) + parsed.data.everyDays * 86_400_000,
    })
    return c.json({ ok: true })
  })
  app.delete(declaredRoute('DELETE', `${root}/:id`), (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    if (!store.get(slug, c.req.param('id'))) return services.notFound(c)
    store.remove(slug, c.req.param('id'))
    return c.json({ ok: true })
  })
  app.get(declaredRoute('GET', `${root}/:id/runs`), (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    if (!store.get(slug, c.req.param('id'))) return services.notFound(c)
    c.header('Cache-Control', 'private, no-store')
    return c.json(store.runs(slug, c.req.param('id')))
  })
  app.get(declaredRoute('GET', `${root}/:id/runs/:runId/csv`), (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const run = store.run(c.req.param('slug'), c.req.param('runId'))
    if (!run || run.setId !== c.req.param('id')) return services.notFound(c)
    c.header('Cache-Control', 'private, no-store')
    c.header('Content-Disposition', 'attachment; filename="evaluation.csv"')
    return c.body(evaluationCsv(run), 200, { 'Content-Type': 'text/csv; charset=utf-8' })
  })
  app.post(declaredRoute('POST', `${root}/:id/runs`), async (c) => {
    if (!store) return c.json({ error: 'evaluations_unavailable' }, 503)
    const slug = c.req.param('slug')
    const config = tenants.get(slug)
    const set = store.get(slug, c.req.param('id'))
    if (!set || !config) return services.notFound(c)
    const confirmation = z.object({
      confirmedAsks: z.number().int(),
      updatedAt: z.string(),
    }).strict().safeParse(await c.req.json().catch(() => null))
    if (
      !confirmation.success || confirmation.data.confirmedAsks !== set.questions.length ||
      confirmation.data.updatedAt !== set.updatedAt
    ) {
      return c.json({
        error: 'confirmation_required',
        asks: set.questions.length,
        updatedAt: set.updatedAt,
      }, 409)
    }
    const at = services.now?.() ?? Date.now()
    const usage = lifecycle.usage(slug, config.timezone ?? 'UTC', at)
    const cap = lifecycle.get(slug).limits?.asksPerDay
    if (cap !== undefined && cap - usage.asksToday < set.questions.length) {
      return c.json({
        error: 'ask_quota_exceeded',
        asks: set.questions.length,
        asksRemaining: Math.max(0, cap - usage.asksToday),
      }, 429)
    }
    const run: EvaluationRun = {
      id: crypto.randomUUID(),
      slug,
      setId: set.id,
      definition: set,
      startedAt: new Date(at).toISOString(),
      completedAt: null,
      status: 'running',
      results: [],
      summary: summariseEvaluation([]),
    }
    if (!store.start(slug, run)) return c.json({ error: 'evaluation_already_running' }, 409)
    const deadline = AbortSignal.timeout(100_000)
    for (const question of set.questions) {
      const signal = AbortSignal.any([c.req.raw.signal, deadline, AbortSignal.timeout(60_000)])
      run.results.push(
        await evaluateQuestion(question, set.topK, async (path, init) => {
          if (lifecycle.get(slug).status !== 'active' || !store.get(slug, set.id)) {
            throw new Error('The portal or evaluation set is no longer active')
          }
          return await evaluationRequest(() => services.request(c, slug, path, init), signal)
        }, signal),
      )
    }
    run.summary = summariseEvaluation(run.results)
    run.status = run.summary.errors ? 'failed' : 'completed'
    run.completedAt = new Date(services.now?.() ?? Date.now()).toISOString()
    store.finish(slug, run)
    return c.json(run)
  })
}
