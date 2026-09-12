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
import type { Role } from '@research-portal/core'
import { openLocalRbac } from '../../apps/api/src/rbac-local.ts'
import { LocalIngress } from '../../apps/api/src/local-ingress.ts'
import { localOwnedStores } from '../../apps/api/src/local-owned-stores.ts'
import { infrastructureHandler } from '../../apps/api/src/permissions.ts'
import { fixtureSession } from '../../apps/api/src/rbac-integration-fixture.ts'

const WEB_DIST = './apps/web/dist'

export interface TestServer {
  url: string
  directory: string
  providerCalls: string[]
  close: () => Promise<void>
}
let nextPort = 8791

export interface EmergencyFixtureState {
  capability: 'enabled' | 'disabled' | 'unknown' | 'failed' | 'loading' | 'session'
  status: number
  requests: number
  credentialRequests: number
  delayMs: number
}

export function startTestServer(options: {
  apiOnly?: boolean
  identity?: { role: Role; slug?: string }
  emergencyFixture?: { directory: string; state: EmergencyFixtureState }
} = {}): TestServer {
  const directory = Deno.makeTempDirSync({ prefix: 'rbac-e2e-' })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    WORKER_NAME: 'corpuskit',
    ENVIRONMENT: 'test',
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    const stores = localOwnedStores(directory, database, rbac.audit, env)
    const tenants = stores.tenants as TenantStore
    const ingress = new LocalIngress({ rbac, tenants, env })
    const identity = options.identity
    const session = identity
      ? fixtureSession({
        oid: `e2e-${identity.role}`,
        roles: identity.role === 'owner'
          ? ['CorpusKit.Owner']
          : identity.role === 'platform-admin'
          ? ['CorpusKit.PlatformAdmin']
          : [],
      })
      : null
    if (session && identity && identity.role !== 'owner' && identity.role !== 'platform-admin') {
      const assigned = rbac.assignmentService(env.ENTRA_TENANT_ID, env.WORKER_NAME).create({
        subjectKind: 'active-oid',
        subjectId: session.oid,
        scope: { kind: 'portal', slug: identity.slug ?? 'marine' },
        role: identity.role,
      }, { requestId: 'e2e-seed', actor: { kind: 'system' } })
      if (!assigned.ok) throw new Error('E2E assignment failed')
    }
    const providerCalls: string[] = []
    const provider = new Proxy(new DoubleProvider(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          providerCalls.push(String(property))
          return value.apply(target, args)
        }
      },
    })
    const app = buildApp({
      ...stores,
      provider,
      tenants,
      rbac,
      audit: rbac.audit,
      configuredTenantId: env.ENTRA_TENANT_ID,
      audience: env.WORKER_NAME,
      requestContext: ingress.requestContext,
      breakGlass: ingress.breakGlass,
      rateLimitAskPerMin: 0,
      rateLimitEstatePerMin: 0,
      ...(options.apiOnly ? {} : { webDistPath: WEB_DIST }),
    })
    if (!options.apiOnly) {
      const homeHtml = Deno.readTextFileSync(`${WEB_DIST}/home.html`)
      app.get('/', infrastructureHandler(async (c) => c.html(homeHtml)))
      app.use('*', infrastructureHandler(serveStatic({ root: WEB_DIST })))
      app.get('*', infrastructureHandler(serveStatic({ path: `${WEB_DIST}/index.html` })))
    }

    // This optional mount belongs only to the E2E server. It is never registered in production.
    const fixture = options.apiOnly ? undefined : options.emergencyFixture
    const handler = async (
      request: Request,
      info: Deno.ServeHandlerInfo<Deno.NetAddr>,
    ): Promise<Response> => {
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
      return await ingress.handle(request, (forwarded) => app.fetch(forwarded), info, session)
    }
    let server: Deno.HttpServer<Deno.NetAddr> | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      const port = nextPort++
      try {
        server = Deno.serve({ port, hostname: '127.0.0.1', onListen: () => {} }, handler)
        break
      } catch (error) {
        if (!(error instanceof Deno.errors.AddrInUse)) throw error
      }
    }
    if (!server) throw new Error('No available fixture port from 8791')
    const addr = server.addr as Deno.NetAddr
    let closing: Promise<void> | undefined
    return {
      url: `http://127.0.0.1:${addr.port}`,
      directory,
      providerCalls,
      close: () =>
        closing ??= (async () => {
          try {
            await server.shutdown()
          } finally {
            database.close()
            Deno.removeSync(directory, { recursive: true })
          }
        })(),
    }
  } catch (error) {
    database.close()
    Deno.removeSync(directory, { recursive: true })
    throw error
  }
}
