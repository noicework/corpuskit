import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  ACCESS_MODES,
  AccessModeSchema,
  AuthorisationPrincipalSchema,
  authorize,
  EffectiveRolesSchema,
  normalisePrincipal,
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
const alpha = { kind: 'portal', slug: 'alpha' }
const platform = { kind: 'platform' }

// D1 oracle copied from DECISIONS.md, independent of production catalogues and grant maps.
const decisionPermissions = [
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
]
const viewerGrants = ['portal.read', 'portal.ask']
const analystGrants = [
  'portal.read',
  'portal.ask',
  'portal.generate',
  'portal.investigate',
  'portal.export',
  'portal.watch',
]
const curatorGrants = [
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
]
const portalAdminGrants = [
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
  'audit.read',
  'audit.export',
]

describe('independent D1 decision oracle', () => {
  it('checks exactly 396 allow and deny cells across six roles, 22 permissions and three scopes', () => {
    expect(PERMISSIONS).toEqual(decisionPermissions)
    expect(new Set(PERMISSIONS).size).toBe(22)
    const fixtures = [
      { role: 'viewer', portal: viewerGrants, platform: [], global: false },
      { role: 'analyst', portal: analystGrants, platform: [], global: false },
      { role: 'curator', portal: curatorGrants, platform: [], global: false },
      { role: 'portal-admin', portal: portalAdminGrants, platform: [], global: false },
      {
        role: 'platform-admin',
        portal: portalAdminGrants,
        platform: ['portal.create', 'audit.read', 'audit.export'],
        global: true,
      },
      {
        role: 'owner',
        portal: portalAdminGrants,
        platform: [
          'portal.create',
          'audit.read',
          'audit.export',
          'portal.delete',
          'platform.members.manage',
          'platform.settings.write',
        ],
        global: true,
      },
    ]
    const locations = [
      { kind: 'platform' },
      { kind: 'portal', slug: 'alpha' },
      { kind: 'portal', slug: 'beta' },
    ] as const
    let decisions = 0
    for (const fixture of fixtures) {
      const roles = fixture.global
        ? { platformRole: fixture.role, portalRoles: [] }
        : { portalRoles: [{ slug: 'alpha', role: fixture.role }] }
      const principal = normalisePrincipal(user, roles)
      expect(principal).not.toBeNull()
      for (const permission of decisionPermissions) {
        for (const scope of locations) {
          const expected = scope.kind === 'platform'
            ? fixture.platform.includes(permission)
            : (fixture.global || scope.slug === 'alpha') && fixture.portal.includes(permission)
          expect({
            role: fixture.role,
            permission,
            scope,
            allowed: authorize(principal, permission, scope),
          })
            .toEqual({ role: fixture.role, permission, scope, allowed: expected })
          decisions++
        }
      }
    }
    expect(decisions).toBe(396)
  })
})

