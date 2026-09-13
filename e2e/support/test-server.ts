// ---------------------------------------------------------------------------
// Boots the real Hono app (apps/api/src/app.ts) against the DoubleProvider,
// serving the built SPA the same way apps/api/src/server.ts does for real
// deploys - one origin, no proxy, no mocked HTTP layer. Only the retrieval
// provider is a double (see double-provider.ts); everything else - routing,
// SSE streaming, tenant config, static file serving - is the production
// code path. Used only by the browser E2E persona journeys in e2e/*.test.ts.
// ---------------------------------------------------------------------------
import { serveStatic } from 'hono/deno'
import { buildApp, type BuildAppOptions } from '../../apps/api/src/app.ts'
import { TenantStore } from '../../apps/api/src/tenants.ts'
import { DoubleProvider } from './double-provider.ts'
import type { AccessMode, Role, Scope } from '@research-portal/core'
import { authorize, normalisePrincipal, PERMISSIONS } from '@research-portal/core'
import type { TrustedSessionFacts } from '../../apps/api/src/principal.ts'
import { openLocalRbac } from '../../apps/api/src/rbac-local.ts'
import { LocalIngress } from '../../apps/api/src/local-ingress.ts'
import { localOwnedStores } from '../../apps/api/src/local-owned-stores.ts'
import { infrastructureHandler } from '../../apps/api/src/permissions.ts'
import { fixtureSession } from '../../apps/api/src/rbac-integration-fixture.ts'
import { InsightsStore, RoutingLog, SourceStore } from '../../apps/api/src/stores.ts'
import { SuggestionStore } from '../../apps/api/src/interrogate.ts'
import { KgProposalStore } from '../../apps/api/src/kg.ts'
import { EnrichmentStore } from '../../apps/api/src/enrichments.ts'
import { BindingStore } from '../../apps/api/src/bindings.ts'
import { RbacState } from '../../apps/api/src/rbac-state.ts'

const WEB_DIST = './apps/web/dist'

