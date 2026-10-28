import { type PortalPrompts, PortalPromptsSchema } from '@research-portal/core'
import type { Context, Hono } from 'hono'
import { declaredRoute, declaredSubAction } from './permissions.ts'
import type { LocalMutationScope } from './audit-execution.ts'
import { type AuditActor, AuditWriteError } from './audit.ts'
import type { TenantStoreApi } from './tenants.ts'

export function registerPromptRoutes(app: Hono, services: {
  tenants: TenantStoreApi
  tenant(slug: string): unknown
  localMutations?: LocalMutationScope
  context(c: Context): { requestId: string; actor: AuditActor }
  signal(c: Context): AbortSignal
}): void {
  const path = '/api/admin/t/:slug/prompts'
  app.get(declaredRoute('GET', path), (c) => {
    const slug = c.req.param('slug')!
    if (!services.tenant(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(services.tenants.promptsFor(slug))
  })
  app.put(declaredRoute('PUT', path), async (c) => {
    const slug = c.req.param('slug')!
    if (!services.tenant(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = PortalPromptsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const before = services.tenants.promptsFor(slug)
    const after: PortalPrompts = {
      ...before,
      ...parsed.data,
      ask: parsed.data.ask?.trim() || undefined,
    }
    if (!services.localMutations) throw new AuditWriteError()
    await declaredSubAction(
      'PUT',
      path,
      'tenant.behaviour.update',
      (declaration) =>
        services.localMutations!.run(
          {
            ...services.context(c),
            action: 'tenant.behaviour.update',
            scope: { kind: 'portal', slug },
            target: { kind: 'tenant', id: slug },
            detail: {
              permission: declaration.permission,
              previousPrompts: JSON.stringify(before),
              prompts: JSON.stringify(after),
            },
          },
          services.signal(c),
          () => services.tenants.patch(slug, { prompts: after }),
        ),
    )
    return c.json({ ok: true })
  })
}
