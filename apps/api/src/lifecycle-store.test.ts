import { expect } from '@std/expect'
import {
  isSafeLifecycleNote,
  PortalLifecycleInputSchema,
  PortalLimitsSchema,
} from '@research-portal/core'
import { join } from 'node:path'
import {
  FileLifecycleState,
  FileLifecycleStore,
  type LifecycleState,
  nextPortalDay,
  PortalLifecycleStore,
} from './lifecycle-store.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { openLocalRbac } from './rbac-local.ts'
import type { AuditInput } from './audit.ts'

class MemoryLifecycleState implements LifecycleState {
  readonly values = new Map<string, unknown>()
  get<T>(key: string, fallback: T): T {
    return structuredClone(this.values.has(key) ? this.values.get(key) : fallback) as T
  }
  put(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value))
  }
  delete(key: string): void {
    this.values.delete(key)
  }
}

const instant = (value: string) => Date.parse(value)

Deno.test('lifecycle schemas accept optional zero limits and reject unsafe or unknown fields', () => {
  expect(PortalLifecycleInputSchema.parse({ status: 'active', limits: null })).toEqual({
    status: 'active',
    limits: null,
  })
  expect(PortalLimitsSchema.parse({ asksPerDay: 0, agentsEnabled: false })).toEqual({
    asksPerDay: 0,
    agentsEnabled: false,
  })
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '10', null]) {
    expect(PortalLimitsSchema.safeParse({ maxResources: value }).success).toBe(false)
  }
  for (
    const value of [
      { status: 'missing', limits: null },
      { status: 'active' },
      { status: 'active', limits: { unknown: 1 } },
      { status: 'active', limits: null, note: 'x'.repeat(1001) },
      { status: 'active', limits: null, token: 'do-not-store' },
    ]
  ) expect(PortalLifecycleInputSchema.safeParse(value).success).toBe(false)
})

Deno.test('lifecycle defaults are active and unlimited without writing state', () => {
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state)
  expect(store.get('marine')).toEqual({ status: 'active', limits: null, updatedAt: null })
  expect(store.usage('marine')).toEqual({ asksToday: 0, asks30d: 0, lastActivityAt: null })
  expect(state.values.size).toBe(0)
})

Deno.test('unconfigured embedded lifecycle stores have isolated transient state', () => {
  const first = new PortalLifecycleStore()
  const second = new PortalLifecycleStore()
  first.set('marine', { status: 'suspended', limits: { asksPerDay: 1 } })
  first.consumeAsk('marine')
  expect(first.get('marine').status).toBe('suspended')
  expect(first.usage('marine').asksToday).toBe(1)
  expect(second.get('marine')).toEqual({ status: 'active', limits: null, updatedAt: null })
  expect(second.usage('marine')).toEqual({ asksToday: 0, asks30d: 0, lastActivityAt: null })
})

Deno.test('audit notes reject credential forms and controls while preserving ordinary free text', () => {
  for (
    const note of [
      'Operator ' + 'a'.repeat(43),
      'Bearer ' + 'a'.repeat(43),
      'Credential enc:v1:AAAA:BBBB',
      'eyJheader.eyJpayload.signature',
      'token=private',
      'Password: private',
      'secret = private',
      'api_key=private',
      'ck_' + 'a'.repeat(43),
      'hello\nworld',
      'hello\u0000world',
    ]
  ) {
    expect(isSafeLifecycleNote(note)).toBe(false)
    expect(PortalLifecycleInputSchema.safeParse({ status: 'active', limits: null, note }).success)
      .toBe(false)
  }
  expect(isSafeLifecycleNote('Content maintenance completed; access restored.')).toBe(true)
  expect(isSafeLifecycleNote('')).toBe(true)
})

Deno.test('lifecycle replacement preserves usage, isolates portals and returns detached values', () => {
  const state = new MemoryLifecycleState()
  const now = instant('2026-09-25T00:00:00Z')
  const store = new PortalLifecycleStore(state, () => now)
  store.consumeAsk('marine', 'UTC')
  const value = store.set('marine', { status: 'read_only', limits: { asksPerDay: 2 } })
  expect(value.updatedAt).toBe('2026-09-25T00:00:00.000Z')
  value.status = 'active'
  expect(store.get('marine').status).toBe('read_only')
  expect(store.get('grains').limits).toBeNull()
  expect(store.usage('marine').asksToday).toBe(1)
  store.set('marine', { status: 'active', limits: null })
  expect(store.get('marine').limits).toBeNull()
  expect(store.usage('marine').asksToday).toBe(1)
})

