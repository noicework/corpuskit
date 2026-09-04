// ---------------------------------------------------------------------------
// Boots the real Hono app (apps/api/src/app.ts) against the DoubleProvider,
// serving the built SPA the same way apps/api/src/server.ts does for real
// deploys - one origin, no proxy, no mocked HTTP layer. Only the retrieval
// provider is a double (see double-provider.ts); everything else - routing,
// SSE streaming, tenant config, static file serving - is the production
// code path. Used only by the browser E2E persona journeys in e2e/*.test.ts.
// ---------------------------------------------------------------------------
import { serveStatic } from 'hono/deno'
import { buildApp } from '../../apps/api/src/app.ts'
import { TenantStore } from '../../apps/api/src/tenants.ts'
import { DoubleProvider } from './double-provider.ts'

const WEB_DIST = './apps/web/dist'

export interface TestServer {
  url: string
  close: () => Promise<void>
}

/** Hermetic tenant store - never reads/writes the repo's real data/tenants.json. */
function freshTenants(): TenantStore {
  return new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })
}

export function startTestServer(): TestServer {
  const app = buildApp({
    provider: new DoubleProvider(),
    tenants: freshTenants(),
    webDistPath: WEB_DIST,
  })
  const homeHtml = Deno.readTextFileSync(`${WEB_DIST}/home.html`)
  app.get('/', (c) => c.html(homeHtml))
  app.use('*', serveStatic({ root: WEB_DIST }))
  app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }))

  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, app.fetch)
  const addr = server.addr as Deno.NetAddr

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.shutdown(),
  }
}
