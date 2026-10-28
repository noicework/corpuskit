// ---------------------------------------------------------------------------
// A stand-in for partners' Progress Agentic RAG knowledge boxes, for the
// federation tests and the agent ask stub (docs/AGENT-ASK.md). It answers the
// two calls a peer key may make, POST /find and the box's MCP server
// (initialize, notifications/initialized, tools/call search_documents), in
// the platform's shapes, as a `fetch` the app is given instead of the
// network. Synthetic boxes only: no real box id, key or passage belongs here.
// ---------------------------------------------------------------------------

export interface PeerDocument {
  resourceId: string
  title: string
  text: string
  originUrl?: string
  /** Raw retrieval score supplied by this synthetic peer. */
  score?: number
  /** Labelled `federation/exclude` in the box. */
  excluded?: boolean
}

export interface PeerBox {
  zone: string
  kbId: string
  key: string
  documents: PeerDocument[]
  /** Answer every call this many milliseconds late (a slow partner). */
  delayMs?: number
}

export interface PeerCall {
  path: string
  method?: string
  tool?: string
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

/** A fetch that serves `boxes`, recording every call it gets. Anything else is a 404. */
export function aragPeerFetch(boxes: PeerBox[]): typeof fetch & { calls: PeerCall[] } {
  const calls: PeerCall[] = []
  const sessions = new Set<string>()
  const handler = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const match = /^\/api\/v1\/kb\/([^/]+)(\/.*)$/.exec(url.pathname)
    const box = boxes.find((candidate) =>
      url.hostname === `${candidate.zone}.dp.progress.cloud` && candidate.kbId === match?.[1]
    )
    const path = match?.[2] ?? url.pathname
    if (!box) {
      calls.push({ path })
      return json({ detail: 'Not found' }, { status: 404 })
    }
    if (box.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, box.delayMs)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(init.signal?.reason)
        }, { once: true })
      })
    }
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    calls.push({
      path,
      ...(body.method ? { method: body.method } : {}),
      ...(body.params?.name ? { tool: body.params.name } : {}),
    })
    if (headers.get('x-nuclia-serviceaccount') !== `Bearer ${box.key}`) {
      return json({ detail: 'Invalid service account' }, { status: 401 })
    }
    const kept = box.documents
    if (path === '/find') {
      return json({
        resources: Object.fromEntries(kept.map((document, rank) => [document.resourceId, {
          title: document.title,
          ...(document.originUrl ? { origin: { url: document.originUrl } } : {}),
          usermetadata: {
            classifications: document.excluded
              ? [{ labelset: 'federation', label: 'exclude' }]
              : [],
          },
          fields: {
            'f/file': {
              paragraphs: {
                [`${document.resourceId}/f/file/0-${document.text.length}`]: {
                  score: document.score ?? 0.9 - rank * 0.05,
                  text: document.text,
                },
              },
            },
          },
        }])),
      })
    }
    if (path !== '/mcp') return json({ detail: 'Not found' }, { status: 404 })
    if (body.method === 'initialize') {
      const session = crypto.randomUUID()
      sessions.add(session)
      return json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: box.kbId, version: '1.29.1' },
        },
      }, { headers: { 'mcp-session-id': session } })
    }
    if (!sessions.has(headers.get('mcp-session-id') ?? '')) {
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'No session' } }, {
        status: 400,
      })
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'tools/call' && body.params?.name === 'search_documents') {
      const result = {
        content: kept.map((document, index) => ({
          type: 'text',
          text: document.text,
          annotations: { audience: ['user', 'assistant'] },
          _meta: {
            type: 'citations',
            paragraph_id: `block-${String.fromCharCode(65 + index)}A`,
            resource_title: document.title,
            parent: document.resourceId,
            score: document.score ?? 0.9 - index * 0.05,
            ...(document.originUrl ? { url: document.originUrl } : {}),
            field_type: 'f',
            field: 'file',
            resource_labels: [{
              field: { field_type: 'f', field: 'file' },
              classifications: document.excluded
                ? [{ labelset: 'federation', label: 'exclude' }]
                : [],
            }],
          },
        })),
        isError: false,
      }
      // Streamed, as a Streamable HTTP server may answer a request.
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown' } })
  }
  return Object.assign(handler as typeof fetch, { calls })
}
