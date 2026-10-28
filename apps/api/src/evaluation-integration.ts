import type { Context, Hono } from 'hono'
import type { BuildAppOptions, PortalRequestContext } from './app.ts'
import { authoriseDeclared } from './app.ts'
import { resolveEffectiveRoles } from './assignments.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import type { TenantStoreApi } from './tenants.ts'
import { registerEvaluationRoutes } from './evaluation-routes.ts'
import {
  evaluateDueSchedules,
  registerScheduledEvaluations,
  scheduledAuthority,
} from './evaluation-schedule.ts'

/** Private in-process dispatch: the existing portal handlers own routing, trust, caps and audit. */
export function registerPortalEvaluations(app: Hono, opts: BuildAppOptions, services: {
  lifecycle: PortalLifecycleStore
  tenants: TenantStoreApi
  requestContext(request: Request): PortalRequestContext
  requestContexts: WeakMap<Request, PortalRequestContext>
  notFound(c: Context): Response
}): void {
  const configuredTenantId = opts.configuredTenantId ?? ''
  const { lifecycle, tenants, requestContext, requestContexts } = services
  const schedules = {
    localMutations: opts.localMutations,
    store: opts.evaluations,
    rbac: opts.rbac,
    lifecycle,
    tenants,
    configuredTenantId,
    audience: opts.audience ?? 'corpuskit',
    externalLoginEnabled: opts.externalLoginEnabled,
    now: opts.now,
  }
  registerScheduledEvaluations(
    app,
    () =>
      evaluateDueSchedules({
        ...schedules,
        dispatch: async (context, path, init) => {
          const request = new Request(new URL(path, 'http://internal.invalid'), init)
          requestContexts.set(request, context)
          return await app.fetch(request)
        },
      }),
  )
  registerEvaluationRoutes(app, {
    store: opts.evaluations,
    tenants,
    lifecycle,
    now: opts.now,
    notFound: services.notFound,
    scheduleOwner: async (c, slug) => {
      const selected = await authoriseDeclared(c)
      if (selected?.kind !== 'session') return null
      const owner = { tenantId: selected.session.tenantId, oid: selected.session.oid }
      return await scheduledAuthority(schedules, owner, slug) ? owner : null
    },
    request: async (c, slug, path, init) => {
      const headers = new Headers(init?.headers)
      const passcode = c.req.header('x-admin-passcode')
      if (passcode) headers.set('x-admin-passcode', passcode)
      const request = new Request(new URL(`/api/t/${encodeURIComponent(slug)}${path}`, c.req.url), {
        ...init,
        headers,
      })
      const original = requestContext(c.req.raw)
      const resolution = original.session && opts.rbac
        ? await resolveEffectiveRoles(
          original.session,
          {
            rbac: opts.rbac,
            tenants,
            audience: opts.audience ?? 'corpuskit',
            externalLoginEnabled: opts.externalLoginEnabled,
          },
          configuredTenantId,
          opts.now?.(),
        )
        : {}
      requestContexts.set(request, {
        ...original,
        ...resolution,
        requestId: crypto.randomUUID(),
        actor: undefined,
        denialAudited: false,
      })
      return await app.fetch(request)
    },
  })
}
