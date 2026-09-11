import { expect } from '@std/expect'
import { authConfigured } from './auth.ts'
import { breakGlassEnabled } from '../../api/src/break-glass.ts'
import { resolveEffectiveRoles } from '../../api/src/assignments.ts'
import { LocalIngress } from '../../api/src/local-ingress.ts'
import { LocalRbacDatabase } from '../../api/src/rbac-local.ts'
import { RbacState } from '../../api/src/rbac-state.ts'
import { signPrincipal } from '../../api/src/principal.ts'
import { fixtureSession } from '../../api/src/rbac-integration-fixture.ts'

Deno.test('every deployment needs its own verified capability and complete group claims', async () => {
  for (const audience of ['corpuskit', 'corpuskit-demo', 'corpuskit-demos']) {
    const database = new LocalRbacDatabase(':memory:')
    try {
      const state = new RbacState(database)
      state.migrate()
      const session = fixtureSession({ groups: ['group-1'], groupStatus: 'complete' })
      state.assignmentService('tenant-1', audience).create({
        subjectKind: 'group',
        subjectId: 'group-1',
        scope: { kind: 'platform' },
        role: 'owner',
      }, { requestId: 'fixture', actor: { kind: 'system' } })
      const resolve = (value = session) =>
        resolveEffectiveRoles(value, {
          rbac: state,
          audience,
          tenants: { list: () => [{ slug: 'marine' }] },
        }, 'tenant-1')
      expect((await resolve()).effectiveRoles).toEqual({ portalRoles: [] })
      expect((await resolve()).groupCapability).toBe('disabled')
      database.exec(
        'INSERT INTO rbac_group_capabilities VALUES (?,?,?)',
        audience,
        'verified-supported',
        Date.now() + 60_000,
      )
      expect((await resolve()).groupCapability).toBe('disabled')
      database.exec('UPDATE rbac_group_capabilities SET verified_at = ?', Date.now() - 1000)
      for (const groupStatus of ['absent', 'malformed', 'overage', 'unverified'] as const) {
        expect((await resolve({ ...session, groups: [], groupStatus })).effectiveRoles).toEqual({
          portalRoles: [],
        })
      }
      expect((await resolve()).effectiveRoles.platformRole).toBe('owner')
      expect(
        (await resolveEffectiveRoles(session, {
          rbac: state,
          audience: 'different-deployment',
          tenants: { list: () => [] },
        }, 'tenant-1')).effectiveRoles,
      ).toEqual({ portalRoles: [] })
    } finally {
      database.close()
    }
  }
})

Deno.test('short or absent secrets refuse configured production identity and signing', async () => {
  for (const sessionSecret of [undefined, '', 'short', 'x'.repeat(31)]) {
    expect(
      authConfigured({
        clientId: 'fixture',
        clientSecret: 'fixture',
        tenantId: 'tenant-1',
        sessionSecret,
      }),
    ).toBe(false)
    const database = new LocalRbacDatabase(':memory:')
    try {
      const rbac = new RbacState(database)
      rbac.migrate()
      expect(() =>
        new LocalIngress({
          rbac,
          tenants: { list: () => [] },
          env: { ENVIRONMENT: 'production', SESSION_SECRET: sessionSecret },
        })
      ).toThrow('SESSION_SECRET')
      await expect(
        signPrincipal({
          v: 1,
          aud: 'corpuskit',
          tid: 'tenant-1',
          oid: 'person-1',
          email: '',
          name: '',
          roles: [],
          groups: [],
          iat: Math.floor(Date.now() / 1000),
        }, sessionSecret ?? ''),
      ).rejects.toThrow()
    } finally {
      database.close()
    }
  }
  expect(
    authConfigured({
      clientId: 'fixture',
      clientSecret: 'fixture',
      tenantId: 'tenant-1',
      sessionSecret: 'x'.repeat(32),
    }),
  ).toBe(true)
})

Deno.test('production break-glass needs the exact explicit flag and a configured passcode', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    expect(breakGlassEnabled(true, 'production', flag)).toBe(false)
  }
  expect(breakGlassEnabled(true, 'production', 'true')).toBe(true)
  expect(breakGlassEnabled(false, 'production', 'true')).toBe(false)
})