describe('independent complete D2 tables', () => {
  it('checks every permission for each unassigned identity and policy boundary', () => {
    const fixtures = [
      { identity: anonymous, policy: publicPolicy, viewer: true },
      { identity: user, policy: publicPolicy, viewer: true },
      { identity: { ...user, tenantId: 'other' }, policy: publicPolicy, viewer: true },
      {
        identity: anonymous,
        policy: { ...publicPolicy, accessMode: 'authenticated' },
        viewer: false,
      },
      { identity: anonymous, policy: { ...publicPolicy, accessMode: 'restricted' }, viewer: false },
      { identity: anonymous, policy: undefined, viewer: false },
      { identity: user, policy: { ...publicPolicy, accessMode: 'authenticated' }, viewer: true },
      {
        identity: { ...user, tenantId: 'other' },
        policy: { ...publicPolicy, accessMode: 'authenticated' },
        viewer: false,
      },
      {
        identity: { ...user, tenantId: 'Tenant-a' },
        policy: { ...publicPolicy, accessMode: 'authenticated' },
        viewer: false,
      },
      { identity: user, policy: { ...publicPolicy, accessMode: 'restricted' }, viewer: false },
      { identity: user, policy: undefined, viewer: false },
    ]
    for (const fixture of fixtures) {
      const principal = normalisePrincipal(fixture.identity, noRoles, fixture.policy)
      expect(principal).not.toBeNull()
      for (const permission of decisionPermissions) {
        expect(authorize(principal, permission, alpha)).toBe(
          fixture.viewer && viewerGrants.includes(permission),
        )
        expect(authorize(principal, permission, { kind: 'portal', slug: 'beta' })).toBe(false)
        expect(authorize(principal, permission, platform)).toBe(false)
      }
    }
    for (const identity of [anonymous, user]) {
      const principal = normalisePrincipal(identity, noRoles, { ...publicPolicy, slug: 'beta' })
      for (const permission of decisionPermissions) {
        expect(authorize(principal, permission, alpha)).toBe(false)
        expect(authorize(principal, permission, { kind: 'portal', slug: 'beta' })).toBe(
          viewerGrants.includes(permission),
        )
      }
    }
  })

  it('preserves each explicit role despite absent, restricted or different-tenant policy', () => {
    for (
      const [role, grants] of [
        ['viewer', viewerGrants],
        ['analyst', analystGrants],
        ['curator', curatorGrants],
        ['portal-admin', portalAdminGrants],
      ] as const
    ) {
      const roles = { portalRoles: [{ slug: 'alpha', role }] }
      for (
        const policy of [
          undefined,
          publicPolicy,
          { ...publicPolicy, accessMode: 'restricted' },
          { ...publicPolicy, accessMode: 'authenticated' },
          { ...publicPolicy, accessMode: 'authenticated', configuredTenantId: 'other' },
        ]
      ) {
        const principal = normalisePrincipal(user, roles, policy)
        expect(principal?.effectiveRoles).toEqual(roles)
        for (const permission of decisionPermissions) {
          expect(authorize(principal, permission, alpha)).toBe(grants.includes(permission))
        }
      }
    }
  })

  it('denies manually forged anonymous contexts and unsupported identity kinds', () => {
    const contexts = [
      {
        identity: anonymous,
        effectiveRoles: { ...noRoles, platformRole: 'owner' },
        portalPolicy: publicPolicy,
      },
      {
        identity: anonymous,
        effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'analyst' }] },
        portalPolicy: publicPolicy,
      },
      { identity: anonymous, effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'viewer' }] } },
      {
        identity: anonymous,
        effectiveRoles: { portalRoles: [{ slug: 'beta', role: 'viewer' }] },
        portalPolicy: publicPolicy,
      },
      {
        identity: anonymous,
        effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'viewer' }] },
        portalPolicy: { ...publicPolicy, accessMode: 'restricted' },
      },
    ]
    for (const identity of [{ kind: 'key', slug: 'alpha', role: 'viewer' }, { kind: 'system' }]) {
      expect(normalisePrincipal(identity, noRoles, publicPolicy)).toBeNull()
      contexts.push({
        identity,
        effectiveRoles: { ...noRoles, platformRole: 'owner' },
        portalPolicy: publicPolicy,
      })
    }
    for (const principal of contexts) {
      for (const permission of decisionPermissions) {
        for (const scope of [alpha, platform]) {
          expect(authorize(principal, permission, scope)).toBe(false)
        }
      }
    }
  })
})

