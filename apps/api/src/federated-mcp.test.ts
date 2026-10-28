import { expect } from '@std/expect'
import {
  type AgentAskEvent,
  AnswerGuardrailsSchema,
  type SearchResults,
} from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { assertToolInventory, DECLARATIONS } from './permissions.ts'
import { collectFederatedAnswer } from './federated-mcp.ts'
import { peerKeyName } from './bindings.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { aragPeerFetch } from '../../../e2e/support/arag-peer-double.ts'

const rpc = (method: string, params?: unknown, key?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})
const tool = (name: string, args: unknown, key?: string) =>
  rpc('tools/call', { name, arguments: args }, key)
const names = (body: { result: { tools: { name: string }[] } }) =>
  body.result.tools.map((entry) => entry.name)

Deno.test('federated tool schemas, declarations and feature visibility are enforced before dispatch', async () => {
  const f = createEnforcementFixture()
  const viewer = f.sessionFor('viewer')
  try {
    const list = await f.requestAs(viewer, '/api/t/a/mcp', rpc('tools/list'))
    const body = await list.json()
    assertToolInventory(names(body), 'portal', true)
    for (const name of ['ask_federated', 'search_federated']) {
      expect(DECLARATIONS.find((d) => d.kind === 'mcp' && d.path === name)?.permission)
        .toBe('portal.ask')
      const schema = body.result.tools.find((t: { name: string }) => t.name === name).inputSchema
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema.properties[name === 'ask_federated' ? 'question' : 'query'].maxLength).toBe(
        2000,
      )
      for (
        const args of [{}, { question: '' }, { query: '' }, { query: 'x', limit: 21 }, {
          question: 'x',
          extra: 'private',
        }]
      ) {
        const before = f.providerCalls.length
        const invalid = await f.requestAs(viewer, '/api/t/a/mcp', tool(name, args))
        const value = await invalid.json()
        expect(Boolean(value.error || value.result?.isError)).toBe(true)
        f.assertNoProtectedDispatch(before)
      }
      for (const session of [null, f.unassigned, f.sessionFor('viewer', 'b')]) {
        const before = f.providerCalls.length
        const denied = await f.requestAs(session, '/api/t/a/mcp', tool(name, { question: 'Why?' }))
        expect(denied.status).toBe(session ? 403 : 401)
        f.assertNoProtectedDispatch(before)
      }
    }
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
    f.stores.tenants.patch('a', { agentAsk: false })
    const off = await f.requestAs(viewer, '/api/t/a/mcp', rpc('tools/list'))
    assertToolInventory(names(await off.json()))
    const before = f.providerCalls.length
    const hidden = await f.requestAs(
      viewer,
      '/api/t/a/mcp',
      tool('ask_federated', { question: 'Why?' }),
    )
    const hiddenBody = await hidden.json()
    expect(Boolean(hiddenBody.error || hiddenBody.result?.isError)).toBe(true)
    f.assertNoProtectedDispatch(before)
  } finally {
    f.close()
  }
})

for (const adapter of ['local', 'durable'] as const) {
  Deno.test(`federated tools attribute host and peer evidence, audit, count asks and honour participation (${adapter})`, async () => {
    const peerFetch = aragPeerFetch([{
      zone: 'fixture-zone',
      kbId: 'fixture-box',
      key: 'synthetic-peer-key',
      documents: [{
        resourceId: 'excluded-peer-document',
        title: 'Excluded peer evidence',
        text: 'This excluded material must stay in its collection.',
        excluded: true,
      }, {
        resourceId: 'peer-document',
        title: 'Soil water',
        text: 'Soil cover holds water in dry seasons.',
      }],
    }])
    const f = createEnforcementFixture({ peerFetch }, adapter)
    try {
      await f.stores.bindings.initialize()
      await f.stores.bindings.set(peerKeyName('a', 'fixture-peer'), {
        baseUrl: 'https://fixture-zone.dp.progress.cloud/api/v1/kb/fixture-box',
        kbId: 'fixture-box',
        token: 'synthetic-peer-key',
      })
      const minted = await f.requestAs(f.sessionFor('portal-admin'), '/api/t/a/mcp/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Research agent', role: 'viewer' }),
      })
      expect(minted.status).toBe(201)
      const { key, credential } = await minted.json()
      f.stores.lifecycle.set('a', { status: 'read_only', limits: { asksPerDay: 1 } })
      const call = async (name: string, args: unknown) => {
        const response = await f.requestAs(null, '/api/t/a/mcp', tool(name, args, key))
        expect(response.status).toBe(200)
        return (await response.json()).result
      }
      const search = await call('search_federated', { query: 'Soil water', limit: 1 })
      expect(search.isError).not.toBe(true)
      expect(
        new Set(
          search.structuredContent.results.map((r: { source: { id: string } }) => r.source.id),
        ),
      )
        .toEqual(new Set(['a', 'peer:fixture-peer']))
      expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
      const answer = await call('ask_federated', { question: 'Soil water #compose' })
      expect(answer.isError).not.toBe(true)
      expect(answer.structuredContent.answer).toContain('Soil cover holds water')
      expect(answer.structuredContent.failed_sources).toEqual([])
      expect(JSON.stringify(answer)).not.toContain('Excluded peer evidence')
      expect(JSON.stringify(search)).not.toContain('Excluded peer evidence')
      expect(
        answer.structuredContent.citations.some((c: { source: { id: string } }) =>
          c.source.id === 'peer:fixture-peer'
        ),
      ).toBe(true)
      expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
      const quota = await call('ask_federated', { question: 'Again #compose' })
      expect(quota.isError).toBe(true)
      expect(quota.structuredContent.error).toBe('ask_quota_exceeded')
      expect((await call('search_federated', { query: 'Water' })).isError).not.toBe(true)
      const events = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } })
      expect(
        events.some((event) =>
          event.action === 'estate.query' && event.target_id === 'ask_federated' &&
          event.actor_id === credential.id
        ),
      ).toBe(true)
      expect(JSON.stringify(events)).not.toContain('synthetic-peer-key')
      f.stores.tenants.patch('a', { federation: { participates: false } })
      const own = await call('search_federated', { query: 'Water' })
      expect(own.structuredContent.sources.map((s: { id: string }) => s.id)).toEqual(['a'])
      f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
      const denied = await f.requestAs(
        null,
        '/api/t/a/mcp',
        tool('search_federated', { query: 'Water' }, key),
      )
      expect(denied.status).toBe(423)
    } finally {
      f.close()
    }
  })
}

