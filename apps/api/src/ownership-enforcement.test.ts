import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { openLocalRbac } from './rbac-local.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { TenantStore } from './tenants.ts'
import { McpKeyStore } from './stores.ts'
import { buildApp } from './app.ts'
import { sessionFor } from './enforcement-fixture.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

function files(root: string): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  const visit = (path: string) => {
    try {
      for (const entry of Deno.readDirSync(path)) {
        const child = `${path}/${entry.name}`
        if (entry.isDirectory) visit(child)
        else result[child.slice(root.length)] = [...Deno.readFileSync(child)]
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  visit(`${root}/research-v2`)
  return result
}

Deno.test('real local ingress restores exact owned files after observed append and SQL COMMIT failure', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'owned-ingress-' })
  const env = {
    DATA_DIR: directory,
    ENTRA_TENANT_ID: 'tenant-1',
    ENVIRONMENT: 'development',
    ADMIN_PASSCODE: 'fixture',
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
    const ingress = new LocalIngress({ env, tenants, rbac })
    const writer = sessionFor('owner', 'marine', Date.now())
    const owner = { kind: 'user' as const, tenantId: writer.tenantId, oid: writer.oid }
    let before: Record<string, number[]> = {}
    let failure: 'append' | 'commit' | undefined
    let observed = 0
    const owned = localOwnedStores(directory, database, {
      append(event) {
        if (event.action === 'local.mutation') {
          observed++
          expect(files(directory)).not.toEqual(before)
          expect(event.actor_id).toBe(writer.oid)
          expect(event.scope_slug).toBe('marine')
          expect(JSON.parse(event.detail_json).operation).toMatch(
            /^(PUT|POST|DELETE) \/api\/t\/:slug\//,
          )
          if (failure === 'append') throw new Error('fixture append')
        }
        rbac.audit.append(event)
        if (failure === 'commit' && event.action === 'local.mutation') {
          database.exec('INSERT INTO owned_child(parent_id) VALUES (1)')
        }
      },
    })
    database.exec('CREATE TABLE owned_parent(id INTEGER PRIMARY KEY)')
    database.exec(
      'CREATE TABLE owned_child(parent_id INTEGER REFERENCES owned_parent(id) DEFERRABLE INITIALLY DEFERRED)',
    )
    const app = buildApp({
      ...owned,
      rbac,
      tenants,
      audience: 'corpuskit',
      audit: rbac.audit,
      configuredTenantId: env.ENTRA_TENANT_ID,
      provider: new DoubleProvider(),
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
      mcpKeys: new McpKeyStore(directory, { database, audit: rbac.audit }),
    })
    const invoke = (path: string, init: RequestInit, identity: typeof writer | null = writer) =>
      ingress.handle(
        new Request(`http://localhost/api/t/marine/${path}`, init),
        (request) => app.fetch(request),
        { remoteAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 8791 } },
        identity ?? undefined,
      )
    owned.sessions.put('marine', owner, sessionBody)
    const watch = owned.watches.add('marine', owner, 'Existing watch')
    owned.watches.update('marine', watch.id, { changed: true }, owner)
    for (const mode of ['append', 'commit'] as const) {
      for (
        const [path, method, value] of [
          ['sessions/new', 'PUT', { ...sessionBody, id: 'new' }],
          ['sessions/session', 'PUT', { ...sessionBody, title: 'Updated' }],
          ['sessions/session', 'DELETE'],
          ['watches', 'POST', { query: 'New watch' }],
          [`watches/${watch.id}/seen`, 'POST'],
          [`watches/${watch.id}`, 'DELETE'],
        ] as const
      ) {
        before = files(directory)
        failure = mode
        const count = observed
        const response = await invoke(path, body(method, value))
        expect(response.status).toBe(500)
        expect(observed).toBe(count + 1)
        expect(files(directory)).toEqual(before)
        expect(database.all('SELECT * FROM owned_child')).toEqual([])
        expect(
          rbac.audit.read({
            scope: { kind: 'platform' },
            requestId: response.headers.get('x-request-id')!,
          })
            .filter((event) => event.action === 'local.mutation'),
        ).toEqual([])
      }
    }
    failure = undefined
    before = files(directory)
    const success = await invoke(
      'sessions/session',
      body('PUT', { ...sessionBody, title: 'Committed' }),
    )
    expect(success.status).toBe(200)
    expect(owned.sessions.get('marine', owner, 'session')!.title).toBe('Committed')
    for (const path of ['sessions', 'watches']) {
      const denied = await invoke(path, {
        headers: { 'x-admin-passcode': 'fixture', 'x-rp-client': writer.oid },
      }, null)
      expect(denied.status).toBe(403)
    }
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

const sessionBody = { id: 'session', title: 'Research', updatedAt: '2026-09-12', messages: [] }
const body = (method: string, value?: unknown, client = 'browser'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'x-rp-client': client },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
})

