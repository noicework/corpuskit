import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'

// ---------------------------------------------------------------------------
// Wave 1 hardening, finding 2: startScheduler used to construct its own
// `new SourceStore()` / `new WatchStore()`, distinct from the ones buildApp
// holds - so a scheduled sync and a concurrent HTTP write could each act on
// a different in-process object. The fix is that server.ts now constructs
// one SourceStore/WatchStore each and passes THOSE SAME instances to both
// buildApp (via BuildAppOptions.sources/.watches) and startScheduler.
//
// These tests prove the wiring itself: that buildApp's HTTP routes and the
// scheduler's run functions (runWatches/runAutoSyncs, which startScheduler
// calls on a timer) both operate on the exact object instance handed to
// them - not merely on stores that happen to persist to the same file path.
// A spy subclass is used (rather than asserting on end-state alone) because
// the store's read-then-write happens fresh from disk on every call, so two
// *separate* instances pointed at the same path would coincidentally reach
// the same end state in a single-threaded test regardless of whether the
// wiring is fixed - identity, not eventual file content, is what changed.
//
// DATA_DIR is read once at stores.ts module load, so - as in stores.test.ts
// - it must be pointed at a temp dir before that module (or anything that
// imports it) is ever imported, via a dynamic import after the env is set.
// ---------------------------------------------------------------------------

const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)

const { buildApp } = await import('./app.ts')
const {
  autoEnrichmentCadenceMs,
  DEFAULT_AUTO_ENRICH_CADENCE_MS,
  runAutoEnrichments,
  runAutoSyncs,
  runWatches,
} = await import('./scheduler.ts')
const { SourceStore, WatchStore } = await import('./stores.ts')
const { EnrichmentStore } = await import('./enrichments.ts')
const { TenantStore } = await import('./tenants.ts')

const freshTenants = () =>
  new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })

class SpyWatchStore extends WatchStore {
  calls: string[] = []
  override list(...args: Parameters<InstanceType<typeof WatchStore>['list']>) {
    this.calls.push('list')
    return super.list(...args)
  }
  override add(...args: Parameters<InstanceType<typeof WatchStore>['add']>) {
    this.calls.push('add')
    return super.add(...args)
  }
  override update(...args: Parameters<InstanceType<typeof WatchStore>['update']>) {
    this.calls.push('update')
    return super.update(...args)
  }
}

class SpySourceStore extends SourceStore {
  calls: string[] = []
  override list(...args: Parameters<InstanceType<typeof SourceStore>['list']>) {
    this.calls.push('list')
    return super.list(...args)
  }
  override add(...args: Parameters<InstanceType<typeof SourceStore>['add']>) {
    this.calls.push('add')
    return super.add(...args)
  }
}

const stubProvider = {
  search: async (_tenant: unknown, query: string) => ({
    query,
    resources: [],
    relatedQuestions: [],
  }),
}

/** A double with just enough of AragProvider's shape for runWatches/
 *  runAutoSyncs, which only call `.search`. Cast, not implemented, because
 *  AragProvider is a concrete class with private fields - no plain object
 *  is structurally assignable to it. */
function fakeManagement(): AragProvider {
  return stubProvider as unknown as AragProvider
}

Deno.test('buildApp routes HTTP watch writes through the exact WatchStore instance it was given', async () => {
  const watches = new SpyWatchStore()
  const app = buildApp({ provider: stubProvider as never, tenants: freshTenants(), watches })

  const response = await app.request('/api/t/marine/watches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'abalone stock health' }),
  })

  expect(response.status).toBe(200)
  // If buildApp had ignored opts.watches and constructed its own store
  // internally (the pre-fix shape), this spy would never be touched.
  expect(watches.calls).toContain('add')
})

Deno.test(
  'the scheduler run function mutates the SAME WatchStore instance buildApp exposes over HTTP',
  async () => {
    const tenants = freshTenants()
    const watches = new SpyWatchStore()
    const app = buildApp({ provider: stubProvider as never, tenants, watches })

    await app.request('/api/t/marine/watches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'rock lobster thermal stress' }),
    })
    watches.calls.length = 0

    // Mirrors exactly what server.ts's startScheduler(provider, tenants,
    // sources, watches) does on its timer: call runWatches with the SAME
    // watches instance buildApp was constructed with.
    await runWatches(fakeManagement(), tenants, watches)

    // The scheduler's own store methods (list/update) ran on OUR spy - proof
    // it is operating on the instance buildApp holds, not a second one.
    expect(watches.calls).toContain('list')
    expect(watches.calls).toContain('update')

    const listResponse = await app.request('/api/t/marine/watches')
    const list = await listResponse.json() as {
      query: string
      lastRun: string | null
      changed: boolean
    }[]
    const ours = list.find((w) => w.query === 'rock lobster thermal stress')
    // runWatches recorded a run against the exact watch the HTTP layer just
    // created - only possible because both saw the same in-process store.
    // (Other tests in this file share the same temp DATA_DIR, so `list` may
    // hold watches from elsewhere too - match on ours specifically.)
    expect(ours).toBeDefined()
    expect(ours!.lastRun).not.toBeNull()
  },
)

class SpyEnrichmentStore extends EnrichmentStore {
  calls: string[] = []
  override get(
    ...args: Parameters<InstanceType<typeof EnrichmentStore>['get']>
  ): ReturnType<InstanceType<typeof EnrichmentStore>['get']> {
    this.calls.push('get')
    void args
    return {} as ReturnType<InstanceType<typeof EnrichmentStore>['get']>
  }
}

Deno.test(
  'runAutoEnrichments reads through the shared EnrichmentStore instance',
  async () => {
    const enrichments = new SpyEnrichmentStore()
    const management = {
      listResources: () => Promise.resolve([{ id: 'r1', title: 'A report', summary: '' }]),
      invalidate: () => {},
    } as unknown as AragProvider

    await runAutoEnrichments(management, freshTenants(), enrichments)

    expect(enrichments.calls).toContain('get')
  },
)

Deno.test('auto-enrichment cadence is daily by default and safely configurable in hours', () => {
  expect(autoEnrichmentCadenceMs(undefined)).toBe(DEFAULT_AUTO_ENRICH_CADENCE_MS)
  expect(autoEnrichmentCadenceMs('6')).toBe(6 * 3600 * 1000)
  expect(autoEnrichmentCadenceMs('0')).toBe(DEFAULT_AUTO_ENRICH_CADENCE_MS)
  expect(autoEnrichmentCadenceMs('not-a-number')).toBe(DEFAULT_AUTO_ENRICH_CADENCE_MS)
  // Operational mistakes cannot create a hot loop or a timer beyond one month.
  expect(autoEnrichmentCadenceMs('0.1')).toBe(3600 * 1000)
  expect(autoEnrichmentCadenceMs('10000')).toBe(24 * 31 * 3600 * 1000)
})

Deno.test(
  'runAutoSyncs (the scheduler auto-sync pass) reads sources through the shared SourceStore instance',
  async () => {
    const tenants = freshTenants()
    const sources = new SpySourceStore()
    // Registered with auto=false so runAutoSyncs's inner loop skips the
    // network-hitting syncSource call, while still exercising the shared
    // `sources.list()` read that proves the wiring.
    sources.add('marine', 'https://example.org/reports', false)
    sources.calls.length = 0

    await runAutoSyncs(fakeManagement(), tenants, sources)

    // Proves runAutoSyncs walked OUR instance's data (list ran on the spy)
    // rather than a separately-constructed, empty SourceStore.
    expect(sources.calls).toContain('list')
  },
)
