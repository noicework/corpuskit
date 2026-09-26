import { expect } from '@std/expect'
import {
  aliasCacheSeconds,
  aliasesFor,
  aliasHostname,
  aliasHostRoute,
  aliasStartupWarnings,
  applyAlias,
  classifyHost,
  HostPortalCache,
  hostPortalFor,
  maxPortalAliases,
  narrowRolesToPortal,
  reservedHostnames,
  storedAliases,
  transportSecurityFor,
  unknownHostsMode,
  withoutAlias,
  withPrimaryAlias,
} from './portal-aliases.ts'
import { TenantStore } from './tenants.ts'

Deno.test('alias hostnames are trimmed, lower-cased and lose one trailing dot', () => {
  for (
    const [input, expected] of [
      ['research.example.org', 'research.example.org'],
      ['  Research.Example.ORG. ', 'research.example.org'],
      ['a.b', 'a.b'],
      ['x1-y2.example.co.uk', 'x1-y2.example.co.uk'],
      // Lookalikes of the platform domain are ordinary DNS names outside it.
      ['corpuskit.org.evil.test', 'corpuskit.org.evil.test'],
      ['notcorpuskit.org', 'notcorpuskit.org'],
      [`${'a'.repeat(63)}.example.org`, `${'a'.repeat(63)}.example.org`],
    ] as const
  ) {
    expect(aliasHostname(input, 'corpuskit.org'), input).toBe(expected)
  }
})

Deno.test('alias hostnames refuse IP literals, ports, wildcards, encodings and platform names', () => {
  const long = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')
  for (
    const input of [
      '',
      ' ',
      '.',
      'localhost',
      'example',
      'example.org..',
      '.example.org',
      'a..b.org',
      '-a.example.org',
      'a-.example.org',
      'a_b.example.org',
      'exa mple.org',
      `${'a'.repeat(64)}.example.org`,
      long,
      // IP literals in every spelling, and any numeric last label.
      '192.0.2.1',
      '192.0.2.1.',
      '0x7f.1',
      'example.123',
      // Hexadecimal last labels, which a URL parser also reads as IPv4.
      '1.0x1',
      '10.0.0.0x1',
      '0x7f.0x1',
      '127.0.0.0x',
      'example.0X1F',
      '[::1]',
      '::1',
      '2001:db8::1',
      // Ports, paths, credentials and wildcards.
      'example.org:8443',
      'example.org/path',
      'user@example.org',
      '*.example.org',
      'example.*',
      'example%2eorg',
      // Unicode and punycode are refused rather than decoded.
      'bücher.example',
      'xn--bcher-kva.example',
      'shop.xn--p1ai',
      'ab--cd.example.org',
      // The platform domain and everything under it, in any case or spelling.
      'corpuskit.org',
      'CorpusKit.ORG.',
      'marine.corpuskit.org',
      'a.b.corpuskit.org',
      // The deployment's direct Worker host.
      'workers.dev',
      'corpuskit.account.workers.dev',
    ]
  ) {
    expect(aliasHostname(input, 'corpuskit.org'), input).toBeNull()
  }
  for (const input of [undefined, null, 42, {}, ['example.org']]) {
    expect(aliasHostname(input, 'corpuskit.org')).toBeNull()
  }
  // A configured platform domain replaces the default one.
  expect(aliasHostname('portal.research.example', 'research.example')).toBeNull()
  expect(aliasHostname('research.example', 'research.example')).toBeNull()
  expect(aliasHostname('corpuskit.org', 'research.example')).toBe('corpuskit.org')
})

Deno.test('alias limits and cache lifetimes accept whole numbers within bounds', () => {
  expect(maxPortalAliases(undefined)).toBe(5)
  expect(maxPortalAliases('0')).toBe(0)
  expect(maxPortalAliases(' 12 ')).toBe(12)
  expect(maxPortalAliases('100')).toBe(100)
  for (const value of ['', '-1', '1.5', 'five', '101', '1e2', '0x10']) {
    expect(maxPortalAliases(value), value).toBe(5)
  }
  expect(aliasCacheSeconds(undefined)).toBe(30)
  expect(aliasCacheSeconds('0')).toBe(0)
  expect(aliasCacheSeconds('300')).toBe(300)
  for (const value of ['', '-5', '2.5', '301', 'never']) {
    expect(aliasCacheSeconds(value), value).toBe(30)
  }
})

