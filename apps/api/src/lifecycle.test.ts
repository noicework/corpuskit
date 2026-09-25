import { expect } from '@std/expect'
import { DOC_PAGES, type DocPage } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import { ADMIN_MATRIX_ROWS, createEnforcementFixture, sessionFor } from './enforcement-fixture.ts'
import { askUse, DECLARATIONS, mutatesPortal } from './permissions.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { tenantConfig } from './tenants.ts'

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
    ) {
      const refused = await f.requestAs(platform, path, json('PUT', invalid))
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({ error: 'invalid_request' })
    }
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
  // Revoking access; granting or changing it is refused.
  'DELETE /api/t/:slug/mcp/keys/:id',
  'DELETE /api/admin/t/:slug/members/:id',
  'DELETE /api/admin/t/:slug/groups/:id',
  // Tightening only, checked by the handler.
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
    // Disable and enable keep their own meaning.
    const admin = f.sessionFor('portal-admin')
    expect((await f.requestAs(admin, '/api/admin/t/a/disable', { method: 'POST' })).status)
      .toBe(200)
    expect((await f.requestAs(admin, '/api/admin/t/a/enable', { method: 'POST' })).status)
      .toBe(200)
    expect(f.stores.lifecycle.get('b').status).toBe('active')
  } finally {
    f.close()
  }
})

