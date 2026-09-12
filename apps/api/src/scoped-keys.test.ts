import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { inspectScopedKeys, issueScopedKey, verifyScopedKey } from './scoped-keys.ts'

Deno.test('scoped keys prepare hash-only storage and verify exact bounded authority', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'analyst' },
      f.creator,
      deps,
    )
    expect(prepared.key).toMatch(/^ck_[A-Za-z0-9_-]{43}$/)
    expect(atob(prepared.key.slice(3).replace(/-/g, '+').replace(/_/g, '/')).length).toBe(32)
    expect(f.stores.mcpKeys.list('a')).toEqual([])
    prepared.commit()
    expect(() => prepared.commit()).toThrow()
    expect(JSON.stringify(f.stores.mcpKeys.list('a'))).not.toContain(prepared.key)
    expect(f.stores.mcpKeys.list('a')[0]?.expiresAt).toBeNull()
    expect(await verifyScopedKey(prepared.key, 'a', deps)).toMatchObject({
      kind: 'key',
      slug: 'a',
      role: 'analyst',
      actor: { kind: 'key' },
    })
    expect(await verifyScopedKey(prepared.key, 'b', deps)).toBeNull()
    const inspected = await inspectScopedKeys('a', deps)
    expect(inspected[0]).toMatchObject({ status: 'active', effectiveRole: 'analyst' })
    expect(JSON.stringify(inspected)).not.toContain('hash')
    expect(JSON.stringify(inspected)).not.toContain(prepared.key)
  } finally {
    f.close()
  }
})

Deno.test('scoped key preparations recheck limits and authority before mutation', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    const input = { slug: 'a', label: 'Research', role: 'viewer' }
    const delayed = await issueScopedKey(input, f.creator, deps)
    for (let i = 0; i < 20; i++) (await issueScopedKey(input, f.creator, deps)).commit()
    expect(() => delayed.commit()).toThrow('key_limit')
    await expect(issueScopedKey(input, f.creator, deps)).rejects.toThrow('key_limit')
    f.stores.mcpKeys.revoke('a', f.stores.mcpKeys.list('a')[0]!.id, new Date(f.now()).toISOString())
    const fresh = await issueScopedKey(input, f.creator, deps)
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const assignment = service.list().find((row) => row.subjectId === f.creator.oid)!
    service.remove(assignment.id, { requestId: 'remove', actor: { kind: 'system' } })
    expect(() => fresh.commit()).toThrow('forbidden')
    expect(f.stores.mcpKeys.list('a')).toHaveLength(20)
  } finally {
    f.close()
  }
})

Deno.test('scoped keys reject malformed digests and inert legacy creators without caller substitution', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    const legacy = 'ck_mcp_abcdefghijkl_' + 'x'.repeat(43)
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy))),
    ].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    f.stores.mcpKeys.add({
      id: 'legacy',
      tenant: 'a',
      issuerUserId: f.creator.oid,
      label: 'Legacy',
      prefix: 'ck_mcp_abcdefghijkl',
      hash,
      createdAt: new Date(f.now()).toISOString(),
      revokedAt: null,
    })
    expect(await verifyScopedKey(legacy, 'a', deps)).toBeNull()
    expect((await inspectScopedKeys('a', deps))[0]?.status).toBe('unproven_creator')
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'viewer' },
      f.creator,
      deps,
    )
    prepared.commit()
    for (
      const token of [
        '',
        'Bearer ' + prepared.key,
        prepared.key + '=',
        prepared.key.slice(0, -1),
        'ck_' + 'x'.repeat(43),
      ]
    ) expect(await verifyScopedKey(token, 'a', deps)).toBeNull()
    const row = f.stores.mcpKeys.list('a')[1]!
    expect(
      await verifyScopedKey(prepared.key, 'a', {
        ...deps,
        keys: {
          list: (slug) => deps.keys.list(slug),
          add: (record) => deps.keys.add(record),
          revoke: (slug, id, at) => deps.keys.revoke(slug, id, at),
          findByPrefix: (slug, prefix) => deps.keys.findByPrefix(slug, prefix),
          findByHash: () => ({ ...row, hash: 'f'.repeat(64) }),
        },
      }),
    ).toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('scoped key app evidence expires at original time while local grants remain authoritative', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    const owner = f.sessionFor('owner')
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'curator' },
      owner,
      deps,
    )
    prepared.commit()
    f.advance(owner.expiresAt - f.now())
    expect(await verifyScopedKey(prepared.key, 'a', deps)).toBeNull()
    expect((await inspectScopedKeys('a', deps))[0]?.status).toBe('creator_no_access')
    f.rbac.assignmentService(f.tenantId, f.audience).create({
      subjectKind: 'active-oid',
      subjectId: owner.oid,
      scope: { kind: 'portal', slug: 'a' },
      role: 'viewer',
    }, { requestId: 'local', actor: { kind: 'system' } })
    expect((await verifyScopedKey(prepared.key, 'a', deps))?.role).toBe('viewer')
    expect(await verifyScopedKey(prepared.key, 'b', deps)).toBeNull()
  } finally {
    f.close()
  }
})

Deno.test('scoped issuance rejects unverified creators, elevation and invalid expiry without writes', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    for (const session of [null, f.otherTenant, f.unassigned, { ...f.creator, verified: false }]) {
      await expect(issueScopedKey({ slug: 'a', label: 'Research', role: 'viewer' }, session, deps))
        .rejects.toThrow()
    }
    await expect(
      issueScopedKey(
        { slug: 'a', label: 'Research', role: 'curator' },
        f.sessionFor('viewer'),
        deps,
      ),
    ).rejects.toThrow()
    for (
      const expiresAt of [
        '2027-01-01',
        new Date(f.now()).toISOString(),
        '2027-01-01T00:00:00Z',
        null,
      ]
    ) {
      await expect(
        issueScopedKey(
          { slug: 'a', label: 'Research', role: 'viewer', expiresAt },
          f.creator,
          deps,
        ),
      ).rejects.toThrow()
    }
    expect(f.stores.mcpKeys.list('a')).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('scoped key creator downgrade, removal, expiry and revocation apply on the next use', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = {
      keys: f.stores.mcpKeys,
      creatorStores: { rbac: f.rbac, audience: f.audience },
      configuredTenantId: f.tenantId,
      now: f.now,
    }
    const prepared = await issueScopedKey(
      {
        slug: 'a',
        label: 'Research',
        role: 'curator',
        expiresAt: new Date(f.now() + 10_000).toISOString(),
      },
      f.creator,
      deps,
    )
    prepared.commit()
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const assignment = service.list().find((row) => row.subjectId === f.creator.oid)!
    const context = { requestId: 'key-change', actor: { kind: 'system' as const } }
    expect(service.change(assignment.id, { role: 'viewer' }, context).ok).toBe(true)
    expect((await verifyScopedKey(prepared.key, 'a', deps))?.role).toBe('viewer')
    expect(service.remove(assignment.id, context).ok).toBe(true)
    expect(await verifyScopedKey(prepared.key, 'a', deps)).toBeNull()
    expect((await inspectScopedKeys('a', deps))[0]?.status).toBe('creator_no_access')
    f.advance(10_000)
    expect((await inspectScopedKeys('a', deps))[0]?.status).toBe('expired')
    f.stores.mcpKeys.revoke('a', prepared.credential.id, new Date(f.now()).toISOString())
    expect((await inspectScopedKeys('a', deps))[0]?.status).toBe('revoked')
  } finally {
    f.close()
  }
})
