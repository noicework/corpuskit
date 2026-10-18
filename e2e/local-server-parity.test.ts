import { expect } from '@std/expect'

const serverPath = new URL('../apps/api/src/server.ts', import.meta.url)
const port = Number(Deno.env.get('PARITY_E2E_PORT') ?? 8796)

function command(directory: string, entra: Record<string, string> = {}) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      `--allow-write=${directory}`,
      '--allow-net',
      serverPath.pathname,
    ],
    env: {
      HOST: '127.0.0.1',
      PORT: String(port),
      ENVIRONMENT: 'test',
      DATA_DIR: directory,
      TENANTS_PATH: `${directory}/tenants.json`,
      BINDINGS_PATH: `${directory}/bindings.json`,
      BRANDING_PATH: `${directory}/branding`,
      KG_PROPOSALS_PATH: `${directory}/kg.json`,
      RBAC_PATH: `${directory}/rbac.sqlite`,
      PLATFORM_DOMAIN: 'research.example.org',
      SHOWCASE_PORTALS: '',
      MAX_PORTAL_ALIASES: '0',
      ENTRA_TENANT_ID: '',
      ENTRA_CLIENT_ID: '',
      ENTRA_CLIENT_SECRET: '',
      ENTRA_REDIRECT_URI: '',
      EXTERNAL_LOGIN_ISSUER: '',
      EXTERNAL_LOGIN_JWK: '',
      OPERATOR_API_KEY: '',
      ...entra,
    },
    stdout: 'piped',
    stderr: 'piped',
  })
}

Deno.test('actual Deno server fails before listening when the Entra callback URI is missing or invalid', async () => {
  const directory = await Deno.makeTempDir()
  try {
    for (
      const uri of ['', '/auth/callback', 'not a URL', 'http://research.example/auth/callback']
    ) {
      const result = await command(directory, {
        ENTRA_TENANT_ID: 'fixture-directory',
        ENTRA_REDIRECT_URI: uri,
      }).output()
      expect(result.success, uri).toBe(false)
      expect(new TextDecoder().decode(result.stderr)).toContain(
        'requires ENTRA_REDIRECT_URI to be an absolute HTTPS URL',
      )
    }
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('actual Deno server keeps API operations separate from static handlers and serves shared edge rules', async () => {
  const directory = await Deno.makeTempDir()
  const child = command(directory).spawn()
  const output = child.output()
  let exited = false
  void output.then(() => {
    exited = true
  })
  try {
    // The real static registration (including IndexNow) participates. A synthetic Hono-only
    // harness would miss an unmarked wildcard being classified as a second API operation.
    const request = async (host: string, path: string, method = 'GET') => {
      // Use the wire Host header. Fetch can replace Host with the connection URL's hostname.
      const connection = await Deno.connect({ hostname: '127.0.0.1', port })
      try {
        const bytes = new TextEncoder().encode(
          `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        )
        for (let offset = 0; offset < bytes.length;) {
          offset += await connection.write(bytes.subarray(offset))
        }
        const buffer = new Uint8Array(8192)
        let text = ''
        while (!text.includes('\r\n\r\n')) {
          const count = await connection.read(buffer)
          if (count === null) throw new Error('Server closed before response headers')
          text += new TextDecoder().decode(buffer.subarray(0, count))
        }
        const lines = text.split('\r\n\r\n')[0]!.split('\r\n')
        const status = Number(lines.shift()!.split(' ')[1])
        const headers = new Headers()
        for (const line of lines) {
          const colon = line.indexOf(':')
          headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
        }
        return { status, headers }
      } finally {
        connection.close()
      }
    }
    let ready = false
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      try {
        await request('research.example.org', '/api/health')
        ready = true
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    expect(ready).toBe(true)
    expect(exited).toBe(false)
    const cases: [string, string, number, string | null, string?][] = [
      ['research.example.org', '/api/health', 200, null],
      ['research.example.org', '/admin', 200, 'no-store'],
      ['research.example.org', '/app.js', 200, 'public, max-age=300'],
      ['research.example.org', '/about', 200, 'no-store'],
      ['research.example.org', '/about.html', 200, 'no-store'],
      ['marine.research.example.org', '/about', 404, 'public, max-age=300'],
      ['research.example.org', '/docs', 200, 'no-store'],
      ['research.example.org', '/docs/', 200, 'no-store'],
      ['research.example.org', '/docs/hosting', 200, 'no-store'],
      ['marine.research.example.org', '/docs', 404, 'public, max-age=300'],
      ['marine.research.example.org', '/docs/', 404, 'public, max-age=300'],
      ['marine.research.example.org', '/docs/hosting', 404, 'public, max-age=300'],
      ['marine.research.example.org', '/docs/index.html', 404, 'public, max-age=300'],
      ['marine.research.example.org', '/docs/hosting.html', 404, 'public, max-age=300'],
      ['marine.research.example.org', '/?q=one', 308, null, '/t/marine?q=one'],
      [
        'www.research.example.org',
        '/about?q=two',
        308,
        null,
        'https://research.example.org/about?q=two',
      ],
      ['research.example.org', '/auth/login', 503, 'no-store'],
    ]
    for (const [host, path, status, cache, location] of cases) {
      const response = await request(host, path)
      expect([host, path, response.status]).toEqual([host, path, status])
      expect(response.headers.get('cache-control')).toBe(cache)
      if (location) expect(response.headers.get('location')).toBe(location)
      expect(response.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=(), payment=()',
      )
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('strict-transport-security')).toBe(
        'max-age=63072000; includeSubDomains',
      )
    }
    expect((await request('research.example.org', '/app.js', 'HEAD')).headers.get('cache-control'))
      .toBe('public, max-age=300')
    expect((await request('research.example.org', '/docs/', 'HEAD')).status).toBe(200)
    expect((await request('marine.research.example.org', '/docs/hosting', 'HEAD')).status).toBe(404)
    expect(exited).toBe(false)
  } finally {
    if (!exited) child.kill('SIGTERM')
    await output
    await Deno.remove(directory, { recursive: true })
  }
})
