// Smoke test for the agent ask stub server (`deno task dev:stub`, docs/AGENT-ASK.md): the real
// app over HTTP, the fixture sessions replayed through the real normaliser.
import { expect } from '@std/expect'
import { type AgentAskEvent, AgentAskEventSchema, TenantConfigSchema } from '@research-portal/core'
import { AGENT_STUB_PORTAL, startAgentStub } from './support/agent-stub-server.ts'
import { collectAgentAnswer } from '../apps/web/src/lib/agent-answer-export.ts'

function askAcross(url: string, query: string, slugs: string[]) {
  return fetch(`${url}/api/ask-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, slugs }),
  })
}

function askAgent(url: string, query: string, signal?: AbortSignal) {
  return fetch(`${url}/api/t/${AGENT_STUB_PORTAL}/ask-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  })
}

/** Each event with the milliseconds after the request at which it arrived. */
async function timedEvents(response: Response): Promise<{ at: number; event: AgentAskEvent }[]> {
  const started = performance.now()
  const out: { at: number; event: AgentAskEvent }[] = []
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames.filter((f) => f.trim())) {
      const event = AgentAskEventSchema.parse(JSON.parse(frame.replace(/^data: /, '')))
      out.push({ at: performance.now() - started, event })
    }
  }
  return out
}

Deno.test('the stub serves the portal and streams each fixture session over HTTP', async () => {
  const server = await startAgentStub({ speed: 0 })
  try {
    const page = await fetch(`${server.url}/t/${AGENT_STUB_PORTAL}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
    const config = await fetch(`${server.url}/api/t/${AGENT_STUB_PORTAL}/config`)
    expect(TenantConfigSchema.parse(await config.json()).agentAsk).toBe(true)

    const happy = (await timedEvents(await askAgent(server.url, 'How is warming changing pests?')))
      .map(({ event }) => event)
    expect(happy[0]?.type).toBe('agent-start')
    expect(happy.at(-1)).toEqual({ type: 'done', elapsedMs: 89_800 })
    expect(happy.filter((e) => e.type === 'agent-step' && e.status === 'started').length).toBe(12)
    expect(new Set(happy.flatMap((e) => e.type === 'agent-sources' ? [e.source.label] : [])))
      .toEqual(new Set(['Fisheries research', 'Grains research', 'Rural industries research']))

    const failed = (await timedEvents(await askAgent(server.url, 'Why? #error')))
      .map(({ event }) => event)
    expect(failed.at(-1)).toMatchObject({ type: 'error', code: 'upstream', retryable: true })
    const slow = (await timedEvents(await askAgent(server.url, 'Why? #slow')))
      .map(({ event }) => event)
    expect(slow.at(-1)).toEqual({ type: 'done', elapsedMs: 46_800 })

    // A portal that has not opted in answers as if the route did not exist.
    const unlisted = server.tenants.add({ name: 'Unlisted collection' })
    const other = await fetch(`${server.url}/api/t/${unlisted.slug}/ask-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Why?' }),
    })
    expect(other.status).toBe(404)
    await other.body?.cancel()
  } finally {
    await server.close()
  }
})

Deno.test('the stub replays at the recorded pace, scaled, and #fast skips the waiting', async () => {
  const server = await startAgentStub({ speed: 30, apiOnly: true })
  try {
    const paced = await timedEvents(await askAgent(server.url, 'Why?'))
    // 89.8 s recorded at thirty times: about 3 s, with the first event at once.
    expect(paced[0]!.at).toBeLessThan(500)
    expect(paced.at(-1)!.at).toBeGreaterThan(2500)
    expect(paced.at(-1)!.at).toBeLessThan(8000)
    const fast = await timedEvents(await askAgent(server.url, 'Why? #fast'))
    expect(fast.at(-1)!.at).toBeLessThan(1500)
    expect(fast.map(({ event }) => event)).toEqual(paced.map(({ event }) => event))
  } finally {
    await server.close()
  }
})

