import {
  type PortalLifecycle,
  PortalLifecycleInputSchema,
  type TenantConfig,
} from '@research-portal/core'
import type { Context, Hono } from 'hono'
import type { z } from 'zod'
import { declaredRoute } from './permissions.ts'
import type { PortalLifecycleStore } from './lifecycle-store.ts'
import type { TenantStoreApi } from './tenants.ts'

type LifecycleInput = z.infer<typeof PortalLifecycleInputSchema>

export interface LifecycleRouteServices {
  lifecycle: PortalLifecycleStore
  tenants: TenantStoreApi
  now?: () => number
  members(slug: string): number
  capacity(config: TenantConfig): Promise<{ resources: number; bytes: number | null }>
  update(c: Context, slug: string, input: LifecycleInput): Promise<PortalLifecycle>
}

/** The audited summary of a lifecycle change: status, each limit that is set, and the note. */
export function lifecycleAuditDetail(
  input: LifecycleInput,
): Record<string, string | number | boolean> {
  const { maxResources, maxBytes, asksPerDay, agentsEnabled } = input.limits ?? {}
  return {
    lifecycleStatus: input.status,
    ...(maxResources !== undefined ? { maxResources } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(asksPerDay !== undefined ? { asksPerDay } : {}),
    ...(agentsEnabled !== undefined ? { agentsEnabled } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
}

/**
 * Hosting control at platform scope. These routes stay reachable for platform principals while a
 * portal is suspended, read-only or disabled, so a portal can always be restored.
 */
export function registerLifecycleRoutes(app: Hono, services: LifecycleRouteServices): void {
  app.get(declaredRoute('GET', '/api/admin/t/:slug/lifecycle'), (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    c.header('Cache-Control', 'private, no-store')
    return c.json(services.lifecycle.get(slug))
  })

  app.put(declaredRoute('PUT', '/api/admin/t/:slug/lifecycle'), async (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = PortalLifecycleInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)
    const lifecycle = await services.update(c, slug, parsed.data)
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ok: true, lifecycle })
  })

  app.get(declaredRoute('GET', '/api/admin/t/:slug/usage'), async (c) => {
    const slug = c.req.param('slug')
    const config = services.tenants.get(slug)
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const { resources, bytes } = await services.capacity(config)
    const { status, limits } = services.lifecycle.get(slug)
    const asks = services.lifecycle.usage(slug, config.timezone ?? 'UTC', services.now?.())
    c.header('Cache-Control', 'private, no-store')
    return c.json({
      status,
      limits,
      resources,
      bytes,
      asksToday: asks.asksToday,
      asks30d: asks.asks30d,
      members: services.members(slug),
      lastActivityAt: asks.lastActivityAt,
    })
  })
}
