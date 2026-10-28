// ---------------------------------------------------------------------------
// Federation peers (docs/AGENT-ASK.md): a partner's Progress Agentic RAG
// knowledge box, searched with its read-only service-account key, either
// through the box's retrieval (`arag-kb`: POST /find) or its MCP server
// (`arag-mcp`: the `search_documents` tool over Streamable HTTP).
//
// A peer key may make only those calls. The address is built from the
// peer's zone and box id alone, on `<zone>.dp.progress.cloud` over https,
// so no configured value can point a request anywhere else; redirects are
// refused rather than followed; and every path, JSON-RPC method and tool is
// checked against an allowlist before anything is sent.
// ---------------------------------------------------------------------------
import { COMPOSE_PASSAGE_CHARS, COMPOSE_PASSAGES_PER_SOURCE } from '../../compose.ts'
import {
  FEDERATION_EXCLUDE_LABEL,
  FEDERATION_ZONE,
  type FederationPeer,
} from '@research-portal/core'

/** A passage a peer returned. A resource labelled `federation/exclude` never yields one. */
export interface PeerPassage {
  resourceId: string
  title: string
  text: string
  originUrl?: string
}

export type PeerFailure = 'timeout' | 'unauthorised' | 'error'

/** A peer call that failed, or was refused before it was sent. Never carries the key. */
export class PeerError extends Error {
  constructor(readonly failure: PeerFailure, message: string) {
    super(message)
    this.name = 'PeerError'
  }
}

/** The only paths a peer key may call, per kind: retrieval, and the box's MCP server. */
export const PEER_PATHS: Readonly<Record<FederationPeer['kind'], readonly string[]>> = {
  'arag-kb': ['/find'],
  'arag-mcp': ['/mcp'],
}
/** The only JSON-RPC methods, and the only (read) tools, a peer's MCP session may use. */
export const PEER_MCP_METHODS = ['initialize', 'notifications/initialized', 'tools/call'] as const
export const PEER_MCP_TOOLS = ['search_documents', 'get_document', 'batch_get_documents'] as const
const PROTOCOL_VERSION = '2025-06-18'
/** Passages kept from one peer. */
export const PEER_PASSAGES = COMPOSE_PASSAGES_PER_SOURCE

type PeerAddress = Pick<FederationPeer, 'kind' | 'zone' | 'kbId'>

/** The peer's endpoint for `path`, or a refusal for any address or path not allowed. */
export function peerEndpoint(peer: PeerAddress, path: string): URL {
  if (!FEDERATION_ZONE.test(peer.zone) || !/^[A-Za-z0-9-]{1,64}$/.test(peer.kbId)) {
    throw new PeerError('error', 'The peer address is not a knowledge box address')
  }
  if (!(PEER_PATHS[peer.kind] ?? []).includes(path)) {
    throw new PeerError('error', `A ${peer.kind} peer may not call ${path}`)
  }
  const url = new URL(`https://${peer.zone}.dp.progress.cloud/api/v1/kb/${peer.kbId}${path}`)
  if (url.protocol !== 'https:' || url.hostname !== `${peer.zone}.dp.progress.cloud`) {
    throw new PeerError('error', 'The peer address is not a knowledge box address')
  }
  return url
}

export interface PeerCallOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

async function peerPost(
  peer: PeerAddress,
  path: string,
  token: string,
  body: unknown,
  options: PeerCallOptions,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = peerEndpoint(peer, path)
  const fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis)
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nuclia-serviceaccount': `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options.signal,
      // A redirect could lead anywhere; a knowledge box never needs one.
      redirect: 'manual',
    })
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error
    throw new PeerError('error', 'The peer could not be reached')
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel()
    throw new PeerError('error', 'The peer answered with a redirect, which is refused')
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel()
    throw new PeerError('unauthorised', `The peer refused its key (${res.status})`)
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new PeerError('error', `The peer answered ${res.status}`)
  }
  return res
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const httpsUrl = (value: unknown) => /^https:\/\//i.test(text(value)) ? text(value) : undefined

/** Whether a list of `{labelset, label}` classifications carries the exclusion label. */
function excludedBy(classifications: unknown): boolean {
  return Array.isArray(classifications) &&
    classifications.some((c) =>
      isRecord(c) && c.labelset === FEDERATION_EXCLUDE_LABEL.labelset &&
      c.label === FEDERATION_EXCLUDE_LABEL.label && c.cancelled_by_user !== true
    )
}

/**
 * A peer's passages for `query`: its strongest, at most `PEER_PASSAGES`, none from a resource
 * labelled `federation/exclude`.
 */
export function searchPeer(
  peer: PeerAddress,
  token: string,
  query: string,
  options: PeerCallOptions = {},
): Promise<PeerPassage[]> {
  return peer.kind === 'arag-mcp'
    ? searchPeerMcp(peer, token, query, options)
    : searchPeerKb(peer, token, query, options)
}

