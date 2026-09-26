/** Called as a request body is sent: bytes sent so far and, when known, the total. */
export type UploadProgress = (loaded: number, total: number | undefined) => void

/** A request that reports how much of its body has been sent. */
export interface ProgressRequestInit extends RequestInit {
  onUploadProgress?: UploadProgress
}

/** The parts of XMLHttpRequest the transport uses, so tests can supply their own. */
export interface UploadXhr {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: XMLHttpRequestBodyInit | null): void
  abort(): void
  getAllResponseHeaders(): string
  readonly status: number
  readonly statusText: string
  readonly response: unknown
  responseType: XMLHttpRequestResponseType
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null }
  onload: ((event: ProgressEvent) => void) | null
  onerror: ((event: ProgressEvent) => void) | null
  ontimeout: ((event: ProgressEvent) => void) | null
  onabort: ((event: ProgressEvent) => void) | null
}

/**
 * Whether a request travels over XMLHttpRequest, the one browser transport that reports upload
 * progress everywhere. Only a request that asks for progress does, and never one that must not
 * follow a redirect: XMLHttpRequest always follows them.
 */
export function wantsUploadProgress(init?: ProgressRequestInit): boolean {
  return typeof init?.onUploadProgress === 'function' && init.redirect !== 'error' &&
    typeof XMLHttpRequest !== 'undefined'
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function responseHeaders(raw: string): Headers {
  const headers = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim())
    } catch {
      // A header the Headers class refuses is not one any caller reads.
    }
  }
  return headers
}

/**
 * `fetch` over XMLHttpRequest, for a same-origin request whose body progress the page shows. It
 * honours the method, headers, body and abort signal, and answers with an ordinary Response, so
 * every check a caller makes on a fetched response applies unchanged.
 */
export function xhrFetch(
  input: string,
  init: ProgressRequestInit = {},
  create: () => UploadXhr = () => new XMLHttpRequest(),
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init.signal ?? undefined
    const aborted = () =>
      signal?.reason ?? new DOMException('The request was aborted.', 'AbortError')
    if (signal?.aborted) {
      reject(aborted())
      return
    }
    const xhr = create()
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const settle = () => signal?.removeEventListener('abort', abort)
    xhr.open((init.method ?? 'GET').toUpperCase(), input)
    xhr.responseType = 'blob'
    new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value))
    const progress = init.onUploadProgress
    if (progress) {
      xhr.upload.onprogress = (event) =>
        progress(event.loaded, event.lengthComputable ? event.total : undefined)
    }
    xhr.onload = () => {
      settle()
      try {
        const status = xhr.status
        resolve(
          new Response(NULL_BODY_STATUSES.has(status) ? null : xhr.response as Blob | null, {
            status,
            statusText: xhr.statusText,
            headers: responseHeaders(xhr.getAllResponseHeaders()),
          }),
        )
      } catch (error) {
        reject(error)
      }
    }
    xhr.onerror = () => {
      settle()
      reject(new TypeError('The request could not be sent.'))
    }
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => {
      settle()
      reject(aborted())
    }
    xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null)
  })
}
