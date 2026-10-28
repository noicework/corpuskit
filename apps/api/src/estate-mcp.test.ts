import { expect } from '@std/expect'
import type { AskEvent, SearchResults, TenantConfig } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { assertToolInventory } from './permissions.ts'

/** Per portal: answer as usual, fail, stall until released, or answer with no citation. */
type Behaviour = 'error' | 'stall' | 'uncited'
class EstateProvider extends DoubleProvider {
  readonly behaviour = new Map<string, Behaviour>()
  private stalled: (() => void)[] = []

  release(): void {
    for (const resume of this.stalled.splice(0)) resume()
  }

  private async misbehave(slug: string): Promise<Behaviour | undefined> {
    const behaviour = this.behaviour.get(slug)
    if (behaviour === 'error') throw new Error('upstream detail that must not leak')
    if (behaviour === 'stall') await new Promise<void>((resume) => this.stalled.push(resume))
    return behaviour
  }

  override async search(tenant: TenantConfig, query: string): Promise<SearchResults> {
    await this.misbehave(tenant.slug)
    return await super.search(tenant, query)
  }

  override async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    if (await this.misbehave(tenant.slug) === 'uncited') {
      yield { type: 'delta', text: 'An unsupported claim.' }
      yield { type: 'done', refused: false, text: 'An unsupported claim.' }
      return
    }
    yield* super.ask(tenant, query)
  }
}

type Fixture = ReturnType<typeof createEnforcementFixture>
const ESTATE = '/api/estate/mcp'

function rpc(method: string, params?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }
}
const tool = (name: string, args: Record<string, unknown>, headers?: Record<string, string>) =>
  rpc('tools/call', { name, arguments: args }, headers)
const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

function estateFixture(
  options: Parameters<typeof createEnforcementFixture>[0] = {},
  adapter: 'durable' | 'local' = 'durable',
) {
  const provider = new EstateProvider()
  const f = createEnforcementFixture({ provider, estateSourceTimeoutMs: 50, ...options }, adapter)
  // The key's creator administers portal a (the fixture's creator) and portal b.
  const granted = f.rbac.assignmentService(f.tenantId, f.audience).create({
    subjectKind: 'active-oid',
    subjectId: f.creator.oid,
    scope: { kind: 'portal', slug: 'b' },
    role: 'portal-admin',
  }, { requestId: 'estate-seed', actor: { kind: 'system' } })
  if (!granted.ok) throw new Error('Estate fixture grant failed')
  return { f, provider }
}

async function mint(f: Fixture, body: Record<string, unknown> = {}) {
  const response = await f.requestAs(f.creator, '/api/t/a/mcp/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Estate agent', role: 'viewer', estate: ['b'], ...body }),
  })
  return { status: response.status, body: await response.json() }
}
async function issued(f: Fixture, body: Record<string, unknown> = {}) {
  const result = await mint(f, body)
  expect(result.status).toBe(201)
  return result.body as { key: string; credential: { id: string; estate?: string[] } }
}

async function callTool(f: Fixture, key: string, name: string, args: Record<string, unknown>) {
  const response = await f.requestAs(null, ESTATE, tool(name, args, bearer(key)))
  expect(response.status).toBe(200)
  return {
    requestId: response.headers.get('x-request-id')!,
    result: (await response.json()).result as {
      isError?: boolean
      // deno-lint-ignore no-explicit-any
      structuredContent: any
    },
  }
}

const queried = (f: Fixture, method: string, from = 0) =>
  f.providerCalls.slice(from).filter((call) => call.method === method)
    .map((call) => (call.args[0] as TenantConfig).slug).sort()

