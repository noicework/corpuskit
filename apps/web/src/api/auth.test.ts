import { expect } from '@std/expect'
import { AuthSessionError, externalLoginUrl, getAuthSession, parseAuthSession } from './auth.ts'

export function sessionFixture(slug = 'marine', id: string | null = 'one') {
  return {
    authenticated: id !== null,
    user: id === null ? null : {
      id,
      tenantId: 'tenant',
      name: 'Reader',
      email: 'reader@example.test',
      roles: [],
      isAdmin: false,
    },
    effectiveRoles: { portalRoles: [] },
    provenance: [],
    claimAgeSeconds: id === null ? null : 0,
    groupMappings: 'disabled',
    coarseAdminEligible: false,
    breakGlassEnabled: false,
    platformPermissions: [],
    portalAccess: {
      slug,
      permissions: ['portal.read', 'portal.ask'],
      effectiveRole: 'viewer',
      available: true,
      canEnable: false,
    },
  }
}

Deno.test('auth snapshots reject malformed identity, grants, scope and unavailable inconsistencies', () => {
  const good = sessionFixture()
  expect(parseAuthSession(good, 'marine').status).toBe('ready')
  expect(parseAuthSession(sessionFixture('marine', null), 'marine').authenticated).toBe(false)
  for (
    const value of [
      null,
      {},
      { ...good, authenticated: false },
      { ...good, user: null },
      { ...good, platformPermissions: ['made.up'] },
      { ...good, platformPermissions: ['portal.read'] },
      {
        ...good,
        portalAccess: {
          ...good.portalAccess,
          permissions: ['portal.read', 'platform.settings.write'],
        },
      },
      {
        ...sessionFixture('marine', null),
        portalAccess: { ...good.portalAccess, permissions: ['portal.read', 'members.manage'] },
      },
      {
        ...good,
        provenance: [{ source: 'local', role: 'owner', scope: { kind: 'portal', slug: 'marine' } }],
      },
      { ...good, effectiveRoles: { platformRole: 'superuser', portalRoles: [] } },
      { ...good, provenance: [{ source: 'local', role: 'viewer', scope: { kind: 'wrong' } }] },
      { ...good, portalAccess: { ...good.portalAccess, slug: 'other' } },
      { ...good, portalAccess: { ...good.portalAccess, available: false } },
      { ...good, portalAccess: { ...good.portalAccess, available: 'true' } },
    ]
  ) expect(() => parseAuthSession(value, 'marine')).toThrow(AuthSessionError)
  expect(
    parseAuthSession(
      { ...good, portalAccess: { ...good.portalAccess, canEnable: 'true' } },
      'marine',
    ).portalAccess?.canEnable,
  ).toBe(false)
})

Deno.test('auth transport encodes the selected portal and refuses abort during JSON parsing', async () => {
  const original = globalThis.fetch
  const abort = new AbortController()
  try {
    globalThis.fetch = (input, init) => {
      expect(input).toBe('/auth/me?portal=marine')
      expect(init?.signal).toBe(abort.signal)
      const response = Response.json(sessionFixture())
      response.json = () => {
        abort.abort()
        return Promise.resolve(sessionFixture())
      }
      return Promise.resolve(response)
    }
    await expect(getAuthSession({ slug: 'marine', signal: abort.signal })).rejects.toBeInstanceOf(
      AuthSessionError,
    )
    globalThis.fetch = () => Promise.reject(new Error('offline'))
    await expect(getAuthSession()).rejects.toMatchObject({
      status: 'unavailable',
      platformPermissions: [],
      portalAccess: null,
    })
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('auth snapshots validate external login links and session provenance', () => {
  const good = sessionFixture()
  const session = parseAuthSession({
    ...good,
    entraEnabled: false,
    externalLogin: { name: 'Organisation account', startUrl: 'https://identity.example/start' },
    sessionProvenance: 'external',
    user: { ...good.user, tenantId: 'external', id: 'ext:reader', provenance: 'external' },
  }, 'marine')
  expect(session.externalLogin?.name).toBe('Organisation account')
  expect(session.entraEnabled).toBe(false)
  expect(session.sessionProvenance).toBe('external')
  expect(session.user?.provenance).toBe('external')
  expect(parseAuthSession(good, 'marine').externalLogin).toBeNull()
  expect(parseAuthSession(good, 'marine').externalLoginEnabled).toBeUndefined()
  expect(parseAuthSession({ ...good, externalLoginEnabled: true }, 'marine').externalLoginEnabled)
    .toBe(true)
  expect(
    parseAuthSession({
      ...good,
      externalLogin: { startUrl: 'http://localhost:8000/start' },
    }, 'marine').externalLogin?.name,
  ).toBe('Continue with your organisation account')
  for (
    const startUrl of [
      'javascript:alert(1)',
      '//identity.example',
      'http://identity.example',
      'https://user:password@identity.example',
    ]
  ) {
    expect(() =>
      parseAuthSession({
        ...good,
        externalLogin: { name: 'Organisation account', startUrl },
      }, 'marine')
    ).toThrow(AuthSessionError)
  }
})

Deno.test('external sign-in links carry only the return path to the issuer', () => {
  expect(externalLoginUrl('https://identity.example/start', '/t/marine')).toBe(
    'https://identity.example/start?returnTo=%2Ft%2Fmarine',
  )
  // Existing issuer parameters are kept and a configured returnTo is replaced, not duplicated.
  const url = new URL(
    externalLoginUrl('https://identity.example/start?portal=marine&returnTo=/elsewhere', '/admin'),
  )
  expect(url.origin + url.pathname).toBe('https://identity.example/start')
  expect([...url.searchParams]).toEqual([['portal', 'marine'], ['returnTo', '/admin']])
})
