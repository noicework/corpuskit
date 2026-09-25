import { expect } from '@std/expect'
import { type AuthConfig, authUser, handleAuthRequest } from '../../cloudflare/src/auth.ts'
import {
  auditExternalLoginFailure,
  EXTERNAL_LOGIN_FAILURES,
  externalLoginConfigured,
  externalLoginPresentation,
  ExternalLoginReplayStore,
  externalReturnTo,
  verifyExternalAssertion,
} from './external-login.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { LocalIngress } from './local-ingress.ts'
import { signPrincipal, type TrustedSessionFacts, verifyPrincipal } from './principal.ts'
import { authoriseOperation, selectRequestAuthority } from './authorisation.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const secret = 'test-session-key-with-at-least-32-bytes'
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)))
async function fixture() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const config: AuthConfig = {
    clientId: '',
    clientSecret: '',
    tenantId: '',
    sessionSecret: secret,
    externalLogin: {
      issuer: 'https://issuer.example',
      audience: 'portal-deployment',
      jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    },
  }
  const mint = async (
    extra: Record<string, unknown> = {},
    header: unknown = { alg: 'EdDSA', typ: 'JWT' },
  ) => {
    const now = Math.floor(Date.now() / 1000)
    const content = `${json(header)}.${
      json({
        iss: config.externalLogin!.issuer,
        aud: config.externalLogin!.audience,
        sub: 'person-1',
        email: 'Person@Example.test',
        email_verified: true,
        name: 'Person',
        iat: now - 10,
        exp: now + 60,
        jti: crypto.randomUUID(),
        ...extra,
      })
    }`
    return `${content}.${
      encode(
        new Uint8Array(
          await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(content)),
        ),
      )
    }`
  }
  return { config, mint }
}
const request = (assertion: string, returnTo = '/t/marine') =>
  new Request(
    `https://portal.example/auth/external?${new URLSearchParams({ assertion, returnTo })}`,
  )

Deno.test('external assertion verifies Ed25519, normalises email and bounds issuance inclusively', async () => {
  const { config, mint } = await fixture()
  const now = Math.floor(Date.now() / 1000)
  const assertion = await mint({ iat: now + 30, exp: now + 150, sub: '用户 / opaque' })
  const claims = await verifyExternalAssertion(assertion, config.externalLogin!, now * 1000)
  expect(claims.email).toBe('person@example.test')
  expect(claims.sub).toBe('用户 / opaque')
  const exp = await mint({ iat: now - 120, exp: now })
  expect((await verifyExternalAssertion(exp, config.externalLogin!, now * 1000)).exp).toBe(now)
})

