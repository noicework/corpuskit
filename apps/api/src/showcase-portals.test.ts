import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { LocalIngress } from './local-ingress.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { buildApp } from './app.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { showcasePortals, showcasePortalsWarning, TenantStore } from './tenants.ts'
import { runSystemMaintenance } from './scheduler.ts'
import { SourceStore } from './stores.ts'
import { EnrichmentStore } from './enrichments.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

// The seeded showcase portals (marine, grains) are compiled into every build. A deployment
// serves them only when SHOWCASE_PORTALS names them; otherwise they are not portals there at all.

const peer = { remoteAddr: { transport: 'tcp' as const, hostname: '192.0.2.1', port: 40000 } }

/** The local server's stack over its file stores, configured by `env`. */
function localServer(env: Record<string, string>) {
  const directory = Deno.makeTempDirSync({ prefix: 'showcase-' })
  const database = new LocalRbacDatabase(':memory:')
  const rbac = new RbacState(database)
  rbac.migrate()
  const settings = { ...env, TENANTS_PATH: `${directory}/tenants.json` }
  const owned = localOwnedStores(directory, database, rbac.audit, settings)
  const tenants = owned.tenants!
  const ingress = new LocalIngress({
    rbac,
    tenants,
    env: { ENTRA_TENANT_ID: 'tenant-1', ...settings },
  })
  const app = buildApp({
    ...owned,
    tenants,
    provider: new DoubleProvider(),
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    rateLimitAskPerMin: 0,
    rateLimitAnonPortalAskPerMin: 0,
  })
  const request = async (path: string, init?: RequestInit) => {
    const response = await ingress.handle(
      new Request(`http://localhost${path}`, init),
      (forwarded) => app.fetch(forwarded),
      peer,
    )
    return { status: response.status, text: await response.text() }
  }
  return {
    directory,
    rbac,
    owned,
    tenants,
    request,
    close: () => {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

const slugsOf = (text: string) => (JSON.parse(text) as { slug: string }[]).map((t) => t.slug)

Deno.test('the showcase portals are off unless SHOWCASE_PORTALS names them', () => {
  expect([...showcasePortals({})]).toEqual([])
  expect([...showcasePortals({ SHOWCASE_PORTALS: '' })]).toEqual([])
  expect([...showcasePortals({ SHOWCASE_PORTALS: 'marine,grains' })].sort()).toEqual([
    'grains',
    'marine',
  ])
  expect([...showcasePortals({ SHOWCASE_PORTALS: ' Grains ' })]).toEqual(['grains'])
  // Names that are not seeded showcase portals are ignored, and said so at start-up.
  expect([...showcasePortals({ SHOWCASE_PORTALS: 'marine,acme' })]).toEqual(['marine'])
  expect(showcasePortalsWarning({ SHOWCASE_PORTALS: 'marine,acme' })).toContain('acme')
  expect(showcasePortalsWarning({ SHOWCASE_PORTALS: 'marine,grains' })).toBeNull()
  expect(showcasePortalsWarning({})).toBeNull()
})

Deno.test('a deployment that does not turn the showcase on lists and serves no showcase portal', async () => {
  const server = localServer({})
  try {
    expect(server.tenants.list(true)).toEqual([])
    expect(server.tenants.get('marine')).toBeUndefined()
    // The deployment's own portal, public as every new portal is.
    server.tenants.add({ name: 'Acme Research' })
    // The portal list, and a cross-portal ask, reach no showcase portal.
    const listed = await server.request('/api/tenants')
    expect(listed.status).toBe(200)
    expect(slugsOf(listed.text)).toEqual(['acme-research'])
    const estate = await server.request('/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    expect(estate.status).toBe(200)
    expect(estate.text).toContain('"slug":"acme-research"')
    expect(estate.text).not.toContain('"slug":"marine"')
    expect(estate.text).not.toContain('"slug":"grains"')
    // Every route answers for a showcase slug exactly as for a slug that never held a portal.
    for (
      const path of [
        '/api/t/%s/config',
        '/api/t/%s/search?q=abalone',
        '/api/t/%s/resources',
        '/api/admin/t/%s/lifecycle',
      ]
    ) {
      const showcase = await server.request(path.replace('%s', 'marine'))
      const unknown = await server.request(path.replace('%s', 'no-such-portal'))
      expect({ path, ...showcase }).toEqual({ path, ...unknown })
    }
    // A portal named like a showcase portal never takes its slug, so turning the showcase on
    // later cannot put a seed in front of it.
    expect(server.tenants.add({ name: 'Marine' }).slug).toBe('marine-2')
    // Nightly maintenance never visits them.
    const visited: string[] = []
    await runSystemMaintenance(
      {
        listResources: (config: { slug: string }) => {
          visited.push(config.slug)
          return Promise.resolve([])
        },
        invalidate: () => {},
      } as unknown as AragProvider,
      {
        rbac: server.rbac,
        tenants: server.tenants,
        watches: server.owned.watches!,
        sources: new SourceStore(server.directory),
        enrichments: new EnrichmentStore(server.directory),
      },
      undefined,
      ['enrichment'],
      false,
    )
    expect([...new Set(visited)].sort()).toEqual(['acme-research', 'marine-2'])
  } finally {
    server.close()
  }
})

Deno.test('a deployment serves exactly the showcase portals SHOWCASE_PORTALS names', async () => {
  const server = localServer({ SHOWCASE_PORTALS: 'grains' })
  try {
    expect(slugsOf((await server.request('/api/tenants')).text)).toEqual(['grains'])
    expect((await server.request('/api/t/grains/config')).status).toBe(200)
    const marine = await server.request('/api/t/marine/config')
    const unknown = await server.request('/api/t/no-such-portal/config')
    expect(marine).toEqual(unknown)
  } finally {
    server.close()
  }
  const both = localServer({ SHOWCASE_PORTALS: 'marine,grains' })
  try {
    expect(slugsOf((await both.request('/api/tenants')).text).sort()).toEqual(['grains', 'marine'])
  } finally {
    both.close()
  }
})

Deno.test('turning the showcase off keeps what it stored, and turning it back on restores it', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'showcase-toggle-' })
  try {
    const path = `${directory}/tenants.json`
    const on = new TenantStore({ TENANTS_PATH: path, SHOWCASE_PORTALS: 'marine' })
    on.patch('marine', { searchPlaceholder: 'Search the reef archive' })
    const off = new TenantStore({ TENANTS_PATH: path })
    expect(off.get('marine')).toBeUndefined()
    expect(off.list()).toEqual([])
    const again = new TenantStore({ TENANTS_PATH: path, SHOWCASE_PORTALS: 'marine' })
    expect(again.get('marine')?.searchPlaceholder).toBe('Search the reef archive')
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a caller who can see no portal gets an empty list, not a refusal', async () => {
  const server = localServer({})
  try {
    // A deployment with no portal at all.
    expect(await server.request('/api/tenants')).toEqual({ status: 200, text: '[]' })
    // A deployment whose only portal an anonymous caller may not see.
    const restricted = server.tenants.add({ name: 'Private Archive' })
    server.tenants.patch(restricted.slug, { accessMode: 'restricted' })
    expect(await server.request('/api/tenants')).toEqual({ status: 200, text: '[]' })
    // Nothing is recorded as a refusal.
    const denials = server.rbac.audit.read({ scope: { kind: 'platform' }, limit: 100 })
      .filter((event) => event.action === 'request.denied')
    expect(denials).toEqual([])
    // A cross-portal ask with nowhere to ask is still refused.
    const estate = await server.request('/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    expect(estate.status).toBe(401)
  } finally {
    server.close()
  }
})

Deno.test('a record stored under a showcase slug is never served as a portal of its own', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'showcase-shadow-' })
  try {
    const path = `${directory}/tenants.json`
    const own = new TenantStore({ TENANTS_PATH: path }).add({ name: 'Stray' })
    // As a restore or a hand edit could leave it: a portal record under the marine slug.
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        custom: { marine: { ...own, slug: 'marine' } },
        overrides: {},
        disabled: [],
        retired: [],
      }),
    )
    const off = new TenantStore({ TENANTS_PATH: path })
    expect(off.get('marine')).toBeUndefined()
    expect(off.list()).toEqual([])
    const on = new TenantStore({ TENANTS_PATH: path, SHOWCASE_PORTALS: 'marine' })
    expect(on.get('marine')?.branding.organisation).toBe('Southern Waters Research Institute')
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})