Deno.test('read-only lets access be revoked or tightened but never granted or loosened', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin', 'authenticated-a')
    const access = (accessMode: string) =>
      f.requestAs(admin, '/api/admin/t/authenticated-a/access', json('PATCH', { accessMode }))
    const readOnly = async (response: Response) => {
      expect(response.status).toBe(423)
      expect(await response.json()).toEqual({ error: 'portal_read_only' })
    }
    const member = await f.requestAs(
      admin,
      '/api/admin/t/authenticated-a/members',
      json('POST', {
        subjectKind: 'pending-email',
        subjectId: 'reader@example.test',
        role: 'viewer',
      }),
    )
    expect(member.status).toBe(201)
    const memberId = (await member.json()).id
    const group = await f.requestAs(
      admin,
      '/api/admin/t/authenticated-a/groups',
      json('POST', { subjectId: 'fixture-group', role: 'viewer' }),
    )
    const groupId = group.status === 201 ? (await group.json()).id : undefined
    const key = await f.requestAs(
      admin,
      '/api/t/authenticated-a/mcp/keys',
      json('POST', { label: 'Fixture key', role: 'viewer' }),
    )
    expect(key.status).toBe(201)
    const keyId = (await key.json()).credential.id
    f.stores.lifecycle.set('authenticated-a', { status: 'read_only', limits: null })
    // Loosening access, and granting or changing any role or key, is a configuration write.
    await readOnly(await access('public'))
    await readOnly(
      await f.requestAs(
        admin,
        '/api/admin/t/authenticated-a/members',
        json('POST', {
          subjectKind: 'pending-email',
          subjectId: 'new@example.test',
          role: 'viewer',
        }),
      ),
    )
    await readOnly(
      await f.requestAs(
        admin,
        `/api/admin/t/authenticated-a/members/${memberId}`,
        json('PATCH', { role: 'curator' }),
      ),
    )
    await readOnly(
      await f.requestAs(
        admin,
        '/api/admin/t/authenticated-a/groups',
        json('POST', { subjectId: 'another-group', role: 'viewer' }),
      ),
    )
    await readOnly(
      await f.requestAs(
        admin,
        '/api/t/authenticated-a/mcp/keys',
        json('POST', { label: 'Second key', role: 'viewer' }),
      ),
    )
    expect(f.stores.tenants.get('authenticated-a')!.accessMode).toBe('authenticated')
    // Tightening and revoking still work.
    expect((await access('authenticated')).status).toBe(200)
    expect((await access('restricted')).status).toBe(200)
    await readOnly(await access('authenticated'))
    expect(f.stores.tenants.get('authenticated-a')!.accessMode).toBe('restricted')
    expect(
      (await f.requestAs(admin, `/api/admin/t/authenticated-a/members/${memberId}`, {
        method: 'DELETE',
      }))
        .status,
    ).toBe(200)
    if (groupId) {
      expect(
        (await f.requestAs(admin, `/api/admin/t/authenticated-a/groups/${groupId}`, {
          method: 'DELETE',
        }))
          .status,
      ).toBe(200)
    }
    expect(
      (await f.requestAs(admin, `/api/t/authenticated-a/mcp/keys/${keyId}`, { method: 'DELETE' }))
        .status,
    ).toBe(200)
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
    // An answered cross-portal ask is activity on every portal it reached.
    for (const slug of ['a', 'b']) {
      expect(f.stores.lifecycle.usage(slug, 'UTC', f.now()).lastActivityAt).toBe(
        new Date(f.now()).toISOString(),
      )
    }
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

Deno.test('suspending a portal stops a portal role request mid-operation but not a platform request', async () => {
  for (const role of ['portal-admin', 'platform-admin'] as const) {
    let suspend = () => {}
    let pages = 0
    const management = new AragProvider({ resolveBinding: () => undefined })
    Object.assign(management, {
      ensureSearchConfigs: () => Promise.resolve([]),
      // Each documentation page is its own write; the operator pauses the portal after the first.
      ingestDocumentation: (_config: unknown, batch: DocPage[]) => {
        pages++
        if (pages === 1) suspend()
        return Promise.resolve({ created: [], updated: batch.map((page) => page.id), failed: [] })
      },
    })
    const f = createEnforcementFixture({ management })
    suspend = () => f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
    try {
      const response = await f.requestAs(f.sessionFor(role), '/api/admin/t/a/docs/ingest', {
        method: 'POST',
      })
      if (role === 'portal-admin') {
        expect(response.status).toBe(423)
        expect(await response.json()).toEqual({ error: 'portal_suspended' })
        expect(pages).toBe(1)
      } else {
        expect(response.status, role).toBe(200)
        await response.body?.cancel()
        expect(pages).toBe(DOC_PAGES.length)
      }
    } finally {
      f.close()
    }
  }
})

/**
 * A readable corpus of `total` documents whose paid model calls are counted. `onCall` runs
 * inside each model call, before it answers, so a test can change the portal mid-run.
 */
function generationBox(total: number) {
  const box = {
    calls: 0,
    onCall: (_call: number) => {},
    management: new AragProvider({ resolveBinding: () => undefined }),
  }
  const resources = Array.from({ length: total }, (_, index) => ({
    id: `doc-${index + 1}`,
    title: `Report ${index + 1}`,
    summary: `What report ${index + 1} found.`,
  }))
  const text = 'The survey found that the northern reef recovered within two seasons. '.repeat(8)
  Object.assign(box.management, {
    listResources: () => Promise.resolve(resources),
    invalidate: () => {},
    resourceContent: (_config: unknown, id: string) =>
      Promise.resolve({ id, title: 'Report', kind: 'text', texts: [{ fieldId: 'body', text }] }),
    askStructured: () => {
      box.calls++
      box.onCall(box.calls)
      return Promise.resolve({
        object: {
          title: 'Northern reef recovery',
          summary: 'The northern reef recovered within two seasons.',
          questions: [],
        },
      })
    },
  })
  return box
}

async function runEvents(response: Response) {
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

const GENERATION_RUNS = [
  ['enrichments/run', 'research-summary'],
  ['questions/run', 'suggested-questions'],
] as const
const CORPUS = 8
const CHANGE_AT = 5

Deno.test('a generation run stops before its next model call and write once the portal is paused, read-only or has agents disabled', async () => {
  const changes = [
    [{ status: 'suspended', limits: null }, 'portal_suspended'],
    [{ status: 'read_only', limits: null }, 'portal_read_only'],
    [{ status: 'active', limits: { agentsEnabled: false } }, 'agents_disabled'],
  ] as const
  for (const [run, schemaId] of GENERATION_RUNS) {
    for (const [change, code] of changes) {
      const box = generationBox(CORPUS)
      const f = createEnforcementFixture({ management: box.management })
      try {
        let writtenAtChange = -1
        box.onCall = (call) => {
          if (call !== CHANGE_AT) return
          writtenAtChange = f.stores.enrichments.count('a', schemaId)
          f.stores.lifecycle.set('a', change)
        }
        const response = await f.requestAs(
          f.sessionFor('portal-admin'),
          `/api/admin/t/a/${run}`,
          json('POST', {}),
        )
        expect(response.status).toBe(200)
        const events = await runEvents(response)
        const label = `${run} ${code}`
        // The call under way when the change landed was the last model call made.
        expect(box.calls, label).toBe(CHANGE_AT)
        // Resources finished before the change are kept; nothing is written after it, not even
        // the result of the call that was under way.
        expect(writtenAtChange, label).toBeGreaterThan(0)
        expect(f.stores.enrichments.count('a', schemaId), label).toBe(writtenAtChange)
        // The run ends with one event naming the refusal, never a stream of per-item errors.
        expect(events.at(-1), label).toMatchObject({ type: 'error', error: code })
        expect(events.filter((event) => event.type === 'error'), label).toHaveLength(1)
        expect(events.some((event) => event.type === 'done'), label).toBe(false)
        expect(events.some((event) => event.outcome === 'error'), label).toBe(false)
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('a generation run on an active portal completes, and a platform request carries on through a suspension', async () => {
  for (const [run, schemaId] of GENERATION_RUNS) {
    for (const [role, suspend] of [['portal-admin', false], ['platform-admin', true]] as const) {
      const box = generationBox(CORPUS)
      const f = createEnforcementFixture({ management: box.management })
      try {
        box.onCall = (call) => {
          if (suspend && call === CHANGE_AT) {
            f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
          }
        }
        const response = await f.requestAs(f.sessionFor(role), `/api/admin/t/a/${run}`, {
          ...json('POST', {}),
        })
        expect(response.status).toBe(200)
        const events = await runEvents(response)
        const label = `${run} ${role}`
        expect(box.calls, label).toBe(CORPUS)
        expect(f.stores.enrichments.count('a', schemaId), label).toBe(CORPUS)
        expect(events.at(-1), label).toEqual({ type: 'done', enriched: CORPUS, errors: 0 })
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('enriching one resource refuses to store its result once the portal is paused mid-call', async () => {
  const box = generationBox(1)
  const f = createEnforcementFixture({ management: box.management })
  try {
    box.onCall = () => f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
    const before = f.stores.enrichments.count('a')
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/resources/res-1/enrich',
      { method: 'POST' },
    )
    expect(response.status).toBe(423)
    expect(await response.json()).toEqual({ error: 'portal_suspended' })
    expect(box.calls).toBe(1)
    expect(f.stores.enrichments.count('a')).toBe(before)
  } finally {
    f.close()
  }
})

// Independently authored: every route or tool that makes a paid model call for its caller.
const ASKS_COUNTED = new Set([
  'POST /api/t/:slug/ask',
  'POST /api/t/:slug/docs/ask',
  'POST /api/ask-estate',
  'MCP answer_question',
  'POST /api/t/:slug/generate',
  'POST /api/t/:slug/summarize',
  'POST /api/t/:slug/investigations/:id/synthesise',
])
const ASKS_GATED = new Set([
  'POST /api/t/:slug/route',
  'POST /api/t/:slug/subqueries',
  'POST /api/t/:slug/verdicts',
  'POST /api/t/:slug/followups',
])

Deno.test('the declaration table says which routes and tools count toward the daily ask limit', () => {
  for (const declaration of DECLARATIONS) {
    const key = `${declaration.method} ${declaration.path}`
    const expected = ASKS_COUNTED.has(key) ? 'count' : ASKS_GATED.has(key) ? 'gate' : null
    expect(askUse(declaration), key).toBe(expected)
  }
  expect(
    [...ASKS_COUNTED, ...ASKS_GATED].every((key) =>
      DECLARATIONS.some((d) => `${d.method} ${d.path}` === key)
    ),
  ).toBe(true)
  // A paid route added tomorrow counts unless someone exempts it on purpose.
  for (const permission of ['portal.ask', 'portal.generate'] as const) {
    expect(askUse({
      kind: 'http',
      method: 'POST',
      path: '/api/t/:slug/new-answer',
      permission,
      scope: 'portal',
    })).toBe('count')
  }
})

Deno.test('every paid model route is refused once the day is spent, before any dispatch', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.lifecycle.set('a', { status: 'active', limits: { asksPerDay: 0 } })
    const admin = f.sessionFor('portal-admin')
    for (
      const path of [
        '/api/t/a/ask',
        '/api/t/a/docs/ask',
        '/api/t/a/generate',
        '/api/t/a/summarize',
        '/api/t/a/investigations/inv-1/synthesise',
        '/api/t/a/route',
        '/api/t/a/subqueries',
        '/api/t/a/verdicts',
        '/api/t/a/followups',
      ]
    ) {
      const response = await f.requestAs(admin, path, json('POST', { query: 'Abalone?' }))
      expect(response.status, path).toBe(429)
      expect(await response.json(), path).toEqual({
        error: 'ask_quota_exceeded',
        limit: 0,
        resetsAt: '2026-09-13T00:00:00.000Z',
      })
    }
    f.assertNoProtectedDispatch()
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
  } finally {
    f.close()
  }
})

Deno.test('accompanying calls do not count, and a refused request returns its ask', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.lifecycle.set('a', { status: 'active', limits: { asksPerDay: 2 } })
    const admin = f.sessionFor('portal-admin')
    const asks = () => f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday
    // Refused after admission (invalid input, no content service): the ask is returned, and a
    // refused request is not activity either.
    expect((await f.requestAs(admin, '/api/t/a/ask', json('POST', { nope: true }))).status)
      .toBe(400)
    const summary = await f.requestAs(
      admin,
      '/api/t/a/summarize',
      json('POST', { resourceIds: ['res-1'] }),
    )
    expect(summary.status).toBeGreaterThanOrEqual(400)
    await summary.body?.cancel()
    expect(asks()).toBe(0)
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).lastActivityAt).toBeNull()
    // Routing a question accompanies an ask; it does not count on its own.
    const routed = await f.requestAs(admin, '/api/t/a/route', json('POST', { query: 'Abalone?' }))
    expect(routed.status).toBe(200)
    expect(asks()).toBe(0)
    const asked = await f.requestAs(
      admin,
      '/api/t/a/ask',
      json('POST', { query: 'What does the abalone research show?' }),
    )
    expect(asked.status).toBe(200)
    await asked.text()
    expect(asks()).toBe(1)
  } finally {
    f.close()
  }
})

Deno.test('an ask refused by the per-minute rate limit costs no daily quota', async () => {
  const f = createEnforcementFixture({ rateLimitAskPerMin: 1 })
  try {
    f.stores.lifecycle.set('a', { status: 'active', limits: { asksPerDay: 5 } })
    const viewer = f.sessionFor('viewer')
    const ask = () =>
      f.requestAs(viewer, '/api/t/a/ask', json('POST', { query: 'What about abalone?' }))
    const first = await ask()
    expect(first.status).toBe(200)
    await first.text()
    const throttled = await ask()
    expect(throttled.status).toBe(429)
    expect((await throttled.json()).error).not.toBe('ask_quota_exceeded')
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
  } finally {
    f.close()
  }
})

Deno.test('the add routes answer a full portal with the exact limit body and no dispatch', async () => {
  const writes: string[] = []
  const management = new AragProvider({ resolveBinding: () => undefined })
  const record = (name: string) => () => {
    writes.push(name)
    return Promise.resolve({ id: `created-${writes.length}` })
  }
  Object.assign(management, {
    resourceCount: () => Promise.resolve(0),
    createText: record('createText'),
    createLink: record('createLink'),
    uploadFile: record('uploadFile'),
  })
  const f = createEnforcementFixture({ management })
  try {
    const curator = f.sessionFor('portal-admin')
    const add = (suffix: string) =>
      suffix === 'upload'
        ? f.requestAs(curator, '/api/admin/t/a/resources/upload', {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'x-filename': 'notes.txt' },
          body: 'four',
        })
        : f.requestAs(
          curator,
          `/api/admin/t/a/resources/${suffix}`,
          json(
            'POST',
            suffix === 'link'
              ? { url: 'https://example.test/report' }
              : { title: 'Notes', body: 'four' },
          ),
        )
    f.stores.lifecycle.set('a', { status: 'active', limits: { maxResources: 0 } })
    for (const suffix of ['upload', 'link', 'text']) {
      const response = await add(suffix)
      expect(response.status, suffix).toBe(413)
      expect(await response.json(), suffix).toEqual({
        error: 'limit_exceeded',
        limit: 'maxResources',
        value: 1,
        max: 0,
      })
    }
    f.stores.lifecycle.set('a', { status: 'active', limits: { maxBytes: 3 } })
    for (const suffix of ['upload', 'text']) {
      const response = await add(suffix)
      expect(response.status, suffix).toBe(413)
      expect(await response.json(), suffix).toEqual({
        error: 'limit_exceeded',
        limit: 'maxBytes',
        value: 4,
        max: 3,
      })
    }
    expect(writes).toEqual([])
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('a paused portal serves its logo and projects the same logo as its sign-in screen', async () => {
  const f = createEnforcementFixture()
  try {
    const asset = {
      bytes: new Uint8Array([137, 80, 78, 71]),
      contentType: 'image/png',
      version: 'v7',
    }
    f.stores.branding.put('public-a', 'logo', asset)
    f.stores.branding.put('a', 'logo', asset)
    // The restricted portal's sign-in projection names the uploaded logo.
    const signIn = await (await f.requestAs(null, '/api/t/a/config')).json()
    expect(signIn.branding.logoUrl).toBe('/api/t/a/branding/logo?v=v7')
    f.stores.lifecycle.set('public-a', { status: 'suspended', limits: null })
    f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
    const paused = await f.requestAs(null, '/api/t/public-a/config')
    expect(paused.status).toBe(423)
    expect((await paused.json()).branding.logoUrl).toBe('/api/t/public-a/branding/logo?v=v7')
    const pausedRestricted = await (await f.requestAs(null, '/api/t/a/config')).json()
    expect(pausedRestricted.branding).toEqual({ ...signIn.branding })
    const logo = await f.requestAs(null, '/api/t/public-a/branding/logo')
    expect(logo.status).toBe(200)
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(asset.bytes)
    // Only the logo: every other asset, and every other route, stays paused.
    const hero = await f.requestAs(null, '/api/t/public-a/branding/hero')
    expect(hero.status).toBe(423)
    await hero.body?.cancel()
    // The logo is still only for callers who could read it before the pause.
    expect((await f.requestAs(null, '/api/t/a/branding/logo')).status).toBe(401)
  } finally {
    f.close()
  }
})

Deno.test('portals with any addressable slug work, and one unreadable lifecycle fails alone', async () => {
  const f = createEnforcementFixture()
  try {
    f.stores.tenants.seed({ ...tenantConfig('marine')!, slug: 'Research_A', accessMode: 'public' })
    const platform = f.sessionFor('platform-admin')
    expect((await f.requestAs(null, '/api/t/Research_A/config')).status).toBe(200)
    expect(
      (await f.requestAs(
        platform,
        '/api/admin/t/Research_A/lifecycle',
        json('PUT', { status: 'read_only', limits: { asksPerDay: 3 } }),
      )).status,
    ).toBe(200)
    const listed = await (await f.requestAs(null, '/api/tenants')).json()
    expect(listed.find((row: { slug: string }) => row.slug === 'Research_A')?.status).toBe(
      'read_only',
    )
    // A corrupt record fails its own portal closed and leaves every other portal working.
    f.state.put('portal-lifecycle:public-b', { broken: true })
    const tenants = await f.requestAs(null, '/api/tenants')
    expect(tenants.status).toBe(200)
    const rows = (await tenants.json()) as { slug: string }[]
    expect(rows.some((row) => row.slug === 'public-b')).toBe(false)
    expect(rows.some((row) => row.slug === 'public-a')).toBe(true)
    const broken = await f.requestAs(null, '/api/t/public-b/config')
    expect(broken.status).toBe(500)
    expect(await broken.json()).toEqual({ error: 'internal_error' })
    const estate = await f.requestAs(
      f.sessionFor('owner'),
      '/api/ask-estate',
      json('POST', { query: 'What does the abalone research show?' }),
    )
    expect(estate.status).toBe(200)
    await estate.text()
  } finally {
    f.close()
  }
})

Deno.test('an app built without a lifecycle store keeps hosting state in memory only', async () => {
  const directory = Deno.makeTempDirSync()
  const previous = Deno.env.get('DATA_DIR')
  Deno.env.set('DATA_DIR', directory)
  const f = createEnforcementFixture({ lifecycle: undefined })
  try {
    const asked = await f.requestAs(
      f.sessionFor('viewer'),
      '/api/t/a/ask',
      json('POST', { query: 'What does the abalone research show?' }),
    )
    expect(asked.status).toBe(200)
    await asked.text()
    expect(() => Deno.statSync(`${directory}/lifecycle`)).toThrow(Deno.errors.NotFound)
  } finally {
    f.close()
    if (previous === undefined) Deno.env.delete('DATA_DIR')
    else Deno.env.set('DATA_DIR', previous)
    Deno.removeSync(directory, { recursive: true })
  }
})
