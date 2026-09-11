import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  ACCESS_MODES,
  authorize,
  normalisePrincipal,
  PERMISSIONS,
  PLATFORM_ROLES,
  PORTAL_ROLES,
  ROLES,
} from './rbac.ts'

// Finite test domain copied from the decision contract, not production grant data.
const permissions = [
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
const portalRoles = ['viewer', 'analyst', 'curator', 'portal-admin']
const platformRoles = ['platform-admin', 'owner']
const slugs = [
  'alpha',
  'beta',
  'Alpha',
  'alpha-1',
  'alpha_1',
  'a.b',
  'constructor',
  '__proto__',
  'toString',
]
const identity = { kind: 'user', tenantId: 'tenant-a', oid: 'user-a' }
const policy = { slug: 'alpha', accessMode: 'public', configuredTenantId: 'tenant-a' }
const alpha = { kind: 'portal', slug: 'alpha' }
const platform = { kind: 'platform' }
const scopes = [platform, alpha, { kind: 'portal', slug: 'beta' }]

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('bounded authorisation properties', () => {
  it('preserves every lower-role allowance for every ordered pair within both domains', () => {
    let comparisons = 0
    for (const [domain, roles] of [['portal', portalRoles], ['platform', platformRoles]] as const) {
      for (let lower = 0; lower < roles.length; lower++) {
        for (let higher = lower; higher < roles.length; higher++) {
          const principal = (role: string | undefined) =>
            normalisePrincipal(
              identity,
              domain === 'portal'
                ? { portalRoles: [{ slug: 'alpha', role }] }
                : { platformRole: role, portalRoles: [] },
            )
          const low = principal(roles[lower])
          const high = principal(roles[higher])
          expect(low).not.toBeNull()
          expect(high).not.toBeNull()
          for (const permission of permissions) {
            for (const scope of scopes) {
              const allowed = authorize(low, permission, scope)
              expect(!allowed || authorize(high, permission, scope)).toBe(true)
              comparisons++
            }
          }
        }
      }
    }
    expect(comparisons).toBe(858)
  })

  it('implies full portal authority on every generated exact slug for both platform roles', () => {
    const portalPermissions = [
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
    for (const platformRole of platformRoles) {
      const principal = normalisePrincipal(identity, { platformRole, portalRoles: [] })
      for (const slug of slugs) {
        for (const permission of permissions) {
          expect(authorize(principal, permission, { kind: 'portal', slug })).toBe(
            portalPermissions.includes(permission),
          )
        }
      }
    }
  })

  it('isolates all distinct slug pairs including object property names and case variants', () => {
    let pairs = 0
    for (const assigned of slugs) {
      for (const other of slugs) {
        if (assigned === other) continue
        for (const role of portalRoles) {
          const principal = normalisePrincipal(identity, {
            portalRoles: [{ slug: assigned, role }],
          })
          expect(authorize(principal, 'portal.read', { kind: 'portal', slug: assigned })).toBe(true)
          for (const permission of permissions) {
            expect(authorize(principal, permission, { kind: 'portal', slug: other })).toBe(false)
          }
        }
        pairs++
      }
    }
    expect(pairs).toBe(72)
  })

  it('is invariant to assignment order and rejects duplicate exact slugs rather than merging', () => {
    const assignments = slugs.map((slug, index) => ({
      slug,
      role: portalRoles[index % portalRoles.length],
    }))
    const forward = normalisePrincipal(identity, { portalRoles: assignments })
    const reversed = normalisePrincipal(identity, { portalRoles: [...assignments].reverse() })
    expect(forward).not.toBeNull()
    expect(reversed).not.toBeNull()
    for (const slug of slugs) {
      for (const permission of permissions) {
        expect(authorize(forward, permission, { kind: 'portal', slug })).toBe(
          authorize(reversed, permission, { kind: 'portal', slug }),
        )
      }
      for (const first of portalRoles) {
        for (const second of portalRoles) {
          const roles = {
            platformRole: 'owner',
            portalRoles: [{ slug, role: first }, { slug, role: second }],
          }
          expect(normalisePrincipal(identity, roles)).toBeNull()
          expect(authorize({ identity, effectiveRoles: roles }, 'portal.create', platform)).toBe(
            false,
          )
        }
      }
    }
  })

  it('is deterministic on frozen inputs and leaves previous outputs and all inputs untouched', () => {
    const inputs = deepFreeze({
      identity: structuredClone(identity),
      roles: { portalRoles: [{ slug: 'beta', role: 'analyst' }] },
      policy: structuredClone(policy),
      scopes: structuredClone(scopes),
    })
    const before = structuredClone(inputs)
    const first = normalisePrincipal(inputs.identity, inputs.roles, inputs.policy)
    expect(first).not.toBeNull()
    const outputBefore = structuredClone(first)
    deepFreeze(first)
    for (let repeat = 0; repeat < 5; repeat++) {
      const next = normalisePrincipal(inputs.identity, inputs.roles, inputs.policy)
      expect(next).toEqual(outputBefore)
      expect(next).not.toBe(first)
      for (const scope of inputs.scopes) {
        for (const permission of permissions) {
          expect(authorize(first, permission, scope)).toBe(authorize(next, permission, scope))
        }
      }
      expect(first).toEqual(outputBefore)
      expect(inputs).toEqual(before)
    }
  })

  it('resists mutations of every exported catalogue without changing contents or decisions', () => {
    const catalogues = [
      [PORTAL_ROLES, portalRoles],
      [PLATFORM_ROLES, platformRoles],
      [ROLES, [...portalRoles, ...platformRoles]],
      [ACCESS_MODES, ['public', 'authenticated', 'restricted']],
      [PERMISSIONS, permissions],
    ] as const
    for (const [catalogue, expected] of catalogues) {
      const mutations = [
        () => Reflect.set(catalogue, '0', 'unknown'),
        () => Reflect.set(catalogue, 'length', 0),
        () => Reflect.deleteProperty(catalogue, '0'),
        () => Reflect.defineProperty(catalogue, '0', { value: 'unknown' }),
        () => Array.prototype.push.call(catalogue, 'unknown'),
        () => Array.prototype.reverse.call(catalogue),
      ]
      for (const mutate of mutations) {
        try {
          mutate()
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError)
        }
        expect(catalogue).toEqual(expected)
      }
    }
    const viewer = normalisePrincipal(identity, {
      portalRoles: [{ slug: 'alpha', role: 'viewer' }],
    })
    for (const permission of permissions) {
      expect(authorize(viewer, permission, alpha)).toBe(
        ['portal.read', 'portal.ask'].includes(permission),
      )
    }
    const owner = normalisePrincipal(identity, { platformRole: 'owner', portalRoles: [] })
    expect(authorize(owner, 'portal.delete', platform)).toBe(true)
    expect(authorize(owner, 'portal.delete', alpha)).toBe(false)
  })
})

describe('bounded malformed input mutations', () => {
  const scalars = [null, undefined, false, true, 0, 1, '', 'unknown', [], [identity]]
  const ownerRoles = { platformRole: 'owner', portalRoles: [] }
  const owner = { identity, effectiveRoles: ownerRoles }

  it('rejects malformed identity and authority at every nested level even when owner is present', () => {
    const identities = [
      ...scalars,
      {},
      { kind: 'user' },
      { kind: 'unknown' },
      { kind: 'key' },
      { kind: 'system' },
      { ...identity, oid: '' },
      { ...identity, oid: 1 },
      { ...identity, tenantId: '' },
      { ...identity, tenantId: false },
      { ...identity, extra: true },
      { kind: 'anonymous', extra: true },
    ]
    for (const invalid of identities) {
      expect(normalisePrincipal(invalid, ownerRoles, policy)).toBeNull()
      expect(authorize({ ...owner, identity: invalid }, 'portal.create', platform)).toBe(false)
    }
    const entries = [
      ...scalars,
      {},
      { slug: 'alpha' },
      { role: 'viewer' },
      { slug: '', role: 'viewer' },
      { slug: 1, role: 'viewer' },
      { slug: 'alpha', role: false },
      { slug: 'alpha', role: 'unknown' },
      { slug: 'alpha', role: 'owner' },
      { slug: 'alpha', role: 'platform-admin' },
      { slug: 'alpha', role: 'viewer', extra: true },
    ]
    const roles = [
      ...scalars,
      {},
      { platformRole: 'owner' },
      { ...ownerRoles, extra: true },
      ...[null, false, 0, '', 'unknown', ...portalRoles].map((platformRole) => ({
        ...ownerRoles,
        platformRole,
      })),
      ...scalars.filter((value) => !Array.isArray(value) || value.length > 0)
        .map((portalRoles) => ({ platformRole: 'owner', portalRoles })),
      ...entries.map((entry) => ({
        platformRole: 'owner',
        portalRoles: [{ slug: 'beta', role: 'viewer' }, entry],
      })),
    ]
    for (const invalid of roles) {
      expect(normalisePrincipal(identity, invalid, policy)).toBeNull()
      expect(authorize({ ...owner, effectiveRoles: invalid }, 'portal.create', platform)).toBe(
        false,
      )
    }
  })

  it('rejects malformed policy, whole context, scope and permission without throwing', () => {
    const policies = [
      ...scalars.filter((value) => value !== undefined),
      {},
      { slug: 'alpha', accessMode: 'public' },
      { ...policy, slug: '' },
      { ...policy, slug: 1 },
      { ...policy, accessMode: 'unknown' },
      { ...policy, accessMode: false },
      { ...policy, configuredTenantId: '' },
      { ...policy, configuredTenantId: 1 },
      { ...policy, extra: true },
    ]
    for (const invalid of policies) {
      expect(normalisePrincipal(identity, ownerRoles, invalid)).toBeNull()
      expect(authorize({ ...owner, portalPolicy: invalid }, 'portal.create', platform)).toBe(false)
    }
    for (
      const invalid of [...scalars, {}, identity, { identity }, { effectiveRoles: ownerRoles }, {
        ...owner,
        extra: true,
      }]
    ) {
      expect(authorize(invalid, 'portal.create', platform)).toBe(false)
    }
    for (
      const invalid of [
        ...scalars,
        {},
        { kind: 'unknown' },
        { kind: 'portal' },
        { ...alpha, slug: '' },
        { ...alpha, slug: 1 },
        { ...alpha, extra: true },
        { ...platform, slug: 'alpha' },
      ]
    ) {
      expect(authorize(owner, 'portal.create', invalid)).toBe(false)
    }
    for (
      const invalid of [...scalars, {}, 'constructor', '__proto__', 'toString', 'portal.READ', '*']
    ) {
      expect(authorize(owner, invalid, platform)).toBe(false)
    }
  })
})
