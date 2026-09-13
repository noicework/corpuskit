import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'

// A deployment with no Entra configuration (the documentation demo Worker has no
// ENTRA_TENANT_ID and no SESSION_SECRET) must still serve its public portal to
// anonymous callers, while everything that needs identity stays fail-closed.
Deno.test('a sign-in-less deployment serves public portals anonymously and denies the rest', async () => {
  const f = createEnforcementFixture({ identityConfigured: false })
  const rpc = (method: string, params?: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  try {
    const search = await f.requestAs(null, '/api/t/public-a/search?q=Abalone')
    expect(search.status).toBe(200)
    await search.body?.cancel()

    const catalogue = await f.requestAs(null, '/api/t/public-a/catalog?pageSize=1')
    expect(catalogue.status).toBe(200)
    await catalogue.body?.cancel()

    const tools = await f.requestAs(null, '/api/t/public-a/mcp', rpc('tools/list'))
    expect(tools.status).toBe(200)
    await tools.body?.cancel()

    const authenticated = await f.requestAs(null, '/api/t/authenticated-a/search?q=Abalone')
    expect(authenticated.status).toBe(401)
    await authenticated.body?.cancel()

    const restricted = await f.requestAs(null, '/api/t/a/catalog?pageSize=1')
    expect(restricted.status).toBe(401)
    await restricted.body?.cancel()

    const metadata = await f.requestAs(null, '/api/t/a/config')
    expect(metadata.status).toBe(200)
    const body = await metadata.json()
    expect(Object.keys(body).sort()).toEqual(['accessMode', 'branding', 'slug'])

    const admin = await f.requestAs(null, '/api/admin/overview')
    expect(admin.status).toBe(401)
    await admin.body?.cancel()
  } finally {
    await f.close()
  }
})