export interface TestServer {
  url: string
  directory: string
  providerCalls: string[]
  requests: { path: string; method: string; status?: number }[]
  setIdentity: (identity: TrustedSessionFacts | null) => void
  setAssignment: (
    scope: Scope,
    subject: string,
    role: Role | null,
    kind?: 'active-oid' | 'pending-email' | 'group',
  ) => void
  setAccessMode: (slug: string, mode: AccessMode) => void
  setGroupCapability: (enabled: boolean) => void
  delayResponse: (path: string) => { entered: Promise<void>; release(): void }
  setResponseStatus: (path: string, status: number | null) => void
  tenants: TenantStore
  bindings: BindingStore
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
  management?: BuildAppOptions['management']
  sources?: BuildAppOptions['sources']
  insights?: BuildAppOptions['insights']
  domainProvisioner?: BuildAppOptions['domainProvisioner']
  breakGlass?: boolean
  keyScenarios?: boolean
  identity?: { role: Role; slug?: string }
  emergencyFixture?: { directory: string; state: EmergencyFixtureState }
  componentFixture?: { directory: string }
} = {}): TestServer {
  const directory = Deno.makeTempDirSync({ prefix: 'rbac-e2e-' })
  // Legacy JSON stores capture DATA_DIR at module load. Override only their
  // file resolver in this fixture, keeping the actual store operations intact.
  const isolatedStore = <T extends object>(store: T, name: string, extension: string): T =>
    Object.assign(store, {
      pathFor: (slug: string) => `${directory}/${name}/${encodeURIComponent(slug)}.${extension}`,
    })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    WORKER_NAME: 'corpuskit',
    ENVIRONMENT: 'test',
    ...(options.breakGlass ? { ADMIN_PASSCODE: 'fixture-emergency-only' } : {}),
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    const stores = localOwnedStores(directory, database, rbac.audit, env)
    const tenants = stores.tenants as TenantStore
    const bindings = new BindingStore({ BINDINGS_PATH: `${directory}/bindings.json` })
    const ingress = new LocalIngress({ rbac, tenants, env })
    const identity = options.identity
    let session = identity
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
    const service = rbac.assignmentService(env.ENTRA_TENANT_ID, env.WORKER_NAME)
    const seedContext = { requestId: 'e2e-seed', actor: { kind: 'system' as const } }
    const setAssignment: TestServer['setAssignment'] = (
      scope,
      subjectId,
      role,
      subjectKind = 'active-oid',
    ) => {
      const existing = service.list().find((row) =>
        row.subjectId === subjectId &&
        row.subjectKind === subjectKind && JSON.stringify(row.scope) === JSON.stringify(scope)
      )
      const result = existing
        ? role === null
          ? service.remove(existing.id, seedContext)
          : service.change(existing.id, { role }, seedContext)
        : role === null
        ? { ok: true }
        : service.create({ scope, subjectId, subjectKind, role }, seedContext)
      if (!result.ok) throw new Error('Fixture assignment rejected')
    }
    for (const oid of ['fixture-owner-one', 'fixture-owner-two']) {
      setAssignment({ kind: 'platform' }, oid, 'owner')
    }
    for (const role of ['viewer', 'analyst', 'curator', 'portal-admin'] as const) {
      setAssignment({ kind: 'portal', slug: 'marine' }, `fixture-${role}`, role)
    }
    setAssignment(
      { kind: 'portal', slug: 'marine' },
      'pending@example.test',
      'viewer',
      'pending-email',
    )
    // Fixed fake records exercise status displays without retaining usable key material.
    for (
      const [index, label] of ['Legacy fixture', 'Expired fixture', 'Revoked fixture'].entries()
    ) {
      stores.mcpKeys.add({
        v: 1,
        id: `fixture-key-${index}`,
        tenant: 'marine',
        issuerUserId: 'fixture-owner-one',
        label,
        prefix: `fixture_key_${index}`,
        hash: String(index + 1).repeat(64),
        createdAt: new Date(0).toISOString(),
        revokedAt: index === 2 ? new Date(1).toISOString() : null,
        role: 'viewer',
        expiresAt: index === 1 ? new Date(1).toISOString() : null,
        creator: index === 0 ? null : { tenantId: 'tenant-1', oid: 'fixture-owner-one' },
        provenance: index === 0 ? 'legacy-unproven' : 'verified-session',
      })
    }
    if (options.keyScenarios) {
      const old = Date.now() - 28_800_001
      const historical = new RbacState(database, () => old).assignmentService(
        'tenant-1',
        'corpuskit',
      )
      for (
        const [index, label] of [
          'Claims expired fixture',
          'Creator lost access fixture',
          'Reduced ceiling fixture',
        ].entries()
      ) {
        const oid = `fixture-key-creator-${index}`
        historical.observeSession({
          verified: true,
          tenantId: 'tenant-1',
          oid,
          roles: index === 0 ? ['CorpusKit.Owner'] : [],
          groups: [],
          groupStatus: 'complete',
          claimIssuedAt: old,
          expiresAt: old + 28_800_000,
        })
        if (index === 2) setAssignment({ kind: 'portal', slug: 'marine' }, oid, 'analyst')
        stores.mcpKeys.add({
          v: 1,
          id: `fixture-reason-${index}`,
          tenant: 'marine',
          issuerUserId: oid,
          label,
          prefix: `fixture_reason_${index}`,
          hash: String(index + 4).repeat(64),
          createdAt: new Date(old).toISOString(),
          revokedAt: null,
          role: 'curator',
          expiresAt: null,
          creator: { tenantId: 'tenant-1', oid },
          provenance: 'verified-session',
        })
      }
    }
    const requests: TestServer['requests'] = []
    const delays = new Map<string, { entered(): void; wait: Promise<void>; release(): void }>()
    const statuses = new Map<string, number>()
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
      management: options.management,
      bindings,
      domainProvisioner: options.domainProvisioner ?? null,
      sources: options.sources ?? isolatedStore(new SourceStore(), 'sources', 'json'),
      insights: options.insights ?? isolatedStore(new InsightsStore(), 'insights', 'jsonl'),
      routing: isolatedStore(new RoutingLog(), 'routing', 'jsonl'),
      suggestions: isolatedStore(new SuggestionStore(), 'suggestions', 'json'),
      kgProposals: new KgProposalStore({ KG_PROPOSALS_PATH: `${directory}/kg-proposals.json` }),
      enrichments: new EnrichmentStore(directory),
      brandingPath: `${directory}/branding`,
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
    const component = options.apiOnly ? undefined : options.componentFixture
    const handler = async (
      request: Request,
      info: Deno.ServeHandlerInfo<Deno.NetAddr>,
    ): Promise<Response> => {
      const path = new URL(request.url).pathname
      const record = {
        path: path + new URL(request.url).search,
        method: request.method,
        status: undefined as number | undefined,
      }
      requests.push(record)
      if (path === '/__test/rbac-component' || path === '/__test/rbac-component.js') {
        if (!component) return new Response(null, { status: 404 })
        if (path.endsWith('.js')) {
          return new Response(await Deno.readFile(`${component.directory}/entry.js`), {
            headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
          })
        }
        return new Response(
          Deno.readTextFileSync(`${WEB_DIST}/index.html`)
            .replace(/src="\/app\.js[^"]*"/, 'src="/__test/rbac-component.js"'),
          {
            headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
          },
        )
      }
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
          const slug = new URL(request.url).searchParams.get('portal')
          const available = signedIn && !!slug && ['alpha', 'beta', 'marine'].includes(slug)
          const principal = normalisePrincipal(
            { kind: 'user', tenantId: 'fixture', oid: 'fixture' },
            { platformRole: 'owner', portalRoles: [] },
          )
          return Response.json({
            authenticated: signedIn,
            user: signedIn
              ? {
                id: 'fixture',
                tenantId: 'fixture',
                name: 'Test administrator',
                email: 'admin@example.invalid',
                roles: [],
                isAdmin: true,
              }
              : null,
            coarseAdminEligible: signedIn,
            breakGlassEnabled: fixture.state.capability === 'enabled',
            effectiveRoles: { ...(signedIn ? { platformRole: 'owner' } : {}), portalRoles: [] },
            provenance: [],
            claimAgeSeconds: signedIn ? 0 : null,
            groupMappings: 'disabled',
            platformPermissions: signedIn ? ['portal.create'] : [],
            portalAccess: slug
              ? {
                slug,
                available,
                permissions: available
                  ? PERMISSIONS.filter((permission) =>
                    authorize(principal, permission, { kind: 'portal', slug })
                  )
                  : [],
                effectiveRole: available ? 'portal-admin' : null,
                canEnable: false,
              }
              : null,
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
      const response = await ingress.handle(
        request,
        (forwarded) => app.fetch(forwarded),
        info,
        session,
      )
      record.status = response.status
      const delay = delays.get(record.path) ?? delays.get(path)
      if (delay) {
        delay.entered()
        await delay.wait
      }
      const status = statuses.get(record.path) ?? statuses.get(path)
      if (status) {
        await response.body?.cancel()
        return Response.json({ error: 'fixture_response_failure' }, { status })
      }
      return response
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
      requests,
      tenants,
      bindings,
      setIdentity: (value) => {
        session = value ? structuredClone(value) : null
      },
      setAssignment,
      setAccessMode: (slug, mode) => tenants.patch(slug, { accessMode: mode }),
      setGroupCapability: (enabled) =>
        database.exec(
          'INSERT OR REPLACE INTO rbac_group_capabilities(audience,status,verified_at) VALUES (?,?,?)',
          env.WORKER_NAME,
          enabled ? 'verified-supported' : 'disabled',
          Date.now(),
        ),
      setResponseStatus: (path, status) => {
        if (status === null) statuses.delete(path)
        else statuses.set(path, status)
      },
      delayResponse: (path) => {
        const entered = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const release = () => {
          delays.delete(path)
          waiting.resolve()
        }
        delays.set(path, { entered: () => entered.resolve(), wait: waiting.promise, release })
        return { entered: entered.promise, release }
      },
      close: () =>
        closing ??= (async () => {
          try {
            for (const delay of delays.values()) delay.release()
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
