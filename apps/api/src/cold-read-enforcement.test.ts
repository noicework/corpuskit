import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { EnrichmentStore } from './enrichments.ts'
import { buildApp } from './app.ts'
import { DEFAULT_RESEARCH_ENRICHMENT } from '@research-portal/core'

const path = '/api/t/a/resources/res-1/questions'
const cached = {
  schemaId: 'suggested-questions',
  generatedAt: '2026-09-12T00:00:00Z',
  data: { questions: ['What drove the decline?'] },
}

const evidence = 'Genetic techniques improved stock assessments for Southern Bluefin Tuna overall.'
const question = 'How did genetic techniques change stock assessments?'

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`${adapter} cold cache commits once with audit and rolls back append and SQL commit failures`, async () => {
    for (
      const failure of [
        'none',
        'generate-intent',
        'generate-success',
        'cache-intent',
        'cache-success',
        'cache-commit',
      ]
    ) {
      let generated = 0
      const management = {
        resourceContent: () =>
          Promise.resolve({ id: 'res-1', texts: [{ text: evidence }], files: [] }),
        askStructured: () => {
          generated++
          return Promise.resolve({ object: { questions: [{ question, evidence }] } })
        },
      } as unknown as AragProvider
      const f = createEnforcementFixture({ management })
      try {
        const store = adapter === 'local' ? new EnrichmentStore(f.directory) : f.stores.enrichments
        const previous = { ...cached, data: { previous: 'retained' } }
        store.put('a', 'res-1', previous)
        const filename = `${f.directory}/enrichments/a.json`
        const bytes = adapter === 'local' ? Deno.readFileSync(filename) : undefined
        let puts = 0
        const tracked = new Proxy(store, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property === 'put') {
              return (...args: Parameters<EnrichmentStore['put']>) => {
                puts++
                return target.put(...args)
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const context = await f.contextFor(f.sessionFor('curator'))
        const app = buildApp({
          ...f.stores,
          enrichments: tracked,
          provider: f.provider,
          management,
          configuredTenantId: f.tenantId,
          audience: f.audience,
          now: f.now,
          breakGlass: f.rbac.breakGlassService({ environment: 'production' }),
          requestContext: () => context,
        })
        if (failure !== 'none') {
          const [action, outcome] = failure.split('-')
          if (failure === 'cache-commit') {
            f.database.exec(
              "PRAGMA foreign_keys=ON; CREATE TABLE completion_parent(id INTEGER PRIMARY KEY); CREATE TABLE completion_child(id INTEGER REFERENCES completion_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_completion AFTER INSERT ON audit_events WHEN NEW.action = 'resource.questions.cache' AND NEW.outcome = 'success' BEGIN INSERT INTO completion_child VALUES (1); END",
            )
          } else {f.database.exec(
              `CREATE TRIGGER fail_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'resource.questions.${action}' AND NEW.outcome = '${outcome}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
            )}
        }
        const response = await app.request(path)
        expect(response.status).toBe(failure === 'none' ? 200 : 500)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        if (failure === 'none') {
          expect(await response.json()).toEqual({ questions: [question] })
          expect(store.get('a', 'res-1', cached.schemaId)?.data).toEqual({ questions: [question] })
          expect(puts).toBe(1)
        } else {
          expect(await response.json()).toEqual({ error: 'audit_write_failed' })
          expect(store.get('a', 'res-1', cached.schemaId)).toEqual(previous)
          if (adapter === 'local') {
            expect(Deno.readFileSync(filename)).toEqual(bytes)
            expect(new EnrichmentStore(f.directory).get('a', 'res-1', cached.schemaId)).toEqual(
              previous,
            )
          }
          if (failure.startsWith('generate-') || failure === 'cache-intent') expect(puts).toBe(0)
        }
        expect(generated).toBe(failure === 'generate-intent' ? 0 : 1)
        const events = f.rbac.audit.read({
          scope: { kind: 'portal', slug: 'a' },
          requestId: context.requestId,
        })
        expect(
          events.filter((e) => e.action === 'resource.questions.cache' && e.outcome === 'success'),
        ).toHaveLength(failure === 'none' ? 1 : 0)
      } finally {
        f.close()
      }
    }
  })
}

Deno.test('cold question permissions precede generation and shared work; cached viewers retain access', async () => {
  let calls = 0
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const f = createEnforcementFixture({
    management: {
      resourceContent: async () => {
        calls++
        started()
        await held
        return null
      },
    } as unknown as AragProvider,
  })
  try {
    f.stores.enrichments.put('b', 'res-1', cached)
    const anonymous = await f.requestAs(null, path.replace('/a/', '/public-a/'))
    expect(anonymous.status).toBe(401)
    expect(calls).toBe(0)
    for (const role of ['viewer', 'analyst'] as const) {
      expect((await f.requestAs(f.sessionFor(role), path)).status).toBe(403)
      expect(calls).toBe(0)
      expect(f.stores.enrichments.get('a', 'res-1', cached.schemaId)).toBeUndefined()
    }
    const curator = f.requestAs(f.sessionFor('curator'), path)
    await ready
    expect((await f.requestAs(f.sessionFor('viewer'), path)).status).toBe(403)
    expect((await f.requestAs(f.sessionFor('analyst'), path)).status).toBe(403)
    expect(calls).toBe(1)
    release()
    const response = await curator
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ questions: [] })
    const warm = await f.requestAs(f.sessionFor('viewer'), path)
    expect(warm.status).toBe(200)
    expect(await warm.json()).toEqual({ questions: [] })
    expect(calls).toBe(1)
    f.stores.enrichments.put('a', 'missing', cached)
    expect((await f.requestAs(f.sessionFor('viewer'), path.replace('res-1', 'missing'))).status)
      .toBe(404)
    expect((await f.requestAs(f.sessionFor('curator', 'b'), path)).status).toBe(403)
  } finally {
    release()
    f.close()
  }
})

Deno.test('local corrupt enrichment reads preserve original bytes without quarantine', () => {
  const directory = Deno.makeTempDirSync()
  try {
    Deno.mkdirSync(`${directory}/enrichments`)
    const filename = `${directory}/enrichments/a.json`
    const original = '{ invalid legacy data'
    Deno.writeTextFileSync(filename, original)
    const store = new EnrichmentStore(directory)
    expect(() => store.get('a', 'res-1')).toThrow()
    expect(Deno.readTextFileSync(filename)).toBe(original)
    expect([...Deno.readDirSync(`${directory}/enrichments`)].map((entry) => entry.name)).toEqual([
      'a.json',
    ])
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('question keys retain their own actor and analyst keys cannot borrow curator sessions', async () => {
  let calls = 0
  const f = createEnforcementFixture({
    management: {
      resourceContent: () => {
        calls++
        return Promise.resolve(null)
      },
    } as unknown as AragProvider,
  })
  try {
    for (const role of ['analyst', 'curator'] as const) {
      const key = await issueScopedKey(
        { slug: 'a', label: role, role },
        f.creator,
        f.authorityDependencies(),
      )
      key.commit()
      const response = await f.requestAs(f.sessionFor('curator'), path, {
        headers: { authorization: `Bearer ${key.key}` },
      })
      expect(response.status).toBe(role === 'analyst' ? 403 : 200)
      expect(calls).toBe(role === 'analyst' ? 0 : 1)
      if (role === 'curator') {
        const events = f.rbac.audit.read({
          scope: { kind: 'portal', slug: 'a' },
          requestId: response.headers.get('x-request-id')!,
        })
        expect(
          events.filter((e) => e.action.startsWith('resource.questions.')).every((e) =>
            e.actor_kind === 'key' && e.actor_id === key.credential.id
          ),
        ).toBe(true)
      }
    }
  } finally {
    f.close()
  }
})

Deno.test('GET resource overlays read legacy enrichment without migrating or writing state', async () => {
  const f = createEnforcementFixture({
    management: {
      resourceContent: () =>
        Promise.resolve({ id: 'res-1', title: 'Document', texts: [], files: [] }),
      relationsGraph: () => Promise.resolve({ nodes: [], edges: [] }),
      listResources: () => Promise.resolve([]),
    } as unknown as AragProvider,
  })
  try {
    f.state.put('enrichments:a', {
      'suggested-questions': { 'res-1': cached },
      [DEFAULT_RESEARCH_ENRICHMENT.id]: {
        'res-1': { ...cached, data: { title: 'Legacy evidence title' } },
      },
    })
    const before = f.database.all('SELECT * FROM state ORDER BY key')
    for (
      const suffix of [
        'resources',
        'resources/res-1',
        'resources/res-1/questions',
        'catalog',
        'search?q=marine',
        'topics/stock-assessment/resources',
        'resources/res-1/content',
        'entity?name=marine',
      ]
    ) {
      const response = await f.requestAs(f.sessionFor('viewer'), `/api/t/a/${suffix}`)
      expect(response.status).toBe(200)
      expect(f.database.all('SELECT * FROM state ORDER BY key')).toEqual(before)
      expect(f.database.all('SELECT * FROM enrichment_records')).toEqual([])
    }
    expect(f.stores.enrichments.forAgent('a')['res-1']?.data.title).toBe('Legacy evidence title')
    expect(f.stores.enrichments.count('a')).toBe(1)
    expect(f.stores.enrichments.exportRecords('a')[cached.schemaId]?.['res-1']).toEqual(cached)
    expect(f.database.all('SELECT * FROM state ORDER BY key')).toEqual(before)
  } finally {
    f.close()
  }
})
