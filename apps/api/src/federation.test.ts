import { afterEach, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  type AgentAskEvent,
  AgentAskEventSchema,
  type SearchResults,
  type TenantConfig,
} from '@research-portal/core'
import { peerEndpoint, PeerError, PeerMcpSession, searchPeer } from '@research-portal/retrieval'
import { buildApp as buildRawApp, type BuildAppOptions } from './app.ts'
import { BindingStore } from './bindings.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { tenantsWithNeuro } from './fixtures/neuro-tenant.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { aragPeerFetch, type PeerBox } from '../../../e2e/support/arag-peer-double.ts'

// Synthetic partner boxes: no real zone, box, key or passage.
const KB_PEER = {
  id: 'kb-partner',
  label: 'Partner collection',
  kind: 'arag-kb',
  zone: 'test-zone',
  kbId: 'box-kb-0001',
} as const
const MCP_PEER = {
  id: 'mcp-partner',
  label: 'MCP partner',
  kind: 'arag-mcp',
  zone: 'test-zone',
  kbId: 'box-mcp-0001',
} as const
const KB_KEY = 'synthetic-kb-peer-key-000000000000'
const MCP_KEY = 'synthetic-mcp-peer-key-00000000000'
const boxes = (): PeerBox[] => [
  {
    zone: 'test-zone',
    kbId: 'box-kb-0001',
    key: KB_KEY,
    documents: [
      {
        resourceId: 'kb-r1',
        title: 'Soil carbon in mixed farms',
        text: 'Soil carbon rose under perennial pasture across the trial sites.',
        originUrl: 'https://partner.example.org/reports/kb-r1.pdf',
      },
      {
        resourceId: 'kb-r2',
        title: 'Withheld trial report',
        text: 'This withheld passage must never leave the partner collection.',
        excluded: true,
      },
    ],
  },
  {
    zone: 'test-zone',
    kbId: 'box-mcp-0001',
    key: MCP_KEY,
    documents: [
      {
        resourceId: 'mcp-r1',
        title: 'Water use in irrigated cotton',
        text: 'Drip irrigation cut water use in irrigated cotton without lowering yield.',
      },
    ],
  },
]

