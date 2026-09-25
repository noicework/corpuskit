import { expect } from '@std/expect'
import {
  createEnforcementFixture,
  type EnforcementFixture,
} from '../../api/src/enforcement-fixture.ts'
import { encodeStorageIdentifier } from '../../api/src/research-owner.ts'
import { initialiseAcmdDemo } from './acmd-demo.ts'
import { DEMO_TENANT, initialiseDemo } from './demo.ts'

Deno.test('demo bootstrap only writes to a new demo instance', () => {
  const calls: unknown[] = []
  let current: typeof DEMO_TENANT | undefined
  const tenants = {
    get: () => current,
    seed: (config: typeof DEMO_TENANT) => {
      current = config
      calls.push(config)
    },
    setDisabled: (slug: string, disabled: boolean) => calls.push({ slug, disabled }),
  }
  initialiseDemo(tenants, 'production')
  expect(calls).toEqual([])
  initialiseDemo(tenants, 'demo')
  expect(calls).toEqual([
    DEMO_TENANT,
    { slug: 'marine', disabled: true },
    { slug: 'grains', disabled: true },
  ])
  initialiseDemo(tenants, 'demo')
  expect(calls).toHaveLength(3)
  expect(DEMO_TENANT.regionalDiscovery).toBe(false)
})

const OWNER = 'research-client'

/** One record of every kind a removed portal leaves stored under its slug. */
function writeResearchRecords(f: EnforcementFixture, slug: string): void {
  const s = f.stores
  s.sources.add(slug, `https://example.test/${slug}/news`, true)
  s.enrichments.put(slug, 'resource-1', {
    schemaId: 'research',
    generatedAt: '2026-09-12T00:00:00Z',
    data: { title: `${slug} research` },
  })
  s.insights.record(slug, {
    ts: new Date().toISOString(),
    question: `What does ${slug} hold?`,
    answered: true,
    citations: 1,
    durationSec: 1,
    answerRelevance: 4,
    groundedness: 4,
    contextRelevance: 4,
  })
  s.suggestions.replacePending(slug, [{
    id: `${slug}-suggestion`,
    kind: 'entity-type',
    title: 'Species',
    detail: 'Name the species studied',
    status: 'pending',
    createdAt: '2026-09-12T00:00:00Z',
  }])
  s.kgProposals.set(slug, {
    rationale: `${slug} graph`,
    entityTypes: [],
    resourceLabels: [],
    chunkLabels: [],
    examples: [],
  })
  s.sessions.put(slug, OWNER, {
    id: 'session-1',
    title: `${slug} session`,
    updatedAt: '2026-09-12T00:00:00Z',
    messages: [],
  })
  s.investigations.create(slug, OWNER, { name: `${slug} investigation` })
  s.watches.add(slug, OWNER, `${slug} watch`)
  s.branding.put(slug, 'logo', {
    bytes: new Uint8Array([137, 80, 78, 71]),
    contentType: 'image/png',
    version: 'v1',
  })
  s.routing.record(slug, {
    ts: '2026-09-12T00:00:00Z',
    questionHash: 'abc123',
    questionLength: 20,
    intent: 'lookup',
    stage: 'rule',
    confidence: 1,
    rationale: 'fixture',
    configuration: 'default',
    latencyMs: 1,
  })
  // Records written before research storage was owner-scoped.
  f.state.put(`session:${slug}:${OWNER}:legacy`, {
    id: 'legacy',
    title: `${slug} legacy session`,
    updatedAt: '2026-09-01T00:00:00Z',
    messages: [],
  })
  f.state.put(`investigation:${slug}:${OWNER}:legacy`, { id: 'legacy', name: 'Legacy' })
  f.state.put(`watches:${slug}`, [{ id: 'legacy', clientId: OWNER, query: 'legacy watch' }])
}

/** What a portal's own routes can read back of those records. */
function researchRecords(f: EnforcementFixture, slug: string) {
  const s = f.stores
  return {
    sources: s.sources.list(slug).map((source) => source.url),
    enrichments: s.enrichments.exportRecords(slug),
    asks: s.insights.summary(slug).totalAsks,
    suggestions: s.suggestions.list(slug).map((suggestion) => suggestion.id),
    proposal: s.kgProposals.get(slug)?.rationale,
    sessions: s.sessions.list(slug, OWNER).map((session) => session.title),
    investigations: s.investigations.list(slug, OWNER).map((item) => item.name),
    watches: s.watches.list(slug).map((watch) => watch.query),
    logo: s.branding.get(slug, 'logo')?.contentType,
    routing: s.routing.recent(slug).length,
  }
}

