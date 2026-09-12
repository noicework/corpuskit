import { expect } from '@std/expect'
import type { TenantPatch } from './tenants.ts'
import { tenantConfig, TenantStore } from './tenants.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import type { AragProvider } from '@research-portal/retrieval'
import { issueScopedKey } from './scoped-keys.ts'
import type { TrustedSessionFacts } from './principal.ts'
import { buildApp } from './app.ts'
import { type TenantConfig } from '@research-portal/core'

const estateInit = (slugs?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'Abalone', ...(slugs === undefined ? {} : { slugs }) }),
})
const eventSlugs = (text: string) =>
  [
    ...new Set(
      text.split('\n').filter((line) => line.startsWith('data: ')).map((line) =>
        JSON.parse(line.slice(6)).slug
      ).filter(Boolean),
    ),
  ].sort()

Deno.test('aggregate persona matrix returns only exact visible sets before stream consumption', async () => {
  const f = createEnforcementFixture()
  const publicSlugs = ['grains', 'marine', 'public-a', 'public-b']
  try {
    for (
      const [session, extra] of [
        [null, []],
        [f.otherTenant, []],
        [f.unassigned, ['authenticated-a', 'authenticated-b']],
        [f.sessionFor('viewer'), ['a', 'authenticated-a', 'authenticated-b']],
        [f.sessionFor('viewer', 'b'), ['b', 'authenticated-a', 'authenticated-b']],
        [f.sessionFor('platform-admin'), ['a', 'b', 'authenticated-a', 'authenticated-b']],
      ] as [TrustedSessionFacts | null, string[]][]
    ) {
      const expected = [...publicSlugs, ...extra].sort()
      const directory = await f.requestAs(session, '/api/tenants')
      expect(directory.status).toBe(200)
      expect(directory.headers.get('cache-control')).toBe('private, no-store')
      expect((await directory.json()).map((row: { slug: string }) => row.slug).sort()).toEqual(
        expected,
      )
      f.providerCalls.length = 0
      const estate = await f.requestAs(session, '/api/ask-estate', estateInit())
      expect(estate.status).toBe(200)
      // Calls already begun before a consumer reads the stream must also be scoped.
      expect(
        f.providerCalls.filter((call) => call.method === 'ask').map((call) =>
          (call.args[0] as TenantConfig).slug
        ).sort(),
      ).toEqual(expected)
      expect(estate.headers.get('cache-control')).toBe('private, no-store')
      const body = await estate.text()
      expect(eventSlugs(body)).toEqual(expected)
      expect(body).toContain('estate-done')
      expect(body).toContain('"type":"delta"')
      expect(body).not.toContain('"type":"error"')
    }
    expect(f.database.all("SELECT id FROM audit_events WHERE action='request.denied'")).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('aggregate empty or foreign selections deny once; malformed selections never dispatch', async () => {
  const f = createEnforcementFixture()
  try {
    for (const selection of [[], ['b'], ['missing'], ['disabled'], ['corrupt']]) {
      const before =
        f.database.all("SELECT id FROM audit_events WHERE action='request.denied'").length
      const response = await f.requestAs(
        f.sessionFor('viewer'),
        '/api/ask-estate',
        estateInit(selection),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
      expect(f.database.all("SELECT id FROM audit_events WHERE action='request.denied'"))
        .toHaveLength(before + 1)
      f.assertNoProtectedDispatch()
    }
    for (const selection of [null, 'a', [1], ['../a'], ['']]) {
      const response = await f.requestAs(null, '/api/ask-estate', estateInit(selection))
      expect(response.status).toBe(400)
      await response.text()
      f.assertNoProtectedDispatch()
    }
    for (const { slug } of f.stores.tenants.list()) {
      f.stores.tenants.patch(slug, { accessMode: 'restricted' })
    }
    for (
      const [path, init] of [['/api/tenants', undefined], [
        '/api/ask-estate',
        estateInit(),
      ]] as const
    ) {
      const response = await f.requestAs(null, path, init)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorised' })
      f.failAudit()
      const failed = await f.requestAs(null, path, init)
      expect(failed.status).toBe(500)
      expect(failed.headers.get('cache-control')).toBe('private, no-store')
      expect(await failed.json()).toEqual({ error: 'audit_write_failed' })
      f.recoverAudit()
      f.assertNoProtectedDispatch()
    }
  } finally {
    f.close()
  }
})

Deno.test('aggregate scoped keys reject before registry enumeration even with an ambient owner', async () => {
  const f = createEnforcementFixture()
  try {
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Read', role: 'viewer' },
      f.creator,
      f.authorityDependencies(),
    )
    prepared.commit()
    for (const session of [null, f.sessionFor('owner')]) {
      const context = await f.contextFor(session)
      const app = buildApp({
        ...f.stores,
        provider: f.provider,
        configuredTenantId: f.tenantId,
        audience: f.audience,
        now: f.now,
        requestContext: () => ({ ...context, requestId: crypto.randomUUID() }),
        breakGlass: f.rbac.breakGlassService({ environment: 'production' }),
      })
      const original = f.stores.tenants.list.bind(f.stores.tenants)
      let enumerations = 0
      f.stores.tenants.list = (...args) => {
        enumerations++
        return original(...args)
      }
      try {
        for (
          const [path, init] of [['/api/tenants', {}], [
            '/api/ask-estate',
            estateInit(['a']),
          ]] as const
        ) {
          const response = await app.request(path, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init.headers)),
              authorization: `Bearer ${prepared.key}`,
            },
          })
          expect(response.status).toBe(session ? 403 : 401)
          expect(await response.json()).toEqual({ error: session ? 'forbidden' : 'unauthorised' })
          expect(enumerations).toBe(0)
          f.assertNoProtectedDispatch()
        }
      } finally {
        f.stores.tenants.list = original
      }
    }
    expect(f.database.all("SELECT id FROM audit_events WHERE action='request.denied'"))
      .toHaveLength(4)
  } finally {
    f.close()
  }
})

