/**
 * The zone's WAF custom rules, kept in the repository so the edge policy is
 * reviewed and repeatable rather than clicked together in the dashboard.
 *
 *   deno run --allow-net --allow-env --allow-read apps/cloudflare/scripts/edge-rules.ts apply corpuskit.org
 *   deno run --allow-net apps/cloudflare/scripts/edge-rules.ts verify corpuskit.org
 *
 * `apply` upserts the rules below into the zone's custom-rules entry point by
 * description; any other rule in the zone is kept as it is. It reads
 * CLOUDFLARE_API_TOKEN (the repo-root .env is loaded), and that token needs
 * Zone: Read and Zone WAF: Edit on the zone. `verify` probes the live hosts
 * and fails if a probe still reaches the Worker or a page stops answering.
 *
 * Cloudflare evaluates these before the Worker is invoked, so a blocked probe
 * costs nothing. The Worker answers the same probes with a plain 404 on its
 * own (see apps/api/src/public-paths.ts), which is what hosts outside this
 * zone rely on. Everything under /t/ belongs to the web router and is exempt.
 */
import { loadRootEnv } from '../../api/src/load-env.ts'

export interface EdgeRule {
  description: string
  expression: string
  action: 'block'
  enabled: boolean
}

/** A rule as the Rulesets API returns it; `id` keeps a rule's identity across updates. */
export interface ZoneRule {
  id?: string
  description?: string
  expression?: string
  action?: string
  enabled?: boolean
  [key: string]: unknown
}

const PROBE_SEGMENTS = [
  '/.env',
  '/.git',
  '/.aws',
  '/.ssh',
  '/.DS_Store',
  '/wp-',
  '/xmlrpc',
  '/phpmyadmin',
  '/cgi-bin/',
]
const PROBE_EXTENSIONS = ['.php', '.sql', '.bak', '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z']

export const EDGE_RULES: EdgeRule[] = [
  {
    description: 'Block secret, script and archive probes',
    expression: `(not starts_with(http.request.uri.path, "/t/")) and (${
      [
        ...PROBE_SEGMENTS.map((segment) => `(http.request.uri.path contains "${segment}")`),
        ...PROBE_EXTENSIONS.map((extension) =>
          `ends_with(lower(http.request.uri.path), "${extension}")`
        ),
      ].join(' or ')
    })`,
    action: 'block',
    enabled: true,
  },
  {
    description: 'Block non-standard ports',
    expression: 'not (cf.edge.server_port in {80 443})',
    action: 'block',
    enabled: true,
  },
]

/** The zone's rules after the update: foreign rules untouched, ours replaced in place or appended. */
export function mergeRules(existing: ZoneRule[], desired: EdgeRule[]): ZoneRule[] {
  const pending = new Map(desired.map((rule) => [rule.description, rule]))
  const merged: ZoneRule[] = existing.map((rule) => {
    const replacement = rule.description ? pending.get(rule.description) : undefined
    if (!replacement) return rule
    pending.delete(replacement.description)
    return rule.id ? { id: rule.id, ...replacement } : { ...replacement }
  })
  for (const rule of pending.values()) merged.push({ ...rule })
  return merged
}

export interface Probe {
  url: string
  expected: number
  why: string
}

/** What the live zone must answer once the rules are in force. */
export function probes(zone: string): Probe[] {
  return [
    { url: `https://${zone}/.env`, expected: 403, why: 'dotfile probe blocked at the edge' },
    { url: `https://${zone}/wp-admin/install.php`, expected: 403, why: 'WordPress probe blocked' },
    { url: `https://${zone}/backup.ZIP`, expected: 403, why: 'archive probe blocked, any case' },
    { url: `https://demo.${zone}/transactional/.env`, expected: 403, why: 'tenant host covered' },
    { url: `https://${zone}:8443/`, expected: 403, why: 'non-standard port blocked' },
    { url: `https://${zone}/`, expected: 200, why: 'home page still served' },
    { url: `https://${zone}/app.js`, expected: 200, why: 'assets still served' },
    { url: `https://${zone}/api/health`, expected: 200, why: 'API still served' },
    { url: `https://${zone}/robots.txt`, expected: 200, why: 'robots.txt reaches the Worker' },
    { url: `https://${zone}/t/grains/entity/.NET`, expected: 200, why: 'router paths exempt' },
  ]
}

interface ApiEnvelope<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result?: T
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = (await response.json()) as ApiEnvelope<T>
  if (!body.success || body.result === undefined) {
    const detail = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')
    throw new Error(`Cloudflare API ${response.status} on ${path}: ${detail || 'no detail'}`)
  }
  return body.result
}

async function zoneId(token: string, zone: string): Promise<string> {
  const zones = await api<{ id: string; name: string }[]>(
    token,
    `/zones?name=${encodeURIComponent(zone)}`,
  )
  const match = zones.find((z) => z.name === zone)
  if (!match) throw new Error(`Zone ${zone} is not visible to this token`)
  return match.id
}

const ENTRYPOINT = '/rulesets/phases/http_request_firewall_custom/entrypoint'

async function currentRules(token: string, zone: string): Promise<ZoneRule[]> {
  try {
    const ruleset = await api<{ rules?: ZoneRule[] }>(token, `/zones/${zone}${ENTRYPOINT}`)
    return ruleset.rules ?? []
  } catch (error) {
    // A zone that has never had a custom rule has no entry point yet.
    if (error instanceof Error && /API 404/.test(error.message)) return []
    throw error
  }
}

export async function apply(zone: string): Promise<ZoneRule[]> {
  loadRootEnv()
  const token = Deno.env.get('CLOUDFLARE_API_TOKEN')
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required (Zone: Read, Zone WAF: Edit)')
  const id = await zoneId(token, zone)
  const rules = mergeRules(await currentRules(token, id), EDGE_RULES)
  const updated = await api<{ rules?: ZoneRule[] }>(token, `/zones/${id}${ENTRYPOINT}`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  })
  return updated.rules ?? []
}

export async function verify(
  zone: string,
  fetcher: typeof fetch = fetch,
): Promise<{ probe: Probe; status: number | 'unreachable' }[]> {
  return await Promise.all(
    probes(zone).map(async (probe) => {
      try {
        const response = await fetcher(probe.url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        })
        await response.body?.cancel()
        return { probe, status: response.status }
      } catch {
        return { probe, status: 'unreachable' as const }
      }
    }),
  )
}

if (import.meta.main) {
  const [command, zone] = Deno.args
  if (!zone || (command !== 'apply' && command !== 'verify')) {
    console.error('Usage: edge-rules.ts <apply|verify> <zone>')
    Deno.exit(2)
  }
  try {
    if (command === 'apply') {
      const rules = await apply(zone)
      console.log(`${zone}: ${rules.length} custom rule(s) in force`)
      for (const rule of rules) {
        console.log(
          `  ${rule.enabled ? 'on ' : 'off'} ${rule.action}  ${rule.description}  (${rule.id})`,
        )
      }
    } else {
      const results = await verify(zone)
      let failed = 0
      for (const { probe, status } of results) {
        const ok = status === probe.expected
        if (!ok) failed += 1
        console.log(
          `${
            ok ? 'PASS' : 'FAIL'
          } ${status} (expected ${probe.expected}) ${probe.url}  ${probe.why}`,
        )
      }
      if (failed > 0) throw new Error(`${failed} of ${results.length} edge probes failed`)
      console.log(`Edge rules verified on ${zone} (${results.length} probes).`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
  }
}