Deno.test('a reader leaving ends the replay at once', async () => {
  const server = await startAgentStub({ speed: 1, apiOnly: true })
  try {
    const reader = new AbortController()
    const response = await askAgent(server.url, 'Why?', reader.signal)
    const body = response.body!.getReader()
    expect(new TextDecoder().decode((await body.read()).value)).toContain('"agent-start"')
    expect(server.provider.agentAsksOpen).toBe(1)
    reader.abort()
    await body.cancel().catch(() => {})
    const deadline = Date.now() + 3000
    while (server.provider.agentAsksOpen > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(server.provider.agentAsksOpen).toBe(0)
  } finally {
    await server.close()
  }
})

Deno.test('the stub composes across its portals without an agent, naming a portal that fails', async () => {
  const server = await startAgentStub({ speed: 0, apiOnly: true })
  try {
    const slugs = server.portals.map((portal) => portal.slug)
    const events = async (query: string) =>
      (await timedEvents(await askAcross(server.url, query, slugs))).map(({ event }) => event)

    const composed = await events('How is warming changing pests? #compose')
    expect(composed[0]).toMatchObject({ type: 'agent-start', mode: 'orchestrated' })
    const start = composed[0]
    expect(
      start?.type === 'agent-start' &&
        start.sources.filter((source) => source.kind === 'hosted').map((source) => source.portal),
    ).toEqual(slugs)
    const cited = (list: AgentAskEvent[]) =>
      new Set(list.flatMap((event) => event.type === 'citation' ? [event.sourceId] : []))
    // The host's federation peers join every answer it hosts.
    const peers = ['peer:soil-partner', 'peer:water-partner']
    expect(cited(composed)).toEqual(new Set([...slugs, ...peers]))
    expect(composed.some((event) => event.type === 'sources-failed')).toBe(false)
    expect(composed.at(-1)?.type).toBe('done')

    for (const [tag, reason] of [['#source-timeout', 'timeout'], ['#source-error', 'error']]) {
      const partial = await events(`Why? #compose ${tag}`)
      const failed = partial.find((event) => event.type === 'sources-failed')
      // The stub fails its second portal; the other two still answer.
      expect(failed).toMatchObject({
        type: 'sources-failed',
        sources: [{ id: slugs[1], portal: slugs[1], reason }],
      })
      expect(cited(partial)).toEqual(new Set([slugs[0], slugs[2], ...peers]))
      expect(partial.at(-1)?.type).toBe('done')
    }
  } finally {
    await server.close()
  }
})

Deno.test('the stub host federates to its two partner peers, and names one that fails', async () => {
  const server = await startAgentStub({ speed: 0, apiOnly: true })
  try {
    const events = async (query: string) =>
      (await timedEvents(await askAgent(server.url, query))).map(({ event }) => event)
    const composed = await events('How is warming changing pests? #compose')
    const start = composed[0]
    expect(start?.type === 'agent-start' && start.sources.map((s) => [s.id, s.kind, s.transport]))
      .toEqual([
        ['marine', 'hosted', undefined],
        ['peer:soil-partner', 'peer', 'kb'],
        ['peer:water-partner', 'peer', 'mcp'],
      ])
    const cited = new Set(composed.flatMap((e) => e.type === 'citation' ? [e.sourceId] : []))
    expect(cited).toEqual(new Set(['marine', 'peer:soil-partner', 'peer:water-partner']))
    // Partner citations carry no link: the stub peers do not allow one.
    expect(composed.some((e) => e.type === 'citation' && e.url !== undefined)).toBe(false)

    for (
      const [tag, id, reason] of [
        ['#peer-timeout', 'peer:soil-partner', 'timeout'],
        ['#peer-unauthorised', 'peer:water-partner', 'unauthorised'],
      ]
    ) {
      const partial = await events(`Why? #compose ${tag}`)
      expect(partial.find((e) => e.type === 'sources-failed')).toMatchObject({
        sources: [{ id, kind: 'peer', reason }],
      })
      expect(partial.at(-1)?.type).toBe('done')
    }
  } finally {
    await server.close()
  }
})

Deno.test('composition sends generation deltas well before done, with checked final text and timings', async () => {
  const server = await startAgentStub({ speed: 10, apiOnly: true })
  try {
    const received = performance.now()
    const events = await timedEvents(await askAgent(server.url, 'Why warming? #compose'))
    const first = events.find(({ event }) => event.type === 'delta')!
    const done = events.at(-1)!
    expect(done.event.type).toBe('done')
    expect(first.at).toBeLessThan(done.at - 300)
    expect(events.filter(({ event }) => event.type === 'delta').length).toBeGreaterThan(3)
    const compose = events.find(({ event }) =>
      event.type === 'agent-step' && event.id === 'compose' && event.status === 'completed'
    )!.event
    expect(compose).toMatchObject({ firstTokenMs: expect.any(Number) })
    if (compose.type === 'agent-step') {
      expect(compose.firstTokenMs!).toBeLessThan(compose.elapsedMs! - 300)
    }
    const record = collectAgentAnswer(
      'Why warming?',
      events.map(({ event }) =>
        event
      ),
    )
    expect(record.status).toBe('done')
    if (done.event.type === 'done') expect(record.text).toBe(done.event.text)
    expect(record.citations.length).toBeGreaterThan(0)
    console.log(JSON.stringify({
      replaySpeed: 10,
      firstDeltaMs: Math.round(first.at),
      doneMs: Math.round(done.at),
      requestMs: Math.round(performance.now() - received),
    }))
  } finally {
    await server.close()
  }
})