Deno.test('ask admission is atomic across concurrent callers and counts admitted asks only', async () => {
  const state = new MemoryLifecycleState()
  const now = instant('2026-09-25T00:00:00Z')
  const store = new PortalLifecycleStore(state, () => now)
  store.set('marine', { status: 'active', limits: { asksPerDay: 3 } })
  const results = await Promise.all(
    Array.from({ length: 30 }, async () => await store.consumeAsk('marine', 'UTC')),
  )
  expect(results.filter((result) => result === null).length).toBe(3)
  expect(results.filter(Boolean)).toEqual(
    Array.from({ length: 27 }, () => ({ limit: 3, resetsAt: '2026-09-26T00:00:00.000Z' })),
  )
  expect(store.usage('marine').asksToday).toBe(3)
  expect(store.usage('marine').asks30d).toBe(3)
  expect(store.consumeAsk('grains')).toBeNull()
})

Deno.test('zero ask quota denies the first ask and does not record activity', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  store.set('marine', { status: 'active', limits: { asksPerDay: 0 } })
  expect(store.consumeAsk('marine')?.limit).toBe(0)
  expect(store.usage('marine')).toEqual({ asksToday: 0, asks30d: 0, lastActivityAt: null })
})

Deno.test('ask quota resets at local midnight, including quarter-hour timezone offsets', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  store.set('marine', { status: 'active', limits: { asksPerDay: 1 } })
  const before = instant('2026-09-25T18:14:59.999Z')
  const after = instant('2026-09-25T18:15:00.000Z')
  expect(store.consumeAsk('marine', 'Asia/Kathmandu', before)).toBeNull()
  expect(store.consumeAsk('marine', 'Asia/Kathmandu', before)).toEqual({
    limit: 1,
    resetsAt: '2026-09-25T18:15:00.000Z',
  })
  expect(store.consumeAsk('marine', 'Asia/Kathmandu', after)).toBeNull()
  expect(store.usage('marine', 'Asia/Kathmandu', after).asksToday).toBe(1)
  expect(store.usage('marine', 'Asia/Kathmandu', after).asks30d).toBe(2)
})

Deno.test('portal day boundaries follow daylight-saving short and long days', () => {
  for (
    const [zone, start, end] of [
      ['Australia/Melbourne', '2026-10-03T14:00:00Z', '2026-10-04T13:00:00.000Z'],
      ['Australia/Melbourne', '2026-04-04T13:00:00Z', '2026-04-05T14:00:00.000Z'],
      ['Australia/Lord_Howe', '2026-10-03T13:30:00Z', '2026-10-04T13:00:00.000Z'],
      ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00.000Z'],
    ]
  ) expect(nextPortalDay(zone!, instant(start!))).toBe(end)
})

Deno.test('thirty-day ask usage includes exactly thirty local calendar dates across DST', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  const zone = 'Australia/Melbourne'
  store.consumeAsk('marine', zone, instant('2026-09-04T13:59:59Z'))
  store.consumeAsk('marine', zone, instant('2026-09-04T14:00:00Z'))
  store.consumeAsk('marine', zone, instant('2026-10-04T12:59:59Z'))
  const now = instant('2026-10-04T12:59:59Z')
  expect(store.usage('marine', zone, now).asks30d).toBe(2)
  expect(store.usage('marine', zone, now).asksToday).toBe(1)
  expect(store.usage('marine', zone, instant('2026-10-04T13:00:00Z')).asks30d).toBe(1)
})

Deno.test('timezone changes recompute existing asks instead of clearing the quota', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  const now = instant('2026-09-25T00:05:00Z')
  store.set('marine', { status: 'active', limits: { asksPerDay: 1 } })
  store.consumeAsk('marine', 'UTC', now)
  expect(store.consumeAsk('marine', 'America/Los_Angeles', now)?.limit).toBe(1)
  expect(store.usage('marine', 'Asia/Kolkata', now).asksToday).toBe(1)
})

Deno.test('activity does not alter ask usage and older timestamps cannot move it backwards', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  store.touch('marine', instant('2026-09-25T01:00:00Z'))
  store.touch('marine', instant('2026-09-25T00:00:00Z'))
  expect(store.usage('marine')).toEqual({
    asksToday: 0,
    asks30d: 0,
    lastActivityAt: '2026-09-25T01:00:00.000Z',
  })
})

