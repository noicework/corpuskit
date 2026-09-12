import { afterEach, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import { AragApiError, type RetrievalProvider } from '@research-portal/retrieval'
import { buildApp, type BuildAppOptions } from './app.ts'
import { type AuditEvent, AuditWriteError } from './audit.ts'
import { constantTimeHashEqual, executeMcpTool } from './mcp.ts'
import { DECLARATIONS } from './permissions.ts'
import { McpKeyStore } from './stores.ts'
import { TenantStore } from './tenants.ts'
import { openLocalRbac } from './rbac-local.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { sessionFor } from './enforcement-fixture.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { LocalIngress } from './local-ingress.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const RESOURCE: ResourceSummary = {
  id: 'document-1',
  title: 'Abalone stock health',
  summary: 'A grounded summary of current abalone stock indicators.',
  type: 'pdf',
  topicIds: ['stock-assessment'],
  keyFacts: ['Survey abundance was stable in the latest reporting period.'],
}

Deno.test('future privileged MCP declaration classifies logical and provider failure and fails closed', async () => {
  const declaration = {
    ...DECLARATIONS.find((d) => d.kind === 'mcp' && d.path === 'search_corpus')!,
    permission: 'portal.generate' as const,
  }
  for (const mode of ['logical', 'denied', 'intent', 'completion'] as const) {
    const events: AuditEvent[] = []
    let calls = 0
    const context = {
      requestId: 'future-tool',
      actor: { kind: 'legacy-key' as const, id: 'key-id' },
      slug: 'marine',
      mandatoryFailure: undefined as AuditWriteError | undefined,
    }
    const operation = executeMcpTool(declaration, context, {
      append: (event) => {
        if (mode === 'intent' || (mode === 'completion' && events.length === 1)) {
          throw new AuditWriteError()
        }
        events.push(event)
      },
      read: () => events,
    }, () => {
      calls++
      if (mode === 'denied') throw new AragApiError(401, 'private-url', 'private-body')
      return Promise.resolve({ isError: mode === 'logical' })
    })
    if (mode === 'logical') {
      expect(await operation).toEqual({ isError: true })
      expect(events.at(-1)?.outcome).toBe('failure')
    } else {
      await expect(operation).rejects.toThrow()
      if (mode === 'denied') {
        expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual([
          'request.privileged:intent',
          'request.denied:denied',
          'request.privileged:denied',
        ])
      } else expect(context.mandatoryFailure).toBeInstanceOf(AuditWriteError)
    }
    expect(calls).toBe(mode === 'intent' ? 0 : 1)
    expect(JSON.stringify(events)).not.toContain('private')
  }
})

class McpStubProvider implements RetrievalProvider {
  listResources(): Promise<ResourceSummary[]> {
    return Promise.resolve([RESOURCE])
  }

  resource(_tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    return Promise.resolve(id === RESOURCE.id ? RESOURCE : null)
  }

  search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return Promise.resolve({
      query,
      resources: [{ ...RESOURCE, relevance: 0.94, citedCount: 1 }],
      relatedQuestions: [{ id: 'related-1', text: 'What changed over time?' }],
    })
  }

  suggest(): Promise<Question[]> {
    return Promise.resolve([])
  }

  async *ask(): AsyncIterable<AskEvent> {
    yield {
      type: 'sources',
      resources: [{ ...RESOURCE, relevance: 0.94, citedCount: 1 }],
    }
    yield { type: 'delta', text: 'The latest evidence indicates stable survey abundance.' }
    yield {
      type: 'citation',
      citation: {
        index: 1,
        resourceId: RESOURCE.id,
        title: RESOURCE.title,
        passage: 'Survey abundance was stable in the latest reporting period.',
      },
    }
    yield {
      type: 'quality',
      answerRelevance: 5,
      groundedness: 5,
      contextRelevance: 4,
    }
    yield {
      type: 'done',
      text: 'The latest evidence indicates stable survey abundance. [1]',
    }
  }

  catalog(): Promise<CatalogPage> {
    return Promise.resolve({
      items: [{ id: RESOURCE.id, title: RESOURCE.title, status: 'processed', topicIds: [] }],
      total: 1,
    })
  }

  topicResources(): Promise<ResourceSummary[]> {
    return Promise.resolve([RESOURCE])
  }

  facets(): Promise<FacetCounts> {
    return Promise.resolve({})
  }

  labelsets(): Promise<Labelset[]> {
    return Promise.resolve([])
  }
}