const passcode = 'federation-test-passcode'
const BINDING_KEY = btoa('k'.repeat(32))
const databases: LocalRbacDatabase[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(options: Partial<BuildAppOptions> & { peerBoxes?: PeerBox[] } = {}) {
  const database = new LocalRbacDatabase(':memory:')
  databases.push(database)
  const rbac = new RbacState(database)
  rbac.migrate()
  const directory = Deno.makeTempDirSync()
  const bindingsPath = `${directory}/bindings.json`
  const bindings = new BindingStore({ BINDINGS_PATH: bindingsPath, BINDING_KEY })
  const peerFetch = aragPeerFetch(options.peerBoxes ?? boxes())
  const app = buildRawApp({
    provider: new DoubleProvider(),
    tenants: tenantsWithNeuro(),
    bindings,
    peerFetch,
    ...options,
    rbac,
    configuredTenantId: 'tenant-1',
    audience: 'corpuskit',
    audit: rbac.audit,
    breakGlass: rbac.breakGlassService({ passcode, explicitFlag: 'true' }),
    requestContext: () => ({
      requestId: crypto.randomUUID(),
      session: null,
      clientIp: '127.0.0.1',
      coarseAdminEligible: false,
    }),
  })
  const admin = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'x-admin-passcode': passcode, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const ask = async (slug: string, query: string) => {
    const response = await app.request(`/api/t/${slug}/ask-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    return { response, events: response.ok ? await eventsOf(response) : [] }
  }
  return { app, rbac, bindings, bindingsPath, peerFetch, admin, ask }
}
type Setup = ReturnType<typeof setup>

const eventsOf = async (response: Response): Promise<AgentAskEvent[]> =>
  (await response.text()).split('\n\n').map((frame) => frame.trim()).filter(Boolean).map((
    frame,
  ) => AgentAskEventSchema.parse(JSON.parse(frame.replace(/^data: /, ''))))
const ofType = <T extends AgentAskEvent['type']>(events: AgentAskEvent[], type: T) =>
  events.filter((event): event is Extract<AgentAskEvent, { type: T }> => event.type === type)

/** Agent ask on for marine, with both peers configured and their keys stored. */
async function withPeers(f: Setup, peers: unknown[] = [KB_PEER, MCP_PEER]) {
  expect(
    (await f.admin('PATCH', '/api/admin/tenants/marine', {
      agentAsk: true,
      federation: { peers },
    })).status,
  ).toBe(200)
  for (const [id, token] of [[KB_PEER.id, KB_KEY], [MCP_PEER.id, MCP_KEY]]) {
    const stored = await f.admin('PUT', `/api/admin/t/marine/federation/peers/${id}/key`, { token })
    expect(stored.status).toBe(200)
    expect(await stored.json()).toEqual({ ok: true })
  }
}

describe('the federation peer client', () => {
  it('builds every address from the zone and box alone, on the platform host, over https', () => {
    expect(peerEndpoint(KB_PEER, '/find').href).toBe(
      'https://test-zone.dp.progress.cloud/api/v1/kb/box-kb-0001/find',
    )
    for (
      const zone of ['127.0.0.1', '10.0.0.1', 'evil.example', 'a.b', '', '-x', 'x/..']
    ) {
      expect(() => peerEndpoint({ ...KB_PEER, zone }, '/find'), zone).toThrow(PeerError)
    }
    for (const kbId of ['../../admin', 'box/x', 'box?x=1', '']) {
      expect(() => peerEndpoint({ ...KB_PEER, kbId }, '/find'), kbId).toThrow(PeerError)
    }
  })

  it('refuses every path but search, and every MCP call but the read tools, before sending', async () => {
    for (const path of ['/configuration', '/resource/r1', '/ask', '/search', '/upload', '/mcp']) {
      expect(() => peerEndpoint(KB_PEER, path), path).toThrow(PeerError)
    }
    expect(() => peerEndpoint(MCP_PEER, '/find')).toThrow(PeerError)
    const peerFetch = aragPeerFetch(boxes())
    const session = new PeerMcpSession(MCP_PEER, MCP_KEY, { fetchImpl: peerFetch })
    await expect(session.request('tools/list')).rejects.toThrow(PeerError)
    await expect(session.request('resources/read')).rejects.toThrow(PeerError)
    for (const name of ['create_resource', 'delete_resource', 'update_configuration']) {
      await expect(session.request('tools/call', { name, arguments: {} })).rejects.toThrow(
        PeerError,
      )
    }
    expect(peerFetch.calls).toEqual([])
  })

  it('refuses a redirect rather than follow it', async () => {
    const seen: RequestInit[] = []
    const redirecting = ((_input: unknown, init: RequestInit) => {
      seen.push(init)
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/steal' } }),
      )
    }) as typeof fetch
    const error = await searchPeer(KB_PEER, KB_KEY, 'soil', { fetchImpl: redirecting })
      .catch((e) => e)
    expect(error).toBeInstanceOf(PeerError)
    expect(error.failure).toBe('error')
    expect(seen.map((init) => init.redirect)).toEqual(['manual'])
  })

  it('searches a knowledge box through /find only, never returning a withheld resource', async () => {
    const peerFetch = aragPeerFetch(boxes())
    const passages = await searchPeer(KB_PEER, KB_KEY, 'soil carbon', { fetchImpl: peerFetch })
    expect(passages).toEqual([{
      resourceId: 'kb-r1',
      title: 'Soil carbon in mixed farms',
      text: 'Soil carbon rose under perennial pasture across the trial sites.',
      originUrl: 'https://partner.example.org/reports/kb-r1.pdf',
    }])
    expect(peerFetch.calls).toEqual([{ path: '/find' }])
  })

  it('searches a knowledge box over MCP: handshake, session, then search_documents', async () => {
    const peerFetch = aragPeerFetch(boxes())
    const passages = await searchPeer(MCP_PEER, MCP_KEY, 'water use', { fetchImpl: peerFetch })
    expect(passages).toEqual([{
      resourceId: 'mcp-r1',
      title: 'Water use in irrigated cotton',
      text: 'Drip irrigation cut water use in irrigated cotton without lowering yield.',
    }])
    expect(peerFetch.calls).toEqual([
      { path: '/mcp', method: 'initialize' },
      { path: '/mcp', method: 'notifications/initialized' },
      { path: '/mcp', method: 'tools/call', tool: 'search_documents' },
    ])
  })

  it('reports a refused key as unauthorised', async () => {
    for (const peer of [KB_PEER, MCP_PEER]) {
      const error = await searchPeer(peer, 'wrong-key-0000000000000000', 'x', {
        fetchImpl: aragPeerFetch(boxes()),
      }).catch((e) => e)
      expect(error).toBeInstanceOf(PeerError)
      expect(error.failure).toBe('unauthorised')
    }
  })
})

describe('federation peers in a composed answer', () => {
  it('searches each peer beside the host and labels it a federated partner', async () => {
    const f = setup()
    await withPeers(f)
    const { events } = await f.ask('marine', 'Why? #compose')
    const start = events[0]
    expect(start).toMatchObject({ type: 'agent-start', mode: 'orchestrated' })
    expect(start?.type === 'agent-start' && start.sources).toEqual([
      expect.objectContaining({ id: 'marine', kind: 'hosted', portal: 'marine' }),
      { id: 'peer:kb-partner', label: 'Partner collection', kind: 'peer', transport: 'kb' },
      { id: 'peer:mcp-partner', label: 'MCP partner', kind: 'peer', transport: 'mcp' },
    ])
    const peerChunks = ofType(events, 'agent-sources').filter((e) => e.source.kind === 'peer')
    expect(peerChunks.map((e) => [e.source.id, e.chunks.map((c) => c.title)])).toEqual([
      ['peer:kb-partner', ['Soil carbon in mixed farms']],
      ['peer:mcp-partner', ['Water use in irrigated cotton']],
    ])
    const cited = ofType(events, 'citation').filter((c) => c.sourceId.startsWith('peer:'))
    expect(cited.map((c) => c.sourceId).sort()).toEqual(['peer:kb-partner', 'peer:mcp-partner'])
    // No outbound link unless the peer allows one.
    expect(cited.every((c) => c.url === undefined)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('withheld')
    expect(events.at(-1)?.type).toBe('done')
  })

  it("links a peer's citations to their origin only when the peer allows it", async () => {
    const f = setup()
    await withPeers(f, [{ ...KB_PEER, linkOrigins: true }, MCP_PEER])
    const { events } = await f.ask('marine', 'Why? #compose')
    const cited = ofType(events, 'citation').find((c) => c.sourceId === 'peer:kb-partner')
    expect(cited?.url).toBe('https://partner.example.org/reports/kb-r1.pdf')
    expect(
      ofType(events, 'agent-sources').find((e) => e.source.id === 'peer:kb-partner')
        ?.chunks[0]?.url,
    ).toBe('https://partner.example.org/reports/kb-r1.pdf')
  })

  it('names a peer that runs past its time limit, and answers from the rest', async () => {
    const slow = boxes().map((box) => box.kbId === KB_PEER.kbId ? { ...box, delayMs: 2000 } : box)
    const f = setup({ peerBoxes: slow, agentSourceTimeoutMs: 100 })
    await withPeers(f)
    const { events } = await f.ask('marine', 'Why? #compose')
    expect(ofType(events, 'sources-failed')).toEqual([{
      type: 'sources-failed',
      sources: [{
        id: 'peer:kb-partner',
        label: 'Partner collection',
        kind: 'peer',
        transport: 'kb',
        reason: 'timeout',
      }],
    }])
    expect(ofType(events, 'citation').some((c) => c.sourceId === 'peer:mcp-partner')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('names a peer whose key is refused, or missing, as unauthorised', async () => {
    const f = setup()
    await withPeers(f)
    await f.admin('PUT', `/api/admin/t/marine/federation/peers/${KB_PEER.id}/key`, {
      token: 'a-wrong-key-for-this-box-00000000',
    })
    let failed = ofType((await f.ask('marine', 'Why? #compose')).events, 'sources-failed')
    expect(failed[0]?.sources.map((s) => [s.id, s.reason])).toEqual([
      ['peer:kb-partner', 'unauthorised'],
    ])
    // A peer added without a key is reported the same way, never called.
    await f.admin('PATCH', '/api/admin/tenants/marine', {
      federation: {
        peers: [KB_PEER, MCP_PEER, { ...MCP_PEER, id: 'keyless', label: 'Keyless partner' }],
      },
    })
    const calls = f.peerFetch.calls.length
    failed = ofType((await f.ask('marine', 'Why? #compose')).events, 'sources-failed')
    expect(failed[0]?.sources.map((s) => [s.id, s.reason])).toEqual([
      ['peer:kb-partner', 'unauthorised'],
      ['peer:keyless', 'unauthorised'],
    ])
    expect(f.peerFetch.calls.length - calls).toBe(4)
  })

  it('keeps the sealed key out of the configuration, the responses and storage in clear', async () => {
    const f = setup()
    await withPeers(f)
    const config = await (await f.app.request('/api/t/marine/config')).text()
    for (const secret of [KB_KEY, MCP_KEY, 'test-zone', 'box-kb-0001']) {
      expect(config).not.toContain(secret)
    }
    expect(JSON.parse(config).federation).toEqual({
      peers: [
        { id: 'kb-partner', label: 'Partner collection', kind: 'arag-kb' },
        { id: 'mcp-partner', label: 'MCP partner', kind: 'arag-mcp' },
      ],
    })
    const stored = Deno.readTextFileSync(f.bindingsPath)
    expect(stored).not.toContain(KB_KEY)
    expect(stored).not.toContain(MCP_KEY)
    const { events } = await f.ask('marine', 'Why? #compose')
    expect(JSON.stringify(events)).not.toContain(KB_KEY)
  })

  it('audits every peer call on the host with the peer and its duration, never the key', async () => {
    const f = setup()
    await withPeers(f)
    await f.ask('marine', 'Why? #compose')
    const calls = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'marine' } })
      .filter((event) => event.action === 'federation.peer.call')
    expect(calls.length).toBe(2)
    for (const event of calls) {
      expect(event.outcome).toBe('success')
      const detail = JSON.parse(event.detail_json)
      expect(['kb-partner', 'mcp-partner']).toContain(detail.peerId)
      expect(typeof detail.durationMs).toBe('number')
    }
    expect(JSON.stringify(calls)).not.toContain(KB_KEY)
    expect(JSON.stringify(calls)).not.toContain(MCP_KEY)
  })

  it('stores a key only for a configured peer, and only from a valid body', async () => {
    const f = setup()
    await withPeers(f)
    expect(
      (await f.admin('PUT', '/api/admin/t/marine/federation/peers/unknown/key', {
        token: KB_KEY,
      })).status,
    ).toBe(404)
    for (const body of [{}, { token: 'short' }, { token: KB_KEY, extra: 1 }]) {
      expect(
        (await f.admin('PUT', `/api/admin/t/marine/federation/peers/${KB_PEER.id}/key`, body))
          .status,
      ).toBe(400)
    }
    // Readers cannot set one.
    expect(
      (await f.app.request(`/api/admin/t/marine/federation/peers/${KB_PEER.id}/key`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: KB_KEY }),
      })).status,
    ).toBe(401)
  })

  it('refuses invalid peer settings', async () => {
    const f = setup()
    for (
      const peer of [
        { ...KB_PEER, zone: 'localhost.' },
        { ...KB_PEER, zone: '127.0.0.1' },
        { ...KB_PEER, kind: 'corpuskit-mcp' },
        { ...KB_PEER, url: 'https://evil.example' },
        { ...KB_PEER, id: 'Bad Id' },
      ]
    ) {
      const response = await f.admin('PATCH', '/api/admin/tenants/marine', {
        federation: { peers: [peer] },
      })
      expect(response.status, JSON.stringify(peer)).toBe(400)
    }
    expect(
      (await f.admin('PATCH', '/api/admin/tenants/marine', {
        federation: { peers: [KB_PEER, KB_PEER] },
      })).status,
    ).toBe(400)
  })

  it("counts each peer against the host's ask limit", async () => {
    const f = setup({ rateLimitAskPerMin: 3 })
    await withPeers(f)
    const first = await f.ask('marine', 'Why? #compose')
    expect(first.response.status).toBe(200)
    // One ask and two peers: the limit of three is spent.
    expect((await f.ask('marine', 'Why? #compose')).response.status).toBe(429)
  })
})

describe('participation in federated answers', () => {
  /** A provider whose grains portal holds one resource marked for exclusion. */
  class ExcludingProvider extends DoubleProvider {
    override async search(tenant: TenantConfig, query: string): Promise<SearchResults> {
      const results = await super.search(tenant, query)
      if (tenant.slug !== 'grains') return results
      return {
        ...results,
        resources: [
          ...results.resources,
          {
            ...results.resources[0]!,
            id: 'withheld-1',
            title: 'Withheld grains report',
            matchedPassage: 'This withheld grains passage must stay in its own portal.',
            federationExcluded: true as const,
          },
        ],
      }
    }
  }

  const across = async (f: Setup, query: string) => {
    const response = await f.app.request('/api/ask-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, slugs: ['marine', 'grains'] }),
    })
    return { response, events: response.ok ? await eventsOf(response) : [] }
  }

  it('drops a portal that stops taking part from composed and federated answers, recorded', async () => {
    const f = setup()
    for (const slug of ['marine', 'grains']) {
      await f.admin('PATCH', `/api/admin/tenants/${slug}`, { agentAsk: true })
    }
    const sourcesOf = (events: AgentAskEvent[]) => {
      const start = events[0]
      return start?.type === 'agent-start' ? start.sources.map((s) => s.id) : []
    }
    expect(sourcesOf((await across(f, 'Why? #compose')).events)).toEqual(['marine', 'grains'])
    expect(
      (await f.admin('PATCH', '/api/admin/tenants/grains', {
        federation: { participates: false },
      })).status,
    ).toBe(200)
    expect(sourcesOf((await across(f, 'Why? #compose')).events)).toEqual(['marine'])

    const estate = await f.app.request('/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Why?', slugs: ['marine', 'grains'] }),
    })
    const slugs = new Set(
      (await estate.text()).split('\n\n').filter((frame) => frame.trim()).map((frame) =>
        JSON.parse(frame.replace(/^data: /, '')).slug
      ),
    )
    expect(slugs.has('marine')).toBe(true)
    expect(slugs.has('grains')).toBe(false)

    const change = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'grains' } }).find((event) =>
      event.action === 'tenant.behaviour.update' && event.outcome === 'success'
    )
    expect(change).toBeDefined()
    expect(JSON.parse(change!.detail_json)).toMatchObject({
      changedFields: 'federation',
      participates: false,
      previousParticipates: true,
    })
  })

  it('keeps a portal that does not take part from federating to its own peers', async () => {
    const f = setup()
    await withPeers(f)
    await f.admin('PATCH', '/api/admin/tenants/marine', { federation: { participates: false } })
    const { events } = await f.ask('marine', 'Why? #compose')
    const start = events[0]
    expect(start?.type === 'agent-start' && start.sources.map((s) => s.id)).toEqual(['marine'])
    expect(f.peerFetch.calls).toEqual([])
  })

  it("never lets an excluded resource into another portal's federated answer", async () => {
    const f = setup({ provider: new ExcludingProvider() })
    for (const slug of ['marine', 'grains']) {
      await f.admin('PATCH', `/api/admin/tenants/${slug}`, { agentAsk: true })
    }
    const { events } = await across(f, 'Why? #compose')
    expect(JSON.stringify(events)).not.toContain('withheld')
    // In its own portal's answer it is still there.
    await f.admin('PATCH', '/api/admin/tenants/grains', { agentAsk: true })
    const own = await f.ask('grains', 'Why? #compose')
    expect(JSON.stringify(own.events)).toContain('withheld-1')
  })
})
