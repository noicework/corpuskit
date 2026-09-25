import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import { STORED_FILE_POLICY } from './app.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'

// A logo that runs script when a browser opens it as a document.
const SCRIPTED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/admin/people")</script></svg>'
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/** Opening a stored file directly must never run script on a portal host. */
function expectSandboxedDownload(response: Response): void {
  expect(response.headers.get('content-security-policy')).toBe(STORED_FILE_POLICY)
  expect(response.headers.get('content-disposition')).toBe('attachment')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
}

Deno.test('branding uploads refuse SVG, which can carry script, and keep raster images', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin', 'public-a')
    const svg = await f.requestAs(admin, '/api/admin/t/public-a/branding/logo', {
      method: 'POST',
      headers: { 'content-type': 'image/svg+xml' },
      body: SCRIPTED_SVG,
    })
    expect(svg.status).toBe(415)
    expect(await svg.json()).toEqual({
      error: 'unsupported_type',
      message: 'Use PNG, JPEG or WebP.',
    })
    expect(f.stores.branding.get('public-a', 'logo')).toBeNull()

    const png = await f.requestAs(admin, '/api/admin/t/public-a/branding/logo', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG,
    })
    expect(png.status).toBe(200)
    expect(f.stores.branding.get('public-a', 'logo')?.contentType).toBe('image/png')
  } finally {
    f.close()
  }
})

Deno.test('stored branding is served sandboxed as a download to any reader', async () => {
  const f = createEnforcementFixture()
  try {
    // An SVG stored before uploads refused them is still served, but can no longer run.
    f.stores.branding.put('public-a', 'logo', {
      bytes: new TextEncoder().encode(SCRIPTED_SVG),
      contentType: 'image/svg+xml',
      version: 'v1',
    })
    f.stores.branding.put('public-a', 'font-body', {
      bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
      contentType: 'font/woff2',
      version: 'v1',
    })
    for (const kind of ['logo', 'font-body']) {
      const response = await f.requestAs(null, `/api/t/public-a/branding/${kind}`)
      expect(response.status).toBe(200)
      expectSandboxedDownload(response)
      await response.body?.cancel()
    }
    const logo = await f.requestAs(null, '/api/t/public-a/branding/logo')
    expect(logo.headers.get('content-type')).toBe('image/svg+xml')
    expect(await logo.text()).toBe(SCRIPTED_SVG)
  } finally {
    f.close()
  }
})

Deno.test('knowledge box files are sandboxed, and only PDFs and passive media open in place', async () => {
  let contentType = ''
  const management = {
    resourceContent: () =>
      Promise.resolve({ id: 'res-1', files: [{ group: 'files', fieldId: 'original' }] }),
    fileStream: () =>
      Promise.resolve(new Response('stored bytes', { headers: { 'content-type': contentType } })),
    thumbnailResponse: () =>
      Promise.resolve(
        new Response(SCRIPTED_SVG, { headers: { 'content-type': 'image/svg+xml' } }),
      ),
  } as unknown as AragProvider
  const f = createEnforcementFixture({ management })
  try {
    const cases: [string, string, string | null][] = [
      ['text/html; charset=utf-8', 'attachment', STORED_FILE_POLICY],
      ['image/svg+xml', 'attachment', STORED_FILE_POLICY],
      ['application/xhtml+xml', 'attachment', STORED_FILE_POLICY],
      ['', 'attachment', STORED_FILE_POLICY],
      ['image/png', 'inline', STORED_FILE_POLICY],
      ['video/mp4', 'inline', STORED_FILE_POLICY],
      // The browser's PDF viewer does not run in a sandboxed document.
      ['application/pdf', 'inline', "frame-ancestors 'none'"],
    ]
    for (const [type, disposition, policy] of cases) {
      contentType = type
      const response = await f.requestAs(null, '/api/t/public-a/resources/res-1/file/original')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toBe(disposition)
      expect(response.headers.get('content-security-policy')).toBe(policy)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      await response.body?.cancel()
    }
    const thumbnail = await f.requestAs(null, '/api/t/public-a/resources/res-1/thumbnail')
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.headers.get('content-security-policy')).toBe(STORED_FILE_POLICY)
    expect(thumbnail.headers.get('x-content-type-options')).toBe('nosniff')
    await thumbnail.body?.cancel()
  } finally {
    f.close()
  }
})

Deno.test('a knowledge box file opens in place only as exactly the one type that was checked', async () => {
  let upstream = new Headers()
  const management = {
    resourceContent: () =>
      Promise.resolve({ id: 'res-1', files: [{ group: 'files', fieldId: 'original' }] }),
    fileStream: () => Promise.resolve(new Response('stored bytes', { headers: upstream })),
  } as unknown as AragProvider
  const f = createEnforcementFixture({ management })
  const serve = async (...values: string[]) => {
    upstream = new Headers()
    for (const value of values) upstream.append('content-type', value)
    const response = await f.requestAs(null, '/api/t/public-a/resources/res-1/file/original')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await response.body?.cancel()
    return response.headers
  }
  try {
    // A browser splits the header on commas and uses the last type it can parse, so each of
    // these would render as HTML on a host that shares the session cookie if served in place.
    for (
      const values of [
        ['application/pdf;x=1, text/html'],
        ['application/pdf, text/html'],
        ['application/pdf;x="a,b"'],
        ['image/png, text/html'],
        ['video/mp4, text/html; charset=utf-8'],
        ['audio/mpeg;codecs="mp3,html"'],
        // Two upstream headers arrive as one comma-joined value.
        ['application/pdf', 'text/html'],
        ['image/png', 'image/svg+xml'],
      ]
    ) {
      const headers = await serve(...values)
      expect(headers.get('content-disposition')).toBe('attachment')
      expect(headers.get('content-security-policy')).toBe(STORED_FILE_POLICY)
    }

    // A value that is not a media type at all is never PDF or passive media.
    for (const value of ['application/pdf/x', 'application/', '/pdf', 'pdf', 'image/png x']) {
      const headers = await serve(value)
      expect(headers.get('content-disposition')).toBe('attachment')
      expect(headers.get('content-security-policy')).toBe(STORED_FILE_POLICY)
    }

    // One valid type is served as exactly that type, without the upstream parameters.
    const inline: [string, string, string][] = [
      ['application/pdf;x=1', 'application/pdf', "frame-ancestors 'none'"],
      ['Application/PDF; name="report.pdf"', 'application/pdf', "frame-ancestors 'none'"],
      ['image/PNG; x=1', 'image/png', STORED_FILE_POLICY],
      ['image/webp', 'image/webp', STORED_FILE_POLICY],
      ['audio/mpeg; codecs=mp3', 'audio/mpeg', STORED_FILE_POLICY],
      ['video/mp4;codecs=avc1', 'video/mp4', STORED_FILE_POLICY],
    ]
    for (const [value, type, policy] of inline) {
      const headers = await serve(value)
      expect(headers.get('content-type')).toBe(type)
      expect(headers.get('content-disposition')).toBe('inline')
      expect(headers.get('content-security-policy')).toBe(policy)
    }
  } finally {
    f.close()
  }
})
