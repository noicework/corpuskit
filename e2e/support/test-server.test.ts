import { expect } from '@std/expect'
import { startTestServer, type TestServer } from './test-server.ts'

Deno.test('API-only fixture is hermetic without built assets and retains real signed RBAC', async () => {
  const dist = 'apps/web/dist'
  const saved = `apps/web/.dist-smoke-${crypto.randomUUID()}`
  let moved = false
  const servers: TestServer[] = []
  try {
    try {
      Deno.renameSync(dist, saved)
      moved = true
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
    const anonymous = startTestServer({
      apiOnly: true,
      emergencyFixture: {
        directory: '/missing-emergency-assets',
        state: {
          capability: 'session',
          status: 200,
          requests: 0,
          credentialRequests: 0,
          delayMs: 0,
        },
      },
    })
    servers.push(anonymous)
    const viewer = startTestServer({ apiOnly: true, identity: { role: 'viewer' } })
    servers.push(viewer)
    const analyst = startTestServer({ apiOnly: true, identity: { role: 'analyst' } })
    servers.push(analyst)
    for (const server of servers) {
      expect(Number(new URL(server.url).port)).toBeGreaterThanOrEqual(8791)
    }
    expect((await (await fetch(`${anonymous.url}/auth/me`)).json()).authenticated).toBe(false)
    const me = await (await fetch(`${analyst.url}/auth/me`)).json()
    expect(me.authenticated).toBe(true)
    expect(me.effectiveRoles.portalRoles).toContainEqual({ slug: 'marine', role: 'analyst' })
    for (const path of ['/api/t/marine/catalog', '/api/t/marine/search?q=abalone']) {
      const response = await fetch(anonymous.url + path)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('res-1')
    }
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const ask = await fetch(`${anonymous.url}/api/t/marine/ask`, json({ query: 'Abalone stocks?' }))
    expect(ask.status).toBe(200)
    const answer = await ask.text()
    expect(answer).toContain('Abalone populations')
    expect(answer).toContain('"resourceId":"res-1"')
    expect(answer).toContain('"type":"done"')
    for (const server of [anonymous, viewer]) {
      const before = server.providerCalls.length
      const denied = await fetch(
        `${server.url}/api/t/marine/investigations`,
        json({ name: 'Denied investigation' }),
      )
      expect(denied.status).toBe(server === viewer ? 403 : 401)
      await denied.text()
      expect(server.providerCalls.length).toBe(before)
    }
    expect(await (await fetch(`${viewer.url}/api/t/marine/investigations`)).json()).toEqual([])
    const created = await fetch(
      `${analyst.url}/api/t/marine/investigations`,
      json({ name: 'Authorised investigation' }),
    )
    expect(created.status).toBe(200)
    const investigation = await created.json()
    expect(investigation.name).toBe('Authorised investigation')
    const stored = await fetch(`${analyst.url}/api/t/marine/investigations/${investigation.id}`)
    expect(stored.status).toBe(200)
    expect((await stored.json()).name).toBe('Authorised investigation')
    const before = viewer.providerCalls.length
    const forged = await fetch(`${viewer.url}/api/admin/overview`, {
      headers: { 'x-corpuskit-principal': 'forged', 'x-corpuskit-sso-admin': '1' },
    })
    expect(forged.status).toBe(403)
    await forged.text()
    expect(viewer.providerCalls.length).toBe(before)
    for (
      const path of ['/', '/app.js', '/__test/emergency-access', '/__test/emergency-access.js']
    ) {
      const response = await fetch(anonymous.url + path)
      expect(response.status).toBe(404)
      await response.text()
    }
  } finally {
    try {
      const closed = await Promise.allSettled(servers.map((server) => server.close()))
      expect(closed.every((result) => result.status === 'fulfilled')).toBe(true)
      for (const server of servers) {
        await server.close()
        expect(() => Deno.statSync(server.directory)).toThrow()
      }
    } finally {
      if (moved) Deno.renameSync(saved, dist)
    }
  }
})
