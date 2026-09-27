import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import {
  AragApiError,
  type AragProvider,
  KnowledgeBoxNotConnectedError,
} from '@research-portal/retrieval'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { runSystemMaintenance, syncSource } from './scheduler.ts'
import { SourceStore, WatchStore } from './stores.ts'
import { EnrichmentStore } from './enrichments.ts'
import { TenantStore } from './tenants.ts'

// Scheduled maintenance is one pass over every portal. These tests pin down that one portal, one
// source or one job failing never costs the other portals their sync, watches or enrichment, and
// that the failures still reach the runtime as one error at the end of the pass.

const DAY = 24 * 3600 * 1000
const REPORT = 'The survey found that the northern reef recovered within two seasons. '.repeat(8)

interface Fixture {
  rbac: RbacState
  tenants: TenantStore
  sources: SourceStore
  watches: WatchStore
  enrichments: EnrichmentStore
  /** The portals in the order a pass on day 0 visits them. */
  order: string[]
  close(): void
}

/** Three portals: the two seeded showcase portals and one created in the app. */
function fixture(): Fixture {
  const directory = Deno.makeTempDirSync({ prefix: 'maintenance-' })
  const database = new LocalRbacDatabase(':memory:')
  const rbac = new RbacState(database)
  rbac.migrate()
  const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
  tenants.add({ name: 'Third' })
  return {
    rbac,
    tenants,
    sources: new SourceStore(directory),
    watches: new WatchStore(directory),
    enrichments: new EnrichmentStore(directory),
    order: tenants.list().map((t) => t.slug),
    close: () => {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

/** Knowledge-box statuses as the binding store reports them. */
const bindingsFor = (bound: readonly string[]) => ({
  status: (slug: string) => ({
    slug,
    status: bound.includes(slug) ? 'connected' as const : 'none' as const,
  }),
})

/** Crawler fetches: `down.example` answers 503, anything else an empty page. */
function stubCrawler(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return Promise.resolve(
      new URL(url).hostname === 'down.example'
        ? new Response('unavailable', { status: 503 })
        : new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    )
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

/**
 * Enough of the provider for every maintenance job. `failing` portals fail every call; `barren`
 * portals list documents that can never be enriched; `unbound` portals have no knowledge box.
 */
function provider(options: {
  failing?: readonly string[]
  barren?: readonly string[]
  unbound?: readonly string[]
  empty?: readonly string[]
  searchError?: (slug: string) => Error | undefined
  calls?: string[]
}): AragProvider {
  const calls = options.calls ?? []
  const refuse = (slug: string) => {
    if (options.unbound?.includes(slug)) throw new KnowledgeBoxNotConnectedError(slug)
    if (options.failing?.includes(slug)) throw new Error('fixture provider failure')
  }
  return {
    invalidate: () => {},
    search: (config: TenantConfig) => {
      calls.push(`search:${config.slug}`)
      refuse(config.slug)
      const error = options.searchError?.(config.slug)
      if (error) return Promise.reject(error)
      return Promise.resolve({ query: 'q', resources: [{ id: 'doc-1' }], relatedQuestions: [] })
    },
    listResources: (config: TenantConfig) => {
      calls.push(`list:${config.slug}`)
      refuse(config.slug)
      if (options.empty?.includes(config.slug)) return Promise.resolve([])
      return Promise.resolve([
        { id: `${config.slug}-1`, title: 'Report one', summary: '' },
        { id: `${config.slug}-2`, title: 'Report two', summary: '' },
      ])
    },
    resourceContent: (config: TenantConfig, id: string) => {
      refuse(config.slug)
      return Promise.resolve({
        id,
        title: 'Report',
        kind: 'text',
        texts: options.barren?.includes(config.slug) ? [] : [{ fieldId: 'body', text: REPORT }],
      })
    },
    askStructured: (config: TenantConfig) => {
      calls.push(`generate:${config.slug}`)
      refuse(config.slug)
      if (options.barren?.includes(config.slug)) return Promise.reject(new Error('no content'))
      return Promise.resolve({
        object: {
          title: 'Northern reef recovery',
          summary: 'The reef recovered within two seasons.',
          questions: [
            'How quickly did the northern reef recover?',
            'What did the survey find about the reef?',
            'Which reef recovered within two seasons?',
          ],
        },
      })
    },
    createText: () => Promise.resolve('created'),
  } as unknown as AragProvider
}

const failures = (error: unknown) =>
  ((error as { failures?: { job: string; slug?: string; target: string }[] }).failures ?? [])
    .map((f) => `${f.job}:${f.slug ?? '-'}:${f.target}`).sort()

Deno.test('two failing portals never stop the third portal being synced, watched and enriched', async () => {
  const f = fixture()
  const restore = stubCrawler()
  try {
    const [first, second, third] = f.order as [string, string, string]
    f.sources.add(first, 'https://down.example/reports', true)
    f.sources.add(second, 'https://down.example/news', true)
    const healthy = f.sources.add(third, 'https://ok.example/reports', true)
    f.watches.add(first, 'fixture-client', 'reef recovery')
    f.watches.add(second, 'fixture-client', 'reef recovery')
    const watch = f.watches.add(third, 'fixture-client', 'reef recovery')
    const calls: string[] = []
    let caught: unknown
    await runSystemMaintenance(
      provider({ failing: [first], barren: [second], calls }),
      { ...f, bindings: bindingsFor(f.order) },
      undefined,
      ['sync', 'watch', 'enrichment'],
      false,
      { now: () => 0 },
    ).catch((error) => {
      caught = error
    })

    // One combined error, thrown once every job has had every portal.
    expect(caught).toBeInstanceOf(Error)
    expect(failures(caught)).toEqual([
      `enrichment:${first}:enrichment`,
      `enrichment:${first}:questions`,
      `enrichment:${second}:enrichment`,
      `sync:${first}:source`,
      `sync:${second}:source`,
      `watch:${first}:watch`,
    ].sort())
    expect((caught as { halted?: boolean }).halted).toBe(false)

    // The third portal got its whole pass.
    const source = f.sources.find(third, healthy.id)!
    expect(source.lastStatus).toBe('ok')
    expect(f.watches.list(third).find((w) => w.id === watch.id)?.lastRun).not.toBeNull()
    expect(f.enrichments.count(third)).toBe(2)
    expect(f.enrichments.count(third, 'suggested-questions')).toBe(2)
    // The second portal's watch still ran after its source failed.
    expect(f.watches.list(second)[0]?.lastRun).not.toBeNull()
    // Each failing source says why, where Manage shows it.
    expect(f.sources.list(first)[0]?.lastStatus).toBe('error')

    // Every failure is recorded against its own portal, and each job's record counts them.
    const events = f.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
    const failed = (slug: string) =>
      events.filter((e) => e.scope_slug === slug && ['failure', 'uncertain'].includes(e.outcome))
        .map((e) => e.action).sort()
    expect(failed(first)).toEqual([
      'maintenance.enrichment.run',
      'maintenance.questions.run',
      'maintenance.source.sync',
      'maintenance.watch.run',
    ])
    expect(failed(second)).toEqual(['maintenance.enrichment.run', 'maintenance.source.sync'])
    expect(failed(third)).toEqual([])
    const jobs = events.filter((e) => e.action === 'maintenance.run' && e.outcome !== 'intent')
    expect(jobs.map((e) => [e.target_id, e.outcome, JSON.parse(e.detail_json).count]).sort())
      .toEqual([
        ['enrichment', 'failure', 3],
        ['sync', 'failure', 2],
        ['watch', 'failure', 1],
      ])
    expect(JSON.stringify(events)).not.toContain('down.example')
  } finally {
    restore()
    f.close()
  }
})

Deno.test('portals with no knowledge box are skipped and an empty catalogue is nothing to do', async () => {
  const f = fixture()
  try {
    const [first, second, third] = f.order as [string, string, string]
    f.watches.add(first, 'fixture-client', 'reef recovery')
    const calls: string[] = []
    // The showcase portals are listed on every deployment but bound on none but one.
    await runSystemMaintenance(
      provider({ unbound: [first, second], empty: [third], calls }),
      { ...f, bindings: bindingsFor([third]) },
      undefined,
      ['sync', 'watch', 'enrichment'],
      false,
      { now: () => 0 },
    )
    expect(calls.some((call) => call.endsWith(`:${first}`) || call.endsWith(`:${second}`)))
      .toBe(false)
    expect(calls).toContain(`list:${third}`)
    const events = f.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
    expect(events.filter((e) => e.outcome === 'failure' || e.outcome === 'uncertain')).toEqual([])
    expect(
      events.filter((e) => e.action === 'maintenance.run' && e.outcome === 'success').length,
    ).toBe(3)
  } finally {
    f.close()
  }
})

Deno.test('back-pressure from the shared account stops the pass, and nothing else does', async () => {
  const f = fixture()
  try {
    const [first, second, third] = f.order as [string, string, string]
    for (const slug of f.order) f.watches.add(slug, 'fixture-client', 'reef recovery')
    const calls: string[] = []
    let caught: unknown
    await runSystemMaintenance(
      provider({
        calls,
        searchError: (slug) =>
          slug === first
            ? new AragApiError(429, 'https://box.example/find', 'rate limited')
            : undefined,
      }),
      { ...f, bindings: bindingsFor(f.order) },
      undefined,
      ['watch', 'enrichment'],
      false,
      { now: () => 0 },
    ).catch((error) => {
      caught = error
    })
    expect(failures(caught)).toEqual([`watch:${first}:watch`])
    expect((caught as { halted?: boolean }).halted).toBe(true)
    // Nothing after the refusal: not the other portals' watches, not the enrichment job.
    expect(calls).toEqual([`search:${first}`])
    expect(calls.some((call) => call.endsWith(second) || call.endsWith(third))).toBe(false)
  } finally {
    f.close()
  }
})

Deno.test('each night the pass starts at a different portal', async () => {
  const f = fixture()
  try {
    const firstCalls = async (day: number) => {
      const calls: string[] = []
      await runSystemMaintenance(
        // Every box answers as unbound, which is nothing to do: only the order matters here.
        provider({ unbound: f.order, calls }),
        { ...f, bindings: bindingsFor(f.order) },
        undefined,
        ['enrichment'],
        false,
        { now: () => day * DAY + 3600_000 },
      )
      return calls.filter((call) => call.startsWith('list:')).map((call) => call.slice(5))
    }
    const [a, b, c] = f.order as [string, string, string]
    expect((await firstCalls(0))[0]).toBe(a)
    expect((await firstCalls(1))[0]).toBe(b)
    expect((await firstCalls(2))[0]).toBe(c)
    expect((await firstCalls(3))[0]).toBe(a)
    // Every portal is still visited every night.
    expect(new Set(await firstCalls(1))).toEqual(new Set(f.order))
  } finally {
    f.close()
  }
})

Deno.test('a scheduled enrichment run stops starting work once its time budget is spent', async () => {
  const f = fixture()
  try {
    const [, , third] = f.order as [string, string, string]
    let clock = 0
    let generations = 0
    const management = {
      ...provider({}),
      listResources: () =>
        Promise.resolve(
          Array.from(
            { length: 12 },
            (_, i) => ({ id: `doc-${i}`, title: `Report ${i}`, summary: '' }),
          ),
        ),
      askStructured: () => {
        generations++
        // Each generation takes forty seconds on the pass's clock.
        clock += 40_000
        return Promise.resolve({ object: { title: 'Reef recovery', summary: 'It recovered.' } })
      },
    } as unknown as AragProvider
    await runSystemMaintenance(
      management,
      { ...f, bindings: bindingsFor([third]) },
      undefined,
      ['enrichment'],
      false,
      { now: () => clock },
    )
    // The first round of workers started inside the budget; nothing started after it.
    const enriched = f.enrichments.count(third)
    expect(enriched).toBeGreaterThan(0)
    expect(enriched).toBeLessThan(12)
    const events = f.rbac.audit.read({ scope: { kind: 'portal', slug: third }, limit: 100 })
    expect(events.filter((e) => e.outcome === 'failure' || e.outcome === 'uncertain')).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('a source sync stops taking pages when told to, and leaves the rest for the next sync', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'maintenance-sync-' })
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = url.endsWith('/news')
      ? `<html><body>${
        Array.from({ length: 6 }, (_, i) => `<a href="/article-${i}">Article ${i}</a>`).join('')
      }</body></html>`
      : `<html><head><title>Article</title></head><body><main><h1>Article</h1><p>${
        'fisheries stock assessment evidence '.repeat(40)
      }</p></main></body></html>`
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' } }))
  }) as typeof fetch
  try {
    const sources = new SourceStore(directory)
    const source = sources.add('marine', 'https://example.org/news', true, 10)
    let created = 0
    const management = {
      createText: () => {
        created++
        return Promise.resolve('created')
      },
    } as unknown as AragProvider
    const result = await syncSource(
      management,
      sources,
      { slug: 'marine' } as TenantConfig,
      source,
      () => {},
      undefined,
      () => created >= 2,
    )
    expect(result).toEqual({ added: 2, deferred: 4 })
    const after = sources.find('marine', source.id)!
    expect(after.synced).toHaveLength(2)
    expect(after.lastStatus).toBe('ok')
  } finally {
    globalThis.fetch = original
    Deno.removeSync(directory, { recursive: true })
  }
})