Deno.test('an estate key lists the estate tools and gets cited answers and search from each of its portals', async () => {
  const { f } = estateFixture()
  try {
    const { key, credential } = await issued(f)
    expect(credential.estate).toEqual(['b'])
    const listing = await f.requestAs(f.creator, '/api/t/a/mcp/keys')
    expect((await listing.json()).find((row: { id: string }) => row.id === credential.id).estate)
      .toEqual(['b'])

    const list = await f.requestAs(null, ESTATE, rpc('tools/list', undefined, bearer(key)))
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('private, no-store')
    const names = (await list.json()).result.tools.map((item: { name: string }) => item.name)
    expect(names.sort()).toEqual(['answer_estate', 'search_estate'])
    assertToolInventory(names, 'estate')
    expect(() => assertToolInventory(names)).toThrow()

    const before = f.providerCalls.length
    const answer = await callTool(f, key, 'answer_estate', { question: 'Abalone stock health?' })
    expect(answer.result.isError).not.toBe(true)
    const content = answer.result.structuredContent
    expect(content.portals.map((p: { portal: string }) => p.portal)).toEqual(['a', 'b'])
    expect(content.failed_sources).toEqual([])
    expect(content.answers.map((a: { portal: string }) => a.portal)).toEqual(['a', 'b'])
    for (const item of content.answers) {
      expect(item.portalTitle).toBe(f.stores.tenants.get(item.portal)!.branding.productName)
      expect(item.answer).toContain('[1]')
      expect(item.citations.length).toBeGreaterThan(0)
      for (const citation of item.citations) {
        expect(citation).toMatchObject({ portal: item.portal, resourceId: 'res-1' })
      }
    }
    expect(queried(f, 'ask', before)).toEqual(['a', 'b'])

    const search = await callTool(f, key, 'search_estate', { query: 'abalone', limit: 2 })
    const found = search.result.structuredContent
    expect(found.failed_sources).toEqual([])
    expect(found.results.map((r: { portal: string; id: string }) => `${r.portal}:${r.id}`))
      .toEqual(['a:res-1', 'b:res-1', 'a:res-2', 'b:res-2'])
    expect(found.results[0].portalTitle).toBe(f.stores.tenants.get('a')!.branding.productName)
  } finally {
    f.close()
  }
})

Deno.test('a portal outside the key scope is never queried, even public or named in the call', async () => {
  const { f } = estateFixture()
  try {
    const { key } = await issued(f)
    for (const args of [{}, { portals: ['a', 'public-a', 'authenticated-a', 'disabled'] }]) {
      const before = f.providerCalls.length
      const answer = await callTool(f, key, 'answer_estate', { question: 'Abalone?', ...args })
      const expected = 'portals' in args ? ['a'] : ['a', 'b']
      expect(queried(f, 'ask', before)).toEqual(expected)
      expect(answer.result.structuredContent.portals.map((p: { portal: string }) => p.portal))
        .toEqual(expected)
    }
    // Naming only portals outside its scope is refused before any portal is asked.
    const before = f.providerCalls.length
    const outside = await callTool(f, key, 'search_estate', {
      query: 'abalone',
      portals: ['public-b'],
    })
    expect(outside.result.isError).toBe(true)
    f.assertNoProtectedDispatch(before)
    // The estate reaches b only here: b's own endpoint does not know the key.
    const own = await f.requestAs(
      null,
      '/api/t/b/mcp',
      tool('search_corpus', { query: 'abalone' }, bearer(key)),
    )
    expect(own.status).toBe(401)
    f.assertNoProtectedDispatch(before)
    // A plain key reaches its own portal alone at the estate endpoint.
    const { key: plain } = await issued(f, { estate: undefined })
    const single = await callTool(f, plain, 'answer_estate', { question: 'Abalone?' })
    expect(single.result.structuredContent.portals.map((p: { portal: string }) => p.portal))
      .toEqual(['a'])
  } finally {
    f.close()
  }
})

