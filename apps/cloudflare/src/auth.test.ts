import { expect } from '@std/expect'
import { type AuthConfig, authConfigured, authUser, handleAuthRequest } from './auth.ts'

const config: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tenantId: 'tenant-id',
  sessionSecret: 'session-secret-with-more-than-thirty-two-bytes',
}

const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

/** Exercise the actual signed callback, cookie sealing and cookie reader. */
async function signedLogin(extra: Record<string, unknown>) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const original = globalThis.fetch
  let nonce = ''
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('openid-configuration')) {
      return Response.json({
        issuer: 'https://issuer.test',
        jwks_uri: 'https://issuer.test/keys',
        token_endpoint: 'https://issuer.test/token',
        authorization_endpoint: 'https://issuer.test/authorize',
      })
    }
    if (url.endsWith('/keys')) return Response.json({ keys: [{ ...publicKey, kid: 'test' }] })
    if (url.endsWith('/token')) {
      const header = encode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'test' })))
      const claims = encode(
        new TextEncoder().encode(
          JSON.stringify({
            aud: config.clientId,
            iss: 'https://issuer.test',
            tid: config.tenantId,
            oid: 'verified-oid',
            nonce,
            iat: Math.floor(Date.now() / 1000) - 60,
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...extra,
          }),
        ),
      )
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${header}.${claims}`),
      )
      return Response.json({ id_token: `${header}.${claims}.${encode(new Uint8Array(signature))}` })
    }
    throw new Error('Unexpected fixture request')
  }
  try {
    const login =
      (await handleAuthRequest(new Request('https://corpuskit.test/auth/login'), config))!
    const location = new URL(login.headers.get('location')!)
    nonce = location.searchParams.get('nonce')!
    const callback = (await handleAuthRequest(
      new Request(
        `https://corpuskit.test/auth/callback?code=test&state=${
          location.searchParams.get('state')
        }`,
        { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } },
      ),
      config,
    ))!
    const sessionCookie = callback.headers.getSetCookie().find((value) =>
      value.startsWith('__Secure-corpuskit_session=')
    )?.split(';')[0]
    return {
      callback,
      user: sessionCookie
        ? await authUser(
          new Request('https://corpuskit.test', { headers: { cookie: sessionCookie } }),
          config,
        )
        : null,
    }
  } finally {
    globalThis.fetch = original
  }
}

Deno.test('verified sessions preserve original claims and explicit group availability', async () => {
  for (
    const [extra, status] of [
      [{ groups: ['group-one'] }, 'complete'],
      [{}, 'absent'],
      [{ groups: ['ok', 42] }, 'malformed'],
      [{ groups: ['group-one'], _claim_names: { groups: 'source' } }, 'overage'],
      [{ hasgroups: true }, 'overage'],
    ] as const
  ) {
    const { user } = await signedLogin({ preferred_username: 'Person@Example.com', ...extra })
    expect(user?.sessionFacts.preferredUsername).toBe('Person@Example.com')
    expect(user?.sessionFacts.groupStatus).toBe(status)
    expect(user?.sessionFacts.groups).toEqual(status === 'complete' ? ['group-one'] : [])
    expect(user?.sessionFacts.claimIssuedAt).toBeLessThan(Date.now() - 59_000)
    expect(user?.sessionFacts.expiresAt).toBeLessThanOrEqual(
      user!.sessionFacts.claimIssuedAt + 8 * 3600_000,
    )
  }
})

Deno.test('signed tokens cannot replace oid with sub or omit tenant and claim time', async () => {
  for (
    const extra of [{ oid: undefined, sub: 'subject' }, { tid: undefined }, { iat: undefined }, {
      iat: '123',
    }]
  ) {
    const { callback, user } = await signedLogin(extra)
    expect(callback.status).toBe(400)
    expect(user).toBeNull()
  }
})

Deno.test('legacy sealed cookies cannot invent oid provenance or renew authority', async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.sessionSecret)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = new Uint8Array(12)
  const payload = {
    id: 'old-sub-or-oid',
    tenantId: config.tenantId,
    name: 'Old',
    email: '',
    roles: ['CorpusKit.Admin'],
    isAdmin: true,
    expiresAt: Date.now() + 3600_000,
  }
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('__Secure-corpuskit_session') },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  const request = new Request('https://corpuskit.test', {
    headers: {
      cookie: `__Secure-corpuskit_session=v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`,
    },
  })
  expect(await authUser(request, config)).toBeNull()
})

Deno.test('auth configuration fails closed when any credential is absent', () => {
  expect(authConfigured(config)).toBe(true)
  expect(authConfigured({ ...config, clientSecret: undefined })).toBe(false)
  expect(authConfigured({ ...config, sessionSecret: undefined })).toBe(false)
  expect(authConfigured({ ...config, sessionSecret: 'too-short' })).toBe(false)
})

Deno.test('/auth/me reports an anonymous session without calling Entra', async () => {
  const response = await handleAuthRequest(new Request('https://corpuskit.test/auth/me'), config)
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ authenticated: false, user: null })
  expect(response?.headers.get('cache-control')).toBe('no-store')
})

Deno.test('/auth/logout expires the encrypted session cookie', async () => {
  const response = await handleAuthRequest(
    new Request('https://corpuskit.test/auth/logout'),
    config,
  )
  expect(response?.status).toBe(302)
  expect(response?.headers.get('location')).toBe('/')
  expect(response?.headers.get('set-cookie')).toContain('__Secure-corpuskit_session=;')
  expect(response?.headers.get('set-cookie')).toContain('Max-Age=0')
})

Deno.test('/auth/logout clears a session across every corpuskit.org portal', async () => {
  const response = await handleAuthRequest(
    new Request('https://marine.corpuskit.org/auth/logout'),
    { ...config, cookieDomain: 'corpuskit.org' },
  )
  expect(response?.headers.get('set-cookie')).toContain('Domain=corpuskit.org')
})

Deno.test('80 UUID groups sign in within the cookie budget and auth/me reports overage', async () => {
  const { callback } = await signedLogin({
    roles: ['CorpusKit.Admin'],
    preferred_username: 'admin@example.test',
    groups: Array.from({ length: 80 }, () => crypto.randomUUID()),
  })
  expect(callback.status).toBe(302)
  const cookie = callback.headers.getSetCookie().find((value) =>
    value.startsWith('__Secure-corpuskit_session=')
  )!.split(';')[0]!
  expect(new TextEncoder().encode(cookie).byteLength).toBeLessThan(4096)
  expect(new TextEncoder().encode(cookie).byteLength).toBeLessThanOrEqual(3800)
  const me = (await handleAuthRequest(
    new Request('https://corpuskit.test/auth/me', { headers: { cookie } }),
    config,
  ))!
  expect(me.status).toBe(200)
  expect(await me.json()).toMatchObject({
    authenticated: true,
    user: {
      roles: ['CorpusKit.Admin'],
      sessionFacts: { roles: ['CorpusKit.Admin'], groups: [], groupStatus: 'overage' },
    },
  })
})
