import { expect } from '@std/expect'
import { join } from 'node:path'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { buildApp, type BuildAppOptions } from './app.ts'
import { BindingStore } from './bindings.ts'
import { EnrichmentStore } from './enrichments.ts'
import { ExternalLoginReplayStore } from './external-login.ts'
import { SuggestionStore } from './interrogate.ts'
import { KgProposalStore } from './kg.ts'
import { LocalIngress } from './local-ingress.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import type { PortalErasureStores } from './portal-erasure.ts'
import { openLocalRbac } from './rbac-local.ts'
import type { ResearchOwner } from './research-owner.ts'
import { InsightsStore, RoutingLog, SourceStore } from './stores.ts'
import { TenantStore } from './tenants.ts'
import type { AuditEvent } from './audit.ts'

const DAY = 86_400_000
const SLUG = 'erasure-probe'
const operatorKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

type Classification =
  | { erasedBy: keyof PortalErasureStores }
  | { noPortalRecords: string }

/**
 * Every option the application is built with, and how erasure treats it. Typed over every option,
 * so a new store cannot be passed to the application until it is classified here, and a store
 * that holds portal records must name the erasure store that removes them.
 */
const BUILD_OPTIONS: Record<keyof BuildAppOptions, Classification> = {
  lifecycle: { erasedBy: 'lifecycle' },
  rbac: { erasedBy: 'rbac' },
  audit: { erasedBy: 'audit' },
  routing: { erasedBy: 'routing' },
  tenants: { erasedBy: 'tenants' },
  bindings: { erasedBy: 'bindings' },
  insights: { erasedBy: 'insights' },
  sessions: { erasedBy: 'sessions' },
  sources: { erasedBy: 'sources' },
  watches: { erasedBy: 'watches' },
  investigations: { erasedBy: 'investigations' },
  mcpKeys: { erasedBy: 'mcpKeys' },
  suggestions: { erasedBy: 'suggestions' },
  kgProposals: { erasedBy: 'kgProposals' },
  enrichments: { erasedBy: 'enrichments' },
  branding: { erasedBy: 'branding' },
  brandingPath: { erasedBy: 'branding' },
  configuredTenantId: { noPortalRecords: 'identity configuration' },
  externalLoginEnabled: { noPortalRecords: 'identity configuration' },
  audience: { noPortalRecords: 'identity configuration' },
  now: { noPortalRecords: 'clock' },
  localMutations: { noPortalRecords: 'request audit scope' },
  provider: { noPortalRecords: 'retrieval; the knowledge box lives with the provider' },
  management: { noPortalRecords: 'retrieval; the knowledge box lives with the provider' },
  platformDomain: { noPortalRecords: 'deployment configuration' },
  domainProvisioner: { noPortalRecords: 'detaches the hostname on deletion; holds nothing' },
  maxPortalAliases: { noPortalRecords: 'deployment configuration' },
  reservedHostnames: { noPortalRecords: 'deployment configuration' },
  zone: { noPortalRecords: 'deployment configuration' },
  breakGlass: { noPortalRecords: 'attempts and lockouts per client address' },
  requestContext: { noPortalRecords: 'per-request identity' },
  webDistPath: { noPortalRecords: 'the web bundle' },
  webAvailable: { noPortalRecords: 'the web bundle' },
  docsHealth: { noPortalRecords: 'in-memory readiness probe' },
  buildSha: { noPortalRecords: 'build stamp' },
  webBuild: { noPortalRecords: 'build stamp' },
  invalidate: { noPortalRecords: 'drops provider caches; called on erasure' },
  erasureTransaction: { noPortalRecords: 'the erasure transaction itself' },
  operatorDeleteAfterDays: { noPortalRecords: 'deployment configuration' },
  rateLimitAskPerMin: { noPortalRecords: 'in-memory, per client address' },
  rateLimitAskPerMinPerIp: { noPortalRecords: 'in-memory, per client address' },
  rateLimitEstatePerMin: { noPortalRecords: 'in-memory, per client address' },
  rateLimitMcpAuthPerMin: { noPortalRecords: 'in-memory, per client address' },
}

