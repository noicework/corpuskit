import { expect } from '@std/expect'
import {
  encodeResearchOwner,
  encodeStorageIdentifier,
  equalResearchOwner,
  researchOwnerValue,
  storageIdentifierPath,
} from './research-owner.ts'

Deno.test('owner encoding preserves kind, raw identity and tenant without collisions', () => {
  const values = [
    'same',
    'a/b',
    'ab',
    'a:b',
    'a_b',
    'YWJj',
    '[1,"user"]',
    'é',
    'é',
    '😀',
    'x'.repeat(100) + 'a',
    'x'.repeat(100) + 'b',
  ]
  const keys = values.flatMap((value) => [
    encodeResearchOwner({ kind: 'anonymous', clientId: value }),
    encodeResearchOwner({ kind: 'user', tenantId: 'one', oid: value }),
    encodeResearchOwner({ kind: 'user', tenantId: 'two', oid: value }),
  ])
  expect(new Set(keys).size).toBe(keys.length)
  expect(researchOwnerValue('same')).toEqual({ kind: 'anonymous', clientId: 'same' })
  expect(equalResearchOwner('same', { kind: 'anonymous', clientId: 'same' })).toBe(true)
  expect(equalResearchOwner('same', { kind: 'user', tenantId: 'one', oid: 'same' })).toBe(false)
  const raw = { kind: 'user' as const, tenantId: 'a:b', oid: 'a/b' }
  const decoded = JSON.parse(
    atob(encodeResearchOwner(raw).replaceAll('-', '+').replaceAll('_', '/')),
  )
  expect(decoded).toEqual([2, 'user', 'a:b', 'a/b'])
})

Deno.test('identifiers reject malformed Unicode, empty values, oversize and malformed owners', () => {
  for (const value of ['', '\ud800', '\udfff', 'a\ud800b', 'x'.repeat(129), '😀'.repeat(33)]) {
    expect(() => encodeStorageIdentifier(value)).toThrow()
    expect(() => encodeResearchOwner(value)).toThrow()
  }
  for (
    const value of [null, {}, { kind: 'user', oid: 'same' }, {
      kind: 'anonymous',
      clientId: 'same',
      oid: 'same',
    }, { kind: 'system', clientId: 'same' }]
  ) {
    expect(() => researchOwnerValue(value)).toThrow()
  }
  expect(encodeStorageIdentifier('😀'.repeat(32))).toBeTruthy()
  expect(encodeStorageIdentifier('"'.repeat(64))).toBeTruthy()
  expect(encodeStorageIdentifier('\\'.repeat(64))).toBeTruthy()
  expect(() => encodeStorageIdentifier('"'.repeat(65))).toThrow()
  expect(() => encodeStorageIdentifier('\u0000'.repeat(22))).toThrow()
})

Deno.test('long encoded paths are reversible with bounded components and terminal markers', () => {
  const values = ['../a', 'a', 'a/b', 'ab', 'x'.repeat(127) + 'a', 'x'.repeat(127) + 'b']
  const paths = values.map((value) => storageIdentifierPath(encodeStorageIdentifier(value)))
  expect(new Set(paths).size).toBe(values.length)
  paths.forEach((path, index) => {
    const parts = path.split('/')
    expect(parts.pop()).toBe('_')
    expect(parts.every((part) => part.length <= 120 && /^[A-Za-z0-9_-]+$/.test(part))).toBe(true)
    expect(parts.join('')).toBe(encodeStorageIdentifier(values[index]!))
  })
})
