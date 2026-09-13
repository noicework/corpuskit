import { expect } from '@std/expect'
import { AuthorityController } from './access-lifecycle.ts'
import { createKey, KeyError, keyRoles, listKeys, revokeKey } from './keys.ts'

const row = {
  id: 'key-1',
  label: 'Research client',
  prefix: 'ck_' + 'x'.repeat(12),
  createdAt: '2026-09-12T00:00:00.000Z',
  revokedAt: null,
  role: 'viewer',
  expiresAt: null,
  status: 'active',
  inactiveReason: 'active',
  effectiveRole: 'viewer',
  legacy: false,
  upgradeable: true,
}
function authority() {
  const result = new AuthorityController(() => 'fixture')
  result.setSession({
    authenticated: true,
    user: {
      id: 'person',
      tenantId: 'tenant',
      name: 'Person',
      email: 'person@example.test',
      roles: [],
      isAdmin: false,
    },
    effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'portal-admin' }] },
    provenance: [],
    claimAgeSeconds: 0,
    groupMappings: 'disabled',
    breakGlassEnabled: false,
    platformPermissions: [],
    portalAccess: {
      slug: 'marine',
      available: true,
      canEnable: false,
      effectiveRole: 'portal-admin',
      permissions: ['portal.read', 'keys.manage'],
    },
  }, 'marine')
  return result
}
Deno.test('key transport requires current signed scope and sanitised exact summaries', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    const controller = authority()
    const options = { authority: controller, context: controller.context }
    globalThis.fetch = (input, init) => {
      calls++
      expect(String(input)).toBe('/api/t/marine/mcp/keys')
      expect(init?.cache).toBe('no-store')
      expect(new Headers(init?.headers).has('x-admin-passcode')).toBe(false)
      return Promise.resolve(Response.json([row]))
    }
    expect(await listKeys('marine', options)).toEqual([row])
    expect(keyRoles('marine', options)).toEqual(['viewer', 'analyst', 'curator', 'portal-admin'])
    await expect(listKeys('other', options)).rejects.toThrow(KeyError)
    expect(calls).toBe(1)
    for (
      const bad of [
        [{ ...row, key: 'private' }],
        [{ ...row, hash: 'private' }],
        [{ ...row, role: 'owner' }],
        [{ ...row, inactiveReason: 'unknown' }],
        [row, row],
        { items: [row] },
      ]
    ) {
      globalThis.fetch = () => Promise.resolve(Response.json(bad))
      await expect(listKeys('marine', options)).rejects.toThrow(KeyError)
    }
    globalThis.fetch = () =>
      Promise.resolve(Response.json([{ ...row, id: 'a'.repeat(160), prefix: 'p'.repeat(80) }]))
    expect((await listKeys('marine', options))[0]!.id.length).toBe(160)
    controller.invalidate('changed')
    await expect(listKeys('marine', options)).rejects.toThrow('Access changed')
  } finally {
    globalThis.fetch = original
  }
})
Deno.test('key creation bounds inputs and returns plaintext only to the imperative caller', async () => {
  const original = globalThis.fetch
  try {
    const controller = authority()
    const options = { authority: controller, context: controller.context }
    let calls = 0
    globalThis.fetch = (_input, init) => {
      calls++
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ label: 'Research client', role: 'viewer' })
      return Promise.resolve(
        Response.json({ key: 'ck_' + 'x'.repeat(43), credential: row }, { status: 201 }),
      )
    }
    const created = await createKey('marine', { label: 'Research client', role: 'viewer' }, options)
    expect(created.credential).toEqual(row)
    expect(Object.keys(created)).toEqual(['key', 'credential'])
    for (
      const input of [{ label: ' ', role: 'viewer' }, { label: 'x'.repeat(81), role: 'viewer' }, {
        label: 'Client',
        role: 'owner',
      }, { label: 'Client', role: 'viewer', expiresAt: '2000-01-01T00:00:00Z' }]
    ) {
      await expect(createKey('marine', input as Parameters<typeof createKey>[1], options)).rejects
        .toThrow(KeyError)
    }
    expect(calls).toBe(1)
    for (
      const credential of [
        { ...row, prefix: 'wrong' },
        { ...row, role: 'analyst' },
        { ...row, effectiveRole: null },
        { ...row, upgradeable: false },
        { ...row, revokedAt: '2026-09-12T00:00:00.000Z' },
        { ...row, key: 'unwanted' },
      ]
    ) {
      globalThis.fetch = () =>
        Promise.resolve(Response.json({ key: 'ck_' + 'x'.repeat(43), credential }, { status: 201 }))
      await expect(createKey('marine', { label: 'Research client', role: 'viewer' }, options))
        .rejects.toThrow(KeyError)
    }
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    globalThis.fetch = (_input, init) => {
      expect(JSON.parse(String(init?.body)).expiresAt).toBe(expiresAt)
      return Promise.resolve(
        Response.json({ key: 'ck_' + 'x'.repeat(43), credential: { ...row, expiresAt } }, {
          status: 201,
        }),
      )
    }
    expect(
      (await createKey('marine', { label: 'Research client', role: 'viewer', expiresAt }, options))
        .credential.expiresAt,
    ).toBe(expiresAt)
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ error: 'private secret' }, { status: 500 }))
    await expect(createKey('marine', { label: 'Client', role: 'viewer' }, options)).rejects.toThrow(
      'could not be confirmed',
    )
    globalThis.fetch = (input, init) => {
      expect(String(input)).toBe('/api/t/marine/mcp/keys/key-1')
      expect(init?.method).toBe('DELETE')
      return Promise.resolve(Response.json({ ok: true }))
    }
    await revokeKey('marine', 'key-1', options)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('key responses reject obsolete authority even when the network completes', async () => {
  const original = globalThis.fetch
  const controller = authority()
  const options = { authority: controller, context: controller.context }
  const pending = Promise.withResolvers<Response>()
  globalThis.fetch = () => pending.promise
  try {
    const result = createKey('marine', { label: 'Research client', role: 'viewer' }, options)
    controller.invalidate('identity changed')
    pending.resolve(Response.json({ key: 'ck_' + 'x'.repeat(43), credential: row }))
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => keyRoles('marine', options)).toThrow('Access changed')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('key role options honour the current ceiling and creation refuses missing session authority', async () => {
  const controller = authority()
  const snapshot = controller.session!
  controller.setSession({
    ...snapshot,
    effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'curator' }] },
    portalAccess: {
      ...snapshot.portalAccess!,
      effectiveRole: 'curator',
      permissions: ['portal.read'],
    },
  }, 'marine')
  expect(() => keyRoles('marine', { authority: controller })).toThrow(KeyError)
  await expect(
    createKey('marine', { label: 'Research client', role: 'viewer' }, {
      authority: new AuthorityController(),
    }),
  ).rejects.toThrow(KeyError)
})