interface McpHarness {
  app: ReturnType<typeof buildApp>
  keys: McpKeyStore
  dataDir: string
}

function harness(
  rateLimitMcpAuthPerMin = 60,
  overrides: Partial<BuildAppOptions> = {},
): McpHarness {
  const dataDir = Deno.makeTempDirSync()
  const { database, rbac } = openLocalRbac({ DATA_DIR: dataDir, ENTRA_TENANT_ID: 'tenant-1' })
  const audit = overrides.audit ?? rbac.audit
  const owned = localOwnedStores(dataDir, database, audit)
  const keys = owned.mcpKeys
  const tenants = new TenantStore({ TENANTS_PATH: `${dataDir}/tenants.json` })
  const writer = { ...sessionFor('portal-admin', 'marine', Date.now()), oid: 'admin-user-id' }
  const service = rbac.assignmentService('tenant-1', 'corpuskit')
  service.observeSession(writer)
  service.create({
    subjectKind: 'active-oid',
    subjectId: writer.oid,
    scope: { kind: 'portal', slug: 'marine' },
    role: 'portal-admin',
  }, { requestId: 'seed', actor: { kind: 'system' } })
  cleanups.push(() => {
    database.close()
    Deno.removeSync(dataDir, { recursive: true })
  })
  return {
    dataDir,
    keys,
    app: buildApp({
      ...owned,
      rbac,
      audit,
      configuredTenantId: 'tenant-1',
      audience: 'corpuskit',
      breakGlass: rbac.breakGlassService({ environment: 'development', passcode: 'fixture' }),
      provider: new McpStubProvider(),
      tenants,
      mcpKeys: keys,
      rateLimitMcpAuthPerMin,
      requestContext: (request) => {
        const id = request.headers.get('x-test-user')
        const session = id ? { ...writer, oid: id } : null
        return {
          requestId: crypto.randomUUID(),
          session,
          coarseAdminEligible: false,
          effectiveRoles: {
            portalRoles: id === writer.oid ? [{ slug: 'marine', role: 'portal-admin' }] : [],
          },
          actor: session ? { kind: 'user', id: session.oid } : { kind: 'anonymous' },
        }
      },
      ...overrides,
    }),
  }
}

Deno.test('MCP transport and provider denials are audited without key material and audit failure is HTTP 500', async () => {
  for (const fail of [false, true]) {
    const events: AuditEvent[] = []
    class DeniedProvider extends McpStubProvider {
      override search(): Promise<SearchResults> {
        throw new AragApiError(403, 'private-url', 'private-body')
      }
    }
    const test = harness(60, {
      provider: new DeniedProvider(),
      audit: {
        append: (event) => {
          if (fail && event.action === 'request.denied') throw new AuditWriteError()
          events.push(event)
        },
        read: () => events,
      },
    })
    const { key, credential } = await mint(test)
    expect(events.every((event) => event.actor_id === 'admin-user-id')).toBe(true)
    events.length = 0
    const response = await mcpRequest(test, 'marine', key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_corpus', arguments: { query: 'Research' } },
    })
    expect(response.status).toBe(fail ? 500 : 200)
    if (!fail) {
      expect((await response.json()).result.isError).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0]?.actor_kind).toBe('key')
      expect(events[0]?.actor_id).toBe(credential.id)
      expect(events[0]?.target_id).toBe('search_corpus')
    }
    const invalid = await mcpRequest(test, 'marine', 'invalid-secret', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    expect(invalid.status).toBe(fail ? 500 : 401)
    expect(JSON.stringify(events)).not.toContain(key)
    expect(JSON.stringify(events)).not.toContain('private-')
  }
})

