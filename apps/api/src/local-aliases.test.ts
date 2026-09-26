import { expect } from '@std/expect'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { buildApp } from './app.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { TenantStore } from './tenants.ts'

const operatorKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

function fixture() {
  const directory = Deno.makeTempDirSync({ prefix: 'local-aliases-' })
  const database = new LocalRbacDatabase(`${directory}/rbac.sqlite`)
  const rbac = new RbacState(database)
  rbac.migrate()
  const env = {
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'hosting-test',
    ADMIN_PASSCODE: 'fixture-passcode',
    MAX_PORTAL_ALIASES: '3',
  }
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  const ingress = new LocalIngress({ rbac, tenants, env })
  const app = buildApp({
    ...owned,
    rbac,
    tenants,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    provider: new DoubleProvider(),
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    maxPortalAliases: 3,
  })
  const request = (host: string, path: string, init: RequestInit = {}, operator = false) => {
    const headers = new Headers(init.headers)
    if (operator) headers.set('authorization', `Operator ${operatorKey}`)
    return ingress.handle(
      new Request(`http://${host}${path}`, { ...init, headers }),
      (clean) => app.fetch(clean),
    )
  }
  return {
    env,
    rbac,
    ingress,
    request,
    events: () => rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 }),
    dispose() {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

Deno.test('the local server manages portal host aliases through the operator routes', async () => {
  const f = fixture()
  try {
    let response = await f.request(
      'localhost',
      '/api/admin/t/marine/aliases/Research.Example.org.',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"primary":true}' },
      true,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      aliases: [{ hostname: 'research.example.org', primary: true, createdAt: expect.any(String) }],
      hostname: 'research.example.org',
    })
    // Written to the registry file, where a restarted server finds it.
    expect(new TenantStore(f.env).aliasPortal('research.example.org')).toBe('marine')
    response = await f.request('localhost', '/api/admin/t/grains/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'hostname_taken' })
    for (const name of ['two', 'three']) {
      await f.request('localhost', `/api/admin/t/marine/aliases/${name}.example.org`, {
        method: 'PUT',
      }, true)
    }
    response = await f.request('localhost', '/api/admin/t/marine/aliases/four.example.org', {
      method: 'PUT',
    }, true)
    expect(await response.json()).toEqual({ error: 'alias_limit' })
    response = await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'DELETE',
    }, true)
    expect(response.status).toBe(200)
    expect((await response.json()).hostname).toBe('marine.corpuskit.org')
    const actions = f.events().filter((event) => event.action.startsWith('portal.alias.'))
    expect(actions.every((event) => event.actor_id === 'operator:hosting-test')).toBe(true)
    expect(actions.some((event) => event.action === 'portal.alias.remove')).toBe(true)
  } finally {
    f.dispose()
  }
})

Deno.test('the local server serves an alias host as the Worker does', async () => {
  const f = fixture()
  try {
    await f.request('localhost', '/api/admin/t/marine/aliases/research.example.org', {
      method: 'PUT',
    }, true)
    const host = 'research.example.org'
    let response = await f.request(host, '/?x=1')
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/t/marine?x=1')
    expect(f.ingress.hostPortal(new Request(`http://${host}/t/marine`))).toBe('marine')
    expect(f.ingress.hostPortal(new Request('http://localhost/t/marine'))).toBeUndefined()

    response = await f.request(host, '/api/t/marine/config')
    expect(response.status).toBe(200)
    response = await f.request(host, '/api/tenants')
    expect((await response.json()).map((row: { slug: string }) => row.slug)).toEqual(['marine'])
    for (
      const path of [
        '/api/t/grains/config',
        '/api/admin/overview',
        '/api/admin/t/marine/lifecycle',
        '/api/admin/t/marine/aliases',
      ]
    ) {
      response = await f.request(host, path, {
        headers: { 'x-admin-passcode': 'fixture-passcode' },
      })
      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    for (const path of ['/t/grains', '/about', '/admin', '/docs/']) {
      expect((await f.request(host, path)).status, path).toBe(404)
    }
    response = await f.request(host, '/auth/me?portal=grains')
    expect((await response.json()).portalAccess).toBeNull()

    // Operator credentials are refused on the alias host and audited as the operator.
    response = await f.request(host, '/api/admin/t/marine/aliases', {}, true)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'operator_not_allowed' })
    expect(
      f.events().some((event) =>
        event.action === 'request.denied' && event.actor_id === 'operator:hosting-test' &&
        JSON.parse(event.detail_json).code === 'operator_not_allowed'
      ),
    ).toBe(true)
    // Other hosts are unchanged.
    expect((await f.request('localhost', '/api/t/grains/config')).status).toBe(200)
    expect((await f.request('other.example.org', '/api/t/grains/config')).status).toBe(200)
  } finally {
    f.dispose()
  }
})
