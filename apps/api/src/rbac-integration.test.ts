import { buildApp } from './app.ts'
import { LocalIngress } from './local-ingress.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { assertIdentityJourney, fixtureSecret } from './rbac-integration-fixture.ts'

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