Deno.test('a failing, slow or uncited portal is named in failed_sources while the rest return', async () => {
  const { f, provider } = estateFixture()
  try {
    const { key } = await issued(f)
    for (const [behaviour, reason] of [['error', 'upstream'], ['uncited', 'unverified']] as const) {
      provider.behaviour.set('b', behaviour)
      const { result } = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent.answers.map((a: { portal: string }) => a.portal))
        .toEqual(['a'])
      expect(result.structuredContent.failed_sources).toEqual([{
        portal: 'b',
        portalTitle: f.stores.tenants.get('b')!.branding.productName,
        reason,
      }])
      expect(JSON.stringify(result)).not.toContain('must not leak')
    }
    provider.behaviour.set('b', 'stall')
    const slow = await callTool(f, key, 'search_estate', { query: 'abalone' })
    expect(slow.result.structuredContent.results.every((r: { portal: string }) => r.portal === 'a'))
      .toBe(true)
    expect(slow.result.structuredContent.failed_sources).toMatchObject([{
      portal: 'b',
      reason: 'timeout',
    }])
    // With every portal failing the call is an error that still names each failed source.
    provider.behaviour.set('a', 'error')
    const none = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    expect(none.result.isError).toBe(true)
    expect(none.result.structuredContent.answers).toEqual([])
    expect(
      none.result.structuredContent.failed_sources.map((s: { reason: string }) => s.reason).sort(),
    ).toEqual(['timeout', 'upstream'])
    // A portal whose asks are spent for the day is unavailable; the others still answer.
    provider.behaviour.clear()
    f.stores.lifecycle.set('b', { status: 'active', limits: { asksPerDay: 0 } })
    const spent = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    expect(spent.result.structuredContent.failed_sources).toMatchObject([{
      portal: 'b',
      reason: 'unavailable',
    }])
  } finally {
    provider.release()
    f.close()
  }
})

Deno.test('AT8: an issued key gets a cited answer; the same key once revoked, and an expired key, are refused', async () => {
  // Keys live in the Worker's durable state or in the Deno server's files: both are checked.
  for (const adapter of ['durable', 'local'] as const) {
    const { f } = estateFixture({}, adapter)
    try {
      const { key, credential } = await issued(f)
      const expiring = await issued(f, { expiresAt: new Date(f.now() + 1000).toISOString() })
      for (const live of [key, expiring.key]) {
        const { result } = await callTool(f, live, 'answer_estate', { question: 'Abalone?' })
        expect(result.structuredContent.answers[0].citations.length).toBeGreaterThan(0)
      }
      const revoked = await f.requestAs(f.creator, `/api/t/a/mcp/keys/${credential.id}`, {
        method: 'DELETE',
      })
      expect(revoked.status).toBe(200)
      f.advance(1000)
      for (const dead of [key, expiring.key]) {
        for (const init of [rpc('tools/list'), tool('answer_estate', { question: 'Abalone?' })]) {
          const before = f.providerCalls.length
          const headers = { ...Object.fromEntries(new Headers(init.headers)), ...bearer(dead) }
          const response = await f.requestAs(null, ESTATE, { ...init, headers })
          expect(response.status).toBe(401)
          expect(response.headers.get('www-authenticate')).toBe('Bearer realm="CorpusKit MCP"')
          f.assertNoProtectedDispatch(before)
          expect(
            f.rbac.audit.read({
              scope: { kind: 'platform' },
              requestId: response.headers.get('x-request-id')!,
            }).map((event) => `${event.action}:${event.outcome}`),
          ).toEqual(['request.denied:denied'])
        }
      }
    } finally {
      f.close()
    }
  }
})

Deno.test('a key reaches an estate portal only while its creator keeps a role there', async () => {
  const { f } = estateFixture()
  try {
    const { key } = await issued(f, { role: 'analyst' })
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const grant = service.list().find((row) =>
      row.subjectId === f.creator.oid && row.scope.kind === 'portal' && row.scope.slug === 'b'
    )!
    expect(service.remove(grant.id, { requestId: 'drop-b', actor: { kind: 'system' } }).ok)
      .toBe(true)
    const before = f.providerCalls.length
    const { result } = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    expect(result.structuredContent.portals.map((p: { portal: string }) => p.portal))
      .toEqual(['a'])
    expect(queried(f, 'ask', before)).toEqual(['a'])
  } finally {
    f.close()
  }
})

