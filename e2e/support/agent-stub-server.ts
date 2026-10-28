// ---------------------------------------------------------------------------
// The agent ask stub server (`deno task dev:stub`, docs/AGENT-ASK.md): the
// real app on the E2E fixture server, with the DoubleProvider replaying the
// synthetic agent sessions, and three portals opted in to agent ask, each
// searching its own slice of the same synthetic corpus so the portal can
// compose an answer across them. For building and checking the agent ask
// view without a live agent. Local only: never registered in production.
//
//   deno task dev:stub                 recorded pace (about 90 s an answer)
//   deno task dev:stub --speed=10      ten times faster; --speed=0 is instant
//   deno task dev:stub --port=8795     first port to try (8791 by default)
//   deno task dev:stub --primary=#1C1C1C --accent=#00B14E   the host in these colours
// ---------------------------------------------------------------------------
import type { ResourceSummary, SearchResults, TenantConfig } from '@research-portal/core'
import { peerKeyName } from '../../apps/api/src/bindings.ts'
import { agentFixturePassages, agentScenarioFor, pause } from './agent-replay.ts'
import { aragPeerFetch, type PeerBox } from './arag-peer-double.ts'
import { DoubleProvider } from './double-provider.ts'
import { startTestServer, type TestServer } from './test-server.ts'

/** The portal the stub's agent answers for, and the host of a composed answer. */
export const AGENT_STUB_PORTAL = 'marine'
/** A third portal the stub creates, beside the two showcase portals. */
const RURAL_PORTAL_NAME = 'Rural industries research'

/** The stub's portals, the host first, each with the agent driver whose passages it holds. */
export interface AgentStubPortal {
  slug: string
  driver: string
  /** How long its search takes at the recorded pace. */
  searchMs: number
}

/**
 * A DoubleProvider whose portals each search their own slice of the fixture corpus, at a
 * believable pace, and fail on request (`#source-timeout`, `#source-error`).
 */
export class AgentStubProvider extends DoubleProvider {
  readonly #passages = agentFixturePassages()
  portals: AgentStubPortal[] = []

  /** The pause for `ms` at the replay speed, or none for `#fast` and speed 0. */
  #paced(ms: number, question: string): Promise<void> {
    const speed = agentScenarioFor(question).fast ? 0 : this.agentReplaySpeed
    return speed > 0 ? pause(ms / speed) : Promise.resolve()
  }

  override async search(tenant: TenantConfig, query: string): Promise<SearchResults> {
    const index = this.portals.findIndex((portal) => portal.slug === tenant.slug)
    if (index < 0) return super.search(tenant, query)
    const portal = this.portals[index]!
    const { sourceFailure } = agentScenarioFor(query)
    // The second collection is the one that fails on request.
    if (index === 1 && sourceFailure === 'timeout') return new Promise(() => {})
    await this.#paced(portal.searchMs, query)
    if (index === 1 && sourceFailure === 'error') throw new Error('Stub search failure')
    const passages = this.#passages.get(portal.driver) ?? []
    return {
      query,
      resources: passages.map((passage, rank) => ({
        id: passage.id,
        title: passage.title,
        summary: passage.text,
        type: 'pdf' as ResourceSummary['type'],
        topicIds: [],
        keyFacts: [],
        relevance: Math.round((0.92 - rank * 0.07) * 100) / 100,
        citedCount: 0,
        matchedPassage: passage.text,
      })),
      relatedQuestions: [],
    }
  }

  override async compose(
    ...args: Parameters<DoubleProvider['compose']>
  ): ReturnType<DoubleProvider['compose']> {
    await this.#paced(6000, args[1])
    return super.compose(...args)
  }
}

/**
 * The host's two federation peers: synthetic partner boxes, one searched through its retrieval
 * and one over MCP, served in process (`aragPeerFetch`), never over the network.
 */
export const AGENT_STUB_PEERS = [
  {
    id: 'soil-partner',
    label: 'Soil partner collection',
    kind: 'arag-kb',
    zone: 'stub',
    kbId: 'stub-box-soil',
  },
  {
    id: 'water-partner',
    label: 'Water partner collection',
    kind: 'arag-mcp',
    zone: 'stub',
    kbId: 'stub-box-water',
  },
] as const
const STUB_PEER_BOXES: PeerBox[] = [
  {
    zone: 'stub',
    kbId: 'stub-box-soil',
    key: 'stub-peer-key-soil-not-a-real-key',
    documents: [
      {
        resourceId: 'soil-01',
        title: 'Soil moisture after warm winters',
        text: 'Warm, dry winters left less soil moisture at sowing, so crops relied more on ' +
          'spring rain.',
        originUrl: 'https://partner.example.org/soil/soil-01.pdf',
      },
      {
        resourceId: 'soil-02',
        title: 'Cover crops and soil temperature',
        text:
          'Cover crops kept the soil surface cooler through heatwaves and reduced moisture loss.',
      },
    ],
  },
  {
    zone: 'stub',
    kbId: 'stub-box-water',
    key: 'stub-peer-key-water-not-a-real-key',
    documents: [
      {
        resourceId: 'water-01',
        title: 'Irrigation scheduling in hot seasons',
        text: 'Scheduling irrigation by soil moisture rather than calendar saved water in hot ' +
          'seasons.',
      },
    ],
  },
]

