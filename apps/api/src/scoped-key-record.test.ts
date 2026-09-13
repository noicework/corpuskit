import { expect } from '@std/expect'
import {
  decodeScopedKeyRecords,
  migrateLegacyKeyRecord,
  ScopedKeyRecordSchema,
} from './scoped-key-record.ts'

const legacy = {
  id: 'key-1',
  tenant: 'marine',
  issuerUserId: 'user-1',
  label: 'Research access',
  prefix: 'ck_mcp_abcdefghijkl',
  hash: 'a'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  revokedAt: '2026-09-02T00:00:00.000Z',
}

Deno.test('legacy key migration is pure, exact and idempotent without creator inference', () => {
  const before = structuredClone(legacy)
  const migrated = migrateLegacyKeyRecord(legacy)
  expect(migrated).toEqual({
    ...before,
    v: 1,
    role: 'viewer',
    expiresAt: null,
    creator: null,
    provenance: 'legacy-unproven',
  })
  expect(legacy).toEqual(before)
  expect(migrateLegacyKeyRecord(migrated)).toEqual(migrated)
  expect(
    decodeScopedKeyRecords([legacy, {
      ...legacy,
      id: 'key-2',
      prefix: 'second',
      hash: 'b'.repeat(64),
    }], 'marine'),
  ).toHaveLength(2)
})

Deno.test('versioned keys retain verified metadata but require consistent provenance', () => {
  const key = {
    ...migrateLegacyKeyRecord(legacy),
    role: 'curator',
    creator: { tenantId: 'entra-tenant', oid: 'creator-oid' },
    provenance: 'verified-session',
    expiresAt: '2026-10-01T00:00:00.000Z',
  }
  expect(ScopedKeyRecordSchema.parse(key)).toEqual(key)
  expect(migrateLegacyKeyRecord(key)).toEqual(key)
  for (
    const change of [
      { creator: null },
      { provenance: 'legacy-unproven' },
      { role: 'owner' },
      { role: 'platform-admin' },
      { creator: { ...key.creator, plaintext: 'secret' } },
    ]
  ) expect(() => migrateLegacyKeyRecord({ ...key, ...change })).toThrow()
  expect(() => migrateLegacyKeyRecord({ ...migrateLegacyKeyRecord(legacy), role: 'analyst' }))
    .toThrow()
})

Deno.test('key records reject malformed digests, fields, versions and noncanonical times', () => {
  for (
    const change of [
      { hash: 'A'.repeat(64) },
      { hash: 'a'.repeat(63) },
      { hash: 'ck_plaintext' },
      { id: '' },
      { id: 'x'.repeat(161) },
      { tenant: '../marine' },
      { issuerUserId: 'bad\nidentity' },
      { label: 'x'.repeat(81) },
      { label: '' },
      { prefix: '' },
      { prefix: 'x'.repeat(81) },
      { createdAt: '2026-02-30T00:00:00.000Z' },
      { createdAt: '2026-09-01' },
      { createdAt: '2026-09-01T00:00:00+00:00' },
      { revokedAt: 'invalid' },
      { token: 'ck_plaintext' },
      { role: 'viewer' },
      { v: 2 },
    ]
  ) expect(() => migrateLegacyKeyRecord({ ...legacy, ...change })).toThrow()
  for (const value of [null, [], {}, 'secret', 1]) {
    expect(() => migrateLegacyKeyRecord(value)).toThrow()
  }
  for (const expiresAt of ['invalid', '2026-02-30T00:00:00.000Z', Infinity]) {
    expect(() => migrateLegacyKeyRecord({ ...migrateLegacyKeyRecord(legacy), expiresAt })).toThrow()
  }
})

Deno.test('whole-store decoding rejects corrupt arrays, wrong portals and duplicate authority', () => {
  for (const value of [null, {}, '[]', [legacy, {}], [{ ...legacy, tenant: 'other' }]]) {
    expect(() => decodeScopedKeyRecords(value, 'marine')).toThrow()
  }
  for (
    const duplicate of [
      { ...legacy, prefix: 'second', hash: 'b'.repeat(64) },
      { ...legacy, id: 'second', hash: 'b'.repeat(64) },
      { ...legacy, id: 'second', prefix: 'second' },
    ]
  ) expect(() => decodeScopedKeyRecords([legacy, duplicate], 'marine')).toThrow()
  expect(decodeScopedKeyRecords([], 'marine')).toEqual([])
})
