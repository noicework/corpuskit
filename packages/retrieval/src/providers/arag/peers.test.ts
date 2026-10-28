import { expect } from '@std/expect'
import { searchPeer } from './peers.ts'
import { peerScore, peerTitle } from './peer-passages.ts'

Deno.test('peer title suffix removal is generic and only removes the last spaced segment', () => {
  for (const suffix of [' | Field archive', ' - Regional library']) {
    const title = `Water balance - trial findings${suffix}`
    expect(peerTitle(title, '', 'Passage text.', false)).toBe('Water balance - trial findings')
    expect(peerTitle(title, '', 'Passage text.', true)).toBe(title)
  }
  expect(peerTitle('Water-balance findings', '', 'Passage text.')).toBe('Water-balance findings')
})

Deno.test('peer scores must be finite numeric values above the floor', () => {
  for (const score of [undefined, null, '0.8', NaN, Infinity, -Infinity, 0.299]) {
    expect(peerScore(score)).toBeUndefined()
  }
  expect(peerScore(0.3)).toBe(0.3)
  expect(peerScore(12)).toBe(12)
})

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
                          _meta: { parent: 'soil', resource_title: 'Soil study', score: 0.8 },
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

/** In-process MCP protocol fixture; never reaches a network service. */
const mcpFetch = (content: unknown[]): typeof fetch => (_input, init) => {
  const body = JSON.parse(String(init?.body))
  if (body.method === 'notifications/initialized') {
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  return Promise.resolve(Response.json({
    jsonrpc: '2.0',
    id: body.id,
    result: body.method === 'initialize' ? {} : { content },
  }))
}

const mcpPeer = { kind: 'arag-mcp', zone: 'test', kbId: 'peer-box' } as const
const paragraph = (extra: Record<string, unknown> = {}) => ({
  type: 'text',
  text: 'Soil moisture increased under permanent pasture.',
  _meta: { paragraph_id: 'block-AB', parent: 'soil', resource_title: 'Soil study', score: 0.8 },
  ...extra,
})

Deno.test('MCP peers discard generated summaries and title-only items, retaining referenced passages', async () => {
  const passages = await searchPeer(mcpPeer, 'test-key', 'soil', {
    fetchImpl: mcpFetch([
      {
        type: 'text',
        text: 'A generated summary. [1]\n[1]: block-AB\nDocument IDs: block-AB: soil',
      },
      {
        type: 'text',
        text: 'A generated introduction.',
        _meta: { resource_title: 'Summary', score: 1 },
      },
      paragraph(),
      {
        type: 'resource',
        resource: {
          uri: 'https://peer.example.org/paper',
          text: 'Water use fell under drip irrigation.',
        },
        _meta: { resource_title: 'Water use study', score: 0.7 },
      },
    ]),
  })
  expect(passages.map((p) => p.title)).toEqual(['Soil study', 'Water use study'])
  expect(JSON.stringify(passages)).not.toContain('generated')
  expect(JSON.stringify(passages)).not.toContain('peer.example.org')
  expect(passages[0]!.resourceId).toBe('soil')
})

Deno.test('MCP peer filename titles fall back to metadata, then meaningful passage text', async () => {
  const passages = await searchPeer(mcpPeer, 'test-key', 'soil', {
    fetchImpl: mcpFetch([
      paragraph({ title: '1971-021-DLD.pdf | Field archive' }),
      paragraph({
        title: 'report.pdf',
        text: '\narchive.pdf\n---\n1971\n# Pasture water balance\nSoil moisture increased.',
        _meta: { parent: 'water', resource_title: '1971-021-DLD.pdf', score: 0.7 },
      }),
    ]),
  })
  expect(passages.map((p) => p.title)).toEqual(['Soil study', 'Pasture water balance'])
})

Deno.test('MCP peers apply the returned score floor before ranking and capping passages', async () => {
  const content = [-1, 0, 0.29, 0.3, 0.7, 0.8, 0.9, 0.95, undefined, '0.99'].map((score, index) =>
    paragraph({ _meta: { parent: `soil-${index}`, resource_title: 'Soil study', score } })
  )
  const passages = await searchPeer(mcpPeer, 'test-key', 'soil', { fetchImpl: mcpFetch(content) })
  expect(passages.map((p) => p.resourceId)).toEqual(['soil-7', 'soil-6', 'soil-5', 'soil-4'])
  expect(
    await searchPeer(mcpPeer, 'test-key', 'soil', { fetchImpl: mcpFetch(content.slice(0, 3)) }),
  )
    .toEqual([])
  const boundary = await searchPeer(mcpPeer, 'test-key', 'soil', {
    fetchImpl: mcpFetch(content.slice(0, 4)),
  })
  expect(boundary.map((p) => p.resourceId)).toEqual(['soil-3'])
})

Deno.test('KB peers filter weak and unscored paragraphs before choosing descriptive titles', async () => {
  const result = {
    resources: {
      soil: {
        title: '1971-021-DLD.pdf',
        _meta: { resource_title: 'Pasture moisture | Field archive' },
        origin: { url: 'https://peer.example.org/soil' },
        fields: {
          file: {
            paragraphs: {
              weak: { text: 'Off-topic material.', score: 0.29 },
              unscored: { text: 'Unscored material.' },
              match: { text: 'Soil moisture increased under pasture.', score: 0.3 },
            },
          },
        },
      },
      water: {
        title: 'water.pdf',
        fields: {
          file: {
            paragraphs: {
              match: { text: '\n# Irrigation water balance\nWater use fell.', score: 0.5 },
            },
          },
        },
      },
    },
  }
  const fetchImpl: typeof fetch = () => Promise.resolve(Response.json(result))
  const peer = { ...mcpPeer, kind: 'arag-kb' } as const
  const passages = await searchPeer(peer, 'test-key', 'soil', { fetchImpl })
  expect(passages.map((p) => p.title)).toEqual(['Irrigation water balance', 'Pasture moisture'])
  expect(JSON.stringify(passages)).not.toContain('peer.example.org')
  const linked = await searchPeer({ ...peer, linkOrigins: true }, 'test-key', 'soil', { fetchImpl })
  expect(linked[1]).toMatchObject({
    title: 'Pasture moisture | Field archive',
    originUrl: 'https://peer.example.org/soil',
  })
})
