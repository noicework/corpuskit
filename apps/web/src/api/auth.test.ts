import { expect } from '@std/expect'
import { AuthSessionError, getAuthSession, parseAuthSession } from './auth.ts'

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
