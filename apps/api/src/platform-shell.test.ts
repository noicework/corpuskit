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

Deno.test('the shell names the alias host portal, and nothing on every other host', async () => {
  const both = `${shell}<meta name="corpuskit-host-portal" content="__CORPUSKIT_HOST_PORTAL__">` +
    '<p>__CORPUSKIT_HOST_PORTAL__ __CORPUSKIT_PLATFORM_DOMAIN__</p>'
  const bytes = new TextEncoder().encode(both)
  const chunked = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          // Every chunk size splits the markers somewhere.
          for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/html' } },
    )
  const expected = (portal: string) =>
    both.replaceAll('__CORPUSKIT_HOST_PORTAL__', portal).replaceAll(
      '__CORPUSKIT_PLATFORM_DOMAIN__',
      'research.example.org',
    )
  expect(await platformShellResponse(chunked(), 'research.example.org', 'marine').text())
    .toBe(expected('marine'))
  for (const portal of [undefined, '', '"><script>', 'a b', 'x'.repeat(65)]) {
    expect(await platformShellResponse(chunked(), 'research.example.org', portal).text(), portal)
      .toBe(expected(''))
  }
})

Deno.test('the shell names the host that served it, or the platform domain for anything else', async () => {
  const image =
    '<meta property="og:image" content="https://__CORPUSKIT_REQUEST_HOST__/og/corpuskit.png">'
  const bytes = new TextEncoder().encode(`<head>${image}</head>`)
  const chunked = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          // Every chunk size splits the marker somewhere.
          for (let at = 0; at < bytes.length; at += 5) controller.enqueue(bytes.slice(at, at + 5))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/html' } },
    )
  const expected = (host: string) =>
    `<head>${image.replace('__CORPUSKIT_REQUEST_HOST__', host)}</head>`
  for (
    const host of ['marine.research.example.org', 'research.partner.example', 'Portal.Example.org']
  ) {
    expect(await platformShellResponse(chunked(), 'research.example.org', undefined, host).text())
      .toBe(expected(host.toLowerCase()))
  }
  // Anything that is not a hostname cannot reach the page: the platform domain stands in.
  for (
    const host of [undefined, '', 'localhost', '127.0.0.1', '"><script>', 'a b.example', 'x..y']
  ) {
    expect(
      await platformShellResponse(chunked(), 'research.example.org', undefined, host).text(),
      host,
    )
      .toBe(expected('research.example.org'))
  }
})
