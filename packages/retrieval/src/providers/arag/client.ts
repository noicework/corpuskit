/**
 * Thin REST client for the Progress Agentic RAG (Nuclia) regional API.
 * Knowledge-box data operations authenticate with a per-KB service-account
 * token; account-level management (used by provisioning) uses the account key.
 */

export interface KbBinding {
  /** Full KB API endpoint, e.g. https://<zone>.rag.progress.cloud/api/v1/kb/<id>. */
  baseUrl: string
  /** Service-account key with management permissions for the box. */
  token: string
  /** Box id, for display only - derivable from baseUrl. */
  kbId?: string
}

/** Hosts a knowledge box endpoint may live on - anything else is rejected (SSRF guard). */
export const ALLOWED_KB_HOSTS = [
  /\.rag\.progress\.cloud$/i,
  /\.dp\.progress\.cloud$/i,
  /\.nuclia\.cloud$/i,
  /(^|\.)progress\.cloud$/i,
]

/** Parse and validate a pasted KB endpoint URL; returns null when unusable. */
export function parseKbUrl(raw: string): { baseUrl: string; kbId: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim().replace(/\/+$/, ''))
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (!ALLOWED_KB_HOSTS.some((h) => h.test(url.hostname))) return null
  const match = url.pathname.match(/^\/api\/v1\/kb\/([^/]+)$/)
  if (!match?.[1]) return null
  return { baseUrl: `${url.origin}${url.pathname}`, kbId: match[1] }
}

/**
 * Ingestion back-pressure the platform reports via HTTP 429 when its
 * processing queue is full, e.g.
 * `{"detail":{"message":"Too many messages pending to ingest. Retry after
 * <ts>","try_after":<epoch seconds>,"back_pressure_type":"processing"}}`.
 * This is an expected, transient condition under load - not a hard failure.
 */
export interface BackPressureInfo {
  /** Epoch seconds after which the platform expects capacity to free up. */
  tryAfter: number
  /** e.g. "processing", "ingestion" - whichever queue is full. */
  kind: string
  /** The platform's own human-readable explanation. */
  message: string
}

function parseBackPressure(status: number, detail: string): BackPressureInfo | null {
  if (status !== 429) return null
  try {
    const parsed = JSON.parse(detail) as {
      detail?: { message?: string; try_after?: number; back_pressure_type?: string }
    }
    const d = parsed.detail
    if (d && typeof d.try_after === 'number') {
      return {
        tryAfter: d.try_after,
        kind: d.back_pressure_type ?? 'unknown',
        message: d.message ?? 'Too many messages pending to ingest.',
      }
    }
  } catch {
    // Not JSON, or not the shape we expect - fall through to "not back-pressure".
  }
  return null
}

export class AragApiError extends Error {
  /** Set when this 429 is recognised ingestion back-pressure; null for every other error. */
  readonly backpressure: BackPressureInfo | null

  constructor(
    readonly status: number,
    readonly url: string,
    detail: string,
  ) {
    const backpressure = parseBackPressure(status, detail)
    super(
      backpressure
        ? `Agentic RAG API 429 for ${url}: back-pressure (${backpressure.kind}) - ${backpressure.message}`
        : `Agentic RAG API ${status} for ${url}: ${detail.slice(0, 300)}`,
    )
    this.name = 'AragApiError'
    this.backpressure = backpressure
  }

  /** True when the caller should back off and retry rather than treat this as a hard failure. */
  get retryable(): boolean {
    return this.backpressure !== null
  }
}

export const regionalBase = (zone: string) => `https://${zone}.rag.progress.cloud/api/v1`

export class KbClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly binding: KbBinding,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    // Cloudflare's host-provided fetch validates its receiver. Calling a bare
    // reference later as `this.fetchImpl(...)` gives it the KbClient instance
    // as `this`, which Workers rejects with "Illegal invocation". Pin the
    // receiver at the integration boundary so every ARAG operation is safe.
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  private url(path: string) {
    return `${this.binding.baseUrl}${path}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-nuclia-serviceaccount': `Bearer ${this.binding.token}`,
      ...extra,
    }
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, { headers: this.headers() })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json()) as T
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown,
    extra?: Record<string, string>,
  ): Promise<T> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(extra),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json()) as T
  }

  /** POST raw bytes (file upload). Filename rides base64-encoded in X-FILENAME. */
  async postRaw(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ): Promise<unknown> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-filename': btoa(unescape(encodeURIComponent(filename))),
        'x-nuclia-serviceaccount': `Bearer ${this.binding.token}`,
      },
      body: bytes as BodyInit,
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return await res.json().catch(() => ({}))
  }

  async deleteJson(path: string): Promise<void> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, { method: 'DELETE', headers: this.headers() })
    if (!res.ok && res.status !== 404) throw new AragApiError(res.status, url, await res.text())
  }

  async patchJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json().catch(() => ({}))) as T
  }

  /** The data-plane host for this box (DA tasks live there). */
  private dpUrl(path: string) {
    return `${this.binding.baseUrl.replace('.rag.progress.cloud', '.dp.progress.cloud')}${path}`
  }

  async dpJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.dpUrl(path)
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json().catch(() => ({}))) as T
  }

  /** Stream a stored file field (PDF/video/audio) with range support. */
  async fileResponse(path: string, range?: string): Promise<Response> {
    const url = this.url(path)
    const headers: Record<string, string> = {
      'x-nuclia-serviceaccount': `Bearer ${this.binding.token}`,
    }
    if (range) headers.range = range
    const res = await this.fetchImpl(url, { headers })
    if (!res.ok && res.status !== 206) throw new AragApiError(res.status, url, await res.text())
    return res
  }

  /** POST returning the raw streaming response (NDJSON body). */
  async postStream(path: string, body: unknown, extra?: Record<string, string>): Promise<Response> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers({ accept: 'application/x-ndjson', ...extra }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return res
  }
}

/** Iterate the JSON objects of an NDJSON response body, tolerating partial chunks. */
export async function* ndjson(res: Response): AsyncGenerator<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          yield JSON.parse(line)
        } catch {
          // Partial or non-JSON line - skip rather than kill the stream.
        }
      }
      newline = buffer.indexOf('\n')
    }
  }
  const tail = buffer.trim()
  if (tail) {
    try {
      yield JSON.parse(tail)
    } catch {
      // ignore trailing partial line
    }
  }
}
