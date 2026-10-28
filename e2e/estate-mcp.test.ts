import { expect } from '@std/expect'
import { startTestServer } from './support/test-server.ts'
import { fixtureSession } from '../apps/api/src/rbac-integration-fixture.ts'

const rpc = (method: string, params: unknown, key: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})

// AT8 over real HTTP: the local server with its ingress and file-backed key store, and the
// retrieval double behind the two showcase portals. The agent holds nothing but the key.
Deno.test('an agent with an issued estate key gets cited answers from two portals until the key is revoked', async () => {
  const creator = fixtureSession({ oid: 'e2e-portal-admin', roles: [] })
  const server = startTestServer({ apiOnly: true, identity: { role: 'portal-admin' } })
  try {
    server.setAssignment({ kind: 'portal', slug: 'grains' }, creator.oid, 'portal-admin')
    const minted = await fetch(`${server.url}/api/t/marine/mcp/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Estate agent', role: 'viewer', estate: ['grains'] }),
    })
    expect(minted.status).toBe(201)
    const { key, credential } = await minted.json()

    server.setIdentity(null)
    const estate = `${server.url}/api/estate/mcp`
    const list = await fetch(estate, rpc('tools/list', undefined, key))
    expect(list.status).toBe(200)
    expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual(['answer_estate', 'search_estate'])

    const asked = await fetch(
      estate,
      rpc('tools/call', {
        name: 'answer_estate',
        arguments: { question: 'What is known about abalone stock health?' },
      }, key),
    )
    expect(asked.status).toBe(200)
    const answer = (await asked.json()).result.structuredContent
    expect(answer.failed_sources).toEqual([])
    expect(answer.answers.map((item: { portal: string }) => item.portal).sort()).toEqual([
      'grains',
      'marine',
    ])
    for (const item of answer.answers) {
      expect(item.citations[0]).toMatchObject({ portal: item.portal, resourceId: 'res-1' })
    }

    server.setIdentity(creator)
    const revoked = await fetch(`${server.url}/api/t/marine/mcp/keys/${credential.id}`, {
      method: 'DELETE',
    })
    expect(revoked.status).toBe(200)
    server.setIdentity(null)
    const calls = server.providerCalls.length
    const refused = await fetch(
      estate,
      rpc('tools/call', { name: 'answer_estate', arguments: { question: 'Abalone?' } }, key),
    )
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="CorpusKit MCP"')
    await refused.body?.cancel()
    expect(server.providerCalls.length).toBe(calls)
  } finally {
    await server.close()
  }
})
