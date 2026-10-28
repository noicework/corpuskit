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
// ---------------------------------------------------------------------------
import type { ResourceSummary, SearchResults, TenantConfig } from '@research-portal/core'
import { agentFixturePassages, agentScenarioFor, pause } from './agent-replay.ts'
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

export interface AgentStubServer extends TestServer {
  provider: AgentStubProvider
  /** The opted-in portals, the host first. */
  portals: AgentStubPortal[]
}

/** Start the stub: `speed` paces the replay (1 as recorded, 0 without waiting). */
export function startAgentStub(
  options: { speed?: number; apiOnly?: boolean } = {},
): AgentStubServer {
  const speed = options.speed ?? 1
  const provider = new AgentStubProvider()
  provider.agentReplaySpeed = speed
  const server = startTestServer({
    provider,
    apiOnly: options.apiOnly,
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
  const server = startAgentStub({ speed })
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
  const shutdown = () => {
    server.close().finally(() => Deno.exit(0))
  }
  Deno.addSignalListener('SIGINT', shutdown)
  Deno.addSignalListener('SIGTERM', shutdown)
}
