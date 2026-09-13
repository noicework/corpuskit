import { expect } from '@std/expect'
import { ROLES } from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'

Deno.test('enforcement fixture keeps personas, portals and request authority distinct', async () => {
  const fixture = createEnforcementFixture()
  try {
    const identities = ROLES.flatMap((role) =>
      ['a', 'b'].map((slug) => fixture.sessionFor(role, slug).oid)
    )
    expect(new Set(identities).size).toBe(identities.length)
    expect(fixture.unassigned.tenantId).not.toBe(fixture.otherTenant.tenantId)
    for (const mode of ['public', 'authenticated', 'restricted'] as const) {
      for (const suffix of ['a', 'b']) {
        const slug = mode === 'restricted' ? suffix : `${mode}-${suffix}`
        expect(fixture.stores.tenants.get(slug)?.accessMode).toBe(mode)
      }
    }
    expect(fixture.stores.tenants.isDisabled('disabled')).toBe(true)
    expect(() => fixture.stores.tenants.get('corrupt')).toThrow()
    const anonymous = await fixture.requestAs(null, '/api/admin/overview', {
      headers: { 'x-corpuskit-sso-admin': '1', 'x-corpuskit-sso-user-id': 'owner-a' },
    })
    expect([401, 403]).toContain(anonymous.status)
    fixture.assertNoProtectedDispatch()
    const owner = await fixture.contextFor(fixture.sessionFor('owner', 'a'))
    expect(owner.effectiveRoles?.platformRole).toBe('owner')
    const curator = await fixture.contextFor(fixture.sessionFor('curator', 'a'))
    expect(curator.effectiveRoles?.portalRoles).toEqual([{ slug: 'a', role: 'curator' }])
    expect((await fixture.contextFor(null)).effectiveRoles?.portalRoles).toEqual([])
    expect((await fixture.contextFor(fixture.unassigned)).effectiveRoles?.portalRoles).toEqual([])
    expect((await fixture.contextFor(fixture.otherTenant)).effectiveRoles?.portalRoles).toEqual([])
    const creator = fixture.creator
    expect(creator.verified).toBe(true)
    expect(creator.tenantId).toBe(fixture.tenantId)
  } finally {
    fixture.close()
  }
})

Deno.test('enforcement non-dispatch assertion catches a real provider call and registry is explicit', async () => {
  const fixture = createEnforcementFixture()
  try {
    fixture.assertNoProtectedDispatch()
    const response = await fixture.requestAs(null, '/api/t/public-a/catalog')
    expect(response.status).toBe(200)
    expect((await response.json()).items.length).toBeGreaterThan(0)
    expect(fixture.providerCalls.length).toBeGreaterThan(0)
    expect(() => fixture.assertNoProtectedDispatch()).toThrow()
    fixture.providerCalls.length = 0
    fixture.assertNoProtectedDispatch()
    expect(fixture.routeCases).toEqual([])
    fixture.routeCases.push({
      method: 'GET',
      path: '/api/t/:slug/catalog',
      params: { slug: 'public-a' },
      body: undefined,
      seed: () => {},
      expectedPermission: 'portal.read',
      expectedScope: { kind: 'portal', slug: 'public-a' },
      assertAllowed: async (result) => {
        expect(result.status).toBe(200)
        expect((await result.json()).items.length).toBeGreaterThan(0)
      },
    })
    expect(fixture.routeCases[0]?.expectedPermission).toBe('portal.read')
  } finally {
    fixture.close()
  }
})

Deno.test('enforcement fixture audit failure uses SQLite and preserves request isolation concurrently', async () => {
  const fixture = createEnforcementFixture()
  try {
    const owner = fixture.sessionFor('owner', 'a')
    const [allowed, denied] = await Promise.all([
      fixture.requestAs(owner, '/api/admin/overview'),
      fixture.requestAs(null, '/api/admin/overview'),
    ])
    expect(allowed.status).toBe(200)
    expect([401, 403]).toContain(denied.status)
    await allowed.text()
    fixture.failAudit()
    expect((await fixture.requestAs(null, '/api/admin/overview')).status).toBe(500)
    fixture.recoverAudit()
  } finally {
    fixture.close()
  }
})