Deno.test('an allowed provider failure never dispatches to or identifies a hidden estate target', async () => {
  const f = createEnforcementFixture()
  try {
    f.provider.ask = () => {
      throw new Error('upstream fixture failure')
    }
    const response = await f.requestAs(null, '/api/ask-estate', estateInit(['public-a', 'a']))
    expect(response.status).toBe(200)
    expect(f.providerCalls.map((call) => (call.args[0] as TenantConfig).slug)).toEqual(['public-a'])
    const text = await response.text()
    expect(eventSlugs(text)).toEqual(['public-a'])
    expect(text).toContain('"type":"error"')
    expect(text).toContain('estate-done')
  } finally {
    f.close()
  }
})

Deno.test('local and Durable registry predicates run before metadata projection and propagate failures', () => {
  const f = createEnforcementFixture()
  try {
    const local = new TenantStore({ TENANTS_PATH: `${f.directory}/local-tenants.json` })
    for (const store of [local, f.stores.tenants]) {
      const original = store.get.bind(store)
      store.get = (slug) => {
        const config = original(slug)
        return config && new Proxy(config, {
          get(target, property) {
            if (property === 'branding') throw new Error('metadata was projected')
            return Reflect.get(target, property)
          },
        })
      }
      expect(store.list(false, () => false)).toEqual([])
      expect(() =>
        store.list(false, () => {
          throw new Error('predicate failure')
        })
      ).toThrow('predicate failure')
      store.get = original
      expect(store.list(false, (config) => config.slug === 'marine').map((row) => row.slug))
        .toEqual(['marine'])
    }
  } finally {
    f.close()
  }
})

Deno.test('estate cancellation closes the selected provider iterator without consuming hidden targets', async () => {
  const f = createEnforcementFixture()
  let count = 0
  const finished = Promise.withResolvers<void>()
  try {
    f.provider.ask = async function* () {
      try {
        for (let index = 0; index < 20; index++) {
          count++
          yield { type: 'delta' as const, text: 'chunk' }
        }
      } finally {
        finished.resolve()
      }
    }
    const response = await f.requestAs(null, '/api/ask-estate', estateInit(['public-a', 'a']))
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    await finished.promise
    expect(count).toBeLessThan(20)
    expect(f.providerCalls.map((call) => (call.args[0] as TenantConfig).slug)).toEqual(['public-a'])
  } finally {
    f.close()
  }
})

Deno.test('directory and estate fan-out exclude every hidden portal without poisoning visible targets', async () => {
  const f = createEnforcementFixture()
  try {
    const response = await f.requestAs(null, '/api/tenants')
    const slugs = (await response.json()).map((row: { slug: string }) => row.slug)
    expect(slugs).toContain('public-a')
    expect(slugs).not.toContain('a')
    expect(slugs).not.toContain('authenticated-a')
    const estate = await f.requestAs(null, '/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Abalone', slugs: ['public-a', 'a'] }),
    })
    expect(estate.status).toBe(200)
    const text = await estate.text()
    expect(text).toContain('"slug":"public-a"')
    expect(text).not.toContain('"slug":"a"')
    expect(
      f.providerCalls.filter((call) => call.method === 'ask').map((call) =>
        (call.args[0] as { slug: string }).slug
      ),
    ).toEqual(['public-a'])
  } finally {
    f.close()
  }
})