/** `arag-kb`: the box's own retrieval, POST /find. Retrieval only, never generation. */
async function searchPeerKb(
  peer: PeerAddress,
  token: string,
  query: string,
  options: PeerCallOptions,
): Promise<PeerPassage[]> {
  const res = await peerPost(peer, '/find', token, {
    query,
    features: ['keyword', 'semantic'],
    show: ['basic', 'origin'],
    top_k: 20,
  }, options)
  const found = await res.json().catch(() => null) as unknown
  const resources = isRecord(found) && isRecord(found.resources) ? found.resources : {}
  const passages: (PeerPassage & { score: number })[] = []
  for (const [resourceId, raw] of Object.entries(resources)) {
    if (!isRecord(raw)) continue
    const usermetadata = isRecord(raw.usermetadata) ? raw.usermetadata : {}
    const computed = isRecord(raw.computedmetadata) ? raw.computedmetadata : {}
    const excluded = excludedBy(usermetadata.classifications) ||
      excludedBy(computed.classifications) ||
      (Array.isArray(computed.field_classifications) &&
        computed.field_classifications.some((field) =>
          isRecord(field) && excludedBy(field.classifications)
        ))
    if (excluded) continue
    const origin = isRecord(raw.origin) ? httpsUrl(raw.origin.url) : undefined
    const fields = isRecord(raw.fields) ? Object.values(raw.fields) : []
    for (const field of fields) {
      const paragraphs = isRecord(field) && isRecord(field.paragraphs)
        ? Object.values(field.paragraphs)
        : []
      for (const paragraph of paragraphs) {
        if (!isRecord(paragraph) || !text(paragraph.text)) continue
        passages.push({
          resourceId,
          title: text(raw.title) || 'Untitled document',
          text: text(paragraph.text).slice(0, COMPOSE_PASSAGE_CHARS),
          ...(origin ? { originUrl: origin } : {}),
          score: typeof paragraph.score === 'number' ? paragraph.score : 0,
        })
      }
    }
  }
  // The strongest first, at most two from one document, so one long report cannot fill the list.
  const perResource = new Map<string, number>()
  return passages.sort((a, b) => b.score - a.score).filter((passage) => {
    const seen = perResource.get(passage.resourceId) ?? 0
    perResource.set(passage.resourceId, seen + 1)
    return seen < 2
  }).slice(0, PEER_PASSAGES).map(({ score: _score, ...passage }) => passage)
}

/** One MCP session with a peer's knowledge box: JSON-RPC over Streamable HTTP. */
export class PeerMcpSession {
  private session?: string
  private nextId = 1

  constructor(
    private readonly peer: PeerAddress,
    private readonly token: string,
    private readonly options: PeerCallOptions = {},
  ) {}

  /** A request, refused unless its method (and, for a tool call, its tool) is allowed. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.allow(method, params)
    const id = this.nextId++
    const res = await peerPost(
      this.peer,
      '/mcp',
      this.token,
      { jsonrpc: '2.0', id, method, params },
      this.options,
      this.headers(),
    )
    if (method === 'initialize') this.session = res.headers.get('mcp-session-id') ?? undefined
    const message = await rpcMessage(res, id)
    if (!isRecord(message)) throw new PeerError('error', 'The peer sent no answer')
    if (message.error !== undefined) throw new PeerError('error', 'The peer reported an error')
    return message.result
  }

  /** A notification: no answer is expected. */
  async notify(method: string): Promise<void> {
    this.allow(method, {})
    const res = await peerPost(
      this.peer,
      '/mcp',
      this.token,
      { jsonrpc: '2.0', method },
      this.options,
      this.headers(),
    )
    await res.body?.cancel()
  }

  private allow(method: string, params: Record<string, unknown>) {
    if (!(PEER_MCP_METHODS as readonly string[]).includes(method)) {
      throw new PeerError('error', `A peer session may not call ${method}`)
    }
    if (
      method === 'tools/call' &&
      !(PEER_MCP_TOOLS as readonly string[]).includes(String(params.name))
    ) {
      throw new PeerError('error', `A peer session may not call the ${String(params.name)} tool`)
    }
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.session ? { 'mcp-session-id': this.session } : {}),
    }
  }
}

/** The JSON-RPC response with `id`, from a JSON body or a server-sent event stream. */
async function rpcMessage(res: Response, id: number): Promise<unknown> {
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return await res.json().catch(() => undefined)
  }
  const reader = res.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  const messageFrom = (event: string): unknown => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) return undefined
    try {
      const message = JSON.parse(data)
      if (isRecord(message) && message.id === id) return message
    } catch {
      // A comment, notification or non-JSON frame is not this request's answer.
    }
    return undefined
  }
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return messageFrom(buffer)
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const message = messageFrom(frame)
        // Streamable HTTP may keep its connection open after the result. Do not await EOF.
        if (message !== undefined) return message
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** `arag-mcp`: the box's MCP server, `search_documents`. */
async function searchPeerMcp(
  peer: PeerAddress,
  token: string,
  query: string,
  options: PeerCallOptions,
): Promise<PeerPassage[]> {
  const session = new PeerMcpSession(peer, token, options)
  await session.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'corpuskit-federation', version: '1' },
  })
  await session.notify('notifications/initialized')
  const result = await session.request('tools/call', {
    name: 'search_documents',
    arguments: { query },
  })
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
    throw new PeerError('error', 'The peer search failed')
  }
  const passages: PeerPassage[] = []
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== 'text' || !text(item.text)) continue
    const meta = isRecord(item._meta) ? item._meta : {}
    const labels = Array.isArray(meta.resource_labels) ? meta.resource_labels : []
    if (labels.some((entry) => isRecord(entry) && excludedBy(entry.classifications))) continue
    passages.push({
      resourceId: text(meta.parent) || text(meta.paragraph_id) || `passage-${passages.length}`,
      title: text(meta.resource_title) || 'Untitled document',
      text: text(item.text).slice(0, COMPOSE_PASSAGE_CHARS),
    })
    if (passages.length === PEER_PASSAGES) break
  }
  return passages
}
