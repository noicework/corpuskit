// ---------------------------------------------------------------------------
// The agent ask stub server (`deno task dev:stub`, docs/AGENT-ASK.md): the
// real app on the E2E fixture server, with the DoubleProvider replaying the
// synthetic agent sessions and the `marine` portal opted in to agent ask.
// For building and checking the agent ask view without a live agent. Local
// only: never registered in production.
//
//   deno task dev:stub                 recorded pace (about 90 s an answer)
//   deno task dev:stub --speed=10      ten times faster; --speed=0 is instant
//   deno task dev:stub --port=8795     first port to try (8791 by default)
// ---------------------------------------------------------------------------
import { DoubleProvider } from './double-provider.ts'
import { startTestServer, type TestServer } from './test-server.ts'

/** The portal the stub opts in to agent ask. */
export const AGENT_STUB_PORTAL = 'marine'

export interface AgentStubServer extends TestServer {
  provider: DoubleProvider
}

/** Start the stub: `speed` paces the replay (1 as recorded, 0 without waiting). */
export function startAgentStub(
  options: { speed?: number; apiOnly?: boolean } = {},
): AgentStubServer {
  const provider = new DoubleProvider()
  provider.agentReplaySpeed = options.speed ?? 1
  const server = startTestServer({ provider, apiOnly: options.apiOnly })
  try {
    server.tenants.patch(AGENT_STUB_PORTAL, { agentAsk: true })
  } catch (error) {
    void server.close()
    throw error
  }
  return { ...server, provider }
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
  const portal = `${server.url}/t/${AGENT_STUB_PORTAL}`
  console.log(`Agent ask stub on ${server.url} (replay speed ${speed})`)
  console.log(`  portal   ${portal}`)
  console.log(`  stream   curl -N -X POST ${server.url}/api/t/${AGENT_STUB_PORTAL}/ask-agent \\`)
  console.log(
    `             -H 'content-type: application/json' -d '{"query":"Your question #fast"}'`,
  )
  console.log('  tags     #error (fails mid-stream), #slow (slow start), #fast (no waiting)')
  const shutdown = () => {
    server.close().finally(() => Deno.exit(0))
  }
  Deno.addSignalListener('SIGINT', shutdown)
  Deno.addSignalListener('SIGTERM', shutdown)
}