Deno.test('federated MCP and HTTP share caller limits including each peer search', async () => {
  const f = createEnforcementFixture({ rateLimitAskPerMin: 2 })
  try {
    const viewer = f.sessionFor('viewer')
    const first = await f.requestAs(
      viewer,
      '/api/t/a/mcp',
      tool('ask_federated', { question: 'Why? #compose' }),
    )
    const result = (await first.json()).result
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent.failed_sources).toMatchObject([{
      id: 'peer:fixture-peer',
      reason: 'unauthorised',
    }])
    const next = await f.requestAs(viewer, '/api/t/a/ask-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Why? #compose' }),
    })
    expect(next.status).toBe(429)
    await next.body?.cancel()
    const refused = await f.requestAs(
      viewer,
      '/api/t/a/mcp',
      tool('ask_federated', { question: 'Again #compose' }),
    )
    expect((await refused.json()).result.structuredContent.error).toBe('rate_limited')
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(1)
  } finally {
    f.close()
  }
})

Deno.test('federated MCP does not release evidence after a required audit write fails', async () => {
  const f = createEnforcementFixture()
  try {
    const viewer = f.sessionFor('viewer')
    f.failAudit()
    for (
      const [name, args] of [
        ['search_federated', { query: 'Water' }],
        ['ask_federated', { question: 'Water #compose' }],
      ] as const
    ) {
      const response = await f.requestAs(viewer, '/api/t/a/mcp', tool(name, args))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'audit_write_failed' })
    }
  } finally {
    f.close()
  }
})

Deno.test('estate key creation refuses a portal the creator can only read', async () => {
  const f = createEnforcementFixture()
  try {
    const creator = f.sessionFor('portal-admin')
    f.rbac.assignmentService('tenant-1', 'corpuskit').create({
      subjectKind: 'active-oid',
      subjectId: creator.oid,
      scope: { kind: 'portal', slug: 'b' },
      role: 'viewer',
    }, { requestId: 'fixture-seed', actor: { kind: 'system' } })
    const response = await f.requestAs(creator, '/api/t/a/mcp/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Estate agent', role: 'viewer', estate: ['b'] }),
    })
    expect(response.status).toBe(403)
    expect(f.stores.mcpKeys.list('a')).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('a broken agent stream withholds partial answers and private error messages', async () => {
  async function* broken(): AsyncIterable<AgentAskEvent> {
    yield { type: 'delta', text: 'Partial answer' }
    yield {
      type: 'error',
      code: 'upstream',
      message: 'private upstream diagnostic',
      retryable: true,
    }
  }
  const result = await collectFederatedAnswer(broken())
  expect(result.answer).toBe('')
  expect(result.failed).toBe(true)
  expect(JSON.stringify(result)).not.toContain('private upstream')
})

Deno.test('estate portal choices reveal only enabled portals the caller administers on both adapters', async () => {
  for (const adapter of ['local', 'durable'] as const) {
    const f = createEnforcementFixture({}, adapter)
    try {
      const creator = f.sessionFor('portal-admin')
      const choices = async () => {
        const response = await f.requestAs(creator, '/api/t/a/mcp/portals')
        expect(response.status).toBe(200)
        return (await response.json()).map((portal: { slug: string }) => portal.slug).sort()
      }
      expect(await choices()).toEqual(['a'])
      const service = f.rbac.assignmentService('tenant-1', 'corpuskit')
      const added = service.create({
        subjectKind: 'active-oid',
        subjectId: creator.oid,
        scope: { kind: 'portal', slug: 'b' },
        role: 'portal-admin',
      }, { requestId: 'choice-seed', actor: { kind: 'system' } })
      expect(added.ok).toBe(true)
      expect(await choices()).toEqual(['a', 'b'])
      f.stores.tenants.setDisabled('b', true)
      expect(await choices()).toEqual(['a'])
    } finally {
      f.close()
    }
  }
})

