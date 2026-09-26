import { expect } from '@std/expect'
import {
  aliasesFor,
  aliasHostname,
  applyAlias,
  storedAliases,
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
