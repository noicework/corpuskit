import { expect } from '@std/expect'
import { createEnforcementFixture, type EnforcementFixture } from './enforcement-fixture.ts'
import { TenantStore } from './tenants.ts'

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const departedAdmin = {
  subjectKind: 'pending-email',
  subjectId: 'departed-admin@first-customer.example',
  role: 'portal-admin',
}

/** Every role assignment and group mapping scoped to one portal slug. */
function portalRows(f: EnforcementFixture, slug: string) {
  return f.rbac.assignments.list(f.tenantId).filter((row) =>
    row.scope.kind === 'portal' && row.scope.slug === slug
  )
}

async function createPortal(f: EnforcementFixture, name: string): Promise<string> {
  const response = await f.requestAs(
    f.sessionFor('owner'),
    '/api/admin/tenants',
    json('POST', {
      name,
    }),
  )
  expect(response.status).toBe(200)
  return (await response.json()).slug
}

Deno.test('a removed portal retires its slug and revokes its members, group mappings and keys', async () => {
  const f = createEnforcementFixture()
  try {
    const owner = f.sessionFor('owner')
    expect(await createPortal(f, 'Acme')).toBe('acme')
    const member = await f.requestAs(
      owner,
      '/api/admin/t/acme/members',
      json('POST', departedAdmin),
    )
    expect(member.status).toBe(201)
    const group = f.rbac.assignmentService(f.tenantId, f.audience).create({
      subjectKind: 'group',
      subjectId: 'first-customer-readers',
      scope: { kind: 'portal', slug: 'acme' },
      role: 'viewer',
    }, { requestId: 'fixture-group', actor: { kind: 'system' } })
    expect(group.ok).toBe(true)
    const key = await f.requestAs(
      owner,
      '/api/t/acme/mcp/keys',
      json('POST', {
        label: 'First customer client',
        role: 'viewer',
      }),
    )
    expect(key.status).toBe(201)
    const { key: secret } = await key.json()
    expect(portalRows(f, 'acme')).toHaveLength(2)

    const removed = await f.requestAs(owner, '/api/admin/tenants/acme', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(f.stores.tenants.get('acme')).toBeUndefined()
    expect(f.stores.tenants.isRetired('acme')).toBe(true)
    expect(portalRows(f, 'acme')).toEqual([])
    expect(f.stores.mcpKeys.list('acme').every((record) => record.revokedAt)).toBe(true)
    const revocations = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'acme' }, limit: 100 })
      .filter((event) => event.action === 'assignment.delete')
    expect(revocations.map((event) => event.actor_id)).toEqual([owner.oid, owner.oid])

    // The next customer with the same name gets a fresh slug and inherits nothing.
    expect(await createPortal(f, 'Acme')).toBe('acme-2')
    const members = await f.requestAs(owner, '/api/admin/t/acme-2/members')
    expect(members.status).toBe(200)
    expect((await members.json()).items).toEqual([])
    expect(portalRows(f, 'acme-2')).toEqual([])
    expect(f.stores.mcpKeys.list('acme-2')).toEqual([])
    expect((await f.requestAs(owner, '/api/admin/t/acme/members')).status).toBe(403)
    const call = await f.requestAs(null, '/api/t/acme/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect([401, 403, 404]).toContain(call.status)
    await call.body?.cancel()
  } finally {
    f.close()
  }
})

Deno.test('a removed portal with no members or keys still never gives its slug to a new portal', async () => {
  const f = createEnforcementFixture()
  try {
    const owner = f.sessionFor('owner')
    expect(await createPortal(f, 'Plain')).toBe('plain')
    const removed = await f.requestAs(owner, '/api/admin/tenants/plain', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    // Nothing but the retired slug is left on record to keep the next portal off it.
    expect(portalRows(f, 'plain')).toEqual([])
    expect(f.stores.mcpKeys.list('plain')).toEqual([])
    expect(f.stores.tenants.isRetired('plain')).toBe(true)

    expect(await createPortal(f, 'Plain')).toBe('plain-2')
    expect(f.stores.tenants.get('plain')).toBeUndefined()
    // The store refuses the retired slug by itself, whatever the caller checked first.
    expect(f.stores.tenants.add({ name: 'Plain' }).slug).toBe('plain-3')
  } finally {
    f.close()
  }
})

Deno.test('a slug still holding access from a portal removed before retirement is not reused', async () => {
  const f = createEnforcementFixture()
  try {
    const owner = f.sessionFor('owner')
    expect(await createPortal(f, 'Orphan')).toBe('orphan')
    expect(
      (await f.requestAs(owner, '/api/admin/t/orphan/members', json('POST', departedAdmin))).status,
    ).toBe(201)
    // A removal by earlier code: the portal record went, its grants and slug stayed behind.
    const raw = f.state.get<{ custom: Record<string, unknown>; retired?: string[] }>('tenants', {
      custom: {},
    })
    delete raw.custom.orphan
    f.state.put('tenants', raw)
    expect(f.stores.tenants.get('orphan')).toBeUndefined()
    expect(f.stores.tenants.isRetired('orphan')).toBe(false)

    expect(await createPortal(f, 'Orphan')).toBe('orphan-2')
    expect(portalRows(f, 'orphan-2')).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('the local portal store retires removed slugs across restarts', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'portal-removal-' })
  try {
    const path = `${directory}/tenants.json`
    const store = new TenantStore({ TENANTS_PATH: path })
    expect(store.add({ name: 'Acme' }).slug).toBe('acme')
    expect(store.remove('acme')).toBe(true)
    expect(store.isRetired('acme')).toBe(true)
    const restarted = new TenantStore({ TENANTS_PATH: path })
    expect(restarted.isRetired('acme')).toBe(true)
    expect(restarted.add({ name: 'Acme' }).slug).toBe('acme-2')
    expect(restarted.add({ name: 'Beta' }, (slug) => slug === 'beta').slug).toBe('beta-2')
    // Seeded portals cannot be removed, so their slugs are never retired.
    expect(restarted.remove('marine')).toBe(false)
    expect(restarted.isRetired('marine')).toBe(false)
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})