function readFixture() {
  const calls: string[] = []
  const management = {
    thumbnailResponse: () => {
      calls.push('thumbnail')
      return Promise.resolve(
        new Response('thumbnail', {
          headers: { 'cache-control': 'public, max-age=86400', etag: '"v1"' },
        }),
      )
    },
    fileStream: (_config: unknown, _id: string, _field: string, range?: string) => {
      calls.push('file')
      return Promise.resolve(
        new Response(range ? 'fi' : 'file bytes', {
          status: range ? 206 : 200,
          headers: {
            'cache-control': 'public, max-age=300',
            etag: '"v1"',
            ...(range ? { 'content-range': 'bytes 0-1/10' } : {}),
          },
        }),
      )
    },
    resourceContent: () => {
      calls.push('content')
      return Promise.resolve({
        id: 'res-1',
        title: 'Abalone',
        kind: 'pdf',
        texts: [],
        transcript: [],
        files: [{ group: 'files', fieldId: 'file' }],
      })
    },
    typeahead: () => {
      calls.push('typeahead')
      return Promise.resolve({ entities: ['Abalone'], titles: [] })
    },
    relationsGraph: () => {
      calls.push('relations')
      return Promise.resolve({
        nodes: [{ id: 'Abalone', group: 'species', weight: 1 }, {
          id: 'Ocean',
          group: 'place',
          weight: 1,
        }],
        edges: [{ source: 'Abalone', target: 'Ocean', label: 'lives in' }],
      })
    },
    entityGroups: () => {
      calls.push('entities')
      return Promise.resolve([{ group: 'species', entities: ['Abalone'] }])
    },
    counters: () => {
      calls.push('counters')
      return Promise.resolve({ resources: 2 })
    },
    graphData: () => {
      calls.push('graph')
      return Promise.resolve({ nodes: [{ id: 'stock-assessment' }], edges: [] })
    },
  } as unknown as AragProvider
  const f = createEnforcementFixture({ management })
  f.provider.labelsets = () =>
    Promise.resolve([
      { id: 'topic', title: 'Topic', multiple: true, labels: ['stock-assessment'] },
      { id: 'format', title: 'Format', multiple: false, labels: ['article'] },
    ])
  for (const slug of ['a', 'public-a', 'authenticated-a']) {
    f.stores.bindings.set(slug, { baseUrl: 'https://example.test/kb/research', token: 'fixture' })
    for (const kind of ['logo', 'hero', 'font-heading', 'font-body'] as const) {
      f.stores.branding.put(slug, kind, {
        bytes: new TextEncoder().encode(kind),
        contentType: 'image/png',
        version: '1',
      })
    }
    f.stores.enrichments.put(slug, 'res-1', {
      schemaId: 'suggested-questions',
      data: { questions: ['Cached question?'] },
      generatedAt: new Date(f.now()).toISOString(),
    })
  }
  return { ...f, calls }
}

// Independent route fixtures, with actual payload or dispatch proof for every activated read.
const reads = [
  ['config', '', 'searchPlaceholder', null],
  ['branding/logo', '', 'logo', null],
  ['branding/hero', '', 'hero', null],
  ['branding/font-heading', '', 'font-heading', null],
  ['branding/font-body', '', 'font-body', null],
  ['resources/res-1/thumbnail', '', 'thumbnail', 'thumbnail'],
  ['search', '?q=abalone', 'res-1', 'search'],
  ['docs/search', '?q=abalone', 'res-1', 'search'],
  ['catalog', '', 'res-1', 'catalog'],
  ['topics/stock-assessment/resources', '', 'res-1', 'topicResources'],
  ['facets', '', 'stock-assessment', 'facets'],
  ['labelsets', '', 'stock-assessment', 'labelsets'],
  ['suggest', '', 'sq-1', 'suggest'],
  ['resources', '', 'res-1', 'listResources'],
  ['resources/res-1', '', 'res-1', 'resource'],
  ['resources/res-1/questions', '', 'Cached question?', null],
  ['resources/res-1/content', '', 'res-1', 'content'],
  ['resources/res-1/file/file', '', 'file bytes', 'file'],
  ['typeahead', '?q=ab', 'Abalone', 'typeahead'],
  ['graph/relations', '', 'Abalone', 'relations'],
  ['entities', '', 'species', 'entities'],
  ['knowledge-box', '', 'connected', null],
  ['counters', '', 'resources', 'counters'],
  ['graph', '', 'stock-assessment', 'graph'],
  ['entity', '?name=Abalone', 'Abalone', 'relations'],
] as const

