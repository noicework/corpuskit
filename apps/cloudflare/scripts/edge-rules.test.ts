import { expect } from '@std/expect'
import { EDGE_RULES, mergeRules, probes, verify } from './edge-rules.ts'

Deno.test('edge rules block probes and odd ports while leaving router paths alone', () => {
  expect(new Set(EDGE_RULES.map((rule) => rule.description)).size).toBe(EDGE_RULES.length)
  for (const rule of EDGE_RULES) {
    expect(rule.action).toBe('block')
    expect(rule.enabled).toBe(true)
    expect(rule.expression.length).toBeLessThan(4000)
  }

  const probeRule = EDGE_RULES[0]!.expression
  expect(probeRule.startsWith('(not starts_with(http.request.uri.path, "/t/")) and (')).toBe(true)
  for (const segment of ['/.env', '/.git', '/wp-', '/xmlrpc', '/phpmyadmin', '/cgi-bin/']) {
    expect(probeRule).toContain(`(http.request.uri.path contains "${segment}")`)
  }
  for (const extension of ['.php', '.sql', '.zip', '.tar', '.gz', '.7z']) {
    expect(probeRule).toContain(`ends_with(lower(http.request.uri.path), "${extension}")`)
  }
  expect(probeRule).not.toContain('matches')

  expect(EDGE_RULES[1]!.expression).toBe('not (cf.edge.server_port in {80 443})')
})

Deno.test('mergeRules keeps foreign rules, replaces ours in place and appends the rest', () => {
  const existing = [
    {
      id: 'keep-1',
      description: 'Allow the office',
      expression: 'ip.src eq 203.0.113.9',
      action: 'skip',
    },
    {
      id: 'ours-1',
      description: EDGE_RULES[0]!.description,
      expression: 'stale',
      action: 'block',
      enabled: false,
    },
  ]
  const merged = mergeRules(existing, EDGE_RULES)

  expect(merged).toHaveLength(3)
  expect(merged[0]).toEqual(existing[0])
  expect(merged[1]).toEqual({ id: 'ours-1', ...EDGE_RULES[0] })
  expect(merged[2]).toEqual({ ...EDGE_RULES[1] })
  expect(existing[1]!.expression).toBe('stale')
})

Deno.test('verify reports each probe against its expected status and survives an unreachable port', async () => {
  const answers: Record<string, number> = {
    'https://example.org/.env': 403,
    'https://example.org/wp-admin/install.php': 403,
    'https://example.org/backup.ZIP': 403,
    'https://demo.example.org/transactional/.env': 403,
    'https://example.org/': 200,
    'https://example.org/app.js': 200,
    'https://example.org/api/health': 200,
    'https://example.org/robots.txt': 200,
    'https://example.org/t/grains/entity/.NET': 200,
  }
  const fetcher = ((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes(':8443')) return Promise.reject(new Error('connection refused'))
    return Promise.resolve(new Response('', { status: answers[url] ?? 500 }))
  }) as typeof fetch

  const results = await verify('example.org', fetcher)
  expect(results).toHaveLength(probes('example.org').length)
  const failures = results.filter(({ probe, status }) => status !== probe.expected)
  expect(failures.map(({ probe, status }) => [probe.url, status])).toEqual([
    ['https://example.org:8443/', 'unreachable'],
  ])
})