Deno.test('local owned scope blocks delayed writes after completion and cancellation', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'owned-scope-' })
  const { database, rbac } = openLocalRbac({ DATA_DIR: directory })
  try {
    const owned = localOwnedStores(directory, database, rbac.audit)
    for (const cancelled of [false, true]) {
      const controller = new AbortController()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let late!: Promise<void>
      await owned.localMutations.run(
        {
          requestId: 'late',
          actor: { kind: 'user', id: 'writer' },
          action: 'request.privileged',
          scope: { kind: 'portal', slug: 'marine' },
          target: { kind: 'sessions' },
          detail: { permission: 'portal.ask', operation: 'PUT /api/t/:slug/sessions/:id' },
        },
        controller.signal,
        () => {
          late = held.then(() => {
            owned.sessions.put('marine', { kind: 'anonymous', clientId: 'late' }, sessionBody)
          })
        },
      )
      if (cancelled) controller.abort()
      const denied = expect(late).rejects.toThrow()
      release()
      await denied
      expect(files(directory)).toEqual({})
    }
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`${adapter} session/watch methods preserve typed owner and portal with no adoption`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const writer = f.sessionFor('analyst', 'public-a')
      const owner = { kind: 'user' as const, tenantId: writer.tenantId, oid: writer.oid }
      const anonymous = { kind: 'anonymous' as const, clientId: writer.oid }
      const base = '/api/t/public-a'
      f.stores.sessions.put('public-a', anonymous, { ...sessionBody, title: 'Anonymous' })
      f.stores.watches.add('public-a', anonymous, 'Anonymous watch')
      const request = (path: string, init?: RequestInit) => f.requestAs(writer, base + path, init)
      expect((await request('/sessions', body('GET', undefined, writer.oid))).status).toBe(200)
      expect(await (await request('/sessions', body('GET', undefined, writer.oid))).json()).toEqual(
        [],
      )
      expect((await request('/sessions/session', body('GET', undefined, writer.oid))).status).toBe(
        404,
      )
      expect((await request('/sessions/session', body('PUT', sessionBody, writer.oid))).status)
        .toBe(200)
      expect(f.stores.sessions.get('public-a', anonymous, 'session')!.title).toBe('Anonymous')
      expect(f.stores.sessions.get('public-a', owner, 'session')!.title).toBe('Research')
      expect((await request('/sessions/session')).status).toBe(200)
      expect(
        await (await f.requestAs(
          null,
          base + '/sessions/session',
          body('GET', undefined, writer.oid),
        )).json(),
      ).toMatchObject({ title: 'Anonymous' })
      for (
        const [path, value] of [['sessions/other', sessionBody], ['sessions/session', {
          ...sessionBody,
          owner,
        }], ['watches', { query: 'Injected', slug: 'b' }]] as const
      ) {
        expect(
          (await request('/' + path, body(path.startsWith('sessions') ? 'PUT' : 'POST', value)))
            .status,
        ).toBe(400)
      }
      const watchResponse = await request(
        '/watches',
        body('POST', { query: 'Signed watch' }, writer.oid),
      )
      expect(watchResponse.status).toBe(200)
      const watch = await watchResponse.json()
      expect(await (await request('/watches')).json()).toHaveLength(1)
      f.stores.watches.update('public-a', watch.id, { changed: true }, owner)
      expect((await request(`/watches/${watch.id}/seen`, body('POST'))).status).toBe(200)
      expect(f.stores.watches.list('public-a', owner)[0]!.changed).toBe(false)
      const other = f.sessionFor('portal-admin', 'public-a')
      const denied = [
        ['/sessions/session', 'GET'],
        ['/sessions/session', 'DELETE'],
        [`/watches/${watch.id}/seen`, 'POST'],
        [`/watches/${watch.id}`, 'DELETE'],
      ]
      for (const [path, method] of denied) {
        expect((await f.requestAs(other, base + path, body(method!, undefined, writer.oid))).status)
          .toBe(404)
        expect((await f.requestAs(writer, '/api/t/public-b' + path, body(method!))).status).toBe(
          path!.startsWith('/watches') ? 403 : 404,
        )
      }
      expect(
        (await f.requestAs(
          null,
          base + `/watches/${watch.id}/seen`,
          body('POST', undefined, writer.oid),
        )).status,
      ).toBe(401)
      expect((await request('/sessions/session', body('DELETE'))).status).toBe(200)
      expect((await request(`/watches/${watch.id}`, body('DELETE'))).status).toBe(200)
      expect(f.stores.sessions.get('public-a', owner, 'session')).toBeNull()
      expect(f.stores.watches.list('public-a', owner)).toEqual([])
      expect(f.stores.watches.list('public-a', anonymous)).toHaveLength(1)
      f.assertNoProtectedDispatch()
    } finally {
      f.close()
    }
  })
}