const ERASURE_STORES: Record<keyof PortalErasureStores, true> = {
  tenants: true,
  bindings: true,
  lifecycle: true,
  sessions: true,
  investigations: true,
  watches: true,
  sources: true,
  insights: true,
  suggestions: true,
  enrichments: true,
  kgProposals: true,
  branding: true,
  routing: true,
  mcpKeys: true,
  rbac: true,
  audit: true,
}

Deno.test('every application store is classified, and each one holding portal records is erased', () => {
  const erasedBy = new Set(
    Object.values(BUILD_OPTIONS).flatMap((item) => 'erasedBy' in item ? [item.erasedBy] : []),
  )
  expect([...erasedBy].sort()).toEqual(Object.keys(ERASURE_STORES).sort())
})

/** The local server's stack, built the way `server.ts` builds it, in a scratch directory. */
async function localServer() {
  const directory = Deno.makeTempDirSync({ prefix: 'portal-erasure-' })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: join(directory, 'tenants.json'),
    BINDINGS_PATH: join(directory, 'bindings.json'),
    KG_PROPOSALS_PATH: join(directory, 'kg-proposals.json'),
    ENTRA_TENANT_ID: 'tenant-1',
    OPERATOR_API_KEY: operatorKey,
    OPERATOR_ID: 'retention-test',
  }
  const { database, rbac } = openLocalRbac(env)
  const owned = localOwnedStores(directory, database, rbac.audit, env)
  const tenants = owned.tenants!
  const bindings = new BindingStore(env)
  await bindings.initialize()
  const stores = {
    sources: new SourceStore(directory),
    insights: new InsightsStore(directory),
    routing: new RoutingLog(directory),
    suggestions: new SuggestionStore(directory),
    kgProposals: new KgProposalStore(env),
    enrichments: new EnrichmentStore(directory),
  }
  const ingress = new LocalIngress({
    rbac,
    tenants,
    env,
    externalReplays: new ExternalLoginReplayStore(database),
  })
  let clock = Date.UTC(2026, 8, 12)
  const app = buildApp({
    ...owned,
    ...stores,
    rbac,
    tenants,
    bindings,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    now: () => clock,
    provider: new DoubleProvider(),
    audit: rbac.audit,
    breakGlass: ingress.breakGlass,
    requestContext: ingress.requestContext,
    brandingPath: join(directory, 'branding'),
    domainProvisioner: null,
    maxPortalAliases: 5,
    reservedHostnames: new Set(),
    operatorDeleteAfterDays: 30,
    rateLimitAskPerMin: 0,
    rateLimitEstatePerMin: 0,
    rateLimitMcpAuthPerMin: 0,
  })
  const invoke = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Operator ${operatorKey}`)
    return ingress.handle(
      new Request(`http://localhost${path}`, { ...init, headers }),
      (request) => app.fetch(request),
    )
  }
  return {
    directory,
    env,
    database,
    rbac,
    owned,
    tenants,
    bindings,
    stores,
    invoke,
    advance: (ms: number) => clock += ms,
    now: () => clock,
    dispose() {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Every file under the directory, with its path relative to it. */
function files(root: string, dir = root): string[] {
  const found: string[] = []
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) found.push(...files(root, path))
    else found.push(path.slice(root.length + 1))
  }
  return found
}

const researcher: ResearchOwner = { kind: 'user', tenantId: 'tenant-1', oid: 'researcher-1' }

