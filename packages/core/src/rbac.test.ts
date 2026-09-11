import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  ACCESS_MODES,
  AccessModeSchema,
  AuthorisationPrincipalSchema,
  EffectiveRolesSchema,
  PERMISSIONS,
  PermissionSchema,
  PLATFORM_ROLES,
  PlatformRoleSchema,
  PORTAL_ROLES,
  PortalPolicySchema,
  PortalRoleSchema,
  PrincipalSchema,
  ROLES,
  RoleSchema,
  ScopeSchema,
} from './rbac.ts'

const user = { kind: 'user', tenantId: 'tenant-a', oid: 'user-a' }
const anonymous = { kind: 'anonymous' }
const publicPolicy = { slug: 'alpha', accessMode: 'public', configuredTenantId: 'tenant-a' }
const noRoles = { portalRoles: [] }

describe('RBAC catalogue and schema contracts', () => {
  it('exports exactly the ordered domains and permission catalogue', () => {
    expect(PORTAL_ROLES).toEqual(['viewer', 'analyst', 'curator', 'portal-admin'])
    expect(PLATFORM_ROLES).toEqual(['platform-admin', 'owner'])
    expect(ROLES).toEqual([
      'viewer',
      'analyst',
      'curator',
      'portal-admin',
      'platform-admin',
      'owner',
    ])
    expect(ACCESS_MODES).toEqual(['public', 'authenticated', 'restricted'])
    expect(PERMISSIONS).toEqual([
      'portal.read',
      'portal.ask',
      'portal.generate',
      'portal.investigate',
      'portal.export',
      'portal.watch',
      'content.write',
      'taxonomy.write',
      'enrichments.write',
      'graph.write',
      'behaviour.write',
      'appearance.write',
      'bindings.write',
      'domains.write',
      'keys.manage',
      'members.manage',
      'portal.create',
      'portal.delete',
      'platform.members.manage',
      'platform.settings.write',
      'audit.read',
      'audit.export',
    ])
    for (const catalogue of [PORTAL_ROLES, PLATFORM_ROLES, ROLES, ACCESS_MODES, PERMISSIONS]) {
      expect(Object.isFrozen(catalogue)).toBe(true)
    }
  })

  it('rejects unknown catalogue values and confused role domains', () => {
    for (const schema of [RoleSchema, PermissionSchema, AccessModeSchema]) {
      for (const invalid of ['unknown', '', null, undefined, 1, {}]) {
        expect(schema.safeParse(invalid).success).toBe(false)
      }
    }
    for (const role of ROLES) expect(RoleSchema.safeParse(role).success).toBe(true)
    for (const permission of PERMISSIONS) {
      expect(PermissionSchema.safeParse(permission).success).toBe(true)
    }
    expect(PortalRoleSchema.safeParse('owner').success).toBe(false)
    expect(PlatformRoleSchema.safeParse('portal-admin').success).toBe(false)
  })

  it('admits only minimal anonymous or nonempty user identity', () => {
    expect(PrincipalSchema.parse(anonymous)).toEqual(anonymous)
    expect(PrincipalSchema.parse(user)).toEqual(user)
    for (
      const invalid of [
        { ...anonymous, oid: 'user-a' },
        { ...anonymous, isAdmin: true },
        { ...user, email: 'user@example.test' },
        { ...user, roles: ['owner'] },
        { ...user, tenantId: '' },
        { ...user, oid: '' },
        { kind: 'user', oid: 'user-a' },
        { kind: 'key' },
        { kind: 'system' },
        null,
        undefined,
      ]
    ) expect(PrincipalSchema.safeParse(invalid).success).toBe(false)
  })

  it('validates scopes and preserves exact nonempty strings', () => {
    expect(ScopeSchema.parse({ kind: 'platform' })).toEqual({ kind: 'platform' })
    for (const slug of ['alpha', 'Alpha', ' alpha ', '__proto__', 'constructor', '*']) {
      expect(ScopeSchema.parse({ kind: 'portal', slug })).toEqual({ kind: 'portal', slug })
    }
    for (
      const invalid of [
        { kind: 'platform', slug: 'alpha' },
        { kind: 'portal', slug: '' },
        { kind: 'portal' },
        { kind: 'portal', slug: 'alpha', accessMode: 'public' },
        { kind: 'public' },
        { kind: 'portal', slug: 123 },
      ]
    ) expect(ScopeSchema.safeParse(invalid).success).toBe(false)
  })

  it('requires whole effective authority with unique exact portal slugs', () => {
    expect(EffectiveRolesSchema.parse(noRoles)).toEqual(noRoles)
    expect(
      EffectiveRolesSchema.safeParse({
        platformRole: 'owner',
        portalRoles: [{ slug: 'alpha', role: 'viewer' }, { slug: 'Alpha', role: 'curator' }],
      }).success,
    ).toBe(true)
    for (
      const invalid of [
        {},
        { portalRoles: null },
        { ...noRoles, platformRole: null },
        { ...noRoles, platformRole: 'curator' },
        { ...noRoles, isAdmin: true },
        { portalRoles: [{ slug: 'alpha', role: 'owner' }] },
        { portalRoles: [{ slug: 'alpha', role: 'viewer', source: 'local' }] },
        { portalRoles: [{ slug: '', role: 'viewer' }] },
        { platformRole: 'owner', portalRoles: [{ slug: 'alpha', role: 'unknown' }] },
      ]
    ) expect(EffectiveRolesSchema.safeParse(invalid).success).toBe(false)
    for (const slug of ['alpha', '__proto__', 'constructor']) {
      for (const secondRole of ['viewer', 'curator']) {
        expect(
          EffectiveRolesSchema.safeParse({
            portalRoles: [{ slug, role: 'viewer' }, { slug, role: secondRole }],
          }).success,
        ).toBe(false)
      }
    }
  })

  it('requires explicit strict portal policy without defaults or coercion', () => {
    expect(PortalPolicySchema.parse(publicPolicy)).toEqual(publicPolicy)
    for (const accessMode of ACCESS_MODES) {
      expect(PortalPolicySchema.safeParse({ ...publicPolicy, accessMode }).success).toBe(true)
    }
    for (
      const invalid of [
        { slug: 'alpha' },
        { ...publicPolicy, configuredTenantId: '' },
        { ...publicPolicy, slug: '' },
        { ...publicPolicy, accessMode: 'unknown' },
        { ...publicPolicy, extra: true },
        null,
      ]
    ) expect(PortalPolicySchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects malformed contextual authority as a whole', () => {
    const context = { identity: user, effectiveRoles: noRoles }
    expect(AuthorisationPrincipalSchema.parse(context)).toEqual(context)
    for (
      const invalid of [
        user,
        anonymous,
        { ...context, portalPolicy: null },
        { ...context, isAdmin: true },
        { ...context, identity: { ...user, name: 'A' } },
        { ...context, effectiveRoles: { ...noRoles, platformRole: 'unknown' } },
        { ...context, portalPolicy: { ...publicPolicy, extra: true } },
      ]
    ) expect(AuthorisationPrincipalSchema.safeParse(invalid).success).toBe(false)
  })

  it('allows anonymous contextual viewer only for one explicitly public matching portal', () => {
    const context = {
      identity: anonymous,
      effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'viewer' }] },
      portalPolicy: publicPolicy,
    }
    expect(
      AuthorisationPrincipalSchema.safeParse({ identity: anonymous, effectiveRoles: noRoles })
        .success,
    ).toBe(true)
    expect(AuthorisationPrincipalSchema.safeParse(context).success).toBe(true)
    for (
      const invalid of [
        { ...context, portalPolicy: undefined },
        { ...context, portalPolicy: { ...publicPolicy, accessMode: 'authenticated' } },
        { ...context, portalPolicy: { ...publicPolicy, accessMode: 'restricted' } },
        { ...context, portalPolicy: { ...publicPolicy, slug: 'beta' } },
        { ...context, effectiveRoles: { ...noRoles, platformRole: 'owner' } },
        { ...context, effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'analyst' }] } },
        {
          ...context,
          effectiveRoles: {
            portalRoles: [
              { slug: 'alpha', role: 'viewer' },
              { slug: 'beta', role: 'viewer' },
            ],
          },
        },
      ]
    ) expect(AuthorisationPrincipalSchema.safeParse(invalid).success).toBe(false)
  })
})