Deno.test('owned routes reject keys even with an ambient owner and deny restricted anonymous access', async () => {
  const f = createEnforcementFixture()
  try {
    const key = await issueScopedKey(
      { slug: 'a', label: 'Owned refusal', role: 'analyst' },
      f.creator,
      f.authorityDependencies(),
    )
    key.commit()
    for (
      const [path, method, value] of [
        ['sessions', 'GET'],
        ['sessions/session', 'GET'],
        ['sessions/session', 'PUT', sessionBody],
        ['sessions/session', 'DELETE'],
        ['watches', 'GET'],
        ['watches', 'POST', { query: 'Research' }],
        ['watches/watch/seen', 'POST'],
        ['watches/watch', 'DELETE'],
      ] as const
    ) {
      const response = await f.requestAs(f.sessionFor('owner'), `/api/t/a/${path}`, {
        ...body(method, value),
        headers: { authorization: `Bearer ${key.key}`, 'x-rp-client': 'browser' },
      })
      expect(response.status).toBe(403)
      expect((await f.requestAs(null, `/api/t/a/${path}`, body(method, value))).status).toBe(401)
    }
    f.failAudit()
    expect((await f.requestAs(null, '/api/t/public-a/sessions')).status).toBe(500)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('owned session and watch routes deny missing browser identity and anonymous watch writes', async () => {
  const f = createEnforcementFixture()
  try {
    for (const client of [undefined, '', ' ', 'x'.repeat(129), 'bad,client', 'anonymous']) {
      for (const path of ['sessions', 'watches']) {
        const response = await f.requestAs(null, `/api/t/public-a/${path}`, {
          headers: client === undefined ? {} : { 'x-rp-client': client },
        })
        expect(response.status).toBe(401)
      }
    }
    const response = await f.requestAs(null, '/api/t/public-a/watches', {
      method: 'POST',
      headers: { 'x-rp-client': 'browser' },
      body: JSON.stringify({ query: 'Research' }),
    })
    expect(response.status).toBe(401)
    expect(f.stores.watches.list('public-a')).toEqual([])
    expect(
      f.rbac.audit.read({ scope: { kind: 'platform' } }).filter((e) =>
        e.action === 'request.denied'
      ),
    ).toHaveLength(13)
  } finally {
    f.close()
  }
})

Deno.test('public anonymous sessions stay usable with a valid ID and reject unsupported path IDs', async () => {
  const f = createEnforcementFixture()
  try {
    const base = '/api/t/public-a/sessions'
    expect((await f.requestAs(null, `${base}/session`, body('PUT', sessionBody))).status).toBe(200)
    expect(await (await f.requestAs(null, base, body('GET'))).json()).toHaveLength(1)
    expect((await f.requestAs(null, `${base}/session`, body('GET'))).status).toBe(200)
    for (const invalid of ['x'.repeat(129), '%22'.repeat(65)]) {
      expect((await f.requestAs(null, `${base}/${invalid}`, body('GET'))).status).toBe(403)
    }
    expect((await f.requestAs(null, `${base}/session`, body('DELETE'))).status).toBe(200)
    expect(await (await f.requestAs(null, base, body('GET'))).json()).toEqual([])
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})
