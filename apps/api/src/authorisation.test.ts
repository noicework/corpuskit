import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { issueScopedKey } from './scoped-keys.ts'
import {
  authoriseOperation,
  authoriseSubActions,
  researchOwner,
  selectRequestAuthority,
} from './authorisation.ts'
import { AuditWriteError } from './audit.ts'

function dependencies(f: ReturnType<typeof createEnforcementFixture>) {
  return f.authorityDependencies({ passcode: 'test-only', environment: 'development' })
}
const policy = (slug = 'a', accessMode = 'restricted') => ({
  slug,
  accessMode,
  configuredTenantId: 'tenant-1',
})
const scope = { kind: 'portal' as const, slug: 'a' }

Deno.test('session authority is immutable and missing trusted state cannot borrow legacy claims', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const context = await f.contextFor(f.sessionFor('viewer'))
    const authority = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      context,
      deps,
    )
    context.effectiveRoles!.platformRole = 'owner'
    expect(authority.kind).toBe('session')
    if (authority.kind === 'session') {
      expect(() => authority.effectiveRoles.platformRole = 'owner').toThrow()
      expect(() => authority.session.oid = 'other').toThrow()
    }
    expect(() => authoriseOperation(authority, 'portal.create', { kind: 'platform' })).toThrow()
    const missing = await f.contextFor(f.creator)
    delete missing.effectiveRoles
    await expect(selectRequestAuthority(new Request('http://local/api/t/a/search'), missing, deps))
      .rejects.toThrow('forbidden')
    const forged = await f.contextFor(null)
    const anonymous = await selectRequestAuthority(
      new Request('http://local/api/t/a/search', {
        headers: { 'x-corpuskit-sso-admin': '1', 'x-corpuskit-sso-user-id': f.creator.oid },
      }),
      forged,
      deps,
    )
    expect(anonymous.kind).toBe('anonymous')
    expect(() => authoriseOperation(anonymous, 'portal.read', scope, policy())).toThrow()
  } finally {
    f.close()
  }
})

Deno.test('missing, disabled and corrupt portals deny even owner authority and valid keys', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const key = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'viewer' },
      f.creator,
      deps,
    )
    key.commit()
    for (const slug of ['missing', 'disabled', 'corrupt']) {
      const authority = await selectRequestAuthority(
        new Request(`http://local/api/t/${slug}/search`),
        await f.contextFor(f.sessionFor('owner')),
        deps,
      )
      expect(() =>
        authoriseOperation(
          authority,
          'portal.read',
          { kind: 'portal', slug },
          policy(slug, 'public'),
        )
      ).toThrow()
      await expect(
        selectRequestAuthority(
          new Request(`http://local/api/t/${slug}/search`, {
            headers: { authorization: `Bearer ${key.key}` },
          }),
          await f.contextFor(f.sessionFor('owner')),
          deps,
        ),
      ).rejects.toThrow()
    }
    const unknown = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      await f.contextFor(f.creator),
      deps,
    )
    expect(() => authoriseOperation(unknown, 'invented.permission', scope, policy())).toThrow(
      'forbidden',
    )
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('expired and revoked keys never become public viewers or inherit an ambient session', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const creator = f.sessionFor('owner')
    const key = await issueScopedKey(
      {
        slug: 'public-a',
        label: 'Research',
        role: 'viewer',
        expiresAt: new Date(f.now() + 1).toISOString(),
      },
      creator,
      deps,
    )
    key.commit()
    f.advance(1)
    for (const session of [null, creator]) {
      const context = await f.contextFor(session)
      await expect(
        selectRequestAuthority(
          new Request('http://local/api/t/public-a/mcp', {
            headers: { authorization: `Bearer ${key.key}` },
          }),
          context,
          deps,
        ),
      ).rejects.toThrow()
      expect(context.denialAudited).toBe(true)
    }
    const revoked = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'viewer' },
      creator,
      deps,
    )
    revoked.commit()
    f.stores.mcpKeys.revoke('a', revoked.credential.id, new Date(f.now()).toISOString())
    await expect(
      selectRequestAuthority(
        new Request('http://local/api/t/a/mcp', {
          headers: { authorization: `Bearer ${revoked.key}` },
        }),
        await f.contextFor(creator),
        deps,
      ),
    ).rejects.toThrow()
  } finally {
    f.close()
  }
})

