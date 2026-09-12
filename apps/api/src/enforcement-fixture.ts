import { expect } from '@std/expect'
import { type Permission, type Role, ROLES, type Scope } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { DurableState, durableStores, type SqlStorageLike } from '../../cloudflare/src/state.ts'
import { buildApp, type BuildAppOptions, type PortalRequestContext } from './app.ts'
import { coarseAdminEligibility, resolveEffectiveRoles } from './assignments.ts'
import type { AuthorityDependencies } from './authorisation.ts'
import type { BreakGlassPolicy } from './break-glass.ts'
import { type TrustedSessionFacts, validSessionFacts } from './principal.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import type { SqlValue } from './rbac-state.ts'
import { tenantConfig } from './tenants.ts'
import { type Declaration, declarationFor } from './permissions.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import type { Hono } from 'hono'
import { assertDeclarationInventory, assertRouteInventory, DECLARATIONS } from './permissions.ts'
import { issueScopedKey } from './scoped-keys.ts'

type MatrixRow = readonly [
  method: string,
  path: string,
  permission: Permission,
  role: Role,
  body?: unknown,
]
/** Literal independent HTTP policy, including all read, research and key operations. */
export const PORTAL_MATRIX_ROWS: readonly MatrixRow[] = [
  ['GET', '/api/health', 'portal.read', 'viewer'],
  ['ALL', '/t/*', 'portal.read', 'viewer'],
  ['GET', '/api/tenants', 'portal.read', 'viewer'],
  ['POST', '/api/ask-estate', 'portal.ask', 'viewer', { query: 'Abalone evidence' }],
  ['GET', '/api/t/:slug/config', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/branding/:kind', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources/:id/thumbnail', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/search', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/docs/search', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/catalog', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/topics/:topicId/resources', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/facets', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/labelsets', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/suggest', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources/:id', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources/:id/questions', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources/:id/content', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/resources/:id/file/:fieldId', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/typeahead', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/graph/relations', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/entities', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/entity', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/knowledge-box', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/counters', 'portal.read', 'viewer'],
  ['GET', '/api/t/:slug/graph', 'portal.read', 'viewer'],
  ['POST', '/api/t/:slug/ask', 'portal.ask', 'viewer', { query: 'Abalone evidence' }],
  ['POST', '/api/t/:slug/docs/ask', 'portal.ask', 'viewer', { query: 'Abalone evidence' }],
  ['POST', '/api/t/:slug/route', 'portal.ask', 'viewer', { query: 'Abalone evidence' }],
  ['POST', '/api/t/:slug/feedback', 'portal.ask', 'viewer', {
    learningId: 'learning-123',
    good: true,
  }],
  ['POST', '/api/t/:slug/generate', 'portal.generate', 'analyst', {
    kind: 'comparison',
    query: 'Abalone evidence',
  }],
  ['POST', '/api/t/:slug/summarize', 'portal.generate', 'analyst', { resourceIds: ['res-1'] }],
  ['POST', '/api/t/:slug/subqueries', 'portal.generate', 'analyst', { query: 'Abalone evidence' }],
  ['POST', '/api/t/:slug/verdicts', 'portal.generate', 'analyst', {
    question: 'Abalone evidence?',
    sources: [{ id: 'res-1', title: 'Evidence', passage: 'Abalone evidence' }],
  }],
  ['POST', '/api/t/:slug/followups', 'portal.generate', 'analyst', {
    question: 'Abalone evidence?',
    answer: 'Abalone evidence',
    passages: [{
      title: 'Evidence',
      text: 'Abalone populations declined across southern waters. '.repeat(8),
    }],
  }],
  ['GET', '/api/t/:slug/sessions', 'portal.ask', 'viewer'],
  ['GET', '/api/t/:slug/sessions/:id', 'portal.ask', 'viewer'],
  ['PUT', '/api/t/:slug/sessions/:id', 'portal.ask', 'viewer', {
    id: 'session',
    title: 'Updated history',
    updatedAt: '2026-09-12',
    messages: [],
  }],
  ['DELETE', '/api/t/:slug/sessions/:id', 'portal.ask', 'viewer'],
  ['GET', '/api/t/:slug/watches', 'portal.read', 'viewer'],
  ['POST', '/api/t/:slug/watches', 'portal.watch', 'analyst', { query: 'New abalone watch' }],
  ['POST', '/api/t/:slug/watches/:id/seen', 'portal.watch', 'analyst'],
  ['DELETE', '/api/t/:slug/watches/:id', 'portal.watch', 'analyst'],
  ['GET', '/api/t/:slug/investigations', 'portal.read', 'viewer'],
  ['POST', '/api/t/:slug/investigations', 'portal.investigate', 'analyst', {
    name: 'New investigation',
  }],
  ['GET', '/api/t/:slug/investigations/:id', 'portal.read', 'viewer'],
  ['PATCH', '/api/t/:slug/investigations/:id', 'portal.investigate', 'analyst', {
    name: 'Updated investigation',
  }],
  ['DELETE', '/api/t/:slug/investigations/:id', 'portal.investigate', 'analyst'],
  ['POST', '/api/t/:slug/investigations/:id/evidence', 'portal.investigate', 'analyst', {
    resourceId: 'res-1',
    resourceTitle: 'Evidence',
    passage: 'New evidence passage',
  }],
  ['PATCH', '/api/t/:slug/investigations/:id/evidence/:eid', 'portal.investigate', 'analyst', {
    note: 'Updated evidence note',
  }],
  ['DELETE', '/api/t/:slug/investigations/:id/evidence/:eid', 'portal.investigate', 'analyst'],
  ['POST', '/api/t/:slug/investigations/:id/artefacts', 'portal.investigate', 'analyst', {
    kind: 'brief',
    title: 'Evidence brief',
    data: { resourceId: 'res-1' },
  }],
  ['POST', '/api/t/:slug/investigations/:id/synthesise', 'portal.investigate', 'analyst'],
  ['GET', '/api/t/:slug/mcp/keys', 'keys.manage', 'portal-admin'],
  ['POST', '/api/t/:slug/mcp/keys', 'keys.manage', 'portal-admin', {
    label: 'New client',
    role: 'viewer',
  }],
  ['DELETE', '/api/t/:slug/mcp/keys/:id', 'keys.manage', 'portal-admin'],
  ['ALL', '/api/t/:slug/mcp', 'portal.read', 'viewer'],
  ['PATCH', '/api/admin/t/:slug/access', 'behaviour.write', 'portal-admin', {
    accessMode: 'authenticated',
  }],
]

/** Checks all three sets, preserving actual infrastructure identity filtering in the production checker. */
export function assertCompleteHttpInventory(app: Hono, declarations = DECLARATIONS): void {
  assertDeclarationInventory(declarations)
  const rows = [
    ...ADMIN_MATRIX_ROWS.map(([method, suffix, permission]) => ({
      method,
      path: suffix.startsWith('/') ? suffix : `/api/admin/t/:slug/${suffix}`,
      permission,
    })),
    ...PORTAL_MATRIX_ROWS.map(([method, path, permission]) => ({ method, path, permission })),
    ...ACCESS_ROUTE_CASES.map(({ method, path }) => ({
      method,
      path,
      permission: path.includes(':slug') ? 'members.manage' : 'platform.members.manage',
    })),
    ...AUDIT_ROUTE_CASES.map(([path, permission]) => ({ method: 'GET', path, permission })),
  ]
  const keys = rows.map((r) => `${r.method} ${r.path}`).sort()
  expect(new Set(keys).size).toBe(keys.length)
  expect(declarations.filter((d) => d.kind === 'http').map((d) => `${d.method} ${d.path}`).sort())
    .toEqual(keys)
  for (const row of rows) {
    expect(
      declarations.find((d) => d.kind === 'http' && d.method === row.method && d.path === row.path)
        ?.permission,
    ).toBe(row.permission)
  }
  assertRouteInventory(app, declarations)
}

const matrixEvidence = 'Abalone populations declined across southern waters.'
export function matrixManagement(calls: string[]): AragProvider {
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    resourceContent: () => ({
      id: 'res-1',
      title: 'Evidence',
      texts: [{ text: matrixEvidence }],
      files: [{ fieldId: 'original', group: 'files' }],
    }),
    resourceExtraction: () => ({ text: matrixEvidence }),
    thumbnailResponse: () => new Response('thumbnail bytes'),
    fileStream: () => new Response('document bytes'),
    typeahead: () => ({ entities: ['Abalone'], titles: ['Evidence'] }),
    entityGroups: () => [{ group: 'Species', entities: ['Abalone'] }],
    relationsGraph: () => ({ nodes: [{ id: 'Abalone', group: 'Species', weight: 1 }], edges: [] }),
    listAgents: () => [],
    counters: () => ({ resources: 2 }),
    graphData: () => ({ nodes: [{ id: 'stock-assessment' }], edges: [] }),
    feedback: () => undefined,
    rephrase: () => null,
    summarize: () => 'Abalone evidence summary',
    askStructured: (_config, schema) => ({
      object: (schema as { name: string }).name.includes('subquer')
        ? { questions: ['What affects abalone?'] }
        : { summary: 'Abalone evidence [1].', items: [], questions: [], verdicts: [] },
      sources: [matrixResource],
    }),
  }
  return new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => {
      calls.push(String(name))
      if (!methods[String(name)]) throw new Error(`Missing matrix method ${String(name)}`)
      return Promise.resolve(methods[String(name)]!(...args))
    },
  }) as AragProvider
}

