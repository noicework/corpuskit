import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { declaredRoute } from './permissions.ts'
import { aliasHostname, type AliasWriteResult, type PortalAlias } from './portal-aliases.ts'
import type { TenantStoreApi } from './tenants.ts'

type AliasAction = 'portal.alias.set' | 'portal.alias.remove'
/** Every refusal the alias routes answer with, as its error code. */
export type AliasRouteRefusal =
  | 'invalid_hostname'
  | 'invalid_request'
  | 'unknown_tenant'
  | 'hostname_reserved'
  | 'hostname_taken'
  | 'alias_limit'

export interface AliasRouteServices {
  tenants: TenantStoreApi
  platformDomain: string
  /** `MAX_PORTAL_ALIASES`. */
  limit: number
  /** Hostnames the deployment keeps for itself (`reservedHostnames`). */
  reserved: ReadonlySet<string>
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
  /** Audit a refused call: its action, portal, code and, when valid, hostname. */
  refused(
    c: Context,
    action: AliasAction,
    slug: string,
    code: AliasRouteRefusal,
    hostname?: string,
  ): void
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

const STATUS: Record<AliasRouteRefusal, 400 | 404 | 409> = {
  invalid_hostname: 400,
  invalid_request: 400,
  hostname_reserved: 400,
  unknown_tenant: 404,
  hostname_taken: 409,
  alias_limit: 409,
}

/**
 * Portal host aliases (docs/HOSTING.md), hosting control at platform scope like the lifecycle
 * routes. They stay available while a portal is suspended, read-only or disabled. The top-level
 * `hostname` of each answer is the portal's canonical hostname after the call, or null. Every
 * `PUT` and `DELETE` is audited, a refusal included.
 */
export function registerAliasRoutes(app: Hono, services: AliasRouteServices): void {
  const answer = (c: Context, slug: string, aliases: PortalAlias[], extra = {}) => {
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ...extra, aliases, hostname: services.tenants.get(slug)?.hostname ?? null })
  }
  const refuse = (
    c: Context,
    action: AliasAction,
    slug: string,
    code: AliasRouteRefusal,
    hostname?: string,
  ) => {
    services.refused(c, action, slug, code, hostname)
    c.header('Cache-Control', 'private, no-store')
    return c.json({ error: code }, STATUS[code])
  }

  app.get(declaredRoute('GET', '/api/admin/t/:slug/aliases'), (c) => {
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    return answer(c, slug, services.tenants.portalAliases(slug))
  })

  app.put(declaredRoute('PUT', '/api/admin/t/:slug/aliases/:hostname'), async (c) => {
    const action = 'portal.alias.set'
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return refuse(c, action, slug, 'unknown_tenant')
    const hostname = aliasHostname(c.req.param('hostname'), services.platformDomain)
    if (!hostname) return refuse(c, action, slug, 'invalid_hostname')
    // A hostname the deployment already answers on for itself is never handed to a portal.
    if (services.reserved.has(hostname)) {
      return refuse(c, action, slug, 'hostname_reserved', hostname)
    }
    const body = await aliasBody(c)
    if (!body) return refuse(c, action, slug, 'invalid_request', hostname)
    const current = services.tenants.portalAliases(slug).find((alias) =>
      alias.hostname === hostname
    )
    const result = await services.set(c, slug, hostname, body.primary, {
      aliasHostname: hostname,
      aliasPrimary: body.primary ?? current?.primary ?? false,
    })
    if (!result.ok) return refuse(c, action, slug, result.error, hostname)
    return answer(c, slug, result.aliases, { ok: true })
  })

  app.delete(declaredRoute('DELETE', '/api/admin/t/:slug/aliases/:hostname'), async (c) => {
    const action = 'portal.alias.remove'
    const slug = c.req.param('slug')
    if (!services.tenants.get(slug)) return refuse(c, action, slug, 'unknown_tenant')
    const hostname = aliasHostname(c.req.param('hostname'), services.platformDomain)
    if (!hostname) return refuse(c, action, slug, 'invalid_hostname')
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