describe('explicit D2 principal normalisation', () => {
  it('requires contextual authority and exactly three evaluator arguments', () => {
    expect(authorize.length).toBe(3)
    expect(authorize(anonymous, 'portal.read', alpha)).toBe(false)
    expect(authorize(user, 'portal.read', alpha)).toBe(false)
    for (const identity of [anonymous, user]) {
      const principal = normalisePrincipal(identity, noRoles)
      expect(principal).toEqual({ identity, effectiveRoles: noRoles })
      expect(authorize(principal, 'portal.read', alpha)).toBe(false)
    }
  })

  it('adds only viewer on the exact public policy slug for anonymous and signed identities', () => {
    for (const identity of [anonymous, user, { ...user, tenantId: 'other-tenant' }]) {
      const principal = normalisePrincipal(identity, noRoles, publicPolicy)
      expect(principal).toEqual({
        identity,
        effectiveRoles: { portalRoles: [{ slug: 'alpha', role: 'viewer' }] },
        portalPolicy: publicPolicy,
      })
      for (const permission of PERMISSIONS) {
        expect(authorize(principal, permission, alpha)).toBe(
          permission === 'portal.read' || permission === 'portal.ask',
        )
        expect(authorize(principal, permission, { kind: 'portal', slug: 'beta' })).toBe(false)
        expect(authorize(principal, permission, platform)).toBe(false)
      }
    }
  })

  it('requires exact configured tenant equality for authenticated implicit viewer', () => {
    const policy = { ...publicPolicy, accessMode: 'authenticated' }
    expect(authorize(normalisePrincipal(user, noRoles, policy), 'portal.ask', alpha)).toBe(true)
    for (
      const identity of [anonymous, { ...user, tenantId: 'Tenant-a' }, {
        ...user,
        tenantId: 'tenant-a ',
      }]
    ) {
      const principal = normalisePrincipal(identity, noRoles, policy)
      expect(principal?.effectiveRoles).toEqual(noRoles)
      expect(authorize(principal, 'portal.read', alpha)).toBe(false)
    }
  })

  it('adds no implicit authority for restricted portals', () => {
    for (const identity of [anonymous, user]) {
      const principal = normalisePrincipal(identity, noRoles, {
        ...publicPolicy,
        accessMode: 'restricted',
      })
      expect(principal?.effectiveRoles).toEqual(noRoles)
      for (const permission of PERMISSIONS) {
        expect(authorize(principal, permission, alpha)).toBe(false)
      }
    }
  })

  it('preserves higher explicit roles, unrelated assignments and platform authority', () => {
    const roles = {
      platformRole: 'owner',
      portalRoles: [{ slug: 'alpha', role: 'curator' }, { slug: 'beta', role: 'analyst' }],
    }
    for (
      const policy of [undefined, publicPolicy, { ...publicPolicy, accessMode: 'authenticated' }, {
        ...publicPolicy,
        accessMode: 'restricted',
      }]
    ) {
      const principal = normalisePrincipal(user, roles, policy)
      expect(principal?.effectiveRoles).toEqual(roles)
      expect(authorize(principal, 'portal.delete', platform)).toBe(true)
    }
    const assigned = { portalRoles: [{ slug: 'alpha', role: 'curator' }] }
    const wrongTenant = normalisePrincipal({ ...user, tenantId: 'other' }, assigned, {
      ...publicPolicy,
      accessMode: 'authenticated',
    })
    expect(authorize(wrongTenant, 'content.write', alpha)).toBe(true)
    expect(
      normalisePrincipal(user, assigned, { ...publicPolicy, slug: 'beta' })?.effectiveRoles
        .portalRoles,
    ).toEqual([
      { slug: 'alpha', role: 'curator' },
      { slug: 'beta', role: 'viewer' },
    ])
  })

  it('rejects all anonymous explicit assignments, even viewer with public policy', () => {
    for (const role of PORTAL_ROLES) {
      expect(
        normalisePrincipal(anonymous, { portalRoles: [{ slug: 'alpha', role }] }, publicPolicy),
      ).toBeNull()
    }
    for (const platformRole of PLATFORM_ROLES) {
      expect(normalisePrincipal(anonymous, { ...noRoles, platformRole }, publicPolicy)).toBeNull()
    }
  })

  it('rejects malformed inputs without retaining a permissive subset', () => {
    for (
      const identity of [null, {}, { ...anonymous, isAdmin: true }, { ...user, tenantId: '' }, {
        kind: 'key',
      }, { kind: 'system' }]
    ) {
      expect(normalisePrincipal(identity, noRoles, publicPolicy)).toBeNull()
    }
    for (
      const roles of [null, {}, { ...noRoles, platformRole: 'unknown' }, {
        platformRole: 'owner',
        portalRoles: [{ slug: 'alpha', role: 'unknown' }],
      }]
    ) {
      expect(normalisePrincipal(user, roles, publicPolicy)).toBeNull()
    }
    for (
      const policy of [null, {}, { ...publicPolicy, accessMode: 'unknown' }, {
        ...publicPolicy,
        configuredTenantId: '',
      }]
    ) {
      expect(normalisePrincipal(user, { ...noRoles, platformRole: 'owner' }, policy)).toBeNull()
    }
  })

  it('returns fresh contextual objects without mutating input authority', () => {
    const roles = { portalRoles: [{ slug: 'beta', role: 'curator' }] }
    const before = structuredClone({ user, roles, publicPolicy })
    const principal = normalisePrincipal(user, roles, publicPolicy)
    expect({ user, roles, publicPolicy }).toEqual(before)
    expect(principal?.identity).not.toBe(user)
    expect(principal?.effectiveRoles).not.toBe(roles)
    expect(principal?.effectiveRoles.portalRoles[0]).not.toBe(roles.portalRoles[0])
    expect(principal?.portalPolicy).not.toBe(publicPolicy)
  })
})