Deno.test('sub-action checks gate dispatch and sessionless break-glass cannot acquire research ownership', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const authorised = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      await f.contextFor(f.sessionFor('curator')),
      deps,
    )
    let calls = 0
    authoriseSubActions(
      authorised,
      [{ permission: 'portal.read', scope: 'portal' }, {
        permission: 'content.write',
        scope: 'portal',
      }],
      scope,
      policy(),
    )
    calls++
    expect(calls).toBe(1)
    const viewer = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      await f.contextFor(f.sessionFor('viewer')),
      deps,
    )
    expect(() => {
      authoriseSubActions(
        viewer,
        [{ permission: 'portal.read', scope: 'portal' }, {
          permission: 'content.write',
          scope: 'portal',
        }],
        scope,
        policy(),
      )
      calls++
    }).toThrow('forbidden')
    expect(calls).toBe(1)
    const glass = await selectRequestAuthority(
      new Request('http://local/api/t/a/search', { headers: { 'x-admin-passcode': 'test-only' } }),
      await f.contextFor(null),
      deps,
    )
    expect(authoriseOperation(glass, 'content.write', scope, policy())).toBe(true)
    expect(() => researchOwner(glass, policy(), 'browser')).toThrow('forbidden')
    const fresh = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      await f.contextFor(f.creator),
      deps,
    )
    expect(() => authoriseOperation(fresh, 'portal.delete', scope, policy())).toThrow('forbidden')
  } finally {
    f.close()
  }
})

Deno.test('authority selection keeps a key separate from ambient owner and selects once', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const key = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'viewer' },
      f.creator,
      deps,
    )
    key.commit()
    const request = new Request('http://local/api/t/a/search', {
      headers: { authorization: `Bearer ${key.key}` },
    })
    const context = await f.contextFor(f.sessionFor('owner'))
    const authority = await selectRequestAuthority(request, context, deps)
    expect(authority.kind).toBe('key')
    expect('session' in authority).toBe(false)
    expect(await selectRequestAuthority(request, context, deps)).toBe(authority)
    expect(authoriseOperation(authority, 'portal.read', scope, policy())).toBe(true)
    expect(() => researchOwner(authority, policy(), 'browser')).toThrow()
    expect(() => authoriseOperation(authority, 'content.write', scope, policy())).toThrow()
    f.assertNoProtectedDispatch()
    expect(f.rbac.audit.read({ scope: { kind: 'platform' }, requestId: context.requestId }))
      .toHaveLength(1)
  } finally {
    f.close()
  }
})

