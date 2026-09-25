import { expect } from '@std/expect'
import { platformShellResponse } from './platform-shell.ts'

const shell =
  '<head><meta name="corpuskit-platform-domain" content="__CORPUSKIT_PLATFORM_DOMAIN__"></head>'

Deno.test('HTML runtime configuration handles every marker and UTF-8 chunk boundary', async () => {
  const bytes = new TextEncoder().encode(`<!doctype html>${shell}<p>研究</p>`)
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    }),
    {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(bytes.byteLength),
        etag: 'old-body',
        'content-md5': 'old-body',
        'x-frame-options': 'DENY',
      },
    },
  )
  const configured = platformShellResponse(response, 'research.example.org')
  expect(await configured.text()).toBe(
    `<!doctype html>${
      shell.replace('__CORPUSKIT_PLATFORM_DOMAIN__', 'research.example.org')
    }<p>研究</p>`,
  )
  expect(configured.status).toBe(404)
  expect(configured.headers.get('x-frame-options')).toBe('DENY')
  expect(configured.headers.get('cache-control')).toBe('no-store')
  for (const name of ['content-length', 'etag', 'content-md5']) {
    expect(configured.headers.get(name)).toBeNull()
  }
})

Deno.test('runtime shell configuration uses the given domain and preserves other bodies', async () => {
  expect(
    await platformShellResponse(
      new Response(shell, { headers: { 'content-type': 'text/html' } }),
      'corpuskit.org',
    ).text(),
  ).toContain('content="corpuskit.org"')
  for (const response of [new Response('raw'), new Response(null, { status: 204 })]) {
    expect(platformShellResponse(response, 'research.example.org')).toBe(response)
  }
  const noMarker = new Response('<head></head>', { headers: { 'content-type': 'text/html' } })
  expect(await platformShellResponse(noMarker, 'research.example.org').text()).toBe('<head></head>')
})

Deno.test('shell configuration rejects injection before emitting HTML', () => {
  expect(() => platformShellResponse(new Response(shell), '"><script>alert(1)</script>'))
    .toThrow('Invalid PLATFORM_DOMAIN')
})
