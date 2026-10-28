import { afterEach, describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type AgentAskEvent, AgentAskEventSchema, TenantConfigSchema } from '@research-portal/core'
import {
  AgentAskError,
  type AgentAskOptions,
  type RetrievalProvider,
} from '@research-portal/retrieval'
import { buildApp as buildRawApp, type BuildAppOptions } from './app.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { tenantsWithNeuro } from './fixtures/neuro-tenant.ts'
import { AGENT_ASK_MESSAGES, ANSWER_SERVICE_PROBLEM, leaksInternalDetail } from './public-error.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

const passcode = 'agent-ask-test-passcode'
const databases: LocalRbacDatabase[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function buildApp(options: Partial<BuildAppOptions> & Pick<BuildAppOptions, 'provider'>) {
  const database = new LocalRbacDatabase(':memory:')
  databases.push(database)
  const rbac = new RbacState(database)
  rbac.migrate()
  return buildRawApp({
    tenants: tenantsWithNeuro(),
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
}
type App = ReturnType<typeof buildApp>

/** A provider whose agent asks run `agentAsk`, recording each call. */
function agentProvider(
  agentAsk?: (question: string, opts: AgentAskOptions) => AsyncIterable<AgentAskEvent>,
) {
  const calls: { question: string; opts: AgentAskOptions }[] = []
  const provider: RetrievalProvider = Object.assign(new DoubleProvider(), {
    agentAsk: agentAsk &&
      ((_tenant: unknown, question: string, opts: AgentAskOptions = {}) => {
        calls.push({ question, opts })
        return agentAsk(question, opts)
      }),
  })
  return { provider, calls }
}

const askAgent = (app: App, slug: string, body: unknown, init: RequestInit = {}) =>
  app.request(`/api/t/${slug}/ask-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
const setAgentAsk = (app: App, slug: string, agentAsk: unknown) =>
  app.request(`/api/admin/tenants/${slug}`, {
    method: 'PATCH',
    headers: { 'x-admin-passcode': passcode, 'content-type': 'application/json' },
    body: JSON.stringify({ agentAsk }),
  })
const configOf = async (app: App, slug: string) =>
  TenantConfigSchema.parse(await (await app.request(`/api/t/${slug}/config`)).json())
/** The SSE frames of a finished response, each checked against the contract. */
const eventsOf = async (response: Response): Promise<AgentAskEvent[]> =>
  (await response.text()).split('\n\n').map((frame) => frame.trim()).filter(Boolean).map((
    frame,
  ) => AgentAskEventSchema.parse(JSON.parse(frame.replace(/^data: /, ''))))

describe('POST /api/t/:slug/ask-agent', () => {
  it('is off by default and answers as not found, before reading the body', async () => {
    const { provider, calls } = agentProvider(async function* () {})
    const app = buildApp({ provider })
    expect((await configOf(app, 'marine')).agentAsk).toBeUndefined()
    for (const body of [{ query: 'Why?' }, { nope: true }]) {
      const response = await askAgent(app, 'marine', body)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    expect(calls).toEqual([])
  })

  it('is switched on and off per portal by the agentAsk setting', async () => {
    const app = buildApp({ provider: new DoubleProvider() })
    expect((await setAgentAsk(app, 'marine', true)).status).toBe(200)
    expect((await configOf(app, 'marine')).agentAsk).toBe(true)
    const on = await askAgent(app, 'marine', { query: 'Why? #fast' })
    expect(on.status).toBe(200)
    expect((await eventsOf(on)).at(-1)?.type).toBe('done')
    expect((await askAgent(app, 'grains', { query: 'Why?' })).status).toBe(404)
    expect((await setAgentAsk(app, 'marine', false)).status).toBe(200)
    expect((await askAgent(app, 'marine', { query: 'Why?' })).status).toBe(404)
    expect((await setAgentAsk(app, 'marine', 'yes')).status).toBe(400)
  })

  it('stays not found on a provider with no agent support, even when switched on', async () => {
    const { provider } = agentProvider(undefined)
    const app = buildApp({ provider })
    await setAgentAsk(app, 'marine', true)
    expect((await askAgent(app, 'marine', { query: 'Why?' })).status).toBe(404)
  })

  it('refuses an invalid question without reaching the provider', async () => {
    const { provider, calls } = agentProvider(async function* () {})
    const app = buildApp({ provider })
    await setAgentAsk(app, 'marine', true)
    for (
      const body of [{}, { query: '' }, { query: 'x'.repeat(2001) }, {
        query: 'Why?',
        depth: 'deep',
      }]
    ) {
      const response = await askAgent(app, 'marine', body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_query' })
    }
    expect(calls).toEqual([])
  })

  it("streams the agent's events in order, with the question and prior turns", async () => {
    const replay = new DoubleProvider()
    const { provider, calls } = agentProvider((question, opts) =>
      replay.agentAsk({} as never, question, opts)
    )
    const app = buildApp({ provider })
    await setAgentAsk(app, 'marine', true)
    const context = [{ author: 'USER' as const, text: 'Earlier' }]
    const response = await askAgent(app, 'marine', {
      query: ' How is warming changing pests? ',
      context,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    const events = await eventsOf(response)
    expect(events[0]?.type).toBe('agent-start')
    expect(events.at(-1)).toEqual({ type: 'done', elapsedMs: 89_800 })
    expect(events.filter((event) => event.type === 'citation').length).toBe(6)
    expect(calls.map((call) => [call.question, call.opts.context])).toEqual([
      ['How is warming changing pests?', context],
    ])
    expect(calls[0]?.opts.signal).toBeInstanceOf(AbortSignal)
  })

  it("reports a refusal or a failure in the portal's own words, never upstream detail", async () => {
    const leaky = 'Agentic RAG API 500 for https://zone.dp.progress.cloud/api/v1/agent/x/session'
    const cases: [() => AsyncIterable<AgentAskEvent>, AgentAskEvent][] = [
      [() => {
        throw new AgentAskError('not_configured', 'No agent id for this portal')
      }, {
        type: 'error',
        code: 'not_configured',
        message: AGENT_ASK_MESSAGES.not_configured,
        retryable: false,
      }],
      [async function* () {
        yield { type: 'agent-start', sources: [] }
        throw new Error(leaky)
      }, {
        type: 'error',
        code: 'upstream',
        message: 'The answer service had a problem (HTTP 500) - please try again.',
        retryable: true,
      }],
      [async function* () {
        yield { type: 'error', code: 'timeout', message: `Timed out at ${leaky}`, retryable: true }
      }, { type: 'error', code: 'timeout', message: AGENT_ASK_MESSAGES.timeout, retryable: true }],
      [async function* () {
        yield { type: 'error', code: 'upstream', message: 'Driver drv-x: 502', retryable: true }
      }, { type: 'error', code: 'upstream', message: ANSWER_SERVICE_PROBLEM, retryable: true }],
    ]
    for (const [agentAsk, expected] of cases) {
      const { provider } = agentProvider(agentAsk)
      const app = buildApp({ provider })
      await setAgentAsk(app, 'marine', true)
      const events = await eventsOf(await askAgent(app, 'marine', { query: 'Why?' }))
      expect(events.at(-1)).toEqual(expected)
      for (const event of events) {
        if (event.type === 'error') expect(leaksInternalDetail(event.message)).toBe(false)
      }
    }
    // The fixture that fails mid-stream names its driver upstream; the reader never sees it.
    const app = buildApp({ provider: new DoubleProvider() })
    await setAgentAsk(app, 'marine', true)
    const failed = await eventsOf(await askAgent(app, 'marine', { query: 'Why? #error' }))
    expect(failed.at(-1)).toEqual({
      type: 'error',
      code: 'upstream',
      message: ANSWER_SERVICE_PROBLEM,
      retryable: true,
    })
  })

  for (const how of ['response cancelled', 'request aborted'] as const) {
    it(`ends the upstream session as soon as the reader goes away (${how})`, async () => {
      const ended = Promise.withResolvers<boolean>()
      const { provider } = agentProvider(async function* (_question, opts) {
        try {
          yield { type: 'agent-start', sources: [] }
          // An agent still thinking: nothing more arrives until the session is ended.
          await new Promise((resolve) => opts.signal?.addEventListener('abort', resolve))
          yield { type: 'delta', text: 'Never sent.' }
        } finally {
          ended.resolve(opts.signal?.aborted === true)
        }
      })
      const app = buildApp({ provider })
      await setAgentAsk(app, 'marine', true)
      const reader = new AbortController()
      const response = await askAgent(app, 'marine', { query: 'Why?' }, { signal: reader.signal })
      const body = response.body!.getReader()
      const first = new TextDecoder().decode((await body.read()).value)
      expect(first).toContain('"agent-start"')
      if (how === 'request aborted') reader.abort()
      else await body.cancel()
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000))
      expect(await Promise.race([ended.promise, timeout])).toBe(true)
      if (how === 'request aborted') await body.cancel().catch(() => {})
    })
  }

  it('is rate limited as an ask', async () => {
    const app = buildApp({ provider: new DoubleProvider(), rateLimitAskPerMin: 1 })
    await setAgentAsk(app, 'marine', true)
    const first = await askAgent(app, 'marine', { query: 'Why? #fast' })
    expect(first.status).toBe(200)
    await first.text()
    expect((await askAgent(app, 'marine', { query: 'Why? #fast' })).status).toBe(429)
  })
})