export async function runPortalMatrixRow(row: MatrixRow): Promise<void> {
  const [method, template, permission, role, body] = row
  const calls: string[] = []
  const f = createEnforcementFixture({ management: matrixManagement(calls) })
  try {
    assertExpectedPermission(
      method,
      template,
      permission,
      template === '/api/health' || template === '/t/*' ? 'public' : 'portal',
    )
    const session = f.sessionFor(role)
    const owner = { kind: 'user' as const, tenantId: session.tenantId, oid: session.oid }
    f.stores.sessions.put('a', owner, {
      id: 'session',
      title: 'Seeded history',
      updatedAt: '2026-09-12',
      messages: [],
    })
    const watch = f.stores.watches.add('a', owner, 'Seeded watch')
    f.stores.watches.update('a', watch.id, { changed: true }, owner)
    const investigation = f.stores.investigations.create('a', owner, {
      name: 'Seeded investigation',
    })
    const evidence = f.stores.investigations.addEvidence('a', owner, investigation.id, {
      resourceId: 'res-1',
      resourceTitle: 'Evidence',
      passage: matrixEvidence,
      score: null,
      question: '',
      verdict: null,
      aiRelevance: null,
      note: '',
      tags: [],
    })!
    f.stores.enrichments.put('a', 'res-1', {
      schemaId: 'suggested-questions',
      generatedAt: new Date(f.now()).toISOString(),
      data: { questions: ['Seeded question?'] },
    })
    f.stores.branding.put('a', 'logo', {
      bytes: new TextEncoder().encode('branding bytes'),
      contentType: 'image/png',
      version: 'fixture',
    })
    f.stores.bindings.set('a', {
      baseUrl: 'https://example.test/kb/a',
      token: 'fixture',
      kbId: 'a',
    })
    const key = await issueScopedKey(
      { slug: 'a', label: 'Seeded client', role: 'viewer' },
      f.creator,
      f.authorityDependencies(),
    )
    key.commit()
    const id = template.includes('/sessions')
      ? 'session'
      : template.includes('/watches')
      ? watch.id
      : template.includes('/investigations')
      ? investigation.id
      : template.includes('/mcp/keys')
      ? key.credential.id
      : 'res-1'
    const path =
      template.replace(':slug', 'a').replace(':id', id).replace(':eid', evidence.id).replace(
        ':kind',
        'logo',
      ).replace(':topicId', 'stock-assessment').replace(':fieldId', 'original').replace(
        '*',
        'a/assistant',
      ) + '?q=abalone&name=Abalone&labelsets=topic,kind'
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const init = {
      method: method === 'ALL' ? template.includes('/mcp') ? 'POST' : 'GET' : method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      ...(body !== undefined || template.endsWith('/mcp')
        ? { body: JSON.stringify(body ?? rpc) }
        : {}),
    }
    const snapshot = () =>
      ['state', 'branding_assets', 'enrichment_records', 'routing_records', 'audit_query_snapshots']
        .map((table) => f.database.all(`SELECT * FROM ${table}`))
    const baseline = snapshot()
    // Public shell/health have deliberately no denied role. D9 and aggregates have explicit redacted alternatives.
    const special = [
      '/api/health',
      '/t/*',
      '/api/tenants',
      '/api/ask-estate',
      '/api/t/:slug/config',
    ].includes(template)
    if (!special) {
      for (
        const denied of [
          f.unassigned,
          f.sessionFor('portal-admin', 'b'),
          ...(role === 'viewer' ? [] : [f.sessionFor('viewer')]),
        ]
      ) {
        const before = f.providerCalls.length
        const response = await f.requestAs(denied, path, init)
        expect(response.status, `${template} denial`).toBe(403)
        f.assertNoProtectedDispatch(before)
        expect(calls).toEqual([])
        expect(snapshot()).toEqual(baseline)
        expect(
          f.rbac.audit.read({
            scope: { kind: 'platform' },
            requestId: response.headers.get('x-request-id')!,
          }).some((e) => e.outcome === 'denied'),
        ).toBe(true)
      }
    }
    const response = await f.requestAs(session, path, init)
    const result = await response.text()
    expect(response.status, `${template}: ${result}`).toBe(
      template === '/t/*' ? 308 : template.endsWith('/mcp/keys') && method === 'POST' ? 201 : 200,
    )
    expect(result).not.toContain('"error":')
    expect(result).not.toContain('"type":"error"')
    if (
      method !== 'GET' && method !== 'ALL' &&
      (template.includes('/sessions') || template.includes('/investigations') ||
        template.includes('/watches') || template.includes('/mcp/keys') ||
        template.endsWith('/access'))
    ) {
      expect(snapshot(), template).not.toEqual(baseline)
    } else if (f.providerCalls.length || calls.length) {
      const operations: Record<string, string> = {
        search: 'search',
        'docs/search': 'search',
        catalog: 'catalog',
        'topics/:topicId/resources': 'topicResources',
        facets: 'facets',
        labelsets: 'labelsets',
        suggest: 'suggest',
        resources: 'listResources',
        'resources/:id': 'resource',
        'resources/:id/thumbnail': 'thumbnailResponse',
        'resources/:id/content': 'resourceContent',
        'resources/:id/file/:fieldId': 'fileStream',
        typeahead: 'typeahead',
        'graph/relations': 'relationsGraph',
        entities: 'entityGroups',
        entity: 'relationsGraph',
        counters: 'counters',
        graph: 'graphData',
        ask: 'ask',
        'docs/ask': 'ask',
        feedback: 'feedback',
        generate: 'askStructured',
        summarize: 'summarize',
        subqueries: 'askStructured',
        verdicts: 'askStructured',
        followups: 'askStructured',
      }
      const suffix = template.replace('/api/t/:slug/', '')
      if (suffix === 'resources/:id/questions') {
        expect(JSON.parse(result)).toEqual({ questions: ['Seeded question?'] })
      } else {
        const expected = template === '/api/ask-estate' ? 'ask' : operations[suffix]
        expect(expected, `missing dispatch assertion ${template}`).toBeDefined()
        expect([...calls, ...f.providerCalls.map((c) => c.method)], template).toContain(expected)
      }
      if (template.endsWith('/ask') || template === '/api/ask-estate') {
        expect(result).toContain('res-1')
      }
    } else {
      const expected: Record<string, string> = {
        '/api/t/:slug/route': 'latencyMs',
        '/api/health': 'ok',
        '/t/*': '',
        '/api/tenants': 'a',
        '/api/t/:slug/config': 'a',
        '/api/t/:slug/branding/:kind': 'branding bytes',
        '/api/t/:slug/knowledge-box': 'connected',
        '/api/t/:slug/sessions': 'Seeded history',
        '/api/t/:slug/sessions/:id': 'Seeded history',
        '/api/t/:slug/watches': 'Seeded watch',
        '/api/t/:slug/investigations': 'Seeded investigation',
        '/api/t/:slug/investigations/:id': 'Seeded investigation',
        '/api/t/:slug/mcp/keys': 'Seeded client',
        '/api/t/:slug/mcp': 'search_corpus',
      }
      expect(expected[template], `missing positive assertion ${template}`).toBeDefined()
      expect(result).toContain(expected[template]!)
      if (template === '/t/*') {
        expect(response.headers.get('location')).toBe(
          '/t/a/ask?q=abalone&name=Abalone&labelsets=topic,kind',
        )
      }
    }
    if (template === '/api/t/:slug/config') {
      const safe = await (await f.requestAs(f.unassigned, path)).json()
      expect(Object.keys(safe).sort()).toEqual(['accessMode', 'branding', 'slug'])
    }
    if (template === '/api/tenants') {
      const safe = JSON.stringify(await (await f.requestAs(f.unassigned, path)).json())
      expect(safe).not.toContain('"slug":"a"')
    }
    if (template === '/api/ask-estate') {
      const before = f.providerCalls.length
      const denied = await f.requestAs(f.unassigned, path, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${key.key}` },
      })
      expect(denied.status).toBe(403)
      f.assertNoProtectedDispatch(before)
    }
  } finally {
    f.close()
  }
}

/** Expectations are supplied independently by each activated route family's fixtures. */
export function assertExpectedPermission(
  method: string,
  path: string,
  permission: Permission,
  scope: Declaration['scope'],
): void {
  const declaration = declarationFor(method, path)
  expect(declaration.permission).toBe(permission)
  expect(declaration.scope).toBe(scope)
}

export interface ProviderCall {
  method: string
  args: unknown[]
}

/** Independent test expectations. Never populate this from production declarations. */
export interface EnforcementRouteCase {
  method: string
  path: string
  params: Record<string, string>
  body: unknown
  seed: (fixture: EnforcementFixture) => void | Promise<void>
  expectedPermission: Permission
  expectedScope: Scope
  assertAllowed: (response: Response, fixture: EnforcementFixture) => void | Promise<void>
}

export function assertNoProtectedDispatch(calls: readonly ProviderCall[], since = 0): void {
  expect(calls.slice(since)).toEqual([])
}

/** Hermetic trusted facts. The slug is part of the oid to keep every persona distinct. */
export function sessionFor(
  role: Role,
  slug = 'a',
  now = Date.UTC(2026, 8, 12),
): TrustedSessionFacts {
  return {
    verified: true,
    tenantId: 'tenant-1',
    oid: `${role}-${slug}`,
    email: `${role}-${slug}@example.test`,
    roles: role === 'owner'
      ? ['CorpusKit.Owner']
      : role === 'platform-admin'
      ? ['CorpusKit.PlatformAdmin']
      : [],
    groups: [],
    groupStatus: 'absent',
    claimIssuedAt: now - 120_000,
    createdAt: now - 60_000,
    expiresAt: now + 3600_000,
  }
}

/** Test-only SQLite, trusted request-context and provider boundary for all route families. */
export function createEnforcementFixture(
  options: Pick<BuildAppOptions, 'management' | 'domainProvisioner'> & {
    breakGlassPolicy?: BreakGlassPolicy
  } = {},
  ownedAdapter: 'durable' | 'local' = 'durable',
) {
  const directory = Deno.makeTempDirSync({ prefix: 'enforcement-' })
  const database = new LocalRbacDatabase(`${directory}/state.sqlite`)
  let clock = Date.UTC(2026, 8, 12)
  const now = () => clock
  const sql: SqlStorageLike = {
    exec<T extends Record<string, ArrayBuffer | string | number | null>>(
      query: string,
      ...bindings: unknown[]
    ) {
      const values = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value
      ) as SqlValue[]
      let rows: T[] = []
      if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
        rows = database.all<T>(query, ...values)
      } else database.exec(query, ...values)
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error('Expected exactly one SQL row')
          return rows[0]!
        },
      }
    },
  }
  const state = new DurableState(sql, database, now)
  state.migrate()
  const durable = durableStores(state, {})
  const stores = {
    ...durable,
    ...(ownedAdapter === 'local'
      ? localOwnedStores(directory, state.rbacDatabase, state.rbac.audit)
      : {}),
    tenants: durable.tenants,
  }
  const tenantId = 'tenant-1'
  const audience = 'corpuskit'
  for (const accessMode of ['public', 'authenticated', 'restricted'] as const) {
    for (const suffix of ['a', 'b']) {
      const slug = accessMode === 'restricted' ? suffix : `${accessMode}-${suffix}`
      stores.tenants.seed({ ...tenantConfig('marine')!, slug, accessMode })
    }
  }
  stores.tenants.seed({ ...tenantConfig('marine')!, slug: 'disabled', accessMode: 'public' })
  stores.tenants.setDisabled('disabled', true)
  const raw = state.get<{ custom: Record<string, unknown> }>('tenants', { custom: {} })
  raw.custom.corrupt = { ...tenantConfig('marine'), slug: 'corrupt', accessMode: null }
  state.put('tenants', raw)
  const personas = new Map<string, TrustedSessionFacts>()
  const assignmentService = () => state.rbac.assignmentService(tenantId, audience)
  const persona = (role: Role, slug = 'a') => {
    const id = `${role}-${slug}`
    const existing = personas.get(id)
    if (existing) return structuredClone(existing)
    const session = sessionFor(role, slug, clock)
    if (role !== 'owner' && role !== 'platform-admin') {
      const result = assignmentService().create({
        subjectKind: 'active-oid',
        subjectId: session.oid,
        scope: { kind: 'portal', slug },
        role,
      }, { requestId: 'fixture-seed', actor: { kind: 'system' } })
      if (!result.ok) throw new Error('Fixture role assignment failed')
    }
    assignmentService().observeSession(session)
    personas.set(id, session)
    return structuredClone(session)
  }
  for (const role of ROLES) for (const slug of ['a', 'b']) persona(role, slug)
  const unassigned: TrustedSessionFacts = {
    ...sessionFor('viewer', 'unassigned', clock),
    oid: 'unassigned',
  }
  const otherTenant = { ...unassigned, tenantId: 'other-tenant', oid: 'other-tenant-user' }
  const providerCalls: ProviderCall[] = []
  const provider = new Proxy(new DoubleProvider(), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        providerCalls.push({ method: String(property), args })
        return value.apply(target, args)
      }
    },
  })
  const contexts = new WeakMap<Request, PortalRequestContext>()
  const contextFor = async (session: TrustedSessionFacts | null): Promise<PortalRequestContext> => {
    if (session && !validSessionFacts(session, clock)) throw new Error('Invalid fixture session')
    const resolution = await resolveEffectiveRoles(
      session,
      {
        rbac: state.rbac,
        tenants: stores.tenants,
        audience,
      },
      tenantId,
      clock,
    )
    return {
      requestId: crypto.randomUUID(),
      session,
      ...resolution,
      coarseAdminEligible: coarseAdminEligibility(resolution.effectiveRoles),
      clientIp: '192.0.2.1',
      actor: session ? { kind: 'user', id: session.oid } : { kind: 'anonymous' },
    }
  }
  const app = buildApp({
    ...stores,
    ...options,
    configuredTenantId: tenantId,
    audience,
    now,
    provider,
    requestContext: (request) => contexts.get(request),
    breakGlass: state.rbac.breakGlassService(
      options.breakGlassPolicy ?? { environment: 'production' },
    ),
    brandingPath: `${directory}/branding`,
    rateLimitAskPerMin: 0,
    rateLimitEstatePerMin: 0,
    rateLimitMcpAuthPerMin: 0,
  })
  const routeCases: EnforcementRouteCase[] = []
  return {
    directory,
    database,
    state,
    stores,
    rbac: state.rbac,
    tenantId,
    audience,
    now,
    advance: (ms: number) => {
      clock += ms
    },
    app,
    provider,
    providerCalls,
    routeCases,
    sessionFor: persona,
    anonymous: null,
    unassigned,
    otherTenant,
    creator: persona('portal-admin', 'a'),
    contextFor,
    authorityDependencies: (
      policy: BreakGlassPolicy = { environment: 'production' },
    ): AuthorityDependencies => ({
      configuredTenantId: tenantId,
      tenants: stores.tenants,
      keys: stores.mcpKeys,
      creatorStores: { rbac: state.rbac, audience },
      audit: state.rbac.audit,
      breakGlass: state.rbac.breakGlassService(policy),
      now,
    }),
    async requestAs(session: TrustedSessionFacts | null, path: string, init?: RequestInit) {
      const request = new Request(`http://localhost${path}`, init)
      contexts.set(request, await contextFor(session))
      try {
        return await app.fetch(request)
      } finally {
        contexts.delete(request)
      }
    },
    assertNoProtectedDispatch: (since = 0) => assertNoProtectedDispatch(providerCalls, since),
    failAudit: () =>
      database.exec(
        "CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
      ),
    recoverAudit: () => database.exec('DROP TRIGGER fixture_fail_audit'),
    close: () => {
      database.close()
      Deno.removeSync(directory, { recursive: true })
    },
  }
}

export type EnforcementFixture = ReturnType<typeof createEnforcementFixture>

/** Independent audit expectations, exercised by audit-routes.test.ts. */
export const AUDIT_ROUTE_CASES = [
  ['/api/admin/t/:slug/audit', 'audit.read', 'portal'],
  ['/api/admin/t/:slug/audit/export', 'audit.export', 'portal'],
  ['/api/admin/audit', 'audit.read', 'platform'],
  ['/api/admin/audit/export', 'audit.export', 'platform'],
] as const

/** Independent access endpoint fixtures, exercised by access-routes.test.ts. */
export const ACCESS_ROUTE_CASES = [
  { method: 'GET', path: '/api/admin/people' },
  {
    method: 'POST',
    path: '/api/admin/people',
    body: { subjectKind: 'active-oid', subjectId: 'access-target', role: 'platform-admin' },
  },
  { method: 'PATCH', path: '/api/admin/people/:id', body: { role: 'owner' } },
  { method: 'DELETE', path: '/api/admin/people/:id' },
  { method: 'GET', path: '/api/admin/groups' },
  {
    method: 'POST',
    path: '/api/admin/groups',
    body: { subjectId: 'access-target', role: 'platform-admin' },
  },
  { method: 'PATCH', path: '/api/admin/groups/:id', body: { role: 'owner' } },
  { method: 'DELETE', path: '/api/admin/groups/:id' },
  { method: 'GET', path: '/api/admin/t/:slug/members' },
  {
    method: 'POST',
    path: '/api/admin/t/:slug/members',
    body: { subjectKind: 'active-oid', subjectId: 'access-target', role: 'viewer' },
  },
  { method: 'PATCH', path: '/api/admin/t/:slug/members/:id', body: { role: 'curator' } },
  { method: 'DELETE', path: '/api/admin/t/:slug/members/:id' },
  { method: 'GET', path: '/api/admin/t/:slug/groups' },
  {
    method: 'POST',
    path: '/api/admin/t/:slug/groups',
    body: { subjectId: 'access-target', role: 'viewer' },
  },
  { method: 'PATCH', path: '/api/admin/t/:slug/groups/:id', body: { role: 'curator' } },
  { method: 'DELETE', path: '/api/admin/t/:slug/groups/:id' },
] as const

import type { AragProvider } from '@research-portal/retrieval'
const matrixResource = (await new DoubleProvider().search(tenantConfig('marine')!, 'abalone'))
  .resources[0]!
const example = {
  text: 'Abalone populations inhabit southern waters.',
  entities: [{ name: 'Abalone', label: 'Species' }, { name: 'southern waters', label: 'Region' }],
  relations: [{ source: 'Abalone', target: 'southern waters', label: 'inhabits' }],
}
const proposal = {
  rationale: 'Describe the research corpus.',
  entityTypes: [{ label: 'Species', description: 'Animal' }, {
    label: 'Region',
    description: 'Place',
  }],
  resourceLabels: [{ label: 'Research', description: 'Research' }],
  chunkLabels: [{ label: 'Finding', description: 'Finding' }],
  examples: Array.from({ length: 6 }, () => example),
}
const html = `<html><title>Research</title><main><p>${
  'Abalone research in southern waters. '.repeat(90)
}</p><a href="https://example.test/article">Article</a></main></html>`
// Independently authored expectations: do not derive these rows or allowed roles from the catalogue.
export const ADMIN_MATRIX_ROWS: [string, string, Permission, unknown?][] = [
  ['GET', 'extraction/methods', 'content.write'],
  ['POST', 'extraction/profile', 'content.write', { resourceId: 'res-1' }],
  ['POST', 'extraction/compare', 'content.write', { resourceId: 'res-1', methods: ['default'] }],
  ['PUT', 'extraction/rules', 'behaviour.write', { default: 'default', rules: [] }],
  ['GET', 'routing', 'behaviour.write'],
  ['GET', '/api/admin/overview', 'platform.settings.write'],
  ['DELETE', 'knowledge-box', 'bindings.write'],
  ['POST', '/api/admin/tenants', 'portal.create', { name: 'New portal' }],
  ['DELETE', '/api/admin/tenants/:slug', 'portal.delete'],
  ['POST', 'knowledge-box/create', 'bindings.write', { title: 'Research' }],
  ['GET', 'counters', 'content.write'],
  ['GET', 'recent', 'content.write'],
  ['POST', 'resources/link', 'content.write', { url: 'https://example.test/article' }],
  ['POST', 'resources/text', 'content.write', { title: 'Research', body: 'Evidence' }],
  ['POST', 'resources/upload', 'content.write', 'evidence bytes'],
  ['POST', 'disable', 'behaviour.write'],
  ['POST', 'enable', 'behaviour.write'],
  ['POST', 'analyse', 'behaviour.write', {}],
  ['PATCH', '/api/admin/tenants/:slug', 'appearance.write', { name: 'Renamed portal' }],
  ['POST', 'kg/propose', 'graph.write', {}],
  ['POST', 'kg/implement', 'graph.write', { applyExisting: false }],
  ['GET', 'suggestions', 'behaviour.write'],
  ['POST', 'interrogate', 'behaviour.write', {}],
  ['POST', 'suggestions/:id/implement', 'behaviour.write', {}],
  ['POST', 'suggestions/:id/ignore', 'behaviour.write', {}],
  ['GET', 'kg/strategy', 'graph.write'],
  ['PUT', 'kg/strategy', 'graph.write', {
    entityTypes: proposal.entityTypes,
    examples: proposal.examples,
    applyExisting: false,
  }],
  ['GET', 'agents', 'graph.write'],
  ['DELETE', 'agents/:taskId', 'graph.write'],
  ['GET', 'enrichments/export', 'portal.export'],
  ['POST', 'enrichments/import', 'enrichments.write', {
    research: {
      'res-1': {
        schemaId: 'research',
        generatedAt: '2026-09-12T00:00:00Z',
        data: { title: 'Research' },
      },
    },
  }],
  ['GET', 'enrichments', 'enrichments.write'],
  ['POST', 'enrichments/run', 'enrichments.write', { limit: 1 }],
  ['POST', 'questions/run', 'enrichments.write', { limit: 1 }],
  ['POST', 'resources/:id/enrich', 'enrichments.write', {}],
  ['POST', 'branding/:kind', 'appearance.write', 'image bytes'],
  ['GET', 'prompts', 'behaviour.write'],
  ['PUT', 'prompts', 'behaviour.write', { ask: 'Research evidence only.' }],
  ['GET', 'search-configs', 'behaviour.write'],
  ['POST', 'search-configs/ensure', 'behaviour.write', {}],
  ['POST', 'docs/ingest', 'content.write', {}],
  ['GET', 'crawl', 'content.write'],
  ['POST', 'labelsets', 'taxonomy.write', {
    title: 'Species',
    labels: ['Abalone'],
    multiple: true,
  }],
  ['PUT', 'labelsets/:id', 'taxonomy.write', {
    title: 'Topic',
    labels: [{ title: 'Research', text: 'Research evidence' }],
    multiple: true,
  }],
  ['POST', 'reingest', 'content.write', { resourceId: 'res-1', html }],
  ['GET', 'corpus-health', 'content.write'],
  ['POST', 'purge-failed', 'content.write', { dryRun: false }],
  ['GET', 'insights', 'content.write'],
  ['POST', 'resources/:id/hidden', 'content.write', { hidden: true }],
  ['GET', 'sources', 'content.write'],
  ['POST', 'sources', 'content.write', { url: 'https://example.test/new' }],
  ['PATCH', 'sources/:id', 'content.write', { auto: false }],
  ['DELETE', 'sources/:id', 'content.write'],
  ['POST', 'sources/:id/sync', 'content.write', {}],
  ['POST', '/api/admin/migrate', 'platform.settings.write', { from: 'a', to: 'b' }],
  ['POST', 'knowledge-box', 'bindings.write', {
    url: 'https://aws-ap-southeast-2-1.rag.progress.cloud/api/v1/kb/fixture-knowledge-box',
    token: 'fixture-service-account-token',
  }],
]
const curatorPermissions = new Set<Permission>([
  'content.write',
  'taxonomy.write',
  'enrichments.write',
  'graph.write',
  'portal.export',
])
const expectedDispatch: Record<string, string> = {
  'extraction/methods': 'listExtractionMethods',
  'extraction/profile': 'fileStream',
  'extraction/compare': 'uploadFile',
  'knowledge-box/create': 'fetch',
  counters: 'counters',
  recent: 'recentResources',
  'resources/link': 'createText',
  'resources/text': 'createText',
  'resources/upload': 'uploadFile',
  analyse: 'askStructured',
  'kg/propose': 'askStructured',
  'kg/implement': 'startAgent',
  interrogate: 'askStructured',
  'suggestions/:id/implement': 'createLabelset',
  'GET kg/strategy': 'graphStrategy',
  'PUT kg/strategy': 'startAgent',
  agents: 'listAgents',
  'agents/:taskId': 'deleteAgent',
  enrichments: 'listResources',
  'enrichments/run': 'listResources',
  'questions/run': 'listResources',
  'resources/:id/enrich': 'resourceContent',
  'search-configs': 'listSearchConfigs',
  'search-configs/ensure': 'ensureSearchConfigs',
  'docs/ingest': 'ingestDocumentation',
  crawl: 'fetch',
  labelsets: 'createLabelset',
  'labelsets/:id': 'updateLabelset',
  reingest: 'deleteResource',
  'corpus-health': 'corpusHealth',
  'purge-failed': 'purgeFailedResources',
  'resources/:id/hidden': 'setResourceHidden',
  sources: 'fetch',
  'sources/:id/sync': 'fetch',
  '/api/admin/migrate': 'createText',
  'POST knowledge-box': 'fetch',
}
export async function runAdminMatrixRow(row: typeof ADMIN_MATRIX_ROWS[number]): Promise<void> {
  const [method, suffix, permission, body] = row
  const template = suffix.startsWith('/') ? suffix : `/api/admin/t/:slug/${suffix}`
  const platform = ['portal.create', 'portal.delete', 'platform.settings.write'].includes(
    permission,
  )
  assertExpectedPermission(method, template, permission, platform ? 'platform' : 'portal')
  for (
    const role of [
      'owner',
      'platform-admin',
      'portal-admin',
      'curator',
      'analyst',
      'wrong-portal',
    ] as const
  ) {
    const calls: string[] = []
    const content = {
      id: 'res-1',
      title: 'Research',
      text: 'Evidence on abalone populations. '.repeat(40),
      pageSummary: 'Abalone populations in southern waters respond to marine heatwaves.',
      files: [{ fieldId: 'file', contentType: 'application/pdf' }],
    }
    const values: Record<string, (...args: unknown[]) => unknown> = {
      listResources: () => [matrixResource],
      labelsets: () => [{ id: 'topic', title: 'Topic', labels: ['Research'], multiple: true }],
      counters: () => ({ resources: 1 }),
      recentResources: () => [matrixResource],
      createText: () => ({ id: 'created' }),
      createLink: () => ({ id: 'created' }),
      uploadFile: () => ({ id: 'created' }),
      createLabelset: () => undefined,
      updateLabelset: () => undefined,
      agentConfigs: () => [],
      listAgents: () => [{ id: 'task-a', title: 'Existing labeller', task: 'labeler' }],
      deleteAgent: () => undefined,
      startAgent: () => undefined,
      graphStrategy: () => ({ entityDefs: proposal.entityTypes, examples: [example] }),
      augmentationModel: () => 'fixture-model',
      resourceContent: () => content,
      resourceExtraction: () => ({
        status: 'PROCESSED',
        text: content.text,
        chars: 1200,
        paragraphs: 1,
        tableRows: 0,
      }),
      fileStream: () => new Response('fixture document'),
      listExtractionMethods: () => [{ id: 'default', name: 'default', kind: 'default' }, {
        id: 'table',
        name: 'table-aware',
        kind: 'tables',
      }, { id: 'visual', name: 'visual-transcribe', kind: 'visual' }],
      patchResourceMeta: () => undefined,
      deleteResource: () => undefined,
      patchResourceClassifications: () => undefined,
      setResourceHidden: () => undefined,
      invalidate: () => undefined,
      listSearchConfigs: () => ['portal-search'],
      ensureSearchConfigs: () => ['portal-search'],
      ingestDocumentation: () => ({ created: 1 }),
      corpusHealth: () => ({ total: 1, failed: 0 }),
      purgeFailedResources: () => ({ deleted: 1 }),
      resourceFull: () => ({
        id: 'res-1',
        title: 'Research',
        slug: 'research',
        kind: 'text',
        originUrl: 'https://example.test/article',
        texts: [{ body: content.text }],
        topicIds: [],
      }),
      hasSlug: () => false,
      askStructured: (_config, schema) => ({
        object: (schema as { name: string }).name === 'knowledge_graph_strategy'
          ? proposal
          : (schema as { name: string }).name === 'portal_configuration'
          ? {
            topics: [{ id: 'research', label: 'Research', description: 'Evidence' }],
            kinds: [],
            assignments: [],
            suggestedQuestions: [],
          }
          : { suggestions: [], score: 5, reason: 'Readable', questions: [] },
      }),
    }
    const management = new Proxy({}, {
      get: (_target, key) => {
        if (key === 'ask') {
          return async function* () {
            calls.push('ask')
            yield { type: 'delta', text: 'Research evidence' }
            yield { type: 'done' }
          }
        }
        return (...args: unknown[]) => {
          calls.push(String(key))
          if (!values[String(key)]) throw new Error(`Missing fixture method ${String(key)}`)
          return Promise.resolve(values[String(key)]!(...args))
        }
      },
    }) as AragProvider
    const fixture = createEnforcementFixture({
      management,
      domainProvisioner: {
        attach: (hostname) => {
          calls.push('attach')
          return Promise.resolve({ hostname, created: true })
        },
        detach: (hostname) => {
          calls.push('detach')
          return Promise.resolve({ hostname, removed: true })
        },
      },
    })
    const originalFetch = globalThis.fetch
    const env = ['ARAG_NUA_KEY', 'ARAG_ACCOUNT'].map((key) => [key, Deno.env.get(key)] as const)
    try {
      const source = fixture.stores.sources.add('a', 'https://example.test/news', true, 1)
      fixture.stores.enrichments.put('a', 'seeded-record', {
        schemaId: 'research',
        generatedAt: '2026-09-12T00:00:00Z',
        data: { title: 'Seeded research' },
      })
      fixture.stores.bindings.set('a', {
        baseUrl: 'https://example.test/kb/a',
        token: 'fixture-token',
        kbId: 'a',
      })
      fixture.stores.suggestions.replacePending('a', [{
        id: 'suggestion-a',
        kind: 'labelset',
        title: 'Species',
        detail: 'Research taxonomy',
        status: 'pending',
        createdAt: new Date(fixture.now()).toISOString(),
        labelset: { id: 'species', title: 'Species', paragraphs: false, labels: ['Abalone'] },
      }])
      fixture.stores.kgProposals.set('a', proposal)
      if (suffix === 'enable') fixture.stores.tenants.setDisabled('a', true)
      const snapshot = () =>
        ['state', 'branding_assets', 'enrichment_records', 'routing_records'].map((table) =>
          fixture.database.all(`SELECT * FROM ${table}`)
        )
      const baseline = snapshot()
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push('fetch')
        const url = String(input)
        if (url.includes('rag.progress.cloud')) {
          return Promise.resolve(Response.json(
            url.endsWith('/keys')
              ? { token: 'fixture-service-token' }
              : init?.method === 'POST'
              ? { id: 'fixture-knowledge-box' }
              : url.endsWith('/counters')
              ? { resources: 1 }
              : [],
          ))
        }
        return Promise.resolve(new Response(html, { headers: { 'content-type': 'text/html' } }))
      }) as typeof fetch
      Deno.env.set('ARAG_NUA_KEY', 'fixture-key')
      Deno.env.set('ARAG_ACCOUNT', 'fixture-account')
      const path =
        template.replace(':slug', 'a').replace(':taskId', 'task-a').replace(':kind', 'logo')
          .replace(
            ':id',
            suffix.startsWith('sources')
              ? source.id
              : suffix.includes('suggestions')
              ? 'suggestion-a'
              : suffix.includes('labelsets')
              ? 'topic'
              : 'res-1',
          ) + (suffix === 'crawl' ? '?url=https://example.test/news' : '')
      const session = fixture.sessionFor(
        role === 'wrong-portal' ? 'portal-admin' : role as Role,
        role === 'wrong-portal' ? 'b' : 'a',
      )
      const allowed = role === 'owner' ||
        (role === 'platform-admin' && permission !== 'portal.delete' &&
          permission !== 'platform.settings.write') ||
        (!platform &&
          (role === 'portal-admin' ||
            role === 'curator' && curatorPermissions.has(permission) ||
            role === 'analyst' && permission === 'portal.export'))
      const response = await fixture.requestAs(session, path, {
        method,
        ...(body === undefined ? {} : {
          headers: {
            'content-type': suffix.startsWith('branding') ? 'image/png' : 'application/json',
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      })
      const result = await response.text()
      expect(response.status, `${role} ${template}: ${result}`).toBe(allowed ? 200 : 403)
      if (allowed) {
        expect(result).not.toContain('"type":"error"')
        expect(result).not.toContain('"error":')
        const dispatch = expectedDispatch[`${method} ${suffix}`] ?? expectedDispatch[suffix]
        if (
          dispatch && !(method === 'GET' && suffix === 'sources') &&
          !(method === 'DELETE' && suffix === 'knowledge-box')
        ) {
          expect(calls, `${template} must dispatch ${dispatch}`).toContain(dispatch)
        } else if (suffix === '/api/admin/overview') {
          expect(fixture.providerCalls.some((call) => call.method === 'listResources')).toBe(
            true,
          )
          expect(
            JSON.parse(result).some((row: { tenant: { slug: string } }) => row.tenant.slug === 'a'),
          ).toBe(true)
        } else if (method === 'GET') {
          if (suffix === 'sources') expect(JSON.parse(result)[0].id).toBe(source.id)
          else if (suffix === 'suggestions') {
            expect(JSON.parse(result)[0].id).toBe('suggestion-a')
          } else if (suffix === 'enrichments/export') {
            expect(result).toContain('Seeded research')
          } else if (suffix === 'prompts') {
            expect(JSON.parse(result)).toEqual(fixture.stores.tenants.promptsFor('a'))
          } else if (suffix === 'insights') {
            expect(JSON.parse(result)).toEqual(fixture.stores.insights.summary('a'))
          } else if (suffix === 'routing') expect(JSON.parse(result)).toHaveProperty('recent')
          else throw new Error(`Missing positive assertion for ${template}`)
        } else {
          expect(snapshot(), `${template} must change protected state`).not.toEqual(baseline)
          if (suffix === 'disable' || suffix === 'enable') {
            expect(fixture.stores.tenants.isDisabled('a')).toBe(suffix === 'disable')
          }
          if (suffix === '/api/admin/tenants') {
            expect(fixture.stores.tenants.get('new-portal')?.branding.productName).toBe(
              'New portal',
            )
          }
          if (suffix === '/api/admin/tenants/:slug') {
            expect(fixture.stores.tenants.get('a')?.branding.productName).toBe(
              method === 'DELETE' ? undefined : 'Renamed portal',
            )
          }
          if (suffix === 'knowledge-box') {
            expect(fixture.stores.bindings.get('a')).toBeUndefined()
          }
        }
        const events = fixture.rbac.audit.read({ scope: { kind: 'platform' }, limit: 1000 })
        expect(
          events.some((event) =>
            event.action === 'request.privileged' && event.outcome === 'success'
          ),
        ).toBe(true)
      } else {
        expect(calls).toEqual([])
        fixture.assertNoProtectedDispatch()
        expect(snapshot()).toEqual(baseline)
      }
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of env) {
        if (value === undefined) Deno.env.delete(key)
        else Deno.env.set(key, value)
      }
      fixture.close()
    }
  }
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
export async function runAccessMatrix(): Promise<void> {
  for (const route of ACCESS_ROUTE_CASES) {
    const platform = !route.path.includes(':slug')
    const scope = platform ? { kind: 'platform' as const } : { kind: 'portal' as const, slug: 'a' }
    assertExpectedPermission(
      route.method,
      route.path,
      platform ? 'platform.members.manage' : 'members.manage',
      platform ? 'platform' : 'portal',
    )
    for (
      const role of [
        'owner',
        'platform-admin',
        'portal-admin',
        'curator',
        'analyst',
        'viewer',
        'wrong-portal',
        'anonymous',
        'other-tenant',
      ] as const
    ) {
      const f = createEnforcementFixture()
      try {
        f.database.exec(
          "INSERT OR REPLACE INTO rbac_group_capabilities (audience,status,verified_at) VALUES ('corpuskit','verified-supported',0)",
        )
        const service = f.rbac.assignmentService(f.tenantId, f.audience)
        const group = route.path.includes('/groups')
        const seeded = service.create({
          subjectKind: group ? 'group' : 'active-oid',
          subjectId: 'existing-target',
          scope,
          role: platform ? 'platform-admin' : 'viewer',
        }, { requestId: 'seed', actor: { kind: 'system' } })
        if (!seeded.ok) throw new Error('seed failed')
        const before = service.list()
        const session = role === 'anonymous'
          ? null
          : role === 'other-tenant'
          ? f.otherTenant
          : role === 'wrong-portal'
          ? f.sessionFor('portal-admin', 'b')
          : f.sessionFor(role)
        const path = route.path.replace(':slug', 'a').replace(':id', seeded.value.id)
        const response = await f.requestAs(
          session,
          path,
          'body' in route ? json(route.method, route.body) : { method: route.method },
        )
        const allowed = (platform ? ['owner'] : ['owner', 'platform-admin', 'portal-admin'])
          .includes(role)
        expect(response.status, `${role} ${route.method} ${path}`).toBe(
          allowed ? route.method === 'POST' ? 201 : 200 : role === 'anonymous' ? 401 : 403,
        )
        const body = await response.json()
        if (allowed) {
          if (route.method === 'GET') expect(body.items).toContainEqual(seeded.value)
          else {expect(body).toMatchObject({
              subjectKind: group ? 'group' : 'active-oid',
              scope,
              role: platform
                ? route.method === 'PATCH' ? 'owner' : 'platform-admin'
                : route.method === 'PATCH'
                ? 'curator'
                : 'viewer',
            })}
        } else {
          expect(service.list()).toEqual(before)
          expect(
            f.rbac.audit.read({
              scope: { kind: 'platform' },
              requestId: response.headers.get('x-request-id')!,
            }).some((event) => event.outcome === 'denied'),
          ).toBe(true)
        }
        f.assertNoProtectedDispatch()
      } finally {
        f.close()
      }
    }
  }
}

import { type AuditEvent, createAuditEvent } from './audit.ts'
function seedMatrixAudit(
  f: ReturnType<typeof createEnforcementFixture>,
  id: string,
  slug: string | null = 'a',
  at = f.now(),
): AuditEvent {
  const event = createAuditEvent(
    {
      requestId: 'fixture-audit',
      actor: { kind: 'user', id: 'audit-subject' },
      action: 'request.privileged',
      scope: slug === null ? { kind: 'platform' } : { kind: 'portal', slug },
      target: { kind: 'request' },
      outcome: 'success',
    },
    () => at,
    () => id,
  )
  f.rbac.audit.append(event)
  return event
}

export async function runAuditMatrix(): Promise<void> {
  for (const [template, permission, scope] of AUDIT_ROUTE_CASES) {
    assertExpectedPermission('GET', template, permission, scope)
    for (
      const role of [
        'owner',
        'platform-admin',
        'portal-admin',
        'curator',
        'analyst',
        'viewer',
        'wrong-portal',
        'anonymous',
        'other-tenant',
      ] as const
    ) {
      const f = createEnforcementFixture()
      try {
        const a = seedMatrixAudit(f, 'portal-a')
        const b = seedMatrixAudit(f, 'portal-b', 'b')
        const platform = seedMatrixAudit(f, 'platform-event', null)
        const session = role === 'anonymous'
          ? null
          : role === 'other-tenant'
          ? f.otherTenant
          : role === 'wrong-portal'
          ? f.sessionFor('portal-admin', 'b')
          : f.sessionFor(role)
        const before = f.database.all('SELECT * FROM audit_query_snapshots')
        let eventQueries = 0
        const original = f.database.all.bind(f.database)
        f.database.all = (query, ...bindings) => {
          if (query.includes('SELECT audit_events.*')) eventQueries++
          return original(query, ...bindings)
        }
        const response = await f.requestAs(session, template.replace(':slug', 'a'))
        const allowed = ['owner', 'platform-admin', ...(scope === 'portal' ? ['portal-admin'] : [])]
          .includes(role)
        expect(response.status, `${role} ${template}`).toBe(
          allowed ? 200 : role === 'anonymous' ? 401 : 403,
        )
        const body = await response.json()
        if (allowed) {
          expect(body.items).toContainEqual(a)
          if (scope === 'platform') {
            expect(body.items).toContainEqual(b)
            expect(body.items).toContainEqual(platform)
          } else {
            expect(
              body.items.every((e: AuditEvent) =>
                e.scope_kind === 'portal' && e.scope_slug === 'a'
              ),
            ).toBe(true)
          }
          expect(body.complete).toBe(true)
          expect(body.nextCursor).toBe(null)
        } else {
          expect(f.database.all('SELECT * FROM audit_query_snapshots')).toEqual(before)
          expect(eventQueries).toBe(0)
        }
        f.assertNoProtectedDispatch()
      } finally {
        f.close()
      }
    }
  }
}