Deno.test('the local server erases every file and row a deleted portal left', async () => {
  const s = await localServer()
  try {
    const created = await s.invoke('/api/admin/tenants', json('POST', { name: 'Erasure Probe' }))
    expect(created.status).toBe(200)
    expect((await created.json()).slug).toBe(SLUG)
    const before = new Set(files(s.directory))

    // Configuration, an alias, a member, branding and a suspension, through the operator routes.
    for (
      const [path, init, status] of [
        [`/api/admin/tenants/${SLUG}`, json('PATCH', { searchPlaceholder: 'Probe' }), 200],
        [`/api/admin/t/${SLUG}/aliases/research.first-customer.example`, { method: 'PUT' }, 200],
        [
          `/api/admin/t/${SLUG}/members`,
          json('POST', {
            subjectKind: 'pending-email',
            subjectId: 'reader@first-customer.example',
            role: 'viewer',
          }),
          201,
        ],
        [`/api/admin/t/${SLUG}/branding/logo`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        }, 200],
        [`/api/admin/t/${SLUG}/lifecycle`, json('PUT', { status: 'suspended', limits: null }), 200],
      ] as const
    ) {
      const response = await s.invoke(path, init)
      expect([path, response.status]).toEqual([path, status])
      await response.body?.cancel()
    }
    // Research, content and generated records, as the portal's users and jobs write them.
    await s.bindings.set(SLUG, {
      baseUrl: 'https://example.test/kb/probe',
      token: 'probe-service-account-token',
      kbId: 'probe',
    })
    s.owned.sessions.put(SLUG, researcher, {
      id: 'session-1',
      title: 'Private history',
      updatedAt: '2026-09-12',
      messages: [],
    })
    const investigation = s.owned.investigations.create(SLUG, researcher, { name: 'Private' })
    s.owned.investigations.addEvidence(SLUG, researcher, investigation.id, {
      resourceId: 'res-1',
      resourceTitle: 'Evidence',
      passage: 'A saved passage',
      score: null,
      question: '',
      verdict: null,
      aiRelevance: null,
      note: '',
      tags: [],
    })
    s.owned.watches.add(SLUG, researcher, 'abalone decline')
    for (
      const [path, value] of [
        [`sessions/${SLUG}/visitor-1/legacy-1.json`, { id: 'legacy-1', slug: SLUG }],
        [`investigations/${SLUG}/visitor-1/legacy-2.json`, { id: 'legacy-2', slug: SLUG }],
        [`watches/${SLUG}.json`, [{ slug: SLUG }]],
        [`mcp-keys/${SLUG}.json`, []],
      ] as const
    ) {
      Deno.mkdirSync(join(s.directory, path, '..'), { recursive: true })
      Deno.writeTextFileSync(join(s.directory, path), JSON.stringify(value))
    }
    s.stores.sources.add(SLUG, 'https://first-customer.example/news', true)
    s.stores.insights.record(SLUG, {
      ts: new Date(s.now()).toISOString(),
      question: 'What did reader@first-customer.example ask?',
      answered: true,
      citations: 1,
      durationSec: 1,
      answerRelevance: 4,
      groundedness: 4,
      contextRelevance: 4,
    })
    s.stores.routing.record(SLUG, {
      ts: new Date(s.now()).toISOString(),
      questionHash: 'abcd1234',
      questionLength: 12,
      intent: 'general',
      stage: 'rule',
      confidence: 1,
      rationale: 'fixture',
      configuration: 'portal-ask',
      latencyMs: 1,
    })
    s.stores.suggestions.replacePending(SLUG, [{
      id: 'suggestion-1',
      kind: 'entity-type',
      title: 'Species',
      detail: 'Research taxonomy',
      status: 'pending',
      createdAt: new Date(s.now()).toISOString(),
      entityType: { label: 'Species', description: 'Animal' },
    }])
    s.stores.kgProposals.set(SLUG, {
      rationale: 'Describe the corpus.',
      entityTypes: [],
      resourceLabels: [],
      chunkLabels: [],
      examples: [],
    })
    s.stores.enrichments.put(SLUG, 'res-1', {
      schemaId: 'suggested-questions',
      generatedAt: new Date(s.now()).toISOString(),
      data: { questions: ['Private question?'] },
    })
    const mentions = (file: string) =>
      file.includes(SLUG) ||
      (!file.startsWith('rbac.sqlite') &&
        new TextDecoder('latin1').decode(Deno.readFileSync(join(s.directory, file))).includes(SLUG))
    const written = files(s.directory).filter((file) => !before.has(file))
    expect(written.length).toBeGreaterThan(15)

    s.advance(31 * DAY)
    const deleted = await s.invoke(`/api/admin/tenants/${SLUG}/delete-suspended?erase=true`, {
      method: 'POST',
    })
    expect(deleted.status).toBe(200)
    const body = await deleted.json()
    expect(body.domain).toEqual({ status: 'not_configured' })
    for (
      const kind of [
        'sessions',
        'investigations',
        'watches',
        'sources',
        'insights',
        'suggestions',
        'enrichments',
        'kgProposals',
        'branding',
        'routing',
        'mcpKeys',
        'auditEvents',
      ]
    ) expect([kind, body.erasure.erased[kind] > 0]).toEqual([kind, true])
    expect(body.erasure.erased.sessions).toBe(2)
    expect(body.erasure.erased.investigations).toBe(2)
    expect(body.erasure.erased.watches).toBe(2)

    // Only the registry still names the portal, as a retired slug.
    const remaining = files(s.directory)
    expect(remaining.filter(mentions)).toEqual(['tenants.json'])
    const registry = JSON.parse(Deno.readTextFileSync(s.env.TENANTS_PATH))
    expect(registry.retired).toEqual([SLUG])
    expect(JSON.stringify({ ...registry, retired: [] })).not.toContain(SLUG)
    expect(remaining.some((file) => file.startsWith('research-v2/'))).toBe(false)
    // Rows in the local SQLite database.
    expect(
      s.database.all(
        "SELECT * FROM role_assignments WHERE scope_kind = 'portal' AND scope_slug = ?",
        SLUG,
      ),
    ).toEqual([])
    const keyed = s.database.all<AuditEvent>(
      `SELECT * FROM audit_events WHERE (scope_kind = 'portal' AND scope_slug = ?)
        OR (scope_kind = 'platform' AND target_id = ?)`,
      SLUG,
      SLUG,
    )
    const requestId = deleted.headers.get('x-request-id')!
    expect(keyed.length).toBeGreaterThan(0)
    expect(keyed.every((event) => event.request_id === requestId)).toBe(true)
    expect(keyed.every((event) => event.actor_id === 'operator:retention-test')).toBe(true)
    expect(JSON.stringify(keyed)).not.toContain('first-customer.example')
    // Nothing is left in memory either, and a restart reads the same tombstone.
    expect(s.stores.enrichments.get(SLUG, 'res-1', 'suggested-questions')).toBeUndefined()
    expect(s.stores.kgProposals.get(SLUG)).toBeUndefined()
    expect(s.bindings.status(SLUG).status).toBe('none')
    expect(new KgProposalStore(s.env).get(SLUG)).toBeUndefined()
    const restarted = new TenantStore(s.env)
    expect(restarted.isRetired(SLUG)).toBe(true)
    expect(restarted.get(SLUG)).toBeUndefined()

    // Idempotent, and a live portal is refused.
    const again = await s.invoke(`/api/admin/tenants/${SLUG}/erase`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect((await again.json()).total).toBe(0)
    expect(files(s.directory).filter(mentions)).toEqual(['tenants.json'])
    const live = await s.invoke('/api/admin/tenants/marine/erase', { method: 'POST' })
    expect(live.status).toBe(409)
    expect(await live.json()).toEqual({ error: 'portal_active' })
    // The operator credential still cannot use the owner's delete.
    const owner = await s.invoke('/api/admin/tenants/marine', { method: 'DELETE' })
    expect(owner.status).toBe(403)
    await owner.body?.cancel()
  } finally {
    s.dispose()
  }
})