Deno.test('MCP returns the final citation-checked streamed text, including an empty final answer', async () => {
  for (const text of ['The checked answer [1].', '']) {
    const streamed = async function* (): AsyncIterable<AgentAskEvent> {
      yield {
        type: 'agent-start',
        mode: 'orchestrated',
        sources: [{ id: 'a', label: 'Research collection' }],
      }
      yield { type: 'delta', text: 'An unsupported provisional figure [99].' }
      yield {
        type: 'citation',
        marker: '1',
        sourceId: 'a',
        chunkId: 'a/document',
        title: 'Research evidence',
      }
      yield { type: 'done', elapsedMs: 10, text }
    }
    const result = await collectFederatedAnswer(streamed())
    expect(result.answer).toBe(text)
    expect(result.citations[0]?.source?.label).toBe('Research collection')
    expect(JSON.stringify(result)).not.toContain('unsupported provisional')
  }
})

Deno.test('federated MCP retrieval bounds host search and reports every failed source without a daily ask', async () => {
  const provider = new DoubleProvider()
  provider.search = () => new Promise<SearchResults>(() => {})
  const f = createEnforcementFixture({ provider, agentSourceTimeoutMs: 10 })
  try {
    const response = await f.requestAs(
      f.sessionFor('viewer'),
      '/api/t/a/mcp',
      tool('search_federated', { query: 'Water' }),
    )
    expect(response.status).toBe(200)
    const result = (await response.json()).result
    expect(result.isError).toBe(true)
    expect(result.structuredContent.results).toEqual([])
    expect(result.structuredContent.failed_sources).toMatchObject([
      { id: 'a', reason: 'timeout' },
      { id: 'peer:fixture-peer', reason: 'unauthorised' },
    ])
    const options = f.providerCalls.find((call) => call.method === 'search')!.args[2] as {
      passagesOnly: boolean
      signal: AbortSignal
    }
    expect(options.passagesOnly).toBe(true)
    expect(options.signal.aborted).toBe(true)
    expect(f.stores.lifecycle.usage('a', 'UTC', f.now()).asksToday).toBe(0)
  } finally {
    f.close()
  }
})

/** One portal with a peer whose passage the composed answer quotes, and a key to call its tools. */
async function federatedFixture() {
  const peerFetch = aragPeerFetch([{
    zone: 'fixture-zone',
    kbId: 'fixture-box',
    key: 'synthetic-peer-key',
    documents: [{
      resourceId: 'peer-document',
      title: 'Soil water',
      text: 'Soil cover holds water in dry seasons.',
    }],
  }])
  const f = createEnforcementFixture({ peerFetch })
  await f.stores.bindings.initialize()
  await f.stores.bindings.set(peerKeyName('a', 'fixture-peer'), {
    baseUrl: 'https://fixture-zone.dp.progress.cloud/api/v1/kb/fixture-box',
    kbId: 'fixture-box',
    token: 'synthetic-peer-key',
  })
  const minted = await f.requestAs(f.sessionFor('portal-admin'), '/api/t/a/mcp/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Research agent', role: 'viewer' }),
  })
  const { key } = await minted.json()
  const ask = async (question: string) => {
    const response = await f.requestAs(
      null,
      '/api/t/a/mcp',
      tool('ask_federated', { question }, key),
    )
    expect(response.status).toBe(200)
    return (await response.json()).result
  }
  return { f, ask }
}

Deno.test('ask_federated withholds an answer that uses a blocked term of the portal policy', async () => {
  const { f, ask } = await federatedFixture()
  try {
    f.stores.tenants.patch('a', {
      prompts: { guardrails: AnswerGuardrailsSchema.parse({ blockedTerms: ['soil cover'] }) },
    })
    const answer = await ask('Soil water #compose')
    expect(JSON.stringify(answer)).not.toContain('Soil cover holds water')
    expect(answer.structuredContent.answer).toContain('withheld')
    expect(answer.structuredContent.citations).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('ask_federated saves an answer record on the host portal', async () => {
  const { f, ask } = await federatedFixture()
  try {
    expect(f.stores.answerRecords.list('a')).toHaveLength(0)
    const answer = await ask('Soil water #compose')
    expect(answer.structuredContent.answer).toContain('Soil cover holds water')
    const records = f.stores.answerRecords.list('a')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ surface: 'composed', question: 'Soil water #compose' })
  } finally {
    f.close()
  }
})
