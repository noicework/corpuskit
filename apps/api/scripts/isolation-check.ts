/**
 * OPERATOR SCRIPT. Never invoked by tests or maintenance. See docs/EVALUATIONS.md.
 * Requires --execute and an explicit configuration file. Writes one marker document to each
 * named test portal, checks positive controls and every other portal, then removes its markers.
 */
import { ISOLATION_QUERY, isolationProbes } from './lib/isolation-probes.ts'

interface PortalProbeConfig {
  slug: string
  /** A dedicated authorised test session, with content.write; keep this file outside the repo. */
  cookie: string
}
interface ProbeConfig {
  baseUrl: string
  portals: PortalProbeConfig[]
  /** Required once the agent-ask branch is deployed, for example /api/t/:slug/agent/ask. */
  agentAskPath?: string
}

async function main() {
  const configPath = Deno.args.find((arg) => arg.startsWith('--config='))?.slice('--config='.length)
  if (!Deno.args.includes('--execute') || !configPath) {
    throw new Error(
      'Explicit operation required: --execute --config=/path/outside/repo/isolation.json',
    )
  }
  const config = JSON.parse(await Deno.readTextFile(configPath)) as ProbeConfig
  const base = new URL(config.baseUrl)
  if (
    !['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
    !Array.isArray(config.portals) || config.portals.length < 2 ||
    new Set(config.portals.map((p) => p.slug)).size !== config.portals.length ||
    config.portals.some((p) => !/^[A-Za-z0-9_-]{1,64}$/.test(p.slug) || !p.cookie)
  ) {
    throw new Error('Configure one deployment and at least two distinct authorised test portals.')
  }
  const request = async (portal: PortalProbeConfig, path: string, init?: RequestInit) => {
    const url = new URL(path, base)
    if (url.origin !== base.origin) throw new Error('Cross-origin probe refused')
    const headers = new Headers(init?.headers)
    headers.set('cookie', portal.cookie)
    return await fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
    })
  }
  const planted: { portal: PortalProbeConfig; id: string; marker: string }[] = []
  try {
    for (const portal of config.portals) {
      const marker = `boundarytoken${crypto.randomUUID().replace(/[0-9-]/g, 'x')}`
      const response = await request(portal, `/api/admin/t/${portal.slug}/resources/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `Boundary note ${marker}`,
          body: `The boundary note records the validation token ${marker}.`,
        }),
      })
      if (!response.ok) {
        throw new Error(`Marker creation failed on ${portal.slug}: HTTP ${response.status}`)
      }
      const created = await response.json() as { id: string }
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(created.id)) throw new Error('Invalid created resource id')
      planted.push({ portal, id: created.id, marker })
    }
    // Positive retrieval must find each marker before negative checks can prove anything.
    for (const plantedDocument of planted) {
      let ready = false
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await request(
          plantedDocument.portal,
          `/api/t/${plantedDocument.portal.slug}/search?q=${encodeURIComponent(ISOLATION_QUERY)}`,
        )
        if (response.ok && (await response.text()).includes(plantedDocument.marker)) {
          ready = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
      if (!ready) throw new Error(`Positive control not indexed on ${plantedDocument.portal.slug}`)
    }
    for (const own of planted) {
      for (const probe of isolationProbes(own.portal.slug, own.id, config.agentAskPath)) {
        const response = await request(own.portal, probe.path, probe.init)
        const body = await response.text()
        if (!response.ok || !body.includes(own.marker)) {
          throw new Error(`Positive control failed: ${own.portal.slug} ${probe.name}`)
        }
        if (planted.some((other) => other !== own && body.includes(other.marker))) {
          throw new Error(`ISOLATION FAILURE: ${own.portal.slug} ${probe.name}`)
        }
      }
      for (const other of planted.filter((p) => p !== own)) {
        const response = await request(
          own.portal,
          `/api/t/${own.portal.slug}/resources/${other.id}`,
        )
        const body = await response.text()
        if (response.status !== 404 || body.includes(other.marker)) {
          throw new Error('Foreign document isolation failed')
        }
        const mcpProbe = isolationProbes(own.portal.slug, other.id).find((p) =>
          p.name === 'MCP document'
        )!
        const mcp = await request(own.portal, mcpProbe.path, mcpProbe.init)
        const mcpBody = await mcp.text()
        if (
          !mcp.ok || JSON.parse(mcpBody).result?.isError !== true || mcpBody.includes(other.marker)
        ) {
          throw new Error('Foreign MCP document isolation failed')
        }
      }
    }
    console.log(
      `Isolation checks passed for ${planted.length} portals${
        config.agentAskPath ? ', including agent ask' : '; agent ask was not configured'
      }.`,
    )
  } finally {
    for (const document of planted) {
      const response = await request(
        document.portal,
        `/api/admin/t/${document.portal.slug}/resources/${document.id}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        console.error(
          `Marker cleanup needs attention on ${document.portal.slug}: HTTP ${response.status}`,
        )
      }
      await response.body?.cancel()
    }
  }
}
if (import.meta.main) await main()