Deno.test('alias edits keep one primary, stay idempotent and refuse taken names and excess', () => {
  const base = {
    limit: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    claimed: (hostname: string) => hostname === 'own.example.org',
  }
  let result = applyAlias([], { ...base, slug: 'a', hostname: 'one.example.org' })
  if (!result.ok) throw new Error('expected a registration')
  let aliases = result.aliases
  expect(aliasesFor(aliases, 'a')).toEqual([
    { hostname: 'one.example.org', primary: false, createdAt: base.createdAt },
  ])
  result = applyAlias(aliases, {
    ...base,
    slug: 'a',
    hostname: 'two.example.org',
    primary: true,
    createdAt: '2026-01-02T00:00:00.000Z',
  })
  if (!result.ok) throw new Error('expected a registration')
  aliases = result.aliases
  // Promoting the first clears the second: one primary at a time.
  result = applyAlias(aliases, {
    ...base,
    slug: 'a',
    hostname: 'one.example.org',
    primary: true,
    createdAt: '2026-02-01T00:00:00.000Z',
  })
  if (!result.ok) throw new Error('expected an update')
  aliases = result.aliases
  expect(aliasesFor(aliases, 'a')).toEqual([
    { hostname: 'one.example.org', primary: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { hostname: 'two.example.org', primary: false, createdAt: '2026-01-02T00:00:00.000Z' },
  ])
  // Without `primary` the existing alias is unchanged; an update never meets the limit.
  result = applyAlias(aliases, { ...base, slug: 'a', hostname: 'one.example.org' })
  expect(result.ok && aliasesFor(result.aliases, 'a')).toEqual(aliasesFor(aliases, 'a'))
  expect(applyAlias(aliases, { ...base, slug: 'a', hostname: 'three.example.org' }))
    .toEqual({ ok: false, error: 'alias_limit' })
  expect(applyAlias(aliases, { ...base, slug: 'b', hostname: 'one.example.org' }))
    .toEqual({ ok: false, error: 'hostname_taken' })
  expect(applyAlias(aliases, { ...base, slug: 'b', hostname: 'own.example.org' }))
    .toEqual({ ok: false, error: 'hostname_taken' })
  result = applyAlias(aliases, { ...base, slug: 'a', hostname: 'one.example.org', primary: false })
  expect(result.ok && result.aliases.some((alias) => alias.primary)).toBe(false)
  // Removal is scoped to the portal that asks.
  expect(withoutAlias(aliases, 'b', 'one.example.org')).toEqual(aliases)
  expect(aliasesFor(withoutAlias(aliases, 'a', 'one.example.org'), 'a').map((a) => a.hostname))
    .toEqual(['two.example.org'])
  const config = new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/t.json` }).get(
    'marine',
  )!
  expect(withPrimaryAlias({ ...config, slug: 'a' }, aliases).hostname).toBe('one.example.org')
  expect(withPrimaryAlias(config, aliases).hostname).toBe(config.hostname)
})

Deno.test('stored aliases fail closed on any malformed record', () => {
  expect(storedAliases(undefined)).toEqual([])
  const valid = { hostname: 'a.example.org', slug: 'a', primary: false, createdAt: 'x' }
  expect(storedAliases([valid])).toEqual([valid])
  for (
    const value of [
      {},
      'a.example.org',
      [null],
      [{ ...valid, hostname: 'A.example.org' }],
      [{ ...valid, hostname: 'example' }],
      [{ ...valid, slug: '' }],
      [{ ...valid, primary: 'yes' }],
      [{ ...valid, createdAt: 1 }],
      [valid, { ...valid, slug: 'b' }],
    ]
  ) {
    expect(() => storedAliases(value), JSON.stringify(value)).toThrow(
      'Invalid persisted portal configuration',
    )
  }
})

Deno.test('an alias host routes to its portal only', () => {
  const route = (path: string, method = 'GET') =>
    aliasHostRoute(method, new URL(`https://research.example.org${path}`), 'marine')
  expect(route('/?from=card')).toEqual({ kind: 'redirect', location: '/t/marine?from=card' })
  expect(route('/', 'HEAD')).toEqual({ kind: 'redirect', location: '/t/marine' })
  // A write to the root is left to the page route, which refuses it.
  expect(route('/', 'POST')).toEqual({ kind: 'page' })
  for (
    const path of ['/t/marine', '/t/marine/', '/T/marine/library', '/app.js', '/og/x.png']
  ) {
    expect(route(path), path).toEqual({ kind: 'page' })
  }
  for (const path of ['/auth/me', '/auth/external', '/auth/logout', '/auth/login']) {
    expect(route(path), path).toEqual({ kind: 'auth' })
  }
  for (
    const path of [
      '/api/health',
      '/api/tenants',
      '/api/t/marine',
      '/api/t/marine/config',
      '/api/t/marine/mcp',
      '/api/admin/t/marine/members',
      '/api/admin/tenants/marine',
    ]
  ) {
    expect(route(path), path).toEqual({ kind: 'api' })
  }
  for (
    const path of [
      '/api',
      '/api/t/grains/config',
      '/api/t/marine-2/config',
      '/api/t/marinex',
      '/api/t/%6darine/config',
      '/api/admin/t/grains/members',
      '/api/admin/t/marine',
      '/api/admin/tenants',
      '/api/admin/tenants/grains',
      '/api/admin/tenants/marine/extra',
      '/api/admin/overview',
      '/api/admin/people',
      '/api/admin/migrate',
      '/api/ask-estate',
    ]
  ) {
    expect(route(path), path).toEqual({ kind: 'not_found', api: true })
  }
  for (
    const path of [
      '/t/grains',
      '/T/grains',
      '/t/Marine',
      '/t/grains/library',
      '/t/',
      '/t/marine-2',
      '/t/%6darine',
      '/admin',
      '/Admin',
      '/ADMIN/people',
      '/admin/people',
      '/about',
      '/about.html',
      '/docs',
      '/docs/getting-started',
      '/home',
      '/home.html',
    ]
  ) {
    expect(route(path), path).toEqual({ kind: 'not_found', api: false })
  }
})

Deno.test('host lookups skip platform and local hosts and normalise the request host', () => {
  const asked: string[] = []
  const lookup = {
    aliasPortal: (hostname: string) => {
      asked.push(hostname)
      return hostname === 'research.example.org' ? 'marine' : undefined
    },
  }
  for (
    const host of ['corpuskit.org', 'marine.corpuskit.org', 'localhost', '127.0.0.1', '[::1]']
  ) {
    expect(hostPortalFor(lookup, host, 'corpuskit.org')).toBeNull()
  }
  expect(asked).toEqual([])
  expect(hostPortalFor(lookup, 'research.example.org.', 'corpuskit.org')).toBe('marine')
  expect(hostPortalFor(lookup, 'other.example.org', 'corpuskit.org')).toBeNull()
  expect(asked).toEqual(['research.example.org', 'other.example.org'])
})

Deno.test('the host lookup cache keeps answers for their lifetime only and stays bounded', () => {
  const cache = new HostPortalCache(2)
  cache.set('a.example.org', 'marine', 30, 1_000)
  cache.set('b.example.org', null, 30, 1_000)
  expect(cache.get('a.example.org', 30_999)).toBe('marine')
  expect(cache.get('b.example.org', 30_999)).toBeNull()
  expect(cache.get('a.example.org', 31_000)).toBeUndefined()
  expect(cache.get('c.example.org', 1_000)).toBeUndefined()
  // A zero lifetime stores nothing and drops what was there.
  cache.set('b.example.org', 'grains', 0, 2_000)
  expect(cache.get('b.example.org', 2_000)).toBeUndefined()
  cache.set('a.example.org', 'marine', 30, 3_000)
  cache.set('b.example.org', 'grains', 30, 3_000)
  cache.set('c.example.org', null, 30, 3_000)
  expect(cache.get('a.example.org', 3_000)).toBeUndefined()
  expect(cache.get('b.example.org', 3_000)).toBe('grains')
  expect(cache.get('c.example.org', 3_000)).toBeNull()
})

Deno.test('reserved hostnames come from the setting and the deployment sign-in URLs', () => {
  expect(reservedHostnames({})).toEqual(new Set())
  expect(
    reservedHostnames({
      RESERVED_HOSTNAMES: ' Legacy.Example.NET. ,,not a host!, *.example.org, second.example.net ',
      ENTRA_REDIRECT_URI: 'https://Login.Example.net/auth/callback',
      EXTERNAL_LOGIN_START_URL: 'https://issuer.example/start',
    }),
  ).toEqual(
    new Set([
      'legacy.example.net',
      'second.example.net',
      'login.example.net',
      'issuer.example',
    ]),
  )
  expect(reservedHostnames({ ENTRA_REDIRECT_URI: 'not a url' })).toEqual(new Set())
})

Deno.test('unknown hosts are served by default and denied for any other value', () => {
  for (const value of [undefined, '', ' ', 'serve', 'SERVE', ' Serve ']) {
    expect(unknownHostsMode(value), String(value)).toBe('serve')
  }
  for (const value of ['deny', 'DENY', 'blocked', 'false', 'off']) {
    expect(unknownHostsMode(value), value).toBe('deny')
  }
})

Deno.test('hosts are platform, reserved, alias candidates or other', () => {
  const reserved = new Set(['legacy.example.net'])
  const kind = (host: string) => classifyHost(host, 'corpuskit.org', reserved)
  expect(kind('corpuskit.org')).toEqual({ kind: 'platform' })
  expect(kind('Marine.CorpusKit.org.')).toEqual({ kind: 'platform' })
  expect(kind('legacy.example.net.')).toEqual({ kind: 'reserved' })
  expect(kind('Research.Example.org')).toEqual({
    kind: 'candidate',
    hostname: 'research.example.org',
  })
  for (const host of ['localhost', '192.0.2.1', '[::1]', 'corpuskit.account.workers.dev']) {
    expect(kind(host), host).toEqual({ kind: 'other' })
  }
})

Deno.test('HSTS includes subdomains inside the platform domain only', () => {
  for (const host of ['corpuskit.org', 'marine.corpuskit.org', 'CORPUSKIT.ORG.']) {
    expect(transportSecurityFor(host, 'corpuskit.org'), host).toBe(
      'max-age=63072000; includeSubDomains',
    )
  }
  for (
    const host of ['research.example.org', 'corpuskit.org.evil.test', 'localhost', '192.0.2.1']
  ) {
    expect(transportSecurityFor(host, 'corpuskit.org'), host).toBe('max-age=63072000')
  }
})

Deno.test("an alias host keeps only the caller's own grants in its portal", () => {
  // A platform administrator's resolved roles: the platform role, portal-admin on every portal it
  // implies, and their own grants.
  const roles = {
    platformRole: 'platform-admin' as const,
    portalRoles: [
      { slug: 'grains', role: 'portal-admin' as const },
      { slug: 'marine', role: 'portal-admin' as const },
    ],
  }
  const provenance = [
    {
      source: 'local' as const,
      scope: { kind: 'platform' as const },
      role: 'platform-admin' as const,
    },
    {
      source: 'local' as const,
      scope: { kind: 'portal' as const, slug: 'grains' },
      role: 'portal-admin' as const,
    },
    {
      source: 'local' as const,
      scope: { kind: 'portal' as const, slug: 'marine' },
      role: 'viewer' as const,
    },
    {
      source: 'group' as const,
      scope: { kind: 'portal' as const, slug: 'marine' },
      role: 'analyst' as const,
    },
  ]
  // No platform role, nothing it implies: the highest of their own marine grants.
  expect(narrowRolesToPortal(roles, provenance, 'marine')).toEqual({
    effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'analyst' }] },
    provenance: [provenance[2], provenance[3]],
  })
  // Without a grant in the host's portal, no role there at all.
  expect(narrowRolesToPortal(roles, provenance.slice(0, 2), 'marine')).toEqual({
    effectiveRoles: { portalRoles: [] },
    provenance: [],
  })
  expect(narrowRolesToPortal(undefined, undefined, 'marine')).toEqual({
    effectiveRoles: undefined,
    provenance: undefined,
  })
})