/**
 * The stand-in partners, with two tags that fail one on request: `#peer-timeout` holds the
 * search peer's answer until its time limit, and `#peer-unauthorised` refuses the MCP peer's key.
 */
function stubPeerFetch(): typeof fetch {
  const boxes = aragPeerFetch(STUB_PEER_BOXES)
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : ''
    if (body.includes('#peer-timeout') && String(input).endsWith('/find')) {
      await new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      )
    }
    if (body.includes('#peer-unauthorised') && String(input).endsWith('/mcp')) {
      return Response.json({ detail: 'Invalid service account' }, { status: 401 })
    }
    return boxes(input, init)
  }) as typeof fetch
}

export interface AgentStubServer extends TestServer {
  provider: AgentStubProvider
  /** The opted-in portals, the host first. */
  portals: AgentStubPortal[]
}

/** Start the stub: `speed` paces the replay (1 as recorded, 0 without waiting). */
export async function startAgentStub(
  options: { speed?: number; apiOnly?: boolean } = {},
): Promise<AgentStubServer> {
  const speed = options.speed ?? 1
  const provider = new AgentStubProvider()
  provider.agentReplaySpeed = speed
  const server = startTestServer({
    provider,
    apiOnly: options.apiOnly,
    peerFetch: stubPeerFetch(),
    // Long enough for every stub search at the chosen pace, short enough to watch one time out.
    agentSourceTimeoutMs: speed > 0 ? Math.round(12_000 / speed) : 500,
  })
  try {
    const rural = server.tenants.add({ name: RURAL_PORTAL_NAME })
    provider.portals = [
      { slug: AGENT_STUB_PORTAL, driver: 'drv-fisheries', searchMs: 2500 },
      { slug: 'grains', driver: 'drv-grains', searchMs: 4000 },
      { slug: rural.slug, driver: 'drv-rural', searchMs: 3200 },
    ]
    for (const portal of provider.portals) server.tenants.patch(portal.slug, { agentAsk: true })
    server.tenants.patch(AGENT_STUB_PORTAL, {
      federation: { peers: AGENT_STUB_PEERS.map((peer) => ({ ...peer })) },
    })
    await Promise.all(
      STUB_PEER_BOXES.map((box, index) =>
        server.bindings.set(peerKeyName(AGENT_STUB_PORTAL, AGENT_STUB_PEERS[index]!.id), {
          baseUrl: `https://${box.zone}.dp.progress.cloud/api/v1/kb/${box.kbId}`,
          token: box.key,
          kbId: box.kbId,
        })
      ),
    )
  } catch (error) {
    void server.close()
    throw error
  }
  return { ...server, provider, portals: provider.portals }
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  return Deno.args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

if (import.meta.main) {
  const port = flag('port')
  if (port) Deno.env.set('DS_PORT_BASE', port)
  const speed = Number(flag('speed') ?? Deno.env.get('AGENT_STUB_SPEED') ?? 1)
  if (!Number.isFinite(speed) || speed < 0) throw new Error('--speed must be 0 or more')
  const server = await startAgentStub({ speed })
  // `--primary=#1C1C1C --accent=#00B14E` shows the host in a chosen pair of colours (a neutral
  // theme for screenshots, say); the hero takes the primary so nothing stays in the seed's blue.
  const primary = flag('primary')
  const accent = flag('accent')
  if (primary || accent) {
    const host = server.tenants.get(AGENT_STUB_PORTAL)
    if (!host) throw new Error('The stub host is missing')
    const colours = {
      ...host.branding.colours,
      ...(primary ? { primary, heroFrom: primary, heroTo: primary } : {}),
      ...(accent ? { accent } : {}),
    }
    server.tenants.patch(AGENT_STUB_PORTAL, {
      branding: { ...host.branding, colours, paletteId: 'default' },
    })
  }
  const slugs = server.portals.map((portal) => portal.slug)
  const post = (path: string, body: unknown) =>
    `curl -N -X POST ${server.url}${path} -H 'content-type: application/json' -d '${
      JSON.stringify(body)
    }'`
  console.log(`Agent ask stub on ${server.url} (replay speed ${speed})`)
  console.log(`  portal    ${server.url}/t/${AGENT_STUB_PORTAL}`)
  console.log(`  portals   ${slugs.join(', ')} (agent ask on; ${AGENT_STUB_PORTAL} hosts)`)
  console.log(
    `  agent     ${post(`/api/t/${AGENT_STUB_PORTAL}/ask-agent`, { query: 'Why? #fast' })}`,
  )
  console.log(`  composed  ${post('/api/ask-agent', { query: 'Why? #compose #fast', slugs })}`)
  console.log(
    '  tags      #error, #slow (agent sessions); #compose (no agent: the portal composes);',
  )
  console.log(
    '            #source-timeout, #source-error (one collection fails); #fast (no waiting)',
  )
  console.log(
    `  peers     ${AGENT_STUB_PEERS.map((p) => `${p.label} (${p.kind})`).join(', ')} on the host;`,
  )
  console.log('            #peer-timeout, #peer-unauthorised fail one (with #compose)')
  const shutdown = () => {
    server.close().finally(() => Deno.exit(0))
  }
  Deno.addSignalListener('SIGINT', shutdown)
  Deno.addSignalListener('SIGTERM', shutdown)
}
