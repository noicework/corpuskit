import { expect } from '@std/expect'
import { appendAudit, AuditWriteError, createAuditEvent, redactAuditDetail } from './audit.ts'

export function auditInput() {
  return {
    requestId: 'request-1',
    actor: { kind: 'user' as const, id: 'oid-1', label: 'Test User' },
    action: 'assignment.create' as const,
    scope: { kind: 'portal' as const, slug: 'grains' },
    target: { kind: 'assignment', id: 'assignment-1' },
    outcome: 'success' as const,
    detail: { role: 'viewer' },
  }
}

Deno.test('audit event persists exactly D7 fields and normalised UTC time', () => {
  const event = createAuditEvent(auditInput(), () => 0, () => 'event-1')
  expect(event).toEqual({
    id: 'event-1',
    at: '1970-01-01T00:00:00.000Z',
    request_id: 'request-1',
    actor_kind: 'user',
    actor_id: 'oid-1',
    actor_label: 'Test User',
    action: 'assignment.create',
    scope_kind: 'portal',
    scope_slug: 'grains',
    target_kind: 'assignment',
    target_id: 'assignment-1',
    outcome: 'success',
    detail_json: '{"role":"viewer"}',
  })
})

Deno.test('audit allowlist discards bodies, nested secrets and unrecognised fields without traversing them', () => {
  const discarded = { password: 'private-fixture', query: 'private-fixture' }
  Object.defineProperty(discarded, 'token', {
    get: () => {
      throw new Error('never read')
    },
  })
  expect(redactAuditDetail('assignment.create', {
    role: 'curator',
    nested: discarded,
    passcode: 'private-fixture',
    keyHash: 'private-fixture',
    plaintext: 'private-fixture',
    documentText: 'private-fixture',
    query: '?token=private-fixture',
    body: discarded,
    headers: discarded,
  })).toEqual({ role: 'curator' })
})

Deno.test('audit rejects malformed allowed details and unsafe metadata with typed safe failures', () => {
  for (
    const detail of [null, [], 'body', { role: { secret: 'private-fixture' } }, { role: 'system' }]
  ) {
    expect(() => createAuditEvent({ ...auditInput(), detail })).toThrow(AuditWriteError)
  }
  for (
    const label of ['x\nforged', 'https://example.test/?token=private-fixture', 'x'.repeat(161)]
  ) {
    expect(() => createAuditEvent({ ...auditInput(), actor: { kind: 'user', label } })).toThrow(
      AuditWriteError,
    )
  }
  expect(() => redactAuditDetail('unknown.action' as never, {})).toThrow(AuditWriteError)
  expect(() => redactAuditDetail('request.denied', { code: 'private-fixture' })).toThrow(
    AuditWriteError,
  )
})

Deno.test('mandatory append converts storage errors without leaking their details', () => {
  const event = createAuditEvent(auditInput())
  try {
    appendAudit({
      append: () => {
        throw new Error('private-fixture')
      },
    }, event)
    throw new Error('append returned success')
  } catch (error) {
    expect(error).toBeInstanceOf(AuditWriteError)
    expect(String(error)).not.toContain('private-fixture')
    expect((error as Error).cause).toBeUndefined()
  }
})

Deno.test('key actors and named mode/key details are validated without retaining secrets', () => {
  for (const kind of ['key', 'legacy-key'] as const) {
    expect(createAuditEvent({ ...auditInput(), actor: { kind } }).actor_kind).toBe(kind)
  }
  expect(redactAuditDetail('tenant.access.update', {
    previousAccessMode: 'public',
    accessMode: 'restricted',
    token: 'secret',
  })).toEqual({ previousAccessMode: 'public', accessMode: 'restricted' })
  const detail = {
    keyRole: 'curator',
    creatorOid: 'creator',
    creatorTenantId: 'tenant',
    keyStatus: 'active',
  }
  expect(redactAuditDetail('request.privileged', { ...detail, keyHash: 'secret', body: 'secret' }))
    .toEqual(detail)
  for (
    const invalid of [{ keyRole: 'owner' }, { creatorOid: 'x'.repeat(161) }, {
      keyStatus: 'unknown',
    }]
  ) {
    expect(() => redactAuditDetail('request.privileged', invalid)).toThrow(AuditWriteError)
  }
  expect(() => redactAuditDetail('tenant.access.update', { accessMode: 'private' })).toThrow(
    AuditWriteError,
  )
})
