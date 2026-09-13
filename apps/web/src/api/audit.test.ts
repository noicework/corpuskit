import { expect } from '@std/expect'
import { AuthorityController } from './access-lifecycle.ts'
import { AuditError, auditQuery, listAudit, parseAuditPage } from './audit.ts'

const scope = { kind: 'portal' as const, slug: 'marine' }
const id = '11111111-1111-4111-8111-111111111111'
const row = {
  id: 'event-1',
  at: '2026-09-12T00:00:00.000Z',
  request_id: 'request-1',
  actor_kind: 'system',
  actor_id: null,
  actor_label: null,
  action: 'maintenance.run',
  scope_kind: 'portal',
  scope_slug: 'marine',
  target_kind: 'portal',
  target_id: 'marine',
  outcome: 'success',
  detail_json: '{"count":1}',
}
const page = () => ({
  items: [row],
  nextCursor: null,
  snapshot: { id, expiresAt: new Date(Date.now() + 900_000).toISOString() },
  complete: true,
})
const cursor = (snapshotId = id) =>
  btoa(JSON.stringify({ v: 1, snapshotId, last: { at: row.at, id: row.id } })).replaceAll('+', '-')
    .replaceAll('/', '_').replace(/=+$/, '')

Deno.test('audit query validates exact filters, canonical dates, identifiers and opaque cursors', () => {
  expect(auditQuery({ actorId: 'a'.repeat(160), limit: 1000 }).get('limit')).toBe('1000')
  expect(auditQuery({ cursor: cursor() }).get('cursor')).toBe(cursor())
  for (
    const bad of [
      { scope: 'other' },
      { actorKind: 'owner' },
      { action: 'unknown' },
      { actorId: 'https://secret' },
      { requestId: 'x'.repeat(161) },
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { from: '2026-09-12T00:00:00Z' },
      { from: '2026-02-31T00:00:00.000Z' },
      { from: row.at, to: '2020-01-01T00:00:00.000Z' },
      { cursor: 'e30' },
    ]
  ) {
    expect(() => auditQuery(bad as Parameters<typeof auditQuery>[0])).toThrow(AuditError)
  }
})
Deno.test('audit pages reject malformed envelopes, scope leaks and contradictory continuation', () => {
  expect(parseAuditPage(page(), scope).items).toEqual([row])
  expect(parseAuditPage(page(), { kind: 'platform' }).items).toHaveLength(1)
  for (
    const bad of [
      { ...page(), extra: true },
      { ...page(), complete: false },
      { ...page(), items: [row, row] },
      { ...page(), items: [{ ...row, scope_slug: 'grains' }] },
      { ...page(), items: [{ ...row, detail_json: '[]' }] },
      { ...page(), items: [{ ...row, detail_json: '{"nested":{}}' }] },
      { ...page(), items: [{ ...row, at: 'yesterday' }] },
      { ...page(), items: [{ ...row, request_id: 'https://secret' }] },
      { ...page(), snapshot: { id: 'invalid', expiresAt: row.at } },
    ]
  ) {
    expect(() => parseAuditPage(bad, scope)).toThrow(AuditError)
  }
  const continued = { ...page(), complete: false, nextCursor: cursor() }
  expect(parseAuditPage(continued, scope).complete).toBe(false)
  expect(() =>
    parseAuditPage(continued, scope, { cursor: cursor('22222222-2222-4222-8222-222222222222') })
  ).toThrow(AuditError)
})
function authority() {
  const controller = new AuthorityController(() => 'fixture')
  controller.setSession({
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
      permissions: ['portal.read', 'audit.read'],
    },
  }, 'marine')
  return controller
}
Deno.test('audit reads use signed current scope, bound bytes and discard obsolete responses', async () => {
  const original = globalThis.fetch
  try {
    const controller = authority(), options = { authority: controller, context: controller.context }
    let calls = 0
    globalThis.fetch = (input, init) => {
      calls++
      expect(String(input)).toBe('/api/admin/t/marine/audit?limit=100')
      expect(init?.cache).toBe('no-store')
      expect(new Headers(init?.headers).has('x-admin-passcode')).toBe(false)
      return Promise.resolve(Response.json(page()))
    }
    expect((await listAudit(scope, {}, options)).items).toHaveLength(1)
    await expect(listAudit({ kind: 'portal', slug: 'grains' }, {}, options)).rejects.toThrow(
      AuditError,
    )
    await expect(listAudit({ kind: 'platform' }, {}, options)).rejects.toThrow(AuditError)
    expect(calls).toBe(1)
    const input = { requestId: 'request-1' }
    const held = Promise.withResolvers<Response>()
    globalThis.fetch = () => held.promise
    const bound = listAudit(scope, input, options)
    input.requestId = 'changed'
    held.resolve(Response.json(page()))
    expect((await bound).items[0]!.request_id).toBe('request-1')
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(' '.repeat(512 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    await expect(listAudit(scope, {}, options)).rejects.toThrow(AuditError)
    for (const status of [400, 410, 429, 500]) {
      globalThis.fetch = () =>
        Promise.resolve(Response.json({ error: 'private details' }, { status }))
      await expect(listAudit(scope, {}, options)).rejects.toMatchObject({ status })
    }
    const pending = Promise.withResolvers<Response>()
    globalThis.fetch = () => pending.promise
    const result = listAudit(scope, {}, options)
    controller.invalidate('changed identity')
    pending.resolve(Response.json(page()))
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    globalThis.fetch = original
  }
})
