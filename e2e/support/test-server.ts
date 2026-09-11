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

export interface EmergencyFixtureState {
  capability: 'enabled' | 'disabled' | 'unknown' | 'failed' | 'loading' | 'session'
  status: number
  requests: number
  credentialRequests: number
  delayMs: number
}

export function startTestServer(options: {
  emergencyFixture?: { directory: string; state: EmergencyFixtureState }
} = {}): TestServer {
  const app = buildApp({
    provider: new DoubleProvider(),
    tenants: freshTenants(),
    webDistPath: WEB_DIST,
  })
  const homeHtml = Deno.readTextFileSync(`${WEB_DIST}/home.html`)
  app.get('/', (c) => c.html(homeHtml))
  app.use('*', serveStatic({ root: WEB_DIST }))
  app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }))

  // This optional mount belongs only to the E2E server. It is never registered in production.
  const fixture = options.emergencyFixture
  const handler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (fixture) {
      if (path === '/__test/emergency-access') {
        const index = Deno.readTextFileSync(`${WEB_DIST}/index.html`)
          .replace('<div id="root"></div>', '<div id="emergency-fixture-root"></div>')
          .replace(/src="\/app\.js[^"]*"/, 'src="/__test/emergency-access.js"')
        return new Response(index, {
          headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
        })
      }
      if (path === '/__test/emergency-access.js') {
        return new Response(await Deno.readFile(`${fixture.directory}/entry.js`), {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
        })
      }
      if (path === '/auth/me') {
        if (fixture.state.capability === 'loading') {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        if (fixture.state.capability === 'failed') return new Response(null, { status: 503 })
        if (fixture.state.capability === 'unknown' || fixture.state.capability === 'loading') {
          return Response.json({})
        }
        const signedIn = fixture.state.capability === 'session'
        return Response.json({
          authenticated: signedIn,
          user: signedIn
            ? {
              id: 'fixture',
              tenantId: 'fixture',
              name: 'Test administrator',
              email: 'admin@example.invalid',
              roles: [],
            }
            : null,
          coarseAdminEligible: signedIn,
          breakGlassEnabled: fixture.state.capability === 'enabled',
        })
      }
      if (path === '/api/admin/__test/emergency-action') {
        fixture.state.requests++
        if (request.headers.has('x-admin-passcode')) fixture.state.credentialRequests++
        if (fixture.state.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, fixture.state.delayMs))
        }
        return Response.json({ ok: fixture.state.status === 200 }, {
          status: fixture.state.status === 429 ? 403 : fixture.state.status,
          headers: fixture.state.status === 429 ? { 'retry-after': '125' } : {},
        })
      }
    }
    return await app.fetch(request)
  }
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler)
  const addr = server.addr as Deno.NetAddr

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => server.shutdown(),
  }
}
