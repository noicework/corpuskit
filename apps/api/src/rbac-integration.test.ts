import {
  authoriseDeclared,
  authoriseSubActions,
  buildApp,
  type BuildAppOptions,
  researchOwner,
} from './app.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { expect } from '@std/expect'
import { McpKeyStore } from './stores.ts'
import { assertRouteInventory, infrastructureHandler } from './permissions.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { executeAudited } from './audit-execution.ts'
import { Hono } from 'hono'
import { AuthorisationError } from './authorisation.ts'
import { LocalIngress } from './local-ingress.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { assertIdentityJourney, fixtureSecret, fixtureSession } from './rbac-integration-fixture.ts'

/** Test-only activation of one real registered handler; no runtime policy switch exists. */
function guardCatalogue(app: ReturnType<typeof buildApp>, onDispatch = () => {}): Hono {
  const guarded = new Hono()
  for (const route of app.routes) {
    const handler = route.handler
    guarded.on(
      route.method,
      route.path,
      route.method === 'GET' && route.path === '/api/t/:slug/catalog'
        ? async (c, next) => {
          const first = await authoriseDeclared(c)
          expect(await authoriseDeclared(c)).toBe(first)
          onDispatch()
          return handler(c, next)
        }
        : handler,
    )
  }
  guarded.onError((error, c) =>
    error instanceof AuthorisationError
      ? c.json({ error: error.code }, error.status)
      : c.json({ error: 'failed' }, 500)
  )
  return guarded
}

