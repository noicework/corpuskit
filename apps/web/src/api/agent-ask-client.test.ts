import { expect } from '@std/expect'
import type { AgentAskEvent } from '@research-portal/core'
import { ApiError, streamAgentAsk } from './client.ts'

const EVENTS: AgentAskEvent[] = [
  { type: 'agent-start', sources: [{ id: 'drv-one', label: 'Source one' }] },
  {
    type: 'agent-step',
    id: 'context/c1',
    module: 'basic_ask',
    title: 'Searching',
    status: 'started',
  },
  { type: 'delta', text: 'An answer [block-AA].' },
  { type: 'done', elapsedMs: 1200 },
]

/** An SSE body delivered in awkward pieces: frames split mid-way and joined together. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const text = frames.map((frame) => `data: ${frame}\n\n`).join('')
  const encoder = new TextEncoder()
  const pieces = [text.slice(0, 7), text.slice(7, 160), text.slice(160)]
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

Deno.test('streamAgentAsk posts the question and delivers each valid agent ask event in order', async () => {
  const original = globalThis.fetch
  const requests: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (input, init) => {
    requests.push({ url: String(input), init })
    const frames = [
      JSON.stringify(EVENTS[0]),
      JSON.stringify(EVENTS[1]),
      // Not part of the contract: dropped rather than handed to the view.
      JSON.stringify({ type: 'stage', stage: 'retrieval', status: 'started' }),
      JSON.stringify({
        type: 'citation',
        marker: 'm',
        sourceId: 's',
        chunkId: 'c',
        title: 't',
        url: 'javascript:x',
      }),
      JSON.stringify(EVENTS[2]),
      JSON.stringify(EVENTS[3]),
    ]
    return Promise.resolve(
      new Response(sseBody(frames), { headers: { 'content-type': 'text/event-stream' } }),
    )
  }
  try {
    const received: AgentAskEvent[] = []
    await streamAgentAsk('marine', { query: 'Why?' }, (event) => received.push(event))
    expect(received).toEqual(EVENTS)
    expect(requests[0]?.url).toBe('/api/t/marine/ask-agent')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ query: 'Why?' })
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('streamAgentAsk rejects with the status when the portal does not offer agent ask', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(Response.json({ error: 'not_found' }, { status: 404 }))
  try {
    let events = 0
    const error = await streamAgentAsk('marine', { query: 'Why?' }, () => events++).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(events).toBe(0)
  } finally {
    globalThis.fetch = original
  }
})