Deno.test('external failures share one response and audit only a fixed reason', async (t) => {
  const { config, mint } = await fixture()
  const now = Math.floor(Date.now() / 1000)
  const cases: [string, Record<string, unknown>, unknown?][] = [
    ['wrong algorithm', {}, { alg: 'HS256', typ: 'JWT' }],
    ['no algorithm', {}, { alg: 'none', typ: 'JWT' }],
    ['missing algorithm', {}, { typ: 'JWT' }],
    ['wrong type', {}, { alg: 'EdDSA', typ: 'JWS' }],
    ['critical header', {}, { alg: 'EdDSA', typ: 'JWT', crit: ['unknown'] }],
    ['wrong issuer', { iss: 'https://elsewhere.example' }],
    ['wrong audience', { aud: 'other-worker' }],
    ['array audience', { aud: ['portal-deployment'] }],
    ['expired', { iat: now - 60, exp: now - 1 }],
    ['future issuance', { iat: now + 31, exp: now + 90 }],
    ['lifetime too long', { iat: now - 61, exp: now + 60 }],
    ['reversed lifetime', { iat: now, exp: now - 1 }],
    ['missing email', { email: undefined }],
    ['invalid email', { email: 'not-email' }],
    ['unverified email', { email_verified: false }],
    ['missing verification', { email_verified: undefined }],
    ['string verification', { email_verified: 'true' }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['long subject', { sub: 'a'.repeat(129) }],
    ['invalid Unicode', { sub: '\ud800' }],
    ['control character in subject', { sub: 'person\n1' }],
    ['short nonce', { jti: 'a'.repeat(15) }],
    ['missing nonce', { jti: undefined }],
    ['missing issuance', { iat: undefined }],
    ['missing expiry', { exp: undefined }],
    ['fractional issuance', { iat: now - 0.5 }],
  ]
  for (const [name, extra, header] of cases) {
    await t.step(name, async () => {
      const db = new LocalRbacDatabase(':memory:')
      try {
        const rbac = new RbacState(db)
        rbac.migrate()
        const token = await mint(extra, header)
        let consumes = 0
        const response = (await handleAuthRequest(request(token), config, {
          consume: () => {
            consumes++
            return true
          },
          auditFailure: (reason) => auditExternalLoginFailure(rbac.audit, reason),
        }))!
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'external_login_invalid' })
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(consumes).toBe(0)
        const events = rbac.audit.read({ scope: { kind: 'platform' } })
        expect(events).toHaveLength(1)
        expect(events[0]!.action).toBe('auth.external.denied')
        expect(Object.keys(JSON.parse(events[0]!.detail_json))).toEqual(['externalReason'])
        expect(JSON.stringify(events)).not.toContain(token)
        expect(JSON.stringify(events)).not.toContain('Person@Example.test')
      } finally {
        db.close()
      }
    })
  }
  const token = await mint()
  const other = await fixture()
  const [header, payload, signature] = token.split('.') as [string, string, string]
  const [, otherPayload] = (await mint({ sub: 'someone-else' })).split('.')
  const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  for (
    const [assertion, settings, reason] of [
      [token, other.config, 'signature'],
      [`${header}.${payload}.${flipped}`, config, 'signature'],
      [`${header}.${otherPayload}.${signature}`, config, 'signature'],
      [`${header}.${payload}.`, config, 'encoding'],
      [`${header}.${payload}`, config, 'encoding'],
      ['invalid', config, 'encoding'],
      [token, { ...config, externalLogin: {} }, 'configuration'],
      [token, { ...config, sessionSecret: 'short' }, 'configuration'],
      [token, { ...config, externalLogin: { ...config.externalLogin, jwk: '{' } }, 'configuration'],
      [
        token,
        { ...config, externalLogin: { ...config.externalLogin, audience: undefined } },
        'configuration',
      ],
    ] as const
  ) {
    const reasons: string[] = []
    let consumes = 0
    const response = (await handleAuthRequest(request(assertion), settings, {
      consume: () => {
        consumes++
        return true
      },
      auditFailure: (value) => {
        reasons.push(value)
      },
    }))!
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'external_login_invalid' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(reasons).toEqual([reason])
    expect(consumes).toBe(0)
  }
})

Deno.test('every external failure reason is accepted by the audit log', () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    const rbac = new RbacState(db)
    rbac.migrate()
    for (const reason of EXTERNAL_LOGIN_FAILURES) auditExternalLoginFailure(rbac.audit, reason)
    expect(
      rbac.audit.read({ scope: { kind: 'platform' }, action: 'auth.external.denied' })
        .map((event) => JSON.parse(event.detail_json).externalReason).sort(),
    ).toEqual([...EXTERNAL_LOGIN_FAILURES].sort())
  } finally {
    db.close()
  }
})