Deno.test('invalid timezone or timestamp never admits or writes an ask', () => {
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state)
  expect(() => store.consumeAsk('marine', 'not-a-timezone')).toThrow()
  expect(() => store.consumeAsk('marine', 'UTC', NaN)).toThrow()
  expect(() => store.touch('marine', -1)).toThrow()
  expect(state.values.size).toBe(0)
})

Deno.test('malformed persisted lifecycle data fails closed without resetting limits', () => {
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state)
  for (
    const value of [null, {}, { status: 'active' }, {
      v: 1,
      lifecycle: { status: 'active', limits: { asksPerDay: -1 }, updatedAt: null },
      asks: {},
      lastActivityAt: null,
    }]
  ) {
    state.values.set('portal-lifecycle:marine', value)
    expect(() => store.get('marine')).toThrow('Invalid persisted portal lifecycle')
    expect(() => store.consumeAsk('marine')).toThrow('Invalid persisted portal lifecycle')
    expect(() => store.set('marine', { status: 'active', limits: null })).toThrow()
    expect(state.values.get('portal-lifecycle:marine')).toEqual(value)
  }
  for (const slug of ['../marine', 'marine:other', 'a.b', '', 'x'.repeat(65)]) {
    expect(() => store.get(slug)).toThrow()
  }
})