const adminHeaders = {
  'content-type': 'application/json',
  'x-test-user': 'admin-user-id',
  'x-test-admin': '1',
}

async function mint(test: McpHarness, slug = 'marine') {
  const response = await test.app.request(`/api/t/${slug}/mcp/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ label: 'Research client', role: 'viewer' }),
  })
  expect(response.status).toBe(201)
  return await response.json() as {
    key: string
    credential: { id: string; prefix: string; label: string }
  }
}

async function mcpRequest(
  test: McpHarness,
  slug: string,
  key: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-11-25',
  }
  if (key) headers.authorization = `Bearer ${key}`
  return await test.app.request(`/api/t/${slug}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('MCP credential management', () => {
  it('returns a clean 401 to signed-out users and 403 to non-admin users', async () => {
    const test = harness()
    const anonymous = await test.app.request('/api/t/marine/mcp/keys')
    expect(anonymous.status).toBe(401)

    const nonAdmin = await test.app.request('/api/t/marine/mcp/keys', {
      headers: { 'x-test-user': 'ordinary-user' },
    })
    expect(nonAdmin.status).toBe(403)
    expect(await nonAdmin.json()).toEqual({
      error: 'forbidden',
    })
  })

  it('shows the key exactly once and persists only its hash', async () => {
    const test = harness()
    const issued = await mint(test)
    expect(issued.key).toMatch(/^ck_[A-Za-z0-9_-]{43}$/)
    expect(issued.key.startsWith(issued.credential.prefix)).toBe(true)

    const persisted = await Deno.readTextFile(`${test.dataDir}/mcp-keys/marine.json`)
    expect(persisted).not.toContain(issued.key)
    expect(persisted).toContain('"hash"')
    expect(JSON.parse(persisted)[0].issuerUserId).toBe('admin-user-id')

    const listedResponse = await test.app.request('/api/t/marine/mcp/keys', {
      headers: adminHeaders,
    })
    expect(listedResponse.status).toBe(200)
    expect(listedResponse.headers.get('cache-control')).toBe('private, no-store')
    const listedText = await listedResponse.text()
    expect(listedText).not.toContain(issued.key)
    expect(listedText).not.toContain('"hash"')
    expect(listedText).not.toContain('issuerUserId')
    expect(JSON.parse(listedText)[0].prefix).toBe(issued.credential.prefix)
  })

  it('keeps credentials tenant-scoped and revokes them immediately', async () => {
    const test = harness()
    const issued = await mint(test, 'marine')
    const initialise = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }

    expect((await mcpRequest(test, 'marine', issued.key, initialise)).status).toBe(200)
    const wrongTenant = await mcpRequest(test, 'grains', issued.key, initialise)
    expect(wrongTenant.status).toBe(401)
    expect(await wrongTenant.json()).toEqual({ error: 'unauthorised' })

    const revoked = await test.app.request(
      `/api/t/marine/mcp/keys/${issued.credential.id}`,
      { method: 'DELETE', headers: adminHeaders },
    )
    expect(revoked.status).toBe(200)
    expect((await mcpRequest(test, 'marine', issued.key, initialise)).status).toBe(401)
  })
})

describe('Streamable HTTP MCP endpoint', () => {
  it('fails closed for absent, malformed and unknown credentials', async () => {
    const test = harness()
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' }
    for (const key of ['not-a-key', 'ck_mcp_abcdefghijkl_' + 'x'.repeat(43)]) {
      const response = await mcpRequest(test, 'marine', key, body)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorised' })
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="CorpusKit MCP"')
    }
  })

  it('lists the read-only corpus tools and returns a cited answer', async () => {
    const test = harness()
    const issued = await mint(test)
    const initialise = await mcpRequest(test, 'marine', issued.key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })
    expect(initialise.status).toBe(200)
    expect((await initialise.json()).result.protocolVersion).toBe('2025-11-25')

    const initialised = await mcpRequest(test, 'marine', issued.key, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(initialised.status).toBe(202)

    const listResponse = await mcpRequest(test, 'marine', issued.key, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    expect(listResponse.status).toBe(200)
    const listed = await listResponse.json()
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search_corpus',
      'answer_question',
      'get_document',
      'browse_catalogue',
    ])
    expect(
      listed.result.tools.every((tool: { annotations?: { readOnlyHint?: boolean } }) =>
        tool.annotations?.readOnlyHint === true
      ),
    ).toBe(true)

    for (
      const [name, args, field] of [
        ['search_corpus', { query: 'Research' }, 'resources'],
        ['get_document', { id: RESOURCE.id }, 'document'],
        ['browse_catalogue', {}, 'catalogue'],
      ] as const
    ) {
      const response = await mcpRequest(test, 'marine', issued.key, {
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name, arguments: args },
      })
      expect(response.status).toBe(200)
      const result = (await response.json()).result
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent[field]).toBeDefined()
    }

    const callResponse = await mcpRequest(test, 'marine', issued.key, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'answer_question', arguments: { question: 'What is stock health?' } },
    })
    expect(callResponse.status).toBe(200)
    const called = await callResponse.json()
    expect(called.result.isError).not.toBe(true)
    expect(called.result.structuredContent.answer).toContain('stable survey abundance')
    expect(called.result.structuredContent.citations).toEqual([
      {
        index: 1,
        resourceId: RESOURCE.id,
        title: RESOURCE.title,
        passage: 'Survey abundance was stable in the latest reporting period.',
      },
    ])
  })

  it('rejects legacy GET and DELETE streams in stateless mode', async () => {
    const test = harness()
    const issued = await mint(test)
    for (const method of ['GET', 'DELETE']) {
      const response = await test.app.request('/api/t/marine/mcp', {
        method,
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${issued.key}`,
        },
      })
      expect(response.status).toBe(405)
    }
  })

  it('bounds authentication attempts before retrieval', async () => {
    const test = harness(1)
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' }
    expect((await mcpRequest(test, 'marine', null, body)).status).toBe(200)
    const limited = await mcpRequest(test, 'marine', null, body)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })
})

describe('constant-time digest comparison', () => {
  it('accepts equal hashes and rejects mismatches or malformed values', () => {
    expect(constantTimeHashEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(constantTimeHashEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    expect(constantTimeHashEqual('not-a-hash', 'not-a-hash')).toBe(false)
  })
})

Deno.test('key management strictly binds role, creator, expiry and URL portal', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.creator
    const post = (value: unknown, session = admin, headers = {}) =>
      f.requestAs(session, '/api/t/a/mcp/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(value),
      })
    for (
      const patch of [
        { role: 'owner' },
        { role: 'platform-admin' },
        { role: null },
        { role: undefined },
        { label: '' },
        { label: 'x'.repeat(81) },
        { label: 'bad\nlabel' },
        { tenant: 'b' },
        { slug: 'b' },
        { creator: admin.oid },
        { issuerUserId: admin.oid },
        { expiresAt: null },
        { expiresAt: '2027-01-01' },
        { expiresAt: '2027-01-01T00:00:00Z' },
        { expiresAt: new Date(f.now()).toISOString() },
      ]
    ) {
      expect((await post({ label: 'Key', role: 'viewer', ...patch })).status).toBe(400)
      expect(f.stores.mcpKeys.list('a')).toEqual([])
    }
    for (const role of ['viewer', 'analyst', 'curator'] as const) {
      expect((await post({ label: 'Key', role: 'viewer' }, f.sessionFor(role))).status).toBe(403)
    }
    expect((await post({ label: 'Key', role: 'viewer' }, f.otherTenant)).status).toBe(403)
    expect((await f.requestAs(admin, '/api/t/b/mcp/keys')).status).toBe(403)
    const response = await post({
      label: '  Key  ',
      role: 'portal-admin',
      expiresAt: new Date(f.now() + 1000).toISOString(),
    })
    expect(response.status).toBe(201)
    const issued = await response.json()
    expect(issued.credential).toMatchObject({
      label: 'Key',
      role: 'portal-admin',
      status: 'active',
      effectiveRole: 'portal-admin',
    })
    expect(
      (await post({ label: 'Key', role: 'viewer' }, admin, {
        authorization: `Bearer ${issued.key}`,
      })).status,
    ).toBe(403)
    expect(f.stores.mcpKeys.list('a')).toHaveLength(1)
    expect(
      (await f.requestAs(
        f.sessionFor('portal-admin', 'b'),
        `/api/t/b/mcp/keys/${issued.credential.id}`,
        { method: 'DELETE' },
      )).status,
    ).toBe(404)
    f.advance(1000)
    expect((await (await f.requestAs(admin, '/api/t/a/mcp/keys')).json())[0].status).toBe('expired')
    for (let i = 0; i < 2; i++) {
      expect(
        (await f.requestAs(admin, `/api/t/a/mcp/keys/${issued.credential.id}`, {
          method: 'DELETE',
        })).status,
      ).toBe(200)
    }
    expect((await (await f.requestAs(admin, '/api/t/a/mcp/keys')).json())[0].status).toBe('revoked')
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('break-glass key creation still needs the verified creator and current creator ceiling', async () => {
  const f = createEnforcementFixture()
  try {
    for (
      const [session, role, status] of [
        [null, 'viewer', 403],
        [f.otherTenant, 'viewer', 403],
        [f.unassigned, 'viewer', 403],
        [f.sessionFor('viewer'), 'analyst', 403],
        [f.sessionFor('viewer'), 'viewer', 201],
        [f.creator, 'portal-admin', 201],
      ] as const
    ) {
      const context = await f.contextFor(session)
      const app = buildApp({
        ...f.stores,
        now: f.now,
        provider: f.provider,
        configuredTenantId: f.tenantId,
        audience: f.audience,
        requestContext: () => context,
        breakGlass: f.rbac.breakGlassService({ environment: 'development', passcode: 'fixture' }),
      })
      const response = await app.request('/api/t/a/mcp/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-passcode': 'fixture' },
        body: JSON.stringify({ label: 'Emergency', role }),
      })
      expect(response.status).toBe(status)
      if (status === 201) {
        const issued = await response.json()
        expect(
          f.stores.mcpKeys.list('a').find((row) => row.id === issued.credential.id)?.creator?.oid,
        ).toBe(session!.oid)
      }
    }
    expect(f.stores.mcpKeys.list('a')).toHaveLength(2)
  } finally {
    f.close()
  }
})

Deno.test('real local key HTTP commits restore exact bytes on append and SQL COMMIT failure', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'keys-ingress-' })
  const env = {
    DATA_DIR: directory,
    ENTRA_TENANT_ID: 'tenant-1',
    ENVIRONMENT: 'development',
    ADMIN_PASSCODE: 'fixture',
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    const tenants = new TenantStore({ TENANTS_PATH: `${directory}/tenants.json` })
    const ingress = new LocalIngress({ env, tenants, rbac })
    const writer = sessionFor('owner', 'marine', Date.now())
    let failure: 'append' | 'commit' | 'completion' | undefined
    let observed = 0
    let before: number[] | undefined
    const path = `${directory}/mcp-keys/marine.json`
    const bytes = () => {
      try {
        return [...Deno.readFileSync(path)]
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined
        throw error
      }
    }
    const audit = {
      read: rbac.audit.read.bind(rbac.audit),
      append(event: AuditEvent) {
        if (event.action === 'local.mutation') {
          observed++
          expect(bytes()).not.toEqual(before)
          expect(event.actor_id).toBe(writer.oid)
          expect(event.scope_slug).toBe('marine')
          if (failure === 'append') throw new Error('fixture append')
        }
        if (
          failure === 'completion' && event.action === 'request.privileged' &&
          event.outcome === 'success'
        ) throw new Error('fixture completion')
        rbac.audit.append(event)
        if (failure === 'commit' && event.action === 'local.mutation') {
          database.exec('INSERT INTO key_child(parent_id) VALUES (1)')
        }
      },
    }
    const stores = localOwnedStores(directory, database, audit)
    database.exec('CREATE TABLE key_parent(id INTEGER PRIMARY KEY)')
    database.exec(
      'CREATE TABLE key_child(parent_id INTEGER REFERENCES key_parent(id) DEFERRABLE INITIALLY DEFERRED)',
    )
    const app = buildApp({
      ...stores,
      rbac,
      tenants,
      audit,
      audience: 'corpuskit',
      configuredTenantId: 'tenant-1',
      provider: new McpStubProvider(),
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
    })
    const invoke = (method: string, suffix = '', value?: unknown) =>
      ingress.handle(
        new Request(`http://localhost/api/t/marine/mcp/keys${suffix}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(value ? { body: JSON.stringify(value) } : {}),
        }),
        (request) => app.fetch(request),
        { remoteAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 8791 } },
        writer,
      )
    const value = { label: 'Research', role: 'viewer' }
    for (const mode of ['append', 'commit'] as const) {
      failure = mode
      before = bytes()
      const count = observed
      const denied = await invoke('POST', '', value)
      expect(denied.status).toBe(500)
      expect(await denied.text()).not.toContain('ck_')
      expect(observed).toBe(count + 1)
      expect(bytes()).toEqual(before)
      expect(database.all('SELECT * FROM key_child')).toEqual([])
    }
    failure = undefined
    const issuedResponse = await invoke('POST', '', value)
    expect(issuedResponse.status).toBe(201)
    const issued = await issuedResponse.json()
    // Preserve non-canonical original whitespace too, not only equivalent decoded records.
    Deno.writeTextFileSync(path, '\n  ' + Deno.readTextFileSync(path) + '\n')
    for (const mode of ['append', 'commit'] as const) {
      for (const method of ['POST', 'DELETE']) {
        failure = mode
        before = bytes()
        const count = observed
        const denied = await invoke(
          method,
          method === 'DELETE' ? `/${issued.credential.id}` : '',
          method === 'POST' ? value : undefined,
        )
        expect(denied.status).toBe(500)
        expect(await denied.text()).not.toContain('ck_')
        expect(observed).toBe(count + 1)
        expect(bytes()).toEqual(before)
        expect(stores.mcpKeys.list('marine')).toHaveLength(1)
        expect(stores.mcpKeys.list('marine')[0]!.revokedAt).toBeNull()
        expect(
          rbac.audit.read({
            scope: { kind: 'platform' },
            requestId: denied.headers.get('x-request-id')!,
          }).filter((e) => e.action === 'local.mutation'),
        ).toEqual([])
      }
    }
    failure = 'completion'
    before = bytes()
    const hidden = await invoke('POST', '', value)
    expect(hidden.status).toBe(500)
    expect(await hidden.text()).not.toContain('ck_')
    expect(stores.mcpKeys.list('marine')).toHaveLength(2)
    expect(
      rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: hidden.headers.get('x-request-id')!,
      }).filter((e) => e.action === 'local.mutation'),
    ).toHaveLength(1)
    failure = undefined
    before = bytes()
    expect((await invoke('DELETE', `/${issued.credential.id}`)).status).toBe(200)
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