Deno.test('every tenant read independently enforces public, configured-tenant and scoped roles', async (t) => {
  for (const [path, query, expected, dispatch] of reads) {
    await t.step(path, async () => {
      const f = readFixture()
      try {
        const scenarios: [string, TrustedSessionFacts | null, boolean][] = [
          ['public-a', null, true],
          ['authenticated-a', f.unassigned, true],
          ['a', f.sessionFor('viewer'), true],
          ['a', null, false],
          ['a', f.sessionFor('viewer', 'b'), false],
          ['authenticated-a', null, false],
          ['authenticated-a', f.otherTenant, false],
          ['disabled', null, false],
          ['corrupt', null, false],
          ['missing', null, false],
        ]
        for (const [slug, session, allowed] of scenarios) {
          f.providerCalls.length = 0
          f.calls.length = 0
          const response = await f.requestAs(session, `/api/t/${slug}/${path}${query}`)
          const body = await response.text()
          expect(response.headers.get('cache-control')).toBe('private, no-store')
          if (allowed) {
            expect(response.status).toBe(200)
            expect(body).toContain(expected)
            if (dispatch) {
              expect([
                ...f.calls,
                ...f.providerCalls.map((c) => c.method),
              ]).toContain(dispatch)
            }
          } else {
            const safe = path === 'config' && !['disabled', 'corrupt', 'missing'].includes(slug)
            expect(response.status).toBe(safe ? 200 : session ? 403 : 401)
            if (safe) expect(body).not.toContain('searchPlaceholder')
            f.assertNoProtectedDispatch()
            expect(f.calls).toEqual([])
          }
        }
      } finally {
        f.close()
      }
    })
  }
})

/** Minimal RFC shared-cache rules: never store private/no-store, only explicit fresh responses. */
class SharedCache {
  entries = new Map<string, Response>()
  async fetch(key: string, origin: () => Response | Promise<Response>) {
    const hit = this.entries.get(key)
    if (hit) return hit.clone()
    const response = await origin()
    const directives = response.headers.get('cache-control') ?? ''
    if (
      !/(?:private|no-store)/i.test(directives) &&
      /(?:s-maxage|max-age)=[1-9]\d*/i.test(directives) && [200, 206, 304].includes(response.status)
    ) this.entries.set(key, response.clone())
    return response
  }
}

Deno.test('shared caches cannot replay bytes across revocation or mutable portal modes; HEAD and validators reauthorise', async () => {
  const f = readFixture()
  try {
    const cache = new SharedCache()
    for (
      const path of [
        'config',
        'branding/logo',
        'branding/hero',
        'branding/font-heading',
        'branding/font-body',
        'resources/res-1/thumbnail',
        'resources/res-1/content',
        'resources/res-1/file/file',
      ]
    ) {
      const url = `/api/t/public-a/${path}`
      const allowed = await cache.fetch(url, () => f.requestAs(null, url))
      expect(allowed.status).toBe(200)
      await allowed.text()
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin', 'public-a'),
          '/api/admin/t/public-a/access',
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessMode: 'restricted' }),
          },
        )).status,
      ).toBe(200)
      for (const method of ['GET', 'HEAD']) {
        f.providerCalls.length = 0
        f.calls.length = 0
        const denied = await cache.fetch(
          url,
          () =>
            f.requestAs(null, url, {
              method,
              headers: {
                'if-none-match': '"v1"',
                'if-modified-since': new Date(f.now()).toUTCString(),
                range: 'bytes=0-1',
              },
            }),
        )
        expect(denied.status).toBe(path === 'config' ? 200 : 401)
        expect(denied.headers.get('cache-control')).toBe('private, no-store')
        f.assertNoProtectedDispatch()
        expect(f.calls).toEqual([])
        await denied.text()
      }
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin', 'public-a'),
          '/api/admin/t/public-a/access',
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessMode: 'public' }),
          },
        )).status,
      ).toBe(200)
    }
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Read', role: 'viewer' },
      f.creator,
      f.authorityDependencies(),
    )
    prepared.commit()
    const url = '/api/t/a/resources/res-1/file/file'
    const headers = { authorization: `Bearer ${prepared.key}`, range: 'bytes=0-1' }
    const allowed = await cache.fetch(url, () => f.requestAs(null, url, { headers }))
    expect(allowed.status).toBe(206)
    expect(await allowed.text()).toBe('fi')
    f.stores.mcpKeys.revoke('a', prepared.credential.id, new Date(f.now()).toISOString())
    const denied = await cache.fetch(url, () => f.requestAs(f.creator, url, { headers }))
    expect(denied.status).toBe(403)
    await denied.text()
    const session = f.sessionFor('viewer')
    const before = await cache.fetch(url, () => f.requestAs(session, url, { method: 'HEAD' }))
    expect(before.status).toBe(200)
    expect(await before.text()).toBe('')
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    service.remove(service.list().find((row) => row.subjectId === session.oid)!.id, {
      requestId: 'revoke',
      actor: { kind: 'system' },
    })
    const after = await cache.fetch(url, () => f.requestAs(session, url, { method: 'HEAD' }))
    expect(after.status).toBe(403)
    await after.text()
    expect(cache.entries.size).toBe(0)
  } finally {
    f.close()
  }
})