Deno.test('lifecycle accepts every slug the route guard can address', () => {
  const directory = Deno.makeTempDirSync()
  try {
    for (
      const store of [
        new PortalLifecycleStore(new MemoryLifecycleState()),
        new FileLifecycleStore(directory),
      ]
    ) {
      for (const slug of ['Research_A', '_private', 'a', 'x'.repeat(64), '-dash']) {
        expect(store.get(slug).status).toBe('active')
        store.set(slug, { status: 'read_only', limits: { asksPerDay: 2 } })
        expect(store.get(slug).status).toBe('read_only')
        expect(store.consumeAsk(slug, 'UTC', instant('2026-09-25T00:00:00Z'))).toBeNull()
        store.refundAsk(slug, instant('2026-09-25T00:00:00Z'))
        expect(store.usage(slug, 'UTC', instant('2026-09-25T00:00:00Z')).asksToday).toBe(0)
      }
    }
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('a refunded ask frees its slot in the bucket it was counted in', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  store.set('marine', { status: 'active', limits: { asksPerDay: 1 } })
  const at = instant('2026-09-25T10:00:00Z')
  expect(store.consumeAsk('marine', 'UTC', at)).toBeNull()
  expect(store.consumeAsk('marine', 'UTC', at + 1)?.limit).toBe(1)
  store.refundAsk('marine', at)
  expect(store.usage('marine', 'UTC', at).asksToday).toBe(0)
  expect(store.consumeAsk('marine', 'UTC', at + 2)).toBeNull()
  // A refund with nothing counted in that bucket changes nothing.
  store.refundAsk('marine', at - 86_400_000)
  expect(store.usage('marine', 'UTC', at + 2).asksToday).toBe(1)
})

Deno.test('local JSON lifecycle survives restart and shares quota between adapter instances', () => {
  const directory = Deno.makeTempDirSync()
  try {
    const now = instant('2026-09-25T00:00:00Z')
    const first = new FileLifecycleStore(directory, undefined, () => now)
    first.set('marine', { status: 'suspended', limits: { asksPerDay: 1 } })
    first.consumeAsk('marine')
    const second = new FileLifecycleStore(directory, undefined, () => now)
    expect(second.get('marine').status).toBe('suspended')
    expect(second.consumeAsk('marine')?.limit).toBe(1)
    expect(second.get('grains').status).toBe('active')
    expect(second.usage('marine').asksToday).toBe(1)
    Deno.writeTextFileSync(join(directory, 'lifecycle/portal-lifecycle-marine.json'), '{broken')
    expect(() => first.get('marine')).toThrow('Invalid persisted portal lifecycle')
    expect(() => second.get('marine')).toThrow('Invalid persisted portal lifecycle')
    expect(Deno.readTextFileSync(join(directory, 'lifecycle/portal-lifecycle-marine.json')))
      .toBe('{broken')
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('local lifecycle updates roll back the file when their audit append fails', async () => {
  const directory = Deno.makeTempDirSync()
  const { database, rbac } = openLocalRbac({ DATA_DIR: directory })
  try {
    const owned = localOwnedStores(directory, database, rbac.audit)
    owned.lifecycle.set('marine', { status: 'read_only', limits: { asksPerDay: 3 } })
    const before = owned.lifecycle.get('marine')
    database.exec(
      "CREATE TRIGGER fail_lifecycle BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END",
    )
    const input: Omit<AuditInput, 'outcome'> = {
      requestId: 'lifecycle-audit',
      actor: { kind: 'user', id: 'admin' },
      action: 'request.privileged',
      scope: { kind: 'platform' },
      target: { kind: 'lifecycle', id: 'marine' },
      detail: {},
    }
    await expect(owned.localMutations.run(input, new AbortController().signal, async () => {
      owned.lifecycle.set('marine', { status: 'active', limits: null })
    })).rejects.toThrow()
    expect(owned.lifecycle.get('marine')).toEqual(before)
    expect(new FileLifecycleStore(directory).get('marine')).toEqual(before)
    expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('local lifecycle state rejects unscoped keys and keeps capacity state isolated', () => {
  const directory = Deno.makeTempDirSync()
  try {
    const state = new FileLifecycleState(directory)
    state.put('portal-capacity:marine', { resources: 1 })
    expect(state.get('portal-capacity:marine', null)).toEqual({ resources: 1 })
    expect(state.get('portal-lifecycle:marine', null)).toBeNull()
    state.delete('portal-capacity:marine')
    expect(state.get('portal-capacity:marine', null)).toBeNull()
    for (const key of ['tenants', 'portal-lifecycle:../marine', 'portal-capacity:marine/other']) {
      expect(() => state.put(key, {})).toThrow()
    }
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('capacity reservations survive counter lag, release failures and expire', () => {
  let now = instant('2026-09-25T00:00:00Z')
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state, () => now)
  store.set('marine', { status: 'active', limits: { maxResources: 3 } })
  const first = store.reserveAdd('marine', { observed: 1, bytes: 1 })
  const second = store.reserveAdd('marine', { observed: 1, bytes: 1 })
  expect(store.reserveAdd('marine', { observed: 1, bytes: 1 })).toEqual({
    limit: 'maxResources',
    value: 4,
    max: 3,
  })
  store.settleAdd('marine', (first as { admitted: string }).admitted, { created: true, id: 'r1' })
  // A write that failed gives its slot back.
  store.settleAdd('marine', (second as { admitted: string }).admitted, { created: false })
  expect('admitted' in store.reserveAdd('marine', { observed: 1, bytes: 1 })).toBe(true)
  expect(store.reserveAdd('marine', { observed: 1, bytes: 1 })).toEqual({
    limit: 'maxResources',
    value: 4,
    max: 3,
  })
  // Reservations the box never counts expire rather than hold capacity for ever.
  now += 7 * 3_600_000
  expect('admitted' in store.reserveAdd('marine', { observed: 1, bytes: 1 })).toBe(true)
  expect(store.reserveAdd('grains', { observed: 0, bytes: 1 })).toEqual({
    admitted: expect.any(String),
  })
})

Deno.test('capacity ledger sizes resources, releases deletions and resets per knowledge box', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  const add = (bytes: number, id: string) => {
    const admission = store.reserveAdd('marine', { observed: 0, bytes })
    store.settleAdd('marine', (admission as { admitted: string }).admitted, { created: true, id })
  }
  expect(store.hasCapacityLedger('marine')).toBe(false)
  expect(store.bytesUsed('marine', 0)).toBe(0)
  expect(store.bytesUsed('marine', 2)).toBeNull()
  add(5, 'r1')
  add(7, 'r2')
  expect(store.bytesUsed('marine', 2)).toBe(12)
  store.forgetResource('marine', 'r1')
  expect(store.bytesUsed('marine', 2)).toBe(7)
  // A created resource with no usable id exists with an unknown size.
  const admission = store.reserveAdd('marine', { observed: 1, bytes: 3 })
  store.settleAdd('marine', (admission as { admitted: string }).admitted, {
    created: true,
    id: '../escape',
  })
  expect(store.bytesUsed('marine', 2)).toBeNull()
  store.resetCapacity('marine')
  expect(store.hasCapacityLedger('marine')).toBe(false)
  expect(store.bytesUsed('marine', 0)).toBe(0)
})

Deno.test('capacity admission needs an observation only when a limit or a new ledger needs one', () => {
  const store = new PortalLifecycleStore(new MemoryLifecycleState())
  expect(store.reserveAdd('marine', { bytes: 1 })).toEqual({ admitted: null })
  store.set('marine', { status: 'active', limits: { maxBytes: 10 } })
  expect(store.reserveAdd('marine', { bytes: 1 })).toEqual({ unavailable: true })
  expect('admitted' in store.reserveAdd('marine', { observed: 0, bytes: 1 })).toBe(true)
  // Once started, the ledger still wants a fresh count while a limit is set.
  expect(store.reserveAdd('marine', { bytes: 1 })).toEqual({ unavailable: true })
  store.set('marine', { status: 'active', limits: null })
  expect('admitted' in store.reserveAdd('marine', { bytes: 1 })).toBe(true)
})

Deno.test('capacity ledgers reject corrupt state and invalid counts', () => {
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state)
  store.set('marine', { status: 'active', limits: { maxResources: 1 } })
  expect(() => store.reserveAdd('marine', { observed: -1, bytes: 0 })).toThrow()
  expect(() => store.reserveAdd('marine', { observed: 0, bytes: 0.5 })).toThrow()
  for (
    const value of [
      { v: 1, observed: 0, inflight: [], added: [], removed: [], sized: {}, unsized: -1 },
      {
        v: 1,
        observed: 0,
        inflight: [],
        added: [],
        removed: [],
        sized: { ['__proto__']: 1 },
        unsized: 0,
      },
      { v: 1, observed: 0, reserved: [], sized: {}, unsized: 0 },
    ]
  ) {
    state.put('portal-capacity:marine', value)
    expect(() => store.reserveAdd('marine', { observed: 0, bytes: 0 })).toThrow(
      'Invalid persisted portal capacity',
    )
  }
})

Deno.test('removing a portal clears its lifecycle, usage and ledger', () => {
  const state = new MemoryLifecycleState()
  const store = new PortalLifecycleStore(state)
  store.set('marine', { status: 'suspended', limits: { asksPerDay: 1 } })
  store.consumeAsk('marine')
  store.reserveAdd('marine', { observed: 0, bytes: 1 })
  expect(state.values.size).toBe(3)
  store.remove('marine')
  expect(state.values.size).toBe(0)
  expect(store.get('marine')).toEqual({ status: 'active', limits: null, updatedAt: null })
})

Deno.test('activity is recorded at most once a minute', () => {
  const state = new MemoryLifecycleState()
  let writes = 0
  const put = state.put.bind(state)
  state.put = (key, value) => {
    writes++
    put(key, value)
  }
  const store = new PortalLifecycleStore(state)
  const start = instant('2026-09-25T00:00:00Z')
  store.touch('marine', start)
  store.touch('marine', start + 30_000)
  expect(writes).toBe(1)
  store.touch('marine', start + 60_000)
  expect(writes).toBe(2)
  expect(store.usage('marine').lastActivityAt).toBe('2026-09-25T00:01:00.000Z')
})

Deno.test('named lifecycle audit completion and local state roll back together', async () => {
  const directory = Deno.makeTempDirSync()
  const { database, rbac } = openLocalRbac({ DATA_DIR: directory })
  try {
    const owned = localOwnedStores(directory, database, rbac.audit)
    owned.lifecycle.set('marine', { status: 'suspended', limits: null })
    const before = owned.lifecycle.get('marine')
    database.exec(
      "CREATE TRIGGER fail_lifecycle_named BEFORE INSERT ON audit_events WHEN NEW.action = 'portal.lifecycle.update' BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END",
    )
    await expect(owned.localMutations.run(
      {
        requestId: 'lifecycle-named-audit',
        actor: { kind: 'user', id: 'admin' },
        action: 'portal.lifecycle.update',
        scope: { kind: 'platform' },
        target: { kind: 'lifecycle', id: 'marine' },
        detail: { permission: 'portal.create', lifecycleStatus: 'active', note: 'Restore access' },
      },
      new AbortController().signal,
      async () => {
        owned.lifecycle.set('marine', { status: 'active', limits: null })
      },
    )).rejects.toThrow()
    expect(new FileLifecycleStore(directory).get('marine')).toEqual(before)
    expect(rbac.audit.read({ scope: { kind: 'platform' } })).toEqual([])
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})
