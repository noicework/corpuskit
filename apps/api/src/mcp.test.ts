import { describe, it } from '@std/testing/bdd'
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
import type { RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { constantTimeHashEqual } from './mcp.ts'
import { McpKeyStore } from './stores.ts'
import { TenantStore } from './tenants.ts'

const RESOURCE: ResourceSummary = {
  id: 'document-1',
  title: 'Abalone stock health',
  summary: 'A grounded summary of current abalone stock indicators.',
  type: 'pdf',
  topicIds: ['stock-assessment'],
  keyFacts: ['Survey abundance was stable in the latest reporting period.'],
}

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

function harness(rateLimitMcpAuthPerMin = 60): McpHarness {
  const dataDir = Deno.makeTempDirSync()
  const keys = new McpKeyStore(dataDir)
  const tenants = new TenantStore({ TENANTS_PATH: `${dataDir}/tenants.json` })
  return {
    dataDir,
    keys,
    app: buildApp({
      provider: new McpStubProvider(),
      tenants,
      mcpKeys: keys,
      rateLimitMcpAuthPerMin,
      trustedUser: (request) => {
        const id = request.headers.get('x-test-user')
        return id ? { id, isAdmin: request.headers.get('x-test-admin') === '1' } : null
      },
    }),
  }
}

const adminHeaders = {
  'content-type': 'application/json',
  'x-test-user': 'admin-user-id',
  'x-test-admin': '1',
}

async function mint(test: McpHarness, slug = 'marine') {
  const response = await test.app.request(`/api/t/${slug}/mcp/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ label: 'Research client' }),
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
      message: 'Administrator access is required.',
    })
  })

  it('shows the key exactly once and persists only its hash', async () => {
    const test = harness()
    const issued = await mint(test)
    expect(issued.key).toMatch(/^ck_mcp_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/)
    expect(issued.key.startsWith(`${issued.credential.prefix}_`)).toBe(true)

    const persisted = await Deno.readTextFile(`${test.dataDir}/mcp-keys/marine.json`)
    expect(persisted).not.toContain(issued.key)
    expect(persisted).toContain('"hash"')
    expect(JSON.parse(persisted)[0].issuerUserId).toBe('admin-user-id')

    const listedResponse = await test.app.request('/api/t/marine/mcp/keys', {
      headers: adminHeaders,
    })
    expect(listedResponse.status).toBe(200)
    expect(listedResponse.headers.get('cache-control')).toBe('no-store')
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
    for (const key of [null, 'not-a-key', 'ck_mcp_abcdefghijkl_' + 'x'.repeat(43)]) {
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
    expect((await mcpRequest(test, 'marine', null, body)).status).toBe(401)
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
