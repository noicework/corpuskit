import { buildApp } from './app.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import {
  assertEnforcementJourney,
  assertIdentityJourney,
  type EnforcementJourney,
  fixtureSecret,
  trackJourneyProvider,
} from './rbac-integration-fixture.ts'
Deno.test('local signed ingress integrates current assignments, audit failures and persisted lockout', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'local-identity-journey-' })
  const originalNow = Date.now
  let clock = originalNow()
  Date.now = () => clock
  let database: LocalRbacDatabase
  let rbac: RbacState
  let ingress: LocalIngress
  let app: ReturnType<typeof buildApp>
  let stores: EnforcementJourney['stores']
  const calls: string[] = []
  const start = () => {
    database = new LocalRbacDatabase(`${directory}/state.sqlite`)
    rbac = new RbacState(database)
    rbac.migrate()
    const owned = localOwnedStores(directory, database, rbac.audit, {
      TENANTS_PATH: `${directory}/tenants.json`,
    })
    stores = { ...owned, tenants: owned.tenants! }
    const tenants = owned.tenants!
    const provider = new DoubleProvider()
    trackJourneyProvider(provider, calls)
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
      ...owned,
      rbac,
      configuredTenantId: 'tenant-1',
      audience: 'corpuskit',
      provider,
      management: {
        rephrase: async (_config: TenantConfig, query: string) => query,
        resourceExtraction: async (config: TenantConfig, id: string) => {
          const result = await provider.search(config, 'abalone')
          return { text: result.resources.find((r) => r.id === id)?.matchedPassage }
        },
        summarize: async () => {
          calls.push('summarize')
          return 'Abalone evidence summary'
        },
      } as unknown as AragProvider,
      rateLimitAskPerMin: 0,
      rateLimitEstatePerMin: 0,
      tenants,
      audit: rbac.audit,
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
    })
  }
  try {
    start()
    const journey: EnforcementJourney = {
      get stores() {
        return stores
      },
      calls,
      boundary: (header) =>
        ingress.handle(
          new Request('http://localhost/api/t/marine/catalog', {
            headers: { 'x-corpuskit-principal': header },
          }),
          (request) => app.fetch(request),
        ),
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
    }
    await assertIdentityJourney(journey)
    await assertEnforcementJourney(journey)
  } finally {
    database!.close()
    Date.now = originalNow
    Deno.removeSync(directory, { recursive: true })
  }
})
