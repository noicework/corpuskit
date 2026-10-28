// Smoke test for the agent ask stub server (`deno task dev:stub`, docs/AGENT-ASK.md): the real
// app over HTTP, the fixture sessions replayed through the real normaliser.
import { expect } from '@std/expect'
import { type AgentAskEvent, AgentAskEventSchema, TenantConfigSchema } from '@research-portal/core'
import { AGENT_STUB_PORTAL, startAgentStub } from './support/agent-stub-server.ts'

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
  const server = startAgentStub({ speed: 0 })
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
  const server = startAgentStub({ speed: 30, apiOnly: true })
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
  const server = startAgentStub({ speed: 1, apiOnly: true })
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
  const server = startAgentStub({ speed: 0, apiOnly: true })
  try {
    const slugs = server.portals.map((portal) => portal.slug)
    const events = async (query: string) =>
      (await timedEvents(await askAcross(server.url, query, slugs))).map(({ event }) => event)

    const composed = await events('How is warming changing pests? #compose')
    expect(composed[0]).toMatchObject({ type: 'agent-start', mode: 'orchestrated' })
    const start = composed[0]
    expect(start?.type === 'agent-start' && start.sources.map((source) => source.portal))
      .toEqual(slugs)
    const cited = (list: AgentAskEvent[]) =>
      new Set(list.flatMap((event) => event.type === 'citation' ? [event.sourceId] : []))
    expect(cited(composed)).toEqual(new Set(slugs))
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
      expect(cited(partial)).toEqual(new Set([slugs[0], slugs[2]]))
      expect(partial.at(-1)?.type).toBe('done')
    }
  } finally {
    await server.close()
  }
})