Deno.test('explicit credentials deny without fallback on every disallowed path or malformed combination', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const key = await issueScopedKey(
      { slug: 'a', label: 'Research', role: 'viewer' },
      f.creator,
      deps,
    )
    key.commit()
    for (
      const path of [
        '/api/admin/t/a/overview',
        '/api/tenants',
        '/api/ask-estate',
        '/api/health',
        '/api/t/b/search',
      ]
    ) {
      const context = await f.contextFor(f.sessionFor('owner'))
      await expect(
        selectRequestAuthority(
          new Request(`http://local${path}`, { headers: { authorization: `Bearer ${key.key}` } }),
          context,
          deps,
        ),
      ).rejects.toThrow()
      expect(context.denialAudited).toBe(true)
    }
    for (
      const headers of [
        { authorization: `Bearer ${key.key}`, 'x-admin-passcode': 'test-only' },
        { authorization: `Bearer ${key.key}, Bearer ${key.key}` },
        { authorization: 'Basic credentials' },
        { authorization: 'Bearer malformed' },
        { authorization: '' },
        { 'x-admin-passcode': 'wrong' },
      ] as Record<string, string>[]
    ) {
      const context = await f.contextFor(f.sessionFor('owner'))
      await expect(
        selectRequestAuthority(
          new Request('http://local/api/t/a/search', { headers }),
          context,
          deps,
        ),
      ).rejects.toThrow()
      const events = f.rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: context.requestId,
      })
      expect(events.filter((event) => event.outcome === 'denied')).toHaveLength(1)
    }
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('session policy and typed ownership preserve tenant and anonymous isolation', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const select = async (session: Parameters<typeof f.contextFor>[0]) =>
      selectRequestAuthority(
        new Request('http://local/api/t/a/search'),
        await f.contextFor(session),
        deps,
      )
    const signed = await select(f.creator)
    expect(authoriseOperation(signed, 'content.write', scope, policy())).toBe(true)
    expect(researchOwner(signed, policy(), f.creator.oid)).toEqual({
      kind: 'user',
      tenantId: f.tenantId,
      oid: f.creator.oid,
    })
    const anonymous = await select(null)
    const publicPolicy = policy('public-a', 'public')
    expect(
      authoriseOperation(
        anonymous,
        'portal.ask',
        { kind: 'portal', slug: 'public-a' },
        publicPolicy,
      ),
    ).toBe(true)
    expect(researchOwner(anonymous, publicPolicy, f.creator.oid)).toEqual({
      kind: 'anonymous',
      clientId: f.creator.oid,
    })
    const unassigned = await select(f.unassigned)
    expect(
      authoriseOperation(
        unassigned,
        'portal.read',
        { kind: 'portal', slug: 'authenticated-a' },
        policy('authenticated-a', 'authenticated'),
      ),
    ).toBe(true)
    for (const session of [null, f.otherTenant]) {
      const denied = await select(session)
      expect(() =>
        authoriseOperation(
          denied,
          'portal.read',
          { kind: 'portal', slug: 'authenticated-a' },
          policy('authenticated-a', 'authenticated'),
        )
      ).toThrow()
    }
    for (const bad of [undefined, null, {}, policy('b'), policy('a', 'unknown')]) {
      const fresh = await select(f.creator)
      expect(() => authoriseOperation(fresh, 'portal.read', scope, bad)).toThrow()
    }
    for (const clientId of [undefined, '', 'anonymous', 'bad id', 'x'.repeat(161)]) {
      const fresh = await select(null)
      expect(() => researchOwner(fresh, publicPolicy, clientId)).toThrow()
    }
  } finally {
    f.close()
  }
})

Deno.test('break-glass evaluates with ambient session and required denial audit fails closed', async () => {
  const f = createEnforcementFixture()
  try {
    const deps = dependencies(f)
    const authority = await selectRequestAuthority(
      new Request('http://local/api/admin/overview', {
        headers: { 'x-admin-passcode': 'test-only' },
      }),
      await f.contextFor(f.unassigned),
      deps,
    )
    expect(authority.kind).toBe('break-glass')
    expect(authoriseOperation(authority, 'platform.settings.write', { kind: 'platform' })).toBe(
      true,
    )
    expect(researchOwner(authority, policy(), undefined)).toEqual({
      kind: 'user',
      tenantId: f.tenantId,
      oid: f.unassigned.oid,
    })
    const anonymous = await selectRequestAuthority(
      new Request('http://local/api/t/a/search'),
      await f.contextFor(null),
      deps,
    )
    f.failAudit()
    expect(() =>
      authoriseSubActions(
        anonymous,
        [{ permission: 'content.write', scope: 'portal' }],
        scope,
        policy(),
      )
    ).toThrow(AuditWriteError)
    await expect(
      selectRequestAuthority(
        new Request('http://local/api/t/a/search', {
          headers: { authorization: 'Bearer invalid' },
        }),
        await f.contextFor(null),
        deps,
      ),
    ).rejects.toBeInstanceOf(AuditWriteError)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})
