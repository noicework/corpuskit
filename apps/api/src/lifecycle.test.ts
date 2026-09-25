import { expect } from '@std/expect'
import { AragProvider } from '@research-portal/retrieval'
import { ADMIN_MATRIX_ROWS, createEnforcementFixture, sessionFor } from './enforcement-fixture.ts'
import { DECLARATIONS, mutatesPortal } from './permissions.ts'
import { issueScopedKey } from './scoped-keys.ts'

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const matrixBody = (method: string, suffix: string) =>
  ADMIN_MATRIX_ROWS.find(([m, s]) => m === method && s === suffix)?.[3]

Deno.test('lifecycle defaults, replacement, strict input, audit record and portal isolation', async () => {
  const f = createEnforcementFixture()
  try {
    const platform = f.sessionFor('platform-admin')
    const path = '/api/admin/t/a/lifecycle'
    expect(await (await f.requestAs(platform, path)).json()).toEqual({
      status: 'active',
      limits: null,
      updatedAt: null,
    })
    const response = await f.requestAs(
      platform,
      path,
      json('PUT', {
        status: 'read_only',
        limits: { asksPerDay: 3, maxBytes: 1024, agentsEnabled: false },
        note: 'Scheduled maintenance',
      }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.lifecycle).toMatchObject({
      status: 'read_only',
      limits: { asksPerDay: 3, maxBytes: 1024, agentsEnabled: false },
    })
    expect(Number.isFinite(Date.parse(body.lifecycle.updatedAt))).toBe(true)
    expect(body.lifecycle.note).toBeUndefined()
    expect(f.stores.lifecycle.get('b').status).toBe('active')
    const events = f.rbac.audit.read({ scope: { kind: 'platform' } })
    const update = events.find((e) =>
      e.action === 'portal.lifecycle.update' && e.outcome === 'success'
    )!
    expect(update.target_kind).toBe('portal')
    expect(update.target_id).toBe('a')
    expect(JSON.parse(update.detail_json)).toMatchObject({
      lifecycleStatus: 'read_only',
      asksPerDay: 3,
      maxBytes: 1024,
      agentsEnabled: false,
      note: 'Scheduled maintenance',
    })
    for (
      const invalid of [
        null,
        {},
        { status: 'active' },
        { status: 'unknown', limits: null },
        { status: 'active', limits: { maxResources: -1 } },
        { status: 'active', limits: { maxBytes: 0.5 } },
        { status: 'active', limits: { asksPerDay: '1' } },
        { status: 'active', limits: { agentsEnabled: 0 } },
        { status: 'active', limits: { extra: 1 } },
        { status: 'active', limits: null, extra: true },
        { status: 'active', limits: null, note: 'token=private-fixture-value' },
      ]
    ) expect((await f.requestAs(platform, path, json('PUT', invalid))).status).toBe(400)
    expect((await f.requestAs(platform, path, { method: 'PUT', body: '{' })).status).toBe(400)
    expect(JSON.stringify(f.rbac.audit.read({ scope: { kind: 'platform' } }))).not.toContain(
      'private-fixture-value',
    )
    expect((await f.requestAs(platform, path.replace('/a/', '/missing/'))).status).toBe(404)
    expect(
      (await f.requestAs(platform, path, json('PUT', { status: 'active', limits: {} }))).status,
    )
      .toBe(200)
    expect(f.stores.lifecycle.get('a').limits).toEqual({})
    expect(
      (await f.requestAs(platform, path, json('PUT', { status: 'active', limits: null }))).status,
    ).toBe(200)
    expect(f.stores.lifecycle.get('a').limits).toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('lifecycle and usage require platform authority including explicit-key negatives', async () => {
  const f = createEnforcementFixture()
  try {
    for (
      const [method, suffix] of [['GET', 'lifecycle'], ['PUT', 'lifecycle'], ['GET', 'usage']]
    ) {
      for (const role of ['viewer', 'curator', 'portal-admin'] as const) {
        const init = method === 'PUT'
          ? json(method, { status: 'active', limits: null })
          : { method }
        expect((await f.requestAs(f.sessionFor(role), `/api/admin/t/a/${suffix}`, init)).status)
          .toBe(403)
      }
      expect((await f.requestAs(null, `/api/admin/t/a/${suffix}`, { method })).status).toBe(401)
    }
    const key = await issueScopedKey(
      { slug: 'a', label: 'Fixture key', role: 'portal-admin' },
      f.creator,
      f.authorityDependencies(),
    )
    key.commit()
    expect(
      (await f.requestAs(f.sessionFor('owner'), '/api/admin/t/a/lifecycle', {
        method: 'PUT',
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended', limits: null }),
      })).status,
    ).toBe(403)
    expect(f.stores.lifecycle.get('a').status).toBe('active')
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

// Independently authored: the only portal writes a read-only portal still accepts.
const READ_ONLY_EXEMPT = new Set([
  'PUT /api/t/:slug/sessions/:id',
  'DELETE /api/t/:slug/sessions/:id',
  'POST /api/t/:slug/watches',
  'POST /api/t/:slug/watches/:id/seen',
  'DELETE /api/t/:slug/watches/:id',
  'POST /api/t/:slug/investigations',
  'PATCH /api/t/:slug/investigations/:id',
  'DELETE /api/t/:slug/investigations/:id',
  'POST /api/t/:slug/investigations/:id/evidence',
  'PATCH /api/t/:slug/investigations/:id/evidence/:eid',
  'DELETE /api/t/:slug/investigations/:id/evidence/:eid',
  'POST /api/t/:slug/investigations/:id/artefacts',
  'POST /api/t/:slug/investigations/:id/synthesise',
  'POST /api/t/:slug/route',
  'POST /api/t/:slug/generate',
  'POST /api/t/:slug/feedback',
  'POST /api/t/:slug/summarize',
  'POST /api/t/:slug/subqueries',
  'POST /api/t/:slug/verdicts',
  'POST /api/t/:slug/followups',
  'POST /api/t/:slug/ask',
  'POST /api/t/:slug/docs/ask',
  'POST /api/ask-estate',
  'ALL /api/t/:slug/mcp',
  'POST /api/t/:slug/mcp/keys',
  'DELETE /api/t/:slug/mcp/keys/:id',
  'POST /api/admin/t/:slug/members',
  'PATCH /api/admin/t/:slug/members/:id',
  'DELETE /api/admin/t/:slug/members/:id',
  'POST /api/admin/t/:slug/groups',
  'PATCH /api/admin/t/:slug/groups/:id',
  'DELETE /api/admin/t/:slug/groups/:id',
  'PATCH /api/admin/t/:slug/access',
  'POST /api/admin/t/:slug/disable',
  'POST /api/admin/t/:slug/enable',
  'MCP search_corpus',
  'MCP get_document',
  'MCP browse_catalogue',
  'MCP answer_question',
])

Deno.test('every portal write is a read-only mutation unless it is an explicit exemption', () => {
  const writes = DECLARATIONS.filter((d) =>
    d.scope === 'portal' && (d.kind === 'http' || d.kind === 'mcp') &&
    !['GET', 'HEAD'].includes(d.method)
  )
  expect(writes.length).toBeGreaterThan(40)
  for (const declaration of writes) {
    const key = `${declaration.method} ${declaration.path}`
    expect(mutatesPortal(declaration), key).toBe(!READ_ONLY_EXEMPT.has(key))
  }
  expect([...READ_ONLY_EXEMPT].every((key) => writes.some((d) => `${d.method} ${d.path}` === key)))
    .toBe(true)
  // Reads, platform routes and store operations are never portal mutations.
  for (const declaration of DECLARATIONS.filter((d) => !writes.includes(d))) {
    expect(mutatesPortal(declaration), declaration.path).toBe(false)
  }
  // A route added tomorrow is refused in read-only unless someone exempts it on purpose.
  expect(mutatesPortal({
    kind: 'http',
    method: 'POST',
    path: '/api/admin/t/:slug/new-writer',
    permission: 'content.write',
    scope: 'portal',
  })).toBe(true)
})

const contentMutations = [
  ['POST', 'resources/upload'],
  ['POST', 'resources/link'],
  ['POST', 'resources/text'],
  ['POST', 'sources'],
  ['PATCH', 'sources/source'],
  ['DELETE', 'sources/source'],
  ['POST', 'sources/source/sync'],
  ['POST', 'reingest'],
  ['POST', 'labelsets'],
  ['PUT', 'labelsets/topic'],
  ['POST', 'kg/propose'],
  ['POST', 'kg/implement'],
  ['PUT', 'kg/strategy'],
  ['DELETE', 'agents/task'],
  ['POST', 'enrichments/run'],
  ['POST', 'questions/run'],
  ['POST', 'resources/res-1/enrich'],
  ['POST', 'enrichments/import'],
  ['POST', 'purge-failed'],
  ['POST', 'resources/res-1/hidden'],
  ['PUT', 'prompts'],
  ['PUT', 'extraction/rules'],
  ['POST', 'search-configs/ensure'],
  ['POST', 'docs/ingest'],
  ['POST', 'branding/logo'],
  ['POST', 'knowledge-box'],
  ['DELETE', 'knowledge-box'],
  ['POST', 'knowledge-box/create'],
  ['POST', 'analyse'],
  ['POST', 'interrogate'],
  ['POST', 'suggestions/id/implement'],
  ['POST', 'suggestions/id/ignore'],
] as const

Deno.test('read-only refuses every content and configuration route before dispatch, after authorisation', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
    for (const [method, suffix] of contentMutations) {
      const response = await f.requestAs(f.sessionFor('owner'), `/api/admin/t/a/${suffix}`, {
        method,
      })
      expect(response.status, `${method} ${suffix}`).toBe(423)
      expect(await response.json()).toEqual({ error: 'portal_read_only' })
    }
    expect(
      (await f.requestAs(
        f.sessionFor('owner'),
        '/api/admin/tenants/a',
        json('PATCH', { name: 'Changed' }),
      )).status,
    ).toBe(423)
    // Callers without the permission learn nothing new: authorisation answers first.
    expect(
      (await f.requestAs(f.sessionFor('viewer'), '/api/admin/t/a/resources/text', {
        method: 'POST',
      })).status,
    ).toBe(403)
    expect((await f.requestAs(null, '/api/admin/t/a/resources/text', { method: 'POST' })).status)
      .toBe(401)
    f.assertNoProtectedDispatch()
    // Browse, search and configuration reads continue.
    expect((await f.requestAs(f.sessionFor('viewer'), '/api/t/a/search?q=abalone')).status)
      .toBe(200)
    const config = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/config')
    expect(config.status).toBe(200)
    expect((await config.json()).status).toBe('read_only')
    // Access control stays manageable, so access can always be revoked or tightened.
    const admin = f.sessionFor('portal-admin')
    expect((await f.requestAs(admin, '/api/admin/t/a/disable', { method: 'POST' })).status)
      .toBe(200)
    expect((await f.requestAs(admin, '/api/admin/t/a/enable', { method: 'POST' })).status)
      .toBe(200)
    expect(
      (await f.requestAs(admin, '/api/admin/t/a/access', json('PATCH', { mode: 'restricted' })))
        .status,
    ).not.toBe(423)
    expect(f.stores.lifecycle.get('b').status).toBe('active')
  } finally {
    f.close()
  }
})

Deno.test('suspension denies anonymous and portal roles, exposes only safe status metadata, and allows platform recovery', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.lifecycle.set('public-a', { status: 'suspended', limits: null })
    for (
      const session of [
        null,
        f.sessionFor('viewer', 'public-a'),
        f.sessionFor('portal-admin', 'public-a'),
      ]
    ) {
      for (
        const path of [
          '/api/t/public-a/search?q=abalone',
          '/api/t/public-a/config',
          '/api/t/public-a/mcp',
          '/api/admin/t/public-a/counters',
          '/api/admin/t/public-a/enable',
        ]
      ) {
        const response = await f.requestAs(session, path, {
          method: path.endsWith('/enable') ? 'POST' : 'GET',
        })
        expect(response.status, path).toBe(423)
        const body = await response.json()
        expect(body.error).toBe('portal_suspended')
        expect(body.topics).toBeUndefined()
        if (path.endsWith('/config')) {
          expect(Object.keys(body).sort()).toEqual(
            ['accessMode', 'branding', 'error', 'slug', 'status'],
          )
          expect(body.status).toBe('suspended')
          expect(body.branding.productName).toBeTruthy()
        } else expect(Object.keys(body)).toEqual(['error'])
      }
    }
    const list = await (await f.requestAs(null, '/api/tenants')).json()
    expect(list.find((row: { slug: string }) => row.slug === 'public-a').status).toBe('suspended')
    // A cross-portal ask leaves the suspended portal out for non-platform callers.
    const estate = await f.requestAs(
      f.sessionFor('viewer', 'public-a'),
      '/api/ask-estate',
      json('POST', { query: 'What does the abalone research show?', slugs: ['public-a'] }),
    )
    expect(estate.status).not.toBe(200)
    f.assertNoProtectedDispatch()
    const platform = f.sessionFor('platform-admin')
    expect((await f.requestAs(platform, '/api/t/public-a/config')).status).toBe(200)
    expect((await f.requestAs(platform, '/api/admin/t/public-a/lifecycle')).status).toBe(200)
    expect((await f.requestAs(platform, '/api/admin/t/public-a/usage')).status).toBe(200)
    expect(
      (await f.requestAs(
        platform,
        '/api/admin/t/public-a/lifecycle',
        json('PUT', { status: 'active', limits: null }),
      )).status,
    ).toBe(200)
    expect((await f.requestAs(null, '/api/t/public-a/config')).status).toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('disable and lifecycle are independent and lifecycle remains recoverable while disabled', async () => {
  const f = createEnforcementFixture()
  try {
    const platform = f.sessionFor('platform-admin')
    expect((await f.requestAs(platform, '/api/admin/t/a/disable', { method: 'POST' })).status)
      .toBe(200)
    expect(
      (await f.requestAs(
        platform,
        '/api/admin/t/a/lifecycle',
        json('PUT', { status: 'suspended', limits: null }),
      )).status,
    ).toBe(200)
    expect(f.stores.tenants.isDisabled('a')).toBe(true)
    expect((await f.requestAs(platform, '/api/admin/t/a/lifecycle')).status).toBe(200)
    expect((await f.requestAs(platform, '/api/admin/t/a/usage')).status).toBe(200)
    // Enabling brings the portal back only as far as its lifecycle allows.
    const admin = f.sessionFor('portal-admin')
    expect((await f.requestAs(admin, '/api/admin/t/a/enable', { method: 'POST' })).status)
      .toBe(423)
    expect(f.stores.tenants.isDisabled('a')).toBe(true)
    expect((await f.requestAs(platform, '/api/admin/t/a/enable', { method: 'POST' })).status)
      .toBe(200)
    expect(f.stores.tenants.isDisabled('a')).toBe(false)
    expect((await f.requestAs(f.sessionFor('viewer'), '/api/t/a/search?q=abalone')).status)
      .toBe(423)
    await f.requestAs(
      platform,
      '/api/admin/t/a/lifecycle',
      json('PUT', { status: 'active', limits: null }),
    )
    expect((await f.requestAs(f.sessionFor('viewer'), '/api/t/a/search?q=abalone')).status)
      .toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('daily asks atomically cap research, document and help calls before SSE, and reset in portal timezone', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.lifecycle.set('a', { status: 'read_only', limits: { asksPerDay: 1 } })
    const viewer = f.sessionFor('viewer')
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        f.requestAs(
          viewer,
          '/api/t/a/ask',
          json('POST', { query: 'What does the abalone research show?' }),
        )
      ),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429, 429])
    for (const response of responses) await response.text()
    const rejected = await f.requestAs(
      viewer,
      '/api/t/a/docs/ask',
      json('POST', { query: 'How do I search?' }),
    )
    expect(rejected.status).toBe(429)
    const body = await rejected.json()
    expect(body).toEqual({
      error: 'ask_quota_exceeded',
      limit: 1,
      resetsAt: '2026-09-13T00:00:00.000Z',
    })
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
    expect(f.stores.lifecycle.usage('b', 'UTC', f.now()).asksToday).toBe(0)
    f.advance(86_400_000)
    const next = await f.requestAs(
      sessionFor('viewer', 'a', f.now()),
      '/api/t/a/ask',
      json('POST', { query: 'What does the abalone research show?' }),
    )
    expect(next.status).toBe(200)
    await next.text()
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asks30d).toBe(2)
  } finally {
    f.close()
  }
})

Deno.test('a cross-portal ask is admitted on every selected portal or on none', async () => {
  const f = createEnforcementFixture()
  try {
    const owner = f.sessionFor('owner')
    f.stores.lifecycle.set('b', { status: 'active', limits: { asksPerDay: 0 } })
    const refused = await f.requestAs(
      owner,
      '/api/ask-estate',
      json('POST', { query: 'What does the abalone research show?', slugs: ['a', 'b'] }),
    )
    expect(refused.status).toBe(429)
    expect((await refused.json()).error).toBe('ask_quota_exceeded')
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
    f.stores.lifecycle.set('b', { status: 'active', limits: null })
    const admitted = await f.requestAs(
      owner,
      '/api/ask-estate',
      json('POST', { query: 'What does the abalone research show?', slugs: ['a', 'b'] }),
    )
    expect(admitted.status).toBe(200)
    await admitted.text()
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
    expect(f.stores.lifecycle.usage('b', 'UTC', f.now()).asksToday).toBe(1)
  } finally {
    f.close()
  }
})

Deno.test('usage returns the box resource count, ledger bytes, portal assignments and activity', async () => {
  const management = new AragProvider({ resolveBinding: () => undefined })
  let resources = 12
  management.resourceCount = () => Promise.resolve(resources)
  const f = createEnforcementFixture({ management })
  try {
    const platform = f.sessionFor('platform-admin')
    // No knowledge box: nothing is stored.
    expect(await (await f.requestAs(platform, '/api/admin/t/a/usage')).json()).toMatchObject({
      resources: 0,
      bytes: 0,
    })
    f.stores.bindings.set('a', {
      baseUrl: 'https://example.test/kb/a',
      token: 'fixture',
      kbId: 'a',
    })
    const viewer = f.sessionFor('viewer')
    // Reads never write state, so a search is not recorded as activity.
    await f.requestAs(viewer, '/api/t/a/search?q=abalone')
    expect((await (await f.requestAs(platform, '/api/admin/t/a/usage')).json()).lastActivityAt)
      .toBeNull()
    const asked = await f.requestAs(
      viewer,
      '/api/t/a/ask',
      json('POST', { query: 'What does the abalone research show?' }),
    )
    await asked.text()
    const body = await (await f.requestAs(platform, '/api/admin/t/a/usage')).json()
    expect(Object.keys(body).sort()).toEqual([
      'asks30d',
      'asksToday',
      'bytes',
      'lastActivityAt',
      'limits',
      'members',
      'resources',
      'status',
    ])
    expect(body).toMatchObject({
      status: 'active',
      limits: null,
      resources: 12,
      bytes: null,
      asksToday: 1,
      asks30d: 1,
    })
    expect(body.members).toBe(
      f.rbac.assignments.list(f.tenantId).filter((r) =>
        r.scope.kind === 'portal' && r.scope.slug === 'a'
      ).length,
    )
    expect(body.members).toBeGreaterThan(0)
    expect(body.lastActivityAt).toBe(new Date(f.now()).toISOString())
    // An unknown count is a clean 503 with no upstream detail.
    management.resourceCount = () => Promise.reject(new Error('private upstream detail'))
    const failed = await f.requestAs(platform, '/api/admin/t/a/usage')
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: 'usage_unavailable' })
    resources = 0
  } finally {
    f.close()
  }
})

Deno.test('changing the knowledge box starts a fresh ledger and removing a portal clears its lifecycle', async () => {
  const f = createEnforcementFixture({
    domainProvisioner: {
      attach: (hostname) => Promise.resolve({ hostname, created: true }),
      detach: (hostname) => Promise.resolve({ hostname, removed: true }),
    },
  })
  try {
    f.stores.bindings.set('a', {
      baseUrl: 'https://example.test/kb/a',
      token: 'fixture',
      kbId: 'a',
    })
    f.stores.lifecycle.reserveAdd('a', { observed: 0, bytes: 1 })
    expect(f.stores.lifecycle.hasCapacityLedger('a')).toBe(true)
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/knowledge-box',
      {
        method: 'DELETE',
      },
    )
    expect(response.status).toBe(200)
    expect(f.stores.lifecycle.hasCapacityLedger('a')).toBe(false)

    f.stores.lifecycle.set('public-b', { status: 'suspended', limits: { asksPerDay: 1 } })
    const removed = await f.requestAs(f.sessionFor('owner'), '/api/admin/tenants/public-b', {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    expect(f.stores.lifecycle.get('public-b').status).toBe('active')
  } finally {
    f.close()
  }
})

Deno.test('with agents disabled, operations that would start an agent are refused before any write', async () => {
  const calls: string[] = []
  const management = new AragProvider({ resolveBinding: () => undefined })
  const record = (name: string, value: unknown) => () => {
    calls.push(name)
    return Promise.resolve(value)
  }
  Object.assign(management, {
    augmentationModel: record('augmentationModel', 'fixture-model'),
    listAgents: record('listAgents', [{ id: 'kg-1', title: 'kg-a', task: 'llm-graph' }]),
    deleteAgent: record('deleteAgent', undefined),
    startAgent: record('startAgent', undefined),
    updateLabelset: record('updateLabelset', undefined),
    labelsets: record('labelsets', [{ id: 'topic', title: 'Topic', labels: [], multiple: true }]),
    agentConfigs: record('agentConfigs', [{
      id: 'labeller-1',
      title: 'Topic labeller',
      task: 'labeler',
      operations: [{ label: { ident: 'topic', labels: [], multiple: true } }],
    }]),
  })
  const f = createEnforcementFixture({ management })
  try {
    f.stores.bindings.set('a', {
      baseUrl: 'https://example.test/kb/a',
      token: 'fixture',
      kbId: 'a',
    })
    f.stores.lifecycle.set('a', { status: 'active', limits: { agentsEnabled: false } })
    const curator = f.sessionFor('portal-admin')
    const strategy = await f.requestAs(
      curator,
      '/api/admin/t/a/kg/strategy',
      json('PUT', matrixBody('PUT', 'kg/strategy')),
    )
    expect(strategy.status).toBe(403)
    expect(await strategy.json()).toEqual({ error: 'agents_disabled' })
    expect(calls.filter((name) => ['deleteAgent', 'startAgent'].includes(name))).toEqual([])
    calls.length = 0
    const labelset = await f.requestAs(
      curator,
      '/api/admin/t/a/labelsets/topic',
      json('PUT', matrixBody('PUT', 'labelsets/:id')),
    )
    expect(labelset.status).toBe(403)
    expect(await labelset.json()).toEqual({ error: 'agents_disabled' })
    expect(calls).not.toContain('updateLabelset')
    expect(calls).not.toContain('deleteAgent')
    // Once agents are allowed again the same save goes through.
    f.stores.lifecycle.set('a', { status: 'active', limits: null })
    const saved = await f.requestAs(
      curator,
      '/api/admin/t/a/labelsets/topic',
      json('PUT', matrixBody('PUT', 'labelsets/:id')),
    )
    expect(saved.status).not.toBe(403)
    expect(calls).toContain('updateLabelset')
    // Enrichment and suggested-question generators are agents too.
    f.stores.lifecycle.set('a', { status: 'active', limits: { agentsEnabled: false } })
    calls.length = 0
    for (
      const [path, body] of [
        ['enrichments/run', { limit: 1 }],
        ['questions/run', { limit: 1 }],
        ['resources/res-1/enrich', undefined],
      ] as const
    ) {
      const response = await f.requestAs(
        curator,
        `/api/admin/t/a/${path}`,
        body ? json('POST', body) : { method: 'POST' },
      )
      expect(response.status, path).toBe(403)
      expect(await response.json()).toEqual({ error: 'agents_disabled' })
    }
    expect(calls).toEqual([])
  } finally {
    f.close()
  }
})
