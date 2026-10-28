import type { PublicHttpClient } from './public-http.ts'
import type { Hono } from 'hono'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { declaredRoute } from './permissions.ts'
import type { TenantStoreApi } from './tenants.ts'
import type { SourceStoreApi } from './stores.ts'
import { checkLink, type LinkHealthStoreApi, linkTargets, runLinkChecks } from './link-health.ts'

export function registerLinkHealthRoutes(app: Hono, options: {
  tenants: TenantStoreApi
  provider: RetrievalProvider
  sources: SourceStoreApi
  client?: PublicHttpClient
  notFound: (c: import('hono').Context) => Response
  store: LinkHealthStoreApi
  signal: (request: Request) => AbortSignal
}) {
  const base = '/api/admin/t/:slug/link-health'
  app.get(declaredRoute('GET', base), (c) => {
    const slug = c.req.param('slug')!
    if (!options.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(options.store.list(slug))
  })
  app.post(declaredRoute('POST', `${base}/check`), async (c) => {
    const config = options.tenants.get(c.req.param('slug')!)
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const targets = await linkTargets(
      options.provider,
      config,
      options.sources,
      options.signal(c.req.raw),
    )
    return c.json(
      await runLinkChecks(
        options.store,
        config.slug,
        targets,
        options.signal(c.req.raw),
        options.client,
      ),
    )
  })
  for (const action of ['recheck', 'ignore'] as const) {
    app.post(declaredRoute('POST', `${base}/:id/${action}`), async (c) => {
      const slug = c.req.param('slug')!
      if (!options.tenants.get(slug)) return c.json({ error: 'unknown_tenant' }, 404)
      const row = options.store.list(slug).find((row) => row.id === c.req.param('id'))
      if (!row) return options.notFound(c)
      const signal = options.signal(c.req.raw)
      const next = action === 'ignore'
        ? { ...row, ignored: true }
        : await checkLink(row, { ...row, ignored: false }, options.client, signal)
      signal.throwIfAborted()
      options.store.put(slug, next)
      return c.json({ ok: true })
    })
  }
}
