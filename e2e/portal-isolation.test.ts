import { expect } from '@std/expect'
import { DECLARATIONS } from '../apps/api/src/permissions.ts'
import { isolationProbes } from '../apps/api/scripts/lib/isolation-probes.ts'
import { startTestServer } from './support/test-server.ts'
import { PortalMarkerProvider } from './support/portal-marker-provider.ts'

const agentRoute = DECLARATIONS.find((d) =>
  d.kind === 'http' && d.method === 'POST' &&
  /\/agent[^/]*\/ask$/.test(d.path)
)?.path

Deno.test('planted portal markers stay isolated across search, ask, catalogue, document, MCP and estate ask', async () => {
  const provider = new PortalMarkerProvider()
  const portals = ['marine', 'grains']
  const planted = new Map(portals.map((slug) => [slug, provider.plant(slug)]))
  const server = startTestServer({ apiOnly: true, provider, identity: { role: 'owner' } })
  try {
    for (const slug of portals) {
      const own = planted.get(slug)!
      const foreign = portals.filter((other) => other !== slug).map((other) => planted.get(other)!)
      for (const probe of isolationProbes(slug, own.resource.id, agentRoute)) {
        const response = await fetch(`${server.url}${probe.path}`, probe.init)
        const body = await response.text()
        expect(response.status, `${slug} ${probe.name}: ${body}`).toBe(200)
        expect(body, `${slug} ${probe.name} positive control`).toContain(own.marker)
        for (const other of foreign) {
          expect(body, `${slug} ${probe.name} foreign marker`).not.toContain(other.marker)
        }
      }
      for (const other of foreign) {
        const document = await fetch(`${server.url}/api/t/${slug}/resources/${other.resource.id}`)
        expect(document.status).toBe(404)
        expect(await document.text()).not.toContain(other.marker)
        const probe = isolationProbes(slug, other.resource.id).find((p) =>
          p.name === 'MCP document'
        )!
        const mcp = await fetch(`${server.url}${probe.path}`, probe.init)
        const body = await mcp.text()
        expect(mcp.status).toBe(200)
        expect(JSON.parse(body).result.isError).toBe(true)
        expect(body).not.toContain(other.marker)
      }
    }
  } finally {
    await server.close()
  }
})

Deno.test({
  name: 'agent ask marker isolation after the agent route is integrated',
  ignore: !agentRoute,
  fn: async () => {
    const provider = new PortalMarkerProvider()
    const secret = provider.plant('marine')
    const own = provider.plant('grains')
    const server = startTestServer({ apiOnly: true, provider, identity: { role: 'owner' } })
    try {
      const probe = isolationProbes('grains', own.resource.id, agentRoute).find((p) =>
        p.name === 'agent ask'
      )!
      const response = await fetch(`${server.url}${probe.path}`, probe.init)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain(own.marker)
      expect(body).not.toContain(secret.marker)
    } finally {
      await server.close()
    }
  },
})