Deno.test('start-up warnings name reserved aliases and served unknown hosts', () => {
  expect(aliasStartupWarnings({ UNKNOWN_HOSTS: 'deny', MAX_PORTAL_ALIASES: '0' }, [])).toEqual([])
  expect(aliasStartupWarnings({ UNKNOWN_HOSTS: 'deny' }, ['a.example.org'])).toEqual([])
  const served = aliasStartupWarnings({}, [])
  expect(served).toHaveLength(1)
  expect(served[0]).toContain('UNKNOWN_HOSTS is serve')
  expect(aliasStartupWarnings({ MAX_PORTAL_ALIASES: '0' }, [])).toEqual([])
  expect(aliasStartupWarnings({ MAX_PORTAL_ALIASES: '0' }, ['a.example.org'])).toHaveLength(1)
  const reserved = aliasStartupWarnings(
    {
      UNKNOWN_HOSTS: 'deny',
      RESERVED_HOSTNAMES: 'b.example.org,a.example.org',
      ENTRA_REDIRECT_URI: 'https://c.example.org/auth/callback',
    },
    ['c.example.org', 'a.example.org', 'free.example.org'],
  )
  expect(reserved).toEqual([
    '[portal-aliases] Reserved hostnames still registered as portal aliases: a.example.org, ' +
    "c.example.org. The API serves them as those portals' alias hosts; remove the aliases.",
  ])
})

Deno.test('a reserved hostname is never a canonical hostname', () => {
  const config = new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/t.json` }).get(
    'marine',
  )!
  const aliases = [
    { hostname: 'shared.example.org', slug: 'marine', primary: true, createdAt: 'x' },
  ]
  expect(withPrimaryAlias(config, aliases).hostname).toBe('shared.example.org')
  expect(withPrimaryAlias(config, aliases, new Set(['shared.example.org'])).hostname)
    .toBe(config.hostname)
})