Deno.test('every estate call is audited per portal with the key, the tool and its outcome', async () => {
  const { f, provider } = estateFixture()
  try {
    const { key, credential } = await issued(f)
    provider.behaviour.set('b', 'error')
    const { requestId } = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    const rows = (slug: string) =>
      f.rbac.audit.read({ scope: { kind: 'portal', slug }, requestId })
        .filter((event) => event.action === 'estate.query')
    for (const [slug, outcome, code] of [['a', 'success'], ['b', 'failure', 'operation_failed']]) {
      const [row, ...rest] = rows(slug!)
      expect(rest).toEqual([])
      expect(row).toMatchObject({
        actor_kind: 'key',
        actor_id: credential.id,
        scope_kind: 'portal',
        scope_slug: slug,
        target_kind: 'tool',
        target_id: 'answer_estate',
        outcome,
      })
      expect(JSON.parse(row!.detail_json)).toEqual({
        permission: 'portal.ask',
        operation: 'MCP answer_estate',
        count: 2,
        keyRole: 'viewer',
        ...(code ? { code } : {}),
      })
    }
    // A required audit write that fails fails the request, and nothing is released.
    f.failAudit()
    const response = await f.requestAs(
      null,
      ESTATE,
      tool('search_estate', { query: 'abalone' }, bearer(key)),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('res-1')
    f.recoverAudit()
  } finally {
    f.close()
  }
})

Deno.test('estate keys are issued only within the creator reach and to portals that exist', async () => {
  const { f } = estateFixture()
  try {
    // The creator holds no role on public-b, and an estate cannot repeat the key's own portal.
    expect((await mint(f, { estate: ['public-b'] })).status).toBe(403)
    expect((await mint(f, { estate: ['a'] })).status).toBe(400)
    expect((await mint(f, { estate: ['b', 'b'] })).status).toBe(400)
    // Not above the creator's role on any portal the estate names.
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const grant = service.list().find((row) =>
      row.subjectId === f.creator.oid && row.scope.kind === 'portal' && row.scope.slug === 'b'
    )!
    service.change(grant.id, { role: 'viewer' }, {
      requestId: 'lower-b',
      actor: { kind: 'system' },
    })
    expect((await mint(f, { role: 'analyst' })).status).toBe(403)
    expect((await mint(f, { role: 'viewer' })).status).toBe(201)
    // A platform owner reaches every portal, so only an unknown portal is refused, as invalid.
    const owner = f.sessionFor('owner')
    const unknown = await f.requestAs(owner, '/api/t/a/mcp/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Estate', role: 'viewer', estate: ['no-such-portal'] }),
    })
    expect(unknown.status).toBe(400)
  } finally {
    f.close()
  }
})

Deno.test('a session reaches its own portals at the estate endpoint and anonymous callers none', async () => {
  const { f } = estateFixture()
  try {
    const before = f.providerCalls.length
    const response = await f.requestAs(
      f.sessionFor('viewer', 'b'),
      ESTATE,
      tool('answer_estate', { question: 'Abalone?' }),
    )
    expect(response.status).toBe(200)
    const content = (await response.json()).result.structuredContent
    expect(content.answers.map((a: { portal: string }) => a.portal)).toEqual(['b'])
    expect(queried(f, 'ask', before)).toEqual(['b'])
    for (const [session, status] of [[null, 401], [f.unassigned, 403]] as const) {
      const start = f.providerCalls.length
      expect((await f.requestAs(session, ESTATE, rpc('tools/list'))).status).toBe(status)
      f.assertNoProtectedDispatch(start)
    }
    expect((await f.requestAs(f.sessionFor('viewer', 'b'), ESTATE)).status).toBe(405)
  } finally {
    f.close()
  }
})

Deno.test('estate answers count against the caller rate limit and failed bearers against the MCP limit', async () => {
  const { f } = estateFixture({ rateLimitAskPerMin: 3, rateLimitMcpAuthPerMin: 4 })
  try {
    const { key } = await issued(f)
    // Two portals are two asks: the first call fits a budget of three, the second does not.
    const first = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    expect(first.result.structuredContent.answers.length).toBe(2)
    const before = f.providerCalls.length
    const second = await callTool(f, key, 'answer_estate', { question: 'Abalone?' })
    expect(second.result.isError).toBe(true)
    expect(second.result.structuredContent).toMatchObject({ error: 'rate_limited' })
    expect(queried(f, 'ask', before)).toEqual([])
    // Searches are not answers. Every request counts toward the MCP limit of four, a failed
    // bearer included, and the fifth is refused before any key is looked up.
    await callTool(f, key, 'search_estate', { query: 'abalone' })
    const unknown = () => f.requestAs(null, ESTATE, rpc('tools/list', undefined, bearer('ck_x')))
    expect((await unknown()).status).toBe(401)
    expect((await unknown()).status).toBe(429)
  } finally {
    f.close()
  }
})
