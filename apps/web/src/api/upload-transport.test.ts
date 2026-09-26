import { expect } from '@std/expect'
import { type UploadXhr, wantsUploadProgress, xhrFetch } from './upload-transport.ts'
import { AuthorityController, registerAuthorityController } from './access-lifecycle.ts'
import { sessionFixture } from './auth.test.ts'
import { sessionAccess } from './break-glass.ts'
import { uploadAdminFile } from './client.ts'

/** The request a transport opened after `previous`, once it has been created. */
async function nextXhr(previous: FakeXhr | undefined): Promise<FakeXhr> {
  for (let turn = 0; turn < 50 && FakeXhr.last === previous; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!FakeXhr.last || FakeXhr.last === previous) throw new Error('No request was opened')
  return FakeXhr.last
}

/** A scripted XMLHttpRequest: records the request and answers when told to. */
class FakeXhr implements UploadXhr {
  static last: FakeXhr | undefined
  method = ''
  url = ''
  headers = new Map<string, string>()
  body: unknown = undefined
  aborted = false
  status = 0
  statusText = ''
  response: unknown = null
  responseType: XMLHttpRequestResponseType = ''
  rawHeaders = ''
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  onload: ((event: ProgressEvent) => void) | null = null
  onerror: ((event: ProgressEvent) => void) | null = null
  ontimeout: ((event: ProgressEvent) => void) | null = null
  onabort: ((event: ProgressEvent) => void) | null = null
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }
  send(body: XMLHttpRequestBodyInit | null) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.(new ProgressEvent('abort'))
  }
  getAllResponseHeaders() {
    return this.rawHeaders
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.(
      new ProgressEvent('progress', { loaded, total, lengthComputable: true }),
    )
  }
  answer(status: number, body: string | null, headers = 'content-type: application/json\r\n') {
    this.status = status
    this.statusText = status === 200 ? 'OK' : ''
    this.response = body === null ? null : new Blob([body])
    this.rawHeaders = headers
    this.onload?.(new ProgressEvent('load'))
  }
}

Deno.test('the XMLHttpRequest transport sends the request, reports progress and answers a Response', async () => {
  const seen: [number, number | undefined][] = []
  const file = new File(['abcdef'], 'a.pdf', { type: 'application/pdf' })
  const pending = xhrFetch('/api/admin/t/marine/resources/upload', {
    method: 'post',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'a.pdf' },
    body: file,
    onUploadProgress: (loaded, total) => seen.push([loaded, total]),
  }, () => new FakeXhr())
  const xhr = FakeXhr.last!
  expect([xhr.method, xhr.url, xhr.body]).toEqual([
    'POST',
    '/api/admin/t/marine/resources/upload',
    file,
  ])
  expect(Object.fromEntries(xhr.headers)).toEqual({
    'content-type': 'application/pdf',
    'x-filename': 'a.pdf',
  })
  xhr.progress(3, 6)
  xhr.progress(6, 6)
  xhr.answer(200, '{"id":"res-1"}', 'content-type: application/json\r\nx-request-id: r1\r\n')
  const response = await pending
  expect(seen).toEqual([[3, 6], [6, 6]])
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBe('r1')
  expect(await response.json()).toEqual({ id: 'res-1' })
  // A bodiless status still answers, with no body.
  const empty = xhrFetch('/x', {}, () => new FakeXhr())
  FakeXhr.last!.answer(204, 'ignored')
  expect((await empty).body).toBe(null)
})

Deno.test('the XMLHttpRequest transport honours abort signals and reports network failure', async () => {
  const before = new AbortController()
  before.abort()
  let created = 0
  await expect(xhrFetch('/x', { signal: before.signal }, () => {
    created++
    return new FakeXhr()
  })).rejects.toThrow()
  expect(created).toBe(0)
  const during = new AbortController()
  const aborting = xhrFetch('/x', { signal: during.signal }, () => new FakeXhr())
  const xhr = FakeXhr.last!
  during.abort()
  await expect(aborting).rejects.toThrow()
  expect(xhr.aborted).toBe(true)
  const failing = xhrFetch('/x', {}, () => new FakeXhr())
  FakeXhr.last!.onerror?.(new ProgressEvent('error'))
  await expect(failing).rejects.toBeInstanceOf(TypeError)
})

Deno.test('only a progress request travels over XMLHttpRequest, and never one that refuses redirects', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  try {
    Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
    expect(wantsUploadProgress({ onUploadProgress: () => {} })).toBe(false)
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXhr })
    expect(wantsUploadProgress({})).toBe(false)
    expect(wantsUploadProgress({ onUploadProgress: () => {} })).toBe(true)
    expect(wantsUploadProgress({ onUploadProgress: () => {}, redirect: 'error' })).toBe(false)
  } finally {
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original)
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
  }
})

Deno.test('an upload with progress keeps every authority check: denial still withdraws access', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  const originalFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = () => {
    fetched++
    return Promise.reject(new Error('fetch must not carry a progress upload'))
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXhr })
  try {
    const authority = new AuthorityController(() => 'browser')
    authority.setSession(sessionFixture(), 'marine')
    const unregister = registerAuthorityController(authority)
    try {
      const progress: number[] = []
      const file = new File(['abc'], 'a.pdf', { type: 'application/pdf' })
      FakeXhr.last = undefined
      const ok = uploadAdminFile(
        'marine',
        sessionAccess,
        file,
        {},
        (loaded) => progress.push(loaded),
      )
      const first = await nextXhr(undefined)
      first.progress(3, 3)
      first.answer(200, '{"id":"res-9"}')
      expect(await ok).toEqual({ id: 'res-9' })
      expect(progress).toEqual([3])
      expect(authority.status).toBe('ready')
      const denied = uploadAdminFile('marine', sessionAccess, file, {}, () => {})
      ;(await nextXhr(first)).answer(401, '{}')
      await expect(denied).rejects.toThrow()
      expect(authority.status).toBe('unavailable')
      expect(fetched).toBe(0)
    } finally {
      unregister()
    }
  } finally {
    globalThis.fetch = originalFetch
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original)
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
  }
})
