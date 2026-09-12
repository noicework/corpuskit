import { PORTAL_ROLES, type Scope } from '@research-portal/core'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { AssignmentContext, AssignmentResult, AssignmentService } from './assignments.ts'
import { AuthorisationError } from './authorisation.ts'
import { declaredRoute } from './permissions.ts'
import type { RoleAssignment } from './rbac-state.ts'

export interface AccessRouteServices {
  authorise(c: Context): Promise<unknown>
  context(c: Context): AssignmentContext
  assignments(): AssignmentService
  groupCapability(): 'enabled' | 'disabled'
  notFound(c: Context): Response
}

/** Registration consumes the catalogue; permission and actor selection stay in the app guard. */
export function registerAccessRoutes(app: Hono, services: AccessRouteServices): void {
  for (const family of ['members', 'groups'] as const) {
    const base = `/api/admin/t/:slug/${family}`
    const role = z.enum(PORTAL_ROLES)
    const createSchema = family === 'groups'
      ? z.object({ subjectId: z.string(), role }).strict().transform((data) => ({
        ...data,
        subjectKind: 'group' as const,
      }))
      : z.object({
        subjectKind: z.enum(['active-oid', 'pending-email']),
        subjectId: z.string(),
        role,
      }).strict()
    const patchSchema = z.object({ role }).strict()
    const scopeFor = (c: Context): Scope => ({ kind: 'portal', slug: c.req.param('slug')! })
    const belongs = (row: RoleAssignment, scope: Scope) =>
      row.scope.kind === scope.kind &&
      (scope.kind === 'platform' ||
        (row.scope.kind === 'portal' && row.scope.slug === scope.slug)) &&
      (family === 'groups' ? row.subjectKind === 'group' : row.subjectKind !== 'group')
    const result = (c: Context, outcome: AssignmentResult, created = false) => {
      if (outcome.ok) return c.json(outcome.value, created ? 201 : 200)
      return c.json({ error: outcome.code }, outcome.code === 'invalid_input' ? 400 : 409)
    }
    app.get(declaredRoute('GET', base), async (c) => {
      await services.authorise(c)
      c.header('Cache-Control', 'private, no-store')
      const items = services.assignments().list().filter((row) => belongs(row, scopeFor(c)))
      return c.json({
        items,
        ...(family === 'groups' ? { capability: services.groupCapability() } : {}),
      })
    })
    app.post(declaredRoute('POST', base), async (c) => {
      await services.authorise(c)
      const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
      if (family === 'groups' && services.groupCapability() !== 'enabled') {
        throw new AuthorisationError(403)
      }
      const subjectKind = parsed.data.subjectKind
      const input = { ...parsed.data, subjectKind, scope: scopeFor(c) } as const
      const service = services.assignments()
      const outcome = service.create(input, services.context(c))
      if (!outcome.ok && outcome.code === 'invalid_input') {
        const subjectId = subjectKind === 'pending-email'
          ? input.subjectId.trim().toLowerCase()
          : input.subjectId
        if (
          service.list().some((row) =>
            belongs(row, input.scope) && row.subjectKind === subjectKind &&
            row.subjectId === subjectId
          )
        ) {
          return c.json({ error: 'assignment_conflict' }, 409)
        }
      }
      return result(c, outcome, true)
    })
    app.patch(declaredRoute('PATCH', `${base}/:id`), async (c) => {
      await services.authorise(c)
      const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
      const service = services.assignments()
      const row = service.list().find((row) =>
        row.id === c.req.param('id') && belongs(row, scopeFor(c))
      )
      if (!row) return services.notFound(c)
      if (family === 'groups' && services.groupCapability() !== 'enabled') {
        throw new AuthorisationError(403)
      }
      return result(c, service.change(row.id, parsed.data, services.context(c)))
    })
    app.delete(declaredRoute('DELETE', `${base}/:id`), async (c) => {
      await services.authorise(c)
      const body = await c.req.text()
      if (body && !z.object({}).strict().safeParse(await c.req.json().catch(() => null)).success) {
        return c.json({ error: 'invalid_input' }, 400)
      }
      const service = services.assignments()
      const row = service.list().find((row) =>
        row.id === c.req.param('id') && belongs(row, scopeFor(c))
      )
      if (!row) return services.notFound(c)
      return result(c, service.remove(row.id, services.context(c)))
    })
  }
}
