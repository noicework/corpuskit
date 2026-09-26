import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { declaredRoute } from './permissions.ts'
import { aliasHostname, type AliasWriteResult, type PortalAlias } from './portal-aliases.ts'
import type { TenantStoreApi } from './tenants.ts'

export interface AliasRouteServices {
  tenants: TenantStoreApi
  platformDomain: string
  /** `MAX_PORTAL_ALIASES`. */
  limit: number
  /** Register or update the alias as the route's audited sub-action. */
  set(
    c: Context,
    slug: string,
    hostname: string,
    primary: boolean | undefined,
    audited: { aliasHostname: string; aliasPrimary: boolean },
  ): Promise<AliasWriteResult>
  /** Remove the alias as the route's audited sub-action. */
  remove(
    c: Context,
    slug: string,
    hostname: string,
    audited: { aliasHostname: string; aliasPrimary: boolean },
  ): Promise<PortalAlias[]>
}

const AliasBodySchema = z.object({ primary: z.boolean().optional() }).strict()

/** An empty body means `{}`; anything else must be exactly `{ primary?: boolean }`. */
async function aliasBody(c: Context): Promise<{ primary?: boolean } | null> {
  const text = await c.req.text()
  if (!text.trim()) return {}
  try {
    const parsed = AliasBodySchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Portal host aliases (docs/HOSTING.md), hosting control at platform scope like the lifecycle
 * routes. They stay available while a portal is suspended, read-only or disabled. The top-level
 * `hostname` of each answer is the portal's canonical hostname after the call, or null.
 */
export function registerAliasRoutes(app: Hono, services: AliasRouteServices): void {
  const answer = (c: Context, slug: string, aliases: PortalAlias[], extra = {}) => {
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ...extra, aliases, hostname: services.tenants.get(slug)?.hostname ?? null })
  }

  app.get(declaredRoute('GET', '/api/admin/t/:slug/aliases'), (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    return answer(c, slug, services.tenants.portalAliases(slug))
  })

  app.put(declaredRoute('PUT', '/api/admin/t/:slug/aliases/:hostname'), async (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    const hostname = aliasHostname(c.req.param('hostname'), services.platformDomain)
    if (!hostname) return c.json({ error: 'invalid_hostname' }, 400)
    const body = await aliasBody(c)
    if (!body) return c.json({ error: 'invalid_request' }, 400)
    const current = services.tenants.portalAliases(slug).find((alias) =>
      alias.hostname === hostname
    )
    const result = await services.set(c, slug, hostname, body.primary, {
      aliasHostname: hostname,
      aliasPrimary: body.primary ?? current?.primary ?? false,
    })
    if (!result.ok) {
      return c.json(
        { error: result.error },
        result.error === 'unknown_tenant' ? 404 : 409,
      )
    }
    return answer(c, slug, result.aliases, { ok: true })
  })

  app.delete(declaredRoute('DELETE', '/api/admin/t/:slug/aliases/:hostname'), async (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    const hostname = aliasHostname(c.req.param('hostname'), services.platformDomain)
    if (!hostname) return c.json({ error: 'invalid_hostname' }, 400)
    const current = services.tenants.portalAliases(slug).find((alias) =>
      alias.hostname === hostname
    )
    const aliases = await services.remove(c, slug, hostname, {
      aliasHostname: hostname,
      aliasPrimary: current?.primary ?? false,
    })
    return answer(c, slug, aliases, { ok: true })
  })
}