/** Raw rows still stored under a slug, in every table the research stores use. */
function storedRows(f: EnforcementFixture, slug: string): string[] {
  const rows = [
    ...f.database.all<{ row: string }>('SELECT key AS row FROM state'),
    ...f.database.all<{ row: string }>('SELECT key AS row FROM branding_assets'),
    ...f.database.all<{ row: string }>(
      "SELECT 'enrichment:' || tenant_slug AS row FROM enrichment_records",
    ),
    ...f.database.all<{ row: string }>(
      "SELECT 'routing:' || tenant_slug AS row FROM routing_records",
    ),
  ].map(({ row }) => row)
  const research = `research-v2:${encodeStorageIdentifier(slug)}:`
  return rows.filter((row) => row.startsWith(research) || row.split(':').includes(slug)).sort()
}

const EMPTY = {
  sources: [],
  enrichments: {},
  asks: 0,
  suggestions: [],
  proposal: undefined,
  sessions: [],
  investigations: [],
  watches: [],
  logo: undefined,
  routing: 0,
}

Deno.test('a demo portal seeded again after removal starts without the removed portal records', async () => {
  const f = createEnforcementFixture({
    domainProvisioner: {
      attach: (hostname) => Promise.resolve({ hostname, created: true }),
      detach: (hostname) => Promise.resolve({ hostname, removed: true }),
    },
  })
  const initialisers = {
    demo: () => initialiseDemo(f.stores.tenants, 'demo'),
    acmd: () => initialiseAcmdDemo(f.stores.tenants, f.stores.bindings, 'demo'),
  }
  try {
    await f.stores.bindings.initialize()
    const owner = f.sessionFor('owner')
    writeResearchRecords(f, 'public-a')
    const neighbour = researchRecords(f, 'public-a')
    expect(neighbour.sessions).toEqual(['public-a session', 'public-a legacy session'])
    for (const [slug, initialise] of Object.entries(initialisers)) {
      await initialise()
      const seeded = f.stores.tenants.get(slug)
      expect(seeded?.slug).toBe(slug)
      writeResearchRecords(f, slug)
      expect(researchRecords(f, slug).sources).toEqual([`https://example.test/${slug}/news`])

      const removed = await f.requestAs(owner, `/api/admin/tenants/${slug}`, { method: 'DELETE' })
      expect(removed.status).toBe(200)
      expect(f.stores.tenants.get(slug)).toBeUndefined()
      expect(f.stores.tenants.isRetired(slug)).toBe(true)
      // Removal leaves the records stored under the retired slug, where no route reaches them.
      const left = storedRows(f, slug)
      for (
        const kind of [
          'branding',
          'enrichment',
          'insights',
          'investigation',
          'research-v2',
          'routing',
          'session',
          'sources',
          'suggestions',
          'watches',
        ]
      ) expect(left.some((row) => row.startsWith(`${kind}:`))).toBe(true)
      expect(f.stores.kgProposals.get(slug)?.rationale).toBe(`${slug} graph`)

      // The demo Worker's next start seeds the portal again, and it starts clean.
      await initialise()
      expect(f.stores.tenants.get(slug)).toEqual(seeded)
      expect(f.stores.tenants.isRetired(slug)).toBe(true)
      expect(researchRecords(f, slug)).toEqual(EMPTY)
      expect(storedRows(f, slug)).toEqual([])
      expect(f.stores.tenants.add({ name: slug }).slug).toBe(`${slug}-2`)

      // A later start with the portal in place clears nothing.
      writeResearchRecords(f, slug)
      await initialise()
      expect(researchRecords(f, slug).sources).toEqual([`https://example.test/${slug}/news`])
    }
    expect(researchRecords(f, 'public-a')).toEqual(neighbour)

    // A slug that storage would sanitise to another portal's never clears that portal's records.
    f.stores.tenants.seed({ ...DEMO_TENANT, slug: 'de.mo', hostname: undefined })
    expect(researchRecords(f, 'demo').sources).toEqual(['https://example.test/demo/news'])
  } finally {
    f.close()
  }
})