describe('D1 permission boundaries', () => {
  it('grants each portal role its boundary and denies the next level or platform-only action', () => {
    const cases = [
      ['viewer', 'portal.ask', 'portal.generate'],
      ['analyst', 'portal.watch', 'content.write'],
      ['curator', 'graph.write', 'behaviour.write'],
      ['portal-admin', 'members.manage', 'portal.create'],
    ] as const
    for (const [role, allowed, denied] of cases) {
      const principal = normalisePrincipal(user, { portalRoles: [{ slug: 'alpha', role }] })
      expect(authorize(principal, allowed, alpha)).toBe(true)
      expect(authorize(principal, denied, alpha)).toBe(false)
      expect(authorize(principal, allowed, { kind: 'portal', slug: 'beta' })).toBe(false)
    }
  })

  it('grants platform roles in their domain and implies portal-admin on future portals', () => {
    for (const platformRole of PLATFORM_ROLES) {
      const principal = normalisePrincipal(user, { ...noRoles, platformRole })
      expect(authorize(principal, 'portal.create', platform)).toBe(true)
      expect(authorize(principal, 'portal.delete', platform)).toBe(platformRole === 'owner')
      expect(authorize(principal, 'platform.members.manage', platform)).toBe(
        platformRole === 'owner',
      )
      expect(authorize(principal, 'platform.settings.write', platform)).toBe(
        platformRole === 'owner',
      )
      expect(authorize(principal, 'members.manage', { kind: 'portal', slug: 'future' })).toBe(true)
      expect(authorize(principal, 'portal.read', platform)).toBe(false)
      expect(authorize(principal, 'portal.delete', alpha)).toBe(false)
    }
  })

  it('keeps both audit permissions independently scoped', () => {
    const portalAdmin = normalisePrincipal(user, {
      portalRoles: [{ slug: 'alpha', role: 'portal-admin' }],
    })
    const curator = normalisePrincipal(user, { portalRoles: [{ slug: 'alpha', role: 'curator' }] })
    const platformAdmin = normalisePrincipal(user, { ...noRoles, platformRole: 'platform-admin' })
    for (const permission of ['audit.read', 'audit.export']) {
      expect(authorize(portalAdmin, permission, alpha)).toBe(true)
      expect(authorize(portalAdmin, permission, platform)).toBe(false)
      expect(authorize(curator, permission, alpha)).toBe(false)
      expect(authorize(platformAdmin, permission, alpha)).toBe(true)
      expect(authorize(platformAdmin, permission, platform)).toBe(true)
    }
  })

  it('validates the whole input before platform authority can grant anything', () => {
    const owner = { identity: user, effectiveRoles: { ...noRoles, platformRole: 'owner' } }
    for (
      const principal of [
        null,
        undefined,
        {},
        { ...owner, extra: true },
        { ...owner, identity: { ...user, tenantId: '' } },
        {
          ...owner,
          effectiveRoles: {
            platformRole: 'owner',
            portalRoles: [{ slug: 'beta', role: 'unknown' }],
          },
        },
        { ...owner, portalPolicy: { ...publicPolicy, accessMode: 'unknown' } },
        { ...owner, identity: anonymous },
      ]
    ) expect(authorize(principal, 'portal.create', platform)).toBe(false)
    for (const permission of [null, undefined, '', 'unknown', 'constructor', '*', {}]) {
      expect(authorize(owner, permission, platform)).toBe(false)
    }
    for (
      const scope of [null, undefined, {}, { kind: 'portal', slug: '' }, {
        kind: 'platform',
        slug: 'alpha',
      }]
    ) {
      expect(authorize(owner, 'portal.create', scope)).toBe(false)
    }
  })
})

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
