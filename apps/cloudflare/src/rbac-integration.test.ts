/// <reference path="./runtime.d.ts" />
/// <reference path="../../../worker-configuration.d.ts" />
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { DurableState, type DurableStores } from './state.ts'
import type { TrustedSessionFacts } from '../../api/src/principal.ts'
import type { AuthUser } from './auth.ts'
import type { PortalDurableObject } from './worker.ts'
import {
  assertEnforcementJourney,
  assertIdentityJourney,
  type EnforcementJourney,
  fixtureSecret,
  trackJourneyProvider,
} from '../../api/src/rbac-integration-fixture.ts'
type WorkerHandler = {
  fetch(request: Request, env: Env): Promise<Response>
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>
}

type WorkerModule = {
  PortalDurableObject: typeof PortalDurableObject
  default: WorkerHandler
  marketingHomeRequest(request: Request): Request
  forwardPortalRequest(
    request: Request,
    user: AuthUser | null,
    env: Env,
  ): Promise<Request>
}

const workerModule = await loadWorker()
async function sessionCookie(session: TrustedSessionFacts): Promise<string> {
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fixtureSecret)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('__Secure-corpuskit_session') },
    key,
    new TextEncoder().encode(
      JSON.stringify({
        id: session.oid,
        tenantId: session.tenantId,
        name: 'Verified user',
        email: session.email,
        roles: session.roles,
        isAdmin: false,
        expiresAt: session.expiresAt,
        sessionFacts: session,
      }),
    ),
  )
  return `__Secure-corpuskit_session=v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}

Deno.test('sealed Worker sessions integrate the real DO, durable SQLite and mandatory audit', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'durable-identity-journey-' })
  const originalNow = Date.now
  let clock = originalNow()
  Date.now = () => clock
  let database: DatabaseSync
  let object: PortalDurableObject
  let state: DurableState
  const calls: string[] = []
  const env = {
    WORKER_NAME: 'corpuskit',
    SESSION_SECRET: fixtureSecret,
    ENTRA_TENANT_ID: 'tenant-1',
    ENTRA_CLIENT_ID: 'fixture-client',
    ENTRA_CLIENT_SECRET: 'fixture-client-secret',
    ENVIRONMENT: 'production',
    ADMIN_BREAK_GLASS: 'true',
    ADMIN_PASSCODE: 'fixture',
    RATE_LIMIT_ASK_PER_MIN: '0',
    RATE_LIMIT_ESTATE_PER_MIN: '0',
    CF_VERSION_METADATA: { id: 'fixture', tag: 'fixture' },
    ASSETS: { fetch: () => Promise.resolve(new Response('fixture')) },
    PORTAL: { getByName: () => object },
  } as unknown as Env
  const start = () => {
    database = new DatabaseSync(`${directory}/state.sqlite`)
    const storage: DurableObjectState['storage'] = {
      sql: {
        exec<T>(query: string, ...bindings: unknown[]) {
          if (!bindings.length && !/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
            database.exec(query)
            return {
              toArray: () => [],
              one: (): T => {
                throw new Error('No rows')
              },
            }
          }
          const statement = database.prepare(query)
          const rows = statement.columns().length
            ? statement.all(...bindings as SQLInputValue[]) as T[]
            : (statement.run(...bindings as SQLInputValue[]), [])
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error('Expected one row')
              return rows[0]!
            },
          }
        },
      },
      transactionSync<T>(callback: () => T): T {
        database.exec('BEGIN IMMEDIATE')
        try {
          const value = callback()
          database.exec('COMMIT')
          return value
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
    }

    object = new workerModule.PortalDurableObject({ storage }, env)
    state = new DurableState(storage.sql, storage)
    trackJourneyProvider((object as unknown as { provider: object }).provider, calls)
  }
  try {
    start()
    const journey: EnforcementJourney = {
      get stores() {
        return (object as unknown as { stores: DurableStores }).stores
      },
      calls,
      boundary: (header) =>
        object.fetch(
          new Request('https://corpuskit.test/api/t/marine/catalog', {
            headers: { 'x-corpuskit-principal': header },
          }),
        ),
      get rbac() {
        return state.rbac
      },
      exec: (sql) => database.exec(sql),
      restart: () => {
        database.close()
        start()
      },
      advance: (ms) => {
        clock += ms
      },
      invoke: async (path, session, init, peer = true) => {
        const headers = new Headers(init?.headers)
        if (session) headers.set('cookie', await sessionCookie(session))
        if (peer) headers.set('cf-connecting-ip', '192.0.2.1')
        headers.set('x-corpuskit-sso-admin', '1')
        if (!headers.has('x-corpuskit-principal')) {
          headers.set('x-corpuskit-principal', 'caller-forgery')
        }
        return workerModule.default.fetch(
          new Request(`https://corpuskit.test${path}`, { ...init, headers }),
          env,
        )
      },
    }
    await assertIdentityJourney(journey)
    await assertEnforcementJourney(journey)
  } finally {
    database!.close()
    Date.now = originalNow
    Deno.removeSync(directory, { recursive: true })
  }
})

/** Only the platform base class and retrieval provider are replaced; identity and DO code are real. */
async function loadWorker(): Promise<WorkerModule> {
  const workerUrl = new URL('./worker.ts', import.meta.url)
  const durableObjectShim =
    'data:application/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'
  const source = (await Deno.readTextFile(workerUrl))
    .replace("from 'cloudflare:workers'", `from '${durableObjectShim}'`)
    .replace(
      "import { AragProvider } from '@research-portal/retrieval'",
      `import { DoubleProvider } from '${
        new URL('../../../e2e/support/double-provider.ts', import.meta.url).href
      }'; class AragProvider extends DoubleProvider {
        invalidate() {}
        summarize() { return Promise.resolve('Abalone evidence summary') }
        rephrase(_config, query) { return Promise.resolve(query) }
        async resourceExtraction(config, id) {
          const results = await this.search(config, 'abalone')
          const resource = results.resources.find((item) => item.id === id)
          if (!resource) throw new Error('Unknown fixture resource')
          return { text: resource.matchedPassage }
        }
      }`,
    )
    .replaceAll(
      /from '(\.\.?\/[^']+)'/g,
      (_match, specifier: string) => `from '${new URL(specifier, workerUrl).href}'`,
    )
  const moduleUrl = `data:application/typescript,${encodeURIComponent(source)}`
  return await import(moduleUrl) as WorkerModule
}