Deno.test('local dormant helpers use the endpoint key store and current creator assignments', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'local-authority-' })
  const database = new LocalRbacDatabase(`${directory}/state.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  try {
    const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
    const keys = new McpKeyStore(directory, { database, audit: rbac.audit })
    const ingress = new LocalIngress({
      rbac,
      tenants,
      env: {
        ENTRA_TENANT_ID: 'tenant-1',
        WORKER_NAME: 'corpuskit',
        SESSION_SECRET: fixtureSecret,
      },
    })
    const options: BuildAppOptions = {
      provider: new DoubleProvider(),
      tenants,
      mcpKeys: keys,
      rbac,
      configuredTenantId: 'tenant-1',
      audience: 'corpuskit',
      audit: rbac.audit,
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
    }
    let dispatched = 0
    const app = guardCatalogue(buildApp(options), () => {
      dispatched++
    })
    app.get('/', infrastructureHandler(async (c) => c.text('home')))
    app.use(
      '*',
      infrastructureHandler(async (_c, next) => {
        await next()
      }),
    )
    app.get('*', infrastructureHandler(async (c) => c.text('shell')))
    assertRouteInventory(app)
    const session = fixtureSession()
    const invoke = (token?: string, facts = session) =>
      ingress.handle(
        new Request('http://localhost/api/t/marine/catalog', {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
        (request) => app.fetch(request),
        undefined,
        facts,
      )
    expect((await invoke()).status).toBe(200)
    const context = { requestId: 'seed', actor: { kind: 'system' as const } }
    const service = rbac.assignmentService('tenant-1', 'corpuskit')
    const assignment = service.create({
      subjectKind: 'active-oid',
      subjectId: session.oid,
      scope: { kind: 'portal', slug: 'marine' },
      role: 'curator',
    }, context)
    if (!assignment.ok) throw new Error('Fixture assignment failed')
    const prepared = await issueScopedKey(
      { slug: 'marine', label: 'Fixture', role: 'viewer' },
      session,
      {
        keys,
        creatorStores: { rbac, audience: 'corpuskit' },
        configuredTenantId: 'tenant-1',
      },
    )
    await executeAudited({
      audit: rbac.audit,
      input: {
        requestId: 'key-seed',
        actor: context.actor,
        action: 'request.privileged',
        scope: { kind: 'portal', slug: 'marine' },
        target: { kind: 'request' },
      },
      run: () => prepared.commit(),
    })
    const allowed = await invoke(prepared.key)
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).items.length).toBeGreaterThan(0)
    expect(service.remove(assignment.value.id, context).ok).toBe(true)
    const before = dispatched
    expect(
      (await invoke(
        prepared.key,
        fixtureSession({ oid: 'ambient-owner', roles: ['CorpusKit.Owner'] }),
      )).status,
    ).toBe(403)
    database.exec(
      "CREATE TRIGGER fail_authority BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect((await invoke(prepared.key)).status).toBe(500)
    expect(dispatched).toBe(before)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('missing authority configuration refuses even public browse with an audited zero-dispatch denial', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'missing-authority-' })
  const database = new LocalRbacDatabase(`${directory}/state.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  try {
    const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
    let dispatched = 0
    const app = guardCatalogue(
      buildApp({
        provider: new DoubleProvider(),
        tenants,
        audit: rbac.audit,
      }),
      () => {
        dispatched++
      },
    )
    const publicResponse = await app.request('/api/t/marine/catalog')
    expect(publicResponse.status).toBe(401)
    expect(dispatched).toBe(0)
    const before = dispatched
    expect(
      (await app.request('/api/t/marine/catalog', {
        headers: {
          authorization: `Bearer ck_${'A'.repeat(43)}`,
          'x-corpuskit-sso-admin': '1',
          'x-corpuskit-principal': 'forged',
        },
      })).status,
    ).toBe(401)
    tenants.patch('marine', { accessMode: 'restricted' })
    expect((await app.request('/api/t/marine/catalog')).status).toBe(401)
    expect(dispatched).toBe(before)
    expect(
      rbac.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
        .filter((event) => event.action === 'request.denied'),
    ).toHaveLength(3)
    database.exec(
      "CREATE TRIGGER fail_missing_authority BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    expect((await app.request('/api/t/marine/catalog')).status).toBe(500)
    expect(dispatched).toBe(before)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('dormant sub-action and research helpers resolve only declared targets', async () => {
  const fixture = createEnforcementFixture()
  try {
    let trusted = await fixture.contextFor(fixture.sessionFor('viewer'))
    let dispatched = 0
    let names = ['resource.questions.generate', 'resource.questions.cache']
    const source = buildApp({
      ...fixture.stores,
      provider: fixture.provider,
      rbac: fixture.rbac,
      configuredTenantId: fixture.tenantId,
      audience: fixture.audience,
      now: fixture.now,
      requestContext: () => trusted,
      breakGlass: fixture.rbac.breakGlassService({ environment: 'production' }),
    })
    const app = new Hono()
    for (const route of source.routes) {
      app.on(
        route.method,
        route.path,
        route.path === '/api/t/:slug/resources/:id/questions'
          ? async (c) => {
            await authoriseSubActions(c, names)
            dispatched++
            return c.json({ generated: true })
          }
          : route.method === 'GET' && route.path === '/api/t/:slug/sessions'
          ? async (c) => {
            await authoriseDeclared(c)
            return c.json(await researchOwner(c))
          }
          : route.handler,
      )
    }
    app.onError((error, c) =>
      error instanceof AuthorisationError
        ? c.json({ error: error.code }, error.status)
        : c.json({ error: 'failed' }, 500)
    )
    expect((await app.request('/api/t/a/resources/doc/questions')).status).toBe(403)
    trusted = await fixture.contextFor(fixture.sessionFor('analyst'))
    expect((await app.request('/api/t/a/resources/doc/questions')).status).toBe(403)
    expect(dispatched).toBe(0)
    trusted = await fixture.contextFor(fixture.sessionFor('curator'))
    expect(await (await app.request('/api/t/a/resources/doc/questions')).json()).toEqual({
      generated: true,
    })
    expect(dispatched).toBe(1)
    names = ['unknown.action']
    trusted = await fixture.contextFor(fixture.sessionFor('curator'))
    expect((await app.request('/api/t/a/resources/doc/questions')).status).toBe(403)
    expect(dispatched).toBe(1)
    trusted = await fixture.contextFor(fixture.sessionFor('viewer'))
    expect(await (await app.request('/api/t/a/sessions')).json()).toEqual({
      kind: 'user',
      tenantId: fixture.tenantId,
      oid: fixture.sessionFor('viewer').oid,
    })
    trusted = await fixture.contextFor(null)
    expect(
      await (await app.request('/api/t/public-a/sessions', {
        headers: { 'x-rp-client': 'browser-1' },
      })).json(),
    )
      .toEqual({ kind: 'anonymous', clientId: 'browser-1' })
    trusted = await fixture.contextFor(null)
    expect((await app.request('/api/t/public-a/sessions')).status).toBe(401)
    fixture.assertNoProtectedDispatch()
  } finally {
    fixture.close()
  }
})

Deno.test('local signed ingress integrates current assignments, audit failures and persisted lockout', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'local-identity-journey-' })
  const originalNow = Date.now
  let clock = originalNow()
  Date.now = () => clock
  let database: LocalRbacDatabase
  let rbac: RbacState
  let ingress: LocalIngress
  let app: ReturnType<typeof buildApp>
  const start = () => {
    database = new LocalRbacDatabase(`${directory}/state.sqlite`)
    rbac = new RbacState(database)
    rbac.migrate()
    const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
    ingress = new LocalIngress({
      rbac,
      tenants,
      env: {
        ENTRA_TENANT_ID: 'tenant-1',
        SESSION_SECRET: fixtureSecret,
        WORKER_NAME: 'corpuskit',
        ENVIRONMENT: 'production',
        ADMIN_BREAK_GLASS: 'true',
        ADMIN_PASSCODE: 'fixture',
      },
    })
    app = buildApp({
      rbac,
      configuredTenantId: 'tenant-1',
      audience: 'corpuskit',
      provider: new DoubleProvider(),
      tenants,
      audit: rbac.audit,
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
    })
  }
  try {
    start()
    await assertIdentityJourney({
      get rbac() {
        return rbac
      },
      exec: (sql) => database.exec(sql),
      restart: () => {
        database.close()
        start()
      },
      advance: (ms) => {
        clock += ms
      },
      invoke: (path, session, init, peer = true) =>
        ingress.handle(
          new Request(`http://localhost${path}`, init),
          (request) => app.fetch(request),
          peer
            ? { remoteAddr: { transport: 'tcp', hostname: '192.0.2.1', port: 8791 } }
            : undefined,
          session,
        ),
    })
  } finally {
    database!.close()
    Date.now = originalNow
    Deno.removeSync(directory, { recursive: true })
  }
})
