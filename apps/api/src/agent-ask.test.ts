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
import { createEnforcementFixture } from './enforcement-fixture.ts'

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

/**
 * A provider whose agent asks run `agentAsk`, recording each call. It composes as the
 * DoubleProvider does, unless `composes` is false.
 */
function agentProvider(
  agentAsk?: (question: string, opts: AgentAskOptions) => AsyncIterable<AgentAskEvent>,
  composes = true,
) {
  const calls: { question: string; opts: AgentAskOptions }[] = []
  const provider: RetrievalProvider = Object.assign(new DoubleProvider(), {
    agentAsk: agentAsk &&
      ((_tenant: unknown, question: string, opts: AgentAskOptions = {}) => {
        calls.push({ question, opts })
        return agentAsk(question, opts)
      }),
    ...(composes ? {} : { compose: undefined }),
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

  it('stays not found on a provider that has no agent and cannot compose', async () => {
    const { provider } = agentProvider(undefined, false)
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
        yield { type: 'agent-start', mode: 'agent', sources: [] }
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
      // With nothing to fall back on, the agent's own failure is what the reader is told.
      const { provider } = agentProvider(agentAsk, false)
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
          yield { type: 'agent-start', mode: 'agent', sources: [] }
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

describe('POST /api/ask-agent', () => {
  const askAcross = (app: App, body: unknown) =>
    app.request('/api/ask-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('is refused until a selected portal offers agent ask, and leaves out the rest', async () => {
    const app = buildApp({ provider: new DoubleProvider() })
    const slugs = ['marine', 'grains']
    // With nowhere to ask, refused as the federated ask is, before anything is admitted.
    const off = await askAcross(app, { query: 'Why? #compose', slugs })
    expect(off.status).toBe(401)
    await setAgentAsk(app, 'grains', true)
    const events = await eventsOf(await askAcross(app, { query: 'Why? #compose', slugs }))
    expect(events[0]).toMatchObject({
      type: 'agent-start',
      mode: 'orchestrated',
      sources: [{ id: 'grains', portal: 'grains' }],
    })
  })

  it('composes across the selected portals in their order, the first hosting', async () => {
    const provider = new DoubleProvider()
    const hosts: string[] = []
    const compose = provider.compose.bind(provider)
    provider.compose = (host, question, passages) => {
      hosts.push(host.slug)
      return compose(host, question, passages)
    }
    const app = buildApp({ provider })
    for (const slug of ['marine', 'grains']) await setAgentAsk(app, slug, true)
    for (const slugs of [['marine', 'grains'], ['grains', 'marine']]) {
      const events = await eventsOf(await askAcross(app, { query: 'Why? #compose', slugs }))
      const start = events[0]
      expect(start?.type === 'agent-start' && start.sources.map((s) => s.id)).toEqual(slugs)
      expect(events.filter((e) => e.type === 'sources-failed')).toEqual([])
      const cited = new Set(events.flatMap((e) => e.type === 'citation' ? [e.sourceId] : []))
      expect(cited.size).toBeGreaterThan(0)
      for (const sourceId of cited) expect(slugs).toContain(sourceId)
      expect(events.at(-1)?.type).toBe('done')
    }
    expect(hosts).toEqual(['marine', 'grains'])
  })

  it("uses the host portal's agent when it has one", async () => {
    const app = buildApp({ provider: new DoubleProvider() })
    for (const slug of ['marine', 'grains']) await setAgentAsk(app, slug, true)
    const events = await eventsOf(
      await askAcross(app, { query: 'Why?', slugs: ['marine', 'grains'] }),
    )
    expect(events[0]).toMatchObject({ type: 'agent-start', mode: 'agent' })
    expect(events.at(-1)?.type).toBe('done')
  })

  it('refuses an invalid request, and one with no portal the caller may name', async () => {
    const app = buildApp({ provider: new DoubleProvider() })
    await setAgentAsk(app, 'marine', true)
    for (
      const body of [
        { query: '' },
        { query: 'Why?', slugs: [] },
        { query: 'Why?', slugs: Array.from({ length: 13 }, (_, i) => `p${i}`) },
        { query: 'Why?', slugs: ['marine'], extra: true },
      ]
    ) expect((await askAcross(app, body)).status).toBe(400)
    // Anonymous, with no selection: nothing in the directory to ask.
    expect((await askAcross(app, { query: 'Why?' })).status).toBe(401)
  })

  it("takes a day's ask on every portal it reaches, or on none", async () => {
    const f = createEnforcementFixture()
    const init = (slugs: string[]) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Why? #compose', slugs }),
    })
    const asksToday = (slug: string) => f.stores.lifecycle.usage(slug, 'UTC', f.now()).asksToday
    try {
      const owner = f.sessionFor('owner')
      f.stores.lifecycle.set('b', { status: 'active', limits: { asksPerDay: 0 } })
      const refused = await f.requestAs(owner, '/api/ask-agent', init(['a', 'b']))
      expect(refused.status).toBe(429)
      expect((await refused.json()).error).toBe('ask_quota_exceeded')
      expect(asksToday('a')).toBe(0)
      f.stores.lifecycle.set('b', { status: 'active', limits: null })
      const admitted = await f.requestAs(owner, '/api/ask-agent', init(['a', 'b']))
      expect(admitted.status).toBe(200)
      const events = await eventsOf(admitted)
      expect(events[0]).toMatchObject({ type: 'agent-start', mode: 'orchestrated' })
      expect([asksToday('a'), asksToday('b')]).toEqual([1, 1])
    } finally {
      f.close()
    }
  })

  it('is admitted as the federated ask is', async () => {
    const app = buildApp({ provider: new DoubleProvider(), rateLimitEstatePerMin: 1 })
    await setAgentAsk(app, 'marine', true)
    const first = await askAcross(app, { query: 'Why? #compose #fast', slugs: ['marine'] })
    expect(first.status).toBe(200)
    await first.text()
    expect((await askAcross(app, { query: 'Why? #compose', slugs: ['marine'] })).status).toBe(429)
  })
})