Deno.test('external exchange issues normal eight-hour encrypted sessions without claim roles', async () => {
  const { config, mint } = await fixture()
  const db = new LocalRbacDatabase(':memory:')
  try {
    const replays = new ExternalLoginReplayStore(db)
    const token = await mint({ roles: ['CorpusKit.Owner'], groups: ['administrators'] })
    const exchange = () =>
      handleAuthRequest(request(token), config, {
        consume: (key, exp) => replays.consume(key, exp),
        auditFailure: () => {},
      })
    const responses = await Promise.all([exchange(), exchange()])
    expect(responses.map((r) => r!.status).sort()).toEqual([303, 401])
    const response = responses.find((r) => r!.status === 303)!
    expect(response.headers.get('location')).toBe('/t/marine')
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Lax; Max-Age=28800')
    expect(cookie).not.toContain('person@example.test')
    const user = await authUser(
      new Request('https://portal.example/auth/me', { headers: { cookie: cookie.split(';')[0]! } }),
      config,
    )
    expect(user).toMatchObject({
      tenantId: 'external',
      id: 'ext:person-1',
      provenance: 'external',
      roles: [],
      isAdmin: false,
    })
    expect(user!.sessionFacts.expiresAt - user!.sessionFacts.createdAt).toBe(8 * 3600_000)
    expect(user!.sessionFacts.roles).toEqual([])
    expect(
      await authUser(new Request('https://portal.example', { headers: { cookie } }), {
        ...config,
        externalLogin: undefined,
      }),
    ).toBeNull()
    const reasons: string[] = []
    for (
      const consume of [() => {
        throw new Error('storage unavailable')
      }, () => false]
    ) {
      const denied = (await handleAuthRequest(request(await mint()), config, {
        consume,
        auditFailure: (reason) => {
          reasons.push(reason)
        },
      }))!
      expect(denied.status).toBe(401)
      expect(denied.headers.get('set-cookie')).toBeNull()
      // An unwritable failure record fails the request like every other audited denial.
      const unaudited = (await handleAuthRequest(request(await mint()), config, {
        consume,
        auditFailure: () => {
          throw new Error('audit unavailable')
        },
      }))!
      expect(unaudited.status).toBe(500)
      expect(await unaudited.json()).toEqual({ error: 'audit_write_failed' })
      expect(unaudited.headers.get('set-cookie')).toBeNull()
      expect(unaudited.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(reasons).toEqual(['storage', 'replay'])
  } finally {
    db.close()
  }
})

Deno.test('external redirect rejects encoded, nested and browser-normalised escape variants', () => {
  for (
    const value of [
      null,
      '',
      '//evil',
      'https://evil',
      '/\\evil',
      '%2f%2fevil',
      '/%2fevil',
      '/%5cevil',
      '/%255cevil',
      '%252f%252fevil',
      '/%252fevil',
      '/\tevil',
      '/%0a/evil',
      '/%0d%0aLocation:https://evil',
      ' /safe',
      '/%zz',
      '/t/marine /x',
      '/t/用户',
      '/t/café',
      '/∕∕evil',
      '/\u0000evil',
      '/%00evil',
      `/${'a'.repeat(2048)}`,
      // Dot segments that a browser resolves to a protocol-relative path.
      '/..//evil.example',
      '/.//evil.example',
      '/%2e%2e//evil.example',
      '/%2E%2E//evil.example',
      '/%2e//evil.example',
      '/.%2e//evil.example',
      '/%252e%252e//evil.example',
      '/t/..//evil.example',
      '/t/marine/..',
      '/t/./marine',
    ]
  ) {
    expect(externalReturnTo(value)).toBe('/')
  }
  for (
    const value of [
      '/',
      '/t/marine',
      '/t/marine?q=climate#sources',
      '/t/marine?q=one%20two',
      '/t/%E7%94%A8%E6%88%B7',
      '/t/marine?path=../other',
      '/t/marine/...',
      '/t/v1.2/notes',
    ]
  ) {
    expect(externalReturnTo(value)).toBe(value)
    // Every accepted value stays on the origin with one leading slash once a browser resolves it.
    const resolved = new URL(value, 'https://portal.example')
    expect(resolved.origin).toBe('https://portal.example')
    expect(resolved.pathname.startsWith('//')).toBe(false)
  }
})

Deno.test('an unusable return path still signs in and lands on the portal root', async () => {
  const { config, mint } = await fixture()
  const db = new LocalRbacDatabase(':memory:')
  try {
    const replays = new ExternalLoginReplayStore(db)
    for (const returnTo of ['/t/用户', '//evil.example', 'https://evil.example']) {
      const response = (await handleAuthRequest(request(await mint(), returnTo), config, {
        consume: (key, exp) => replays.consume(key, exp),
        auditFailure: () => {
          throw new Error('unexpected failure')
        },
      }))!
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/')
      expect(response.headers.get('set-cookie')).toContain('__Secure-corpuskit_session=')
    }
    const duplicate = new Request(
      `https://portal.example/auth/external?${new URLSearchParams([
        ['assertion', await mint()],
        ['returnTo', '/t/marine'],
        ['returnTo', '//evil.example'],
      ])}`,
    )
    const response = (await handleAuthRequest(duplicate, config, {
      consume: (key, exp) => replays.consume(key, exp),
      auditFailure: () => {},
    }))!
    expect(response.headers.get('location')).toBe('/')
  } finally {
    db.close()
  }
})

Deno.test('external replay survives store recreation and a database reopen until expiry passes', () => {
  const directory = Deno.makeTempDirSync()
  const path = `${directory}/replay.sqlite`
  let db = new LocalRbacDatabase(path)
  try {
    const now = 1800000000000
    const key = 'a'.repeat(64)
    expect(new ExternalLoginReplayStore(db).consume(key, now + 1000, now)).toBe(true)
    expect(new ExternalLoginReplayStore(db).consume(key, now + 1000, now)).toBe(false)
    db.close()
    db = new LocalRbacDatabase(path)
    const replays = new ExternalLoginReplayStore(db)
    expect(replays.consume(key, now + 1000, now + 1000)).toBe(false)
    expect(replays.consume('b'.repeat(64), now + 2000, now + 1001)).toBe(true)
    expect(db.all('SELECT replay_key FROM external_login_replays')).toEqual([{
      replay_key: 'b'.repeat(64),
    }])
    expect(replays.consume(key, now, now + 1001)).toBe(false)
  } finally {
    db.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('external principal envelopes require explicit configuration and never carry claims', async () => {
  const base = {
    v: 1 as const,
    aud: 'arbitrary-portal-worker',
    tid: 'external',
    oid: 'ext:用户 / opaque',
    email: 'p@example.test',
    name: '',
    roles: [] as string[],
    groups: [] as string[],
    iat: Math.floor(Date.now() / 1000),
  }
  const config = { sessionSecret: secret, audience: base.aud, tenantId: 'entra-tenant' }
  const signed = await signPrincipal(base, secret)
  expect(await verifyPrincipal(signed, config)).toMatchObject({ kind: 'rejected', code: 'tenant' })
  expect(await verifyPrincipal(signed, { ...config, externalLoginEnabled: true })).toMatchObject({
    kind: 'verified',
  })
  for (
    const extra of [{ roles: ['CorpusKit.Owner'] }, { groups: ['admin'] }, { oid: 'unprefixed' }]
  ) {
    expect(
      await verifyPrincipal(await signPrincipal({ ...base, ...extra }, secret), {
        ...config,
        externalLoginEnabled: true,
      }),
    ).toMatchObject({ kind: 'rejected' })
  }
})

Deno.test('authority selection refuses external sessions unless external sign-in is configured', async () => {
  const f = createEnforcementFixture()
  try {
    const external: TrustedSessionFacts = {
      verified: true,
      provenance: 'external',
      tenantId: 'external',
      oid: 'ext:person-1',
      email: 'person@example.test',
      roles: [],
      groups: [],
      groupStatus: 'absent',
      claimIssuedAt: f.now() - 60_000,
      createdAt: f.now() - 30_000,
      expiresAt: f.now() + 3600_000,
    }
    const policy = { slug: 'a', accessMode: 'restricted', configuredTenantId: f.tenantId }
    const select = async (externalLoginEnabled: boolean | undefined) => {
      const context = await f.contextFor(external)
      // A resolved grant must still not carry the session once the feature is off.
      context.effectiveRoles = { portalRoles: [{ slug: 'a', role: 'viewer' }] }
      const authority = selectRequestAuthority(
        new Request('http://local/api/t/a/search'),
        context,
        { ...f.authorityDependencies(), externalLoginEnabled },
      )
      return { context, authority }
    }
    for (const disabled of [false, undefined]) {
      const { context, authority } = await select(disabled)
      await expect(authority).rejects.toThrow('unauthorised')
      expect(context.denialAudited).toBe(true)
    }
    const enabled = await (await select(true)).authority
    expect(enabled.kind).toBe('session')
    expect(authoriseOperation(enabled, 'portal.read', { kind: 'portal', slug: 'a' }, policy)).toBe(
      true,
    )
    // The external tenant marker never stands in for an Entra session, or the reverse.
    for (
      const session of [{ ...external, provenance: 'entra' as const }, { ...external, oid: 'x' }]
    ) {
      const context = await f.contextFor(null)
      context.session = session
      await expect(
        selectRequestAuthority(new Request('http://local/api/t/a/search'), context, {
          ...f.authorityDependencies(),
          externalLoginEnabled: true,
        }),
      ).rejects.toThrow('unauthorised')
    }
  } finally {
    f.close()
  }
})

Deno.test('local ingress exchanges, reads and logs out external sessions using durable replay', async () => {
  const { config, mint } = await fixture()
  const db = new LocalRbacDatabase(':memory:')
  try {
    const rbac = new RbacState(db)
    rbac.migrate()
    const env = {
      SESSION_SECRET: secret,
      WORKER_NAME: 'portal-deployment',
      EXTERNAL_LOGIN_ISSUER: config.externalLogin!.issuer,
      EXTERNAL_LOGIN_JWK: config.externalLogin!.jwk,
      EXTERNAL_LOGIN_START_URL: 'https://issuer.example/start',
    }
    const makeIngress = () =>
      new LocalIngress({
        rbac,
        tenants: { list: () => [] },
        env,
        externalReplays: new ExternalLoginReplayStore(db),
      })
    const ingress = makeIngress()
    const token = await mint()
    const response = await ingress.handle(request(token), () => new Response('unexpected'))
    expect(response.status).toBe(303)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const me = await ingress.handle(
      new Request('https://portal.example/auth/me', { headers: { cookie } }),
      () => new Response('unexpected'),
    )
    expect(await me.json()).toMatchObject({
      authenticated: true,
      sessionProvenance: 'external',
      user: { id: 'ext:person-1', provenance: 'external' },
      externalLogin: { startUrl: 'https://issuer.example/start' },
      entraEnabled: false,
    })
    expect((await makeIngress().handle(request(token), () => new Response('unexpected'))).status)
      .toBe(401)
    let dispatched: { session: unknown } | undefined
    const portal = await ingress.handle(
      new Request('https://portal.example/api/t/marine/config', { headers: { cookie } }),
      (clean) => {
        dispatched = ingress.requestContext(clean)
        return new Response('dispatched')
      },
    )
    expect(await portal.text()).toBe('dispatched')
    expect(dispatched?.session).toMatchObject({
      tenantId: 'external',
      oid: 'ext:person-1',
      provenance: 'external',
      roles: [],
    })
    // The Entra flow is not served locally, so its paths still reach the application.
    for (const path of ['/auth/login', '/auth/callback']) {
      const passed = await ingress.handle(
        new Request(`https://portal.example${path}`),
        () => new Response('application'),
      )
      expect(await passed.text()).toBe('application')
    }
    const logout = await ingress.handle(
      new Request('https://portal.example/auth/logout', { headers: { cookie } }),
      () => new Response('unexpected'),
    )
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    // Removing the configuration ignores the existing cookie and refuses new handoffs.
    const disabled = new LocalIngress({
      rbac,
      tenants: { list: () => [] },
      env: { SESSION_SECRET: secret, WORKER_NAME: 'portal-deployment' },
      externalReplays: new ExternalLoginReplayStore(db),
    })
    const anonymous = await disabled.handle(
      new Request('https://portal.example/auth/me', { headers: { cookie } }),
      () => new Response('unexpected'),
    )
    expect(await anonymous.json()).toMatchObject({ authenticated: false, externalLogin: null })
    const refused = await disabled.handle(request(await mint()), () => new Response('unexpected'))
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'external_login_invalid' })
    expect(
      rbac.audit.read({ scope: { kind: 'platform' }, action: 'auth.external.denied' })
        .map((event) => JSON.parse(event.detail_json).externalReason).sort(),
    ).toEqual(['configuration', 'replay'])
  } finally {
    db.close()
  }
})

Deno.test('external login presentation needs both trust settings and a safe start URL', () => {
  const base = {
    issuer: 'https://issuer.example',
    jwk: '{}',
    startUrl: 'https://issuer.example/start',
  }
  expect(externalLoginConfigured(base)).toBe(true)
  expect(externalLoginPresentation(base)).toEqual({
    name: 'Continue with your organisation account',
    startUrl: base.startUrl,
  })
  expect(externalLoginPresentation({ ...base, name: 'Organisation sign-in' })!.name).toBe(
    'Organisation sign-in',
  )
  for (
    const extra of [
      { issuer: undefined },
      { jwk: undefined },
      { startUrl: undefined },
      { startUrl: 'javascript:alert(1)' },
      { startUrl: 'https://user:pass@issuer.example' },
      { startUrl: 'http://issuer.example/start' },
    ]
  ) {
    expect(externalLoginPresentation({ ...base, ...extra })).toBeNull()
  }
  expect(externalLoginPresentation({ ...base, startUrl: 'http://localhost:8000/start' })).not
    .toBeNull()
})
