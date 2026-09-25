import { expect } from '@std/expect'
import { PERMISSIONS, type Role, ROLES } from '@research-portal/core'
import type { TrustedSessionFacts } from './principal.ts'
import { buildUiAccessSnapshot } from './ui-access.ts'

const session = (): TrustedSessionFacts => ({
  verified: true,
  tenantId: 'tenant-1',
  oid: 'person-1',
  roles: [],
  groups: [],
  groupStatus: 'absent',
  claimIssuedAt: Date.now(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600_000,
})
const tenant = { slug: 'marine', accessMode: 'restricted', disabled: false }
const roles = (role?: Role) =>
  role === 'owner' || role === 'platform-admin'
    ? { platformRole: role, portalRoles: [] }
    : { portalRoles: role ? [{ slug: 'marine', role }] : [] }
const snapshot = (input: Partial<Parameters<typeof buildUiAccessSnapshot>[0]> = {}) =>
  buildUiAccessSnapshot({
    session: session(),
    effectiveRoles: roles(),
    configuredTenantId: 'tenant-1',
    selectedSlug: 'marine',
    tenant,
    ...input,
  })
const unavailable = {
  slug: 'marine',
  permissions: [],
  effectiveRole: null,
  available: false,
  canEnable: false,
}

Deno.test('UI snapshot follows all six D1 roles and both scope domains', () => {
  const portalCounts = [2, 6, 10, 18, 18, 18]
  for (const [index, role] of ROLES.entries()) {
    const result = snapshot({ effectiveRoles: roles(role) })
    expect(result.portalAccess?.permissions).toHaveLength(portalCounts[index]!)
    expect(result.portalAccess?.effectiveRole).toBe(index >= 4 ? 'portal-admin' : role)
    expect(result.portalAccess?.available).toBe(true)
    expect(result.portalAccess?.canEnable).toBe(false)
    expect(result.platformPermissions).toEqual(
      PERMISSIONS.filter((permission) =>
        (index >= 4 && ['portal.create', 'audit.read', 'audit.export'].includes(permission)) ||
        (role === 'owner' &&
          ['portal.delete', 'platform.members.manage', 'platform.settings.write'].includes(
            permission,
          ))
      ),
    )
    if (index < 4) {
      expect(
        snapshot({
          effectiveRoles: roles(role),
          selectedSlug: 'grains',
          tenant: { ...tenant, slug: 'grains' },
        }).portalAccess?.permissions,
      ).toEqual([])
    }
  }
})

Deno.test('UI snapshot grants only the public and same-tenant implicit viewer floor', () => {
  for (const accessMode of ['public', 'authenticated', 'restricted']) {
    for (const identity of [null, session(), { ...session(), tenantId: 'foreign' }]) {
      const result = snapshot({ session: identity, tenant: { ...tenant, accessMode } })
      const allowed = accessMode === 'public' ||
        (accessMode === 'authenticated' && identity?.tenantId === 'tenant-1')
      expect(result.portalAccess).toEqual(
        allowed
          ? {
            slug: 'marine',
            permissions: ['portal.read', 'portal.ask'],
            effectiveRole: 'viewer',
            available: true,
            canEnable: false,
          }
          : unavailable,
      )
    }
  }
  expect(
    snapshot({ session: { ...session(), tenantId: 'foreign' }, effectiveRoles: roles('owner') })
      .portalAccess,
  ).toEqual(unavailable)
  expect(snapshot({ session: null, effectiveRoles: roles('owner') }).platformPermissions).toEqual(
    [],
  )
})

Deno.test('UI snapshot is fail closed for malformed, missing and disabled selected policy', () => {
  for (const selectedSlug of [undefined, null, '', '../marine', 'a'.repeat(65), ['marine']]) {
    expect(snapshot({ selectedSlug }).portalAccess).toBeNull()
  }
  for (
    const policy of [null, undefined, {}, { ...tenant, slug: 'grains' }, {
      ...tenant,
      accessMode: 'unknown',
    }, { ...tenant, disabled: 'false' }]
  ) {
    expect(snapshot({ tenant: policy, effectiveRoles: roles('owner') }).portalAccess).toEqual(
      unavailable,
    )
  }
  expect(snapshot({ session: { ...session(), expiresAt: 1 }, effectiveRoles: roles('owner') }))
    .toEqual({ platformPermissions: [], portalAccess: unavailable })
  expect(
    snapshot({ effectiveRoles: { portalRoles: [], platformRole: 'system' } })
      .portalAccess,
  ).toEqual(unavailable)
})

Deno.test('disabled enable capability uses the exact route permission without ordinary access', () => {
  for (const role of ROLES) {
    const result = snapshot({ tenant: { ...tenant, disabled: true }, effectiveRoles: roles(role) })
    expect(result.portalAccess).toEqual({
      ...unavailable,
      canEnable: ['portal-admin', 'platform-admin', 'owner'].includes(role),
    })
    expect(result.portalAccess?.permissions).not.toContain('portal.read')
  }
  for (
    const input of [{ session: null }, { session: { ...session(), tenantId: 'foreign' } }, {
      selectedSlug: 'grains',
    }, { tenant: { ...tenant, accessMode: 'invalid', disabled: true } }]
  ) {
    expect(
      snapshot({
        tenant: { ...tenant, disabled: true },
        effectiveRoles: roles('portal-admin'),
        ...input,
      }).portalAccess?.canEnable,
    ).toBe(false)
  }
})

Deno.test('snapshot output contains no policy, claims, secrets or mutation side effects', () => {
  const input = {
    session: session(),
    effectiveRoles: roles('curator'),
    configuredTenantId: 'tenant-1',
    selectedSlug: 'marine',
    tenant: { ...tenant, secret: 'private', branding: { organisation: 'Private' } },
  }
  const before = structuredClone(input)
  const result = buildUiAccessSnapshot(input)
  expect(input).toEqual(before)
  expect(Object.keys(result)).toEqual(['platformPermissions', 'portalAccess'])
  expect(Object.keys(result.portalAccess!)).toEqual([
    'slug',
    'permissions',
    'effectiveRole',
    'available',
    'canEnable',
  ])
  expect(JSON.stringify(result)).not.toMatch(/private|tenant-1|person-1|claimIssuedAt/i)
})

Deno.test('unconfigured Entra preserves public anonymous access without management grants', () => {
  for (const accessMode of ['public', 'authenticated', 'restricted']) {
    const result = snapshot({
      session: null,
      configuredTenantId: '',
      tenant: { ...tenant, accessMode },
      effectiveRoles: roles('owner'),
    })
    expect(result.platformPermissions).toEqual([])
    expect(result.portalAccess?.permissions).toEqual(
      accessMode === 'public' ? ['portal.read', 'portal.ask'] : [],
    )
    expect(result.portalAccess?.canEnable).toBe(false)
  }
})

Deno.test('external UI access requires enabled trusted provenance and local assignments', () => {
  const external = {
    ...session(),
    tenantId: 'external',
    oid: 'ext:reader',
    provenance: 'external' as const,
  }
  for (const configuredTenantId of ['tenant-1', '', 'external']) {
    for (const accessMode of ['authenticated', 'restricted']) {
      const base = {
        session: external,
        configuredTenantId,
        tenant: { ...tenant, accessMode },
      }
      expect(snapshot({ ...base, externalLoginEnabled: true }).portalAccess).toEqual(unavailable)
      expect(
        snapshot({ ...base, externalLoginEnabled: true, effectiveRoles: roles('curator') })
          .portalAccess?.effectiveRole,
      ).toBe('curator')
      for (const externalLoginEnabled of [undefined, false]) {
        const result = snapshot({ ...base, externalLoginEnabled, effectiveRoles: roles('owner') })
        expect(result.platformPermissions).toEqual([])
        expect(result.portalAccess).toEqual(unavailable)
      }
      const missingProvenance = snapshot({
        ...base,
        session: { ...external, provenance: undefined },
        externalLoginEnabled: true,
        effectiveRoles: roles('owner'),
      })
      expect(missingProvenance.platformPermissions).toEqual([])
      expect(missingProvenance.portalAccess).toEqual(unavailable)
    }
  }
  expect(
    snapshot({
      session: external,
      externalLoginEnabled: true,
      effectiveRoles: roles('owner'),
    }).platformPermissions,
  ).toContain('platform.members.manage')
  expect(
    snapshot({
      session: { ...session(), tenantId: 'foreign' },
      externalLoginEnabled: true,
      effectiveRoles: roles('owner'),
    }).platformPermissions,
  ).toEqual([])
})