Deno.test('invalid explicit config credentials and failed denial audit cannot return safe metadata', async () => {
  const f = readFixture()
  try {
    for (
      const headers of [{ authorization: 'Bearer invalid' }, {
        authorization: 'Bearer ck_invalid',
        'x-admin-passcode': 'invalid',
      }] as Record<string, string>[]
    ) {
      const response = await f.requestAs(f.creator, '/api/t/a/config', { headers })
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('branding')
    }
    f.failAudit()
    for (const path of ['config', 'resources']) {
      const response = await f.requestAs(null, `/api/t/a/${path}`)
      expect(response.status).toBe(500)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.text()).not.toContain('branding')
    }
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('local branding bytes retain no-store and lose access immediately when mode changes', async () => {
  const f = createEnforcementFixture()
  try {
    const directory = `${f.directory}/local-branding`
    Deno.mkdirSync(directory)
    for (const kind of ['logo', 'hero', 'font-heading', 'font-body']) {
      Deno.writeTextFileSync(
        `${directory}/public-a-${kind}.${kind.startsWith('font') ? 'woff2' : 'png'}`,
        kind,
      )
    }
    const app = buildApp({
      ...f.stores,
      branding: undefined,
      brandingPath: directory,
      provider: f.provider,
      configuredTenantId: f.tenantId,
      audience: f.audience,
      now: f.now,
      breakGlass: f.rbac.breakGlassService({ environment: 'production' }),
    })
    const cache = new SharedCache()
    for (const kind of ['logo', 'hero', 'font-heading', 'font-body']) {
      const url = `/api/t/public-a/branding/${kind}`
      const response = await cache.fetch(url, () => app.request(url))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(kind)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    f.stores.tenants.patch('public-a', { accessMode: 'restricted' })
    const config = await app.request('/api/t/public-a/config')
    const body = await config.json()
    expect(body.branding.logoUrl).toMatch(/^\/api\/t\/public-a\/branding\/logo\?v=/)
    expect(body.branding.heroImageUrl).toBeUndefined()
    for (const kind of ['logo', 'hero', 'font-heading', 'font-body']) {
      const url = `/api/t/public-a/branding/${kind}`
      const denied = await cache.fetch(
        url,
        () => app.request(url, { method: 'HEAD', headers: { 'if-none-match': '"v1"' } }),
      )
      expect(denied.status).toBe(401)
      expect(denied.headers.get('cache-control')).toBe('private, no-store')
      await denied.text()
    }
    expect(cache.entries.size).toBe(0)
  } finally {
    f.close()
  }
})

Deno.test('missing tenant declaration denies and audits before an unregistered handler', async () => {
  const f = createEnforcementFixture()
  let dispatched = false
  try {
    f.app.get('/api/t/:slug/undeclared-read', (c) => {
      dispatched = true
      return c.json({ private: true })
    })
    const response = await f.requestAs(null, '/api/t/public-a/undeclared-read')
    expect(response.status).toBe(401)
    expect(dispatched).toBe(false)
    expect(f.database.all("SELECT id FROM audit_events WHERE action='request.denied'"))
      .toHaveLength(1)
    await response.text()
  } finally {
    f.close()
  }
})

Deno.test('tenant reads deny before dispatch and safe config is an exact D9 projection', async () => {
  const f = createEnforcementFixture()
  try {
    const response = await f.requestAs(null, '/api/t/a/resources')
    expect(response.status).toBe(401)
    f.assertNoProtectedDispatch()
    const config = await f.requestAs(null, '/api/t/a/config')
    expect(config.status).toBe(200)
    expect(config.headers.get('cache-control')).toBe('private, no-store')
    const stored = f.stores.tenants.get('a')!
    expect(await config.json()).toEqual({
      slug: 'a',
      accessMode: 'restricted',
      branding: {
        productName: stored.branding.productName,
        organisation: stored.branding.organisation,
        logoUrl: null,
        colours: stored.branding.colours,
        paletteId: stored.branding.paletteId,
      },
    })
  } finally {
    f.close()
  }
})

function fixture(raw?: unknown) {
  const directory = Deno.makeTempDirSync({ prefix: 'access-modes-' })
  const path = `${directory}/tenants.json`
  if (raw !== undefined) Deno.writeTextFileSync(path, JSON.stringify(raw))
  return {
    path,
    open: () => new TenantStore({ TENANTS_PATH: path }),
    close: () => Deno.removeSync(directory, { recursive: true }),
  }
}

Deno.test('local access policy persists every mode across repeated reloads and disabled portals', () => {
  const f = fixture()
  try {
    const store = f.open()
    const custom = store.add({ name: 'Custom' })
    expect(custom.accessMode).toBe('public')
    for (const slug of ['marine', custom.slug]) {
      for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
        store.patch(slug, { accessMode })
        store.setDisabled(slug, true)
        for (let repeat = 0; repeat < 2; repeat++) {
          const loaded = f.open()
          expect(loaded.get(slug)?.accessMode).toBe(accessMode)
          expect(loaded.get(slug)?.branding).toEqual(store.get(slug)?.branding)
          expect(loaded.isDisabled(slug)).toBe(true)
          expect(loaded.list().some((item) => item.slug === slug)).toBe(false)
          expect(loaded.list(true).some((item) => item.slug === slug)).toBe(true)
        }
      }
    }
  } finally {
    f.close()
  }
})

Deno.test('legacy custom and seed overrides default public without losing other fields', () => {
  const config = { ...tenantConfig('marine'), slug: 'legacy', accessMode: undefined }
  for (const raw of [{ legacy: config }, { custom: { legacy: config }, overrides: {} }]) {
    const f = fixture(raw)
    try {
      expect(f.open().get('legacy')?.accessMode).toBe('public')
      expect(f.open().get('marine')?.accessMode).toBe('public')
      expect(f.open().get('legacy')?.topics).toEqual(config.topics)
    } finally {
      f.close()
    }
  }
})

Deno.test('corrupt local policy is unavailable without seed fallback or loss during unrelated writes', () => {
  const bad = [null, 'private', false, {}, []]
  for (const value of bad) {
    for (
      const raw of [
        { custom: { marine: { ...tenantConfig('marine'), accessMode: value } }, overrides: {} },
        { custom: {}, overrides: { marine: { accessMode: value } } },
        ...(value && typeof value === 'object' && !Array.isArray(value)
          ? []
          : [{ custom: {}, overrides: { marine: value } }]),
      ]
    ) {
      const f = fixture(raw)
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          const store = f.open()
          expect(() => store.get('marine')).toThrow()
          expect(store.list(true).some((item) => item.slug === 'marine')).toBe(false)
          expect(store.get('grains')?.accessMode).toBe('public')
          store.patch('grains', { searchPlaceholder: 'Still available' })
        }
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('invalid patch cannot replace an existing restricted policy', () => {
  const f = fixture()
  try {
    const store = f.open()
    store.patch('marine', { accessMode: 'restricted' })
    for (const patch of [{ accessMode: null }, { accessMode: 'private' }, null, []]) {
      expect(() => store.patch('marine', patch as unknown as TenantPatch)).toThrow()
      expect(f.open().get('marine')?.accessMode).toBe('restricted')
    }
  } finally {
    f.close()
  }
})

Deno.test('malformed persisted root never becomes public defaults on restart', () => {
  for (const raw of [null, [], { custom: null }, { custom: {}, overrides: [] }]) {
    const f = fixture(raw)
    try {
      expect(() => f.open()).toThrow()
      expect(() => f.open()).toThrow()
    } finally {
      f.close()
    }
  }
  const f = fixture()
  try {
    Deno.writeTextFileSync(f.path, '{broken')
    expect(() => f.open()).toThrow()
    expect(() => f.open()).toThrow()
  } finally {
    f.close()
  }
})
