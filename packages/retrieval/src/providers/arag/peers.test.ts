import { expect } from '@std/expect'
import { searchPeer } from './peers.ts'

Deno.test('an MCP peer returns its result before a long-lived SSE connection closes', async () => {
  let cancelled = false
  const signal = new AbortController().signal
  const methods: string[] = []
  const passages = await searchPeer(
    { kind: 'arag-mcp', zone: 'test', kbId: 'peer-box' },
    'test-key',
    'Soil moisture',
    {
      signal,
      fetchImpl: (_input, init) => {
        expect(init?.signal).toBe(signal)
        const body = JSON.parse(String(init?.body))
        methods.push(body.method)
        if (body.method === 'initialize') {
          return Promise.resolve(Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, {
            headers: { 'mcp-session-id': 'test-session' },
          }))
        }
        expect(new Headers(init?.headers).get('mcp-session-id')).toBe('test-session')
        if (body.method === 'notifications/initialized') {
          return Promise.resolve(
            new Response(null, { status: 202 }),
          )
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder()
                controller.enqueue(encoder.encode(': heartbeat\r\n\r\ndata: {"id":999}\r\n\r\n'))
                const frame = `data: ${
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                      content: [
                        {
                          type: 'text',
                          text: 'Soil held moisture. '.repeat(200),
                          _meta: { parent: 'soil', resource_title: 'Soil study' },
                        },
                      ],
                    },
                  })
                }\r\n\r\n`
                controller.enqueue(encoder.encode(frame.slice(0, 30)))
                controller.enqueue(encoder.encode(frame.slice(30)))
                // Intentionally never close: matching the result must cancel the rest of this body.
              },
              cancel() {
                cancelled = true
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        )
      },
    },
  )
  expect(passages).toHaveLength(1)
  expect(passages[0]!.text).toHaveLength(1200)
  expect(cancelled).toBe(true)
  expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
})
