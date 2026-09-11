import { expect } from '@std/expect'
import { breakGlassEnabled, BreakGlassService } from './break-glass.ts'
import { AuditWriteError } from './audit.ts'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'
import { rbacFixture } from './rbac-state.test.ts'

const request = (passcode = 'wrong') =>
  new Request('http://local/api/admin/overview', {
    headers: {
      'x-admin-passcode': passcode,
      'x-forwarded-for': crypto.randomUUID(),
      'fly-client-ip': crypto.randomUUID(),
    },
  })
const context = () => ({ requestId: crypto.randomUUID(), clientIp: '192.0.2.1', session: null })
const policy = { passcode: 'test-only-passcode', environment: 'development' }

Deno.test('break-glass capability follows the full D5 configuration matrix', () => {
  for (const configured of [false, true]) {
    for (const environment of [undefined, '', 'production', 'development', 'Production']) {
      for (const flag of [undefined, '', 'false', 'TRUE', 'true']) {
        expect(breakGlassEnabled(configured, environment, flag))
          .toBe(configured && (flag === 'true' || environment !== 'production'))
      }
    }
  }
})

Deno.test('break-glass fifth failure locks atomically and exact expiry restores eligibility', async () => {
  const f = rbacFixture()
  try {
    const service = f.state.breakGlassService(policy)
    for (let i = 1; i <= 5; i++) {
      const result = await service.authorise(request(), context())
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ code: i === 5 ? 'locked' : 'invalid_passcode' })
    }
    expect(await service.authorise(request(policy.passcode), context())).toMatchObject({
      ok: false,
      code: 'locked',
      retryAfter: 600,
    })
    f.advance(599_999)
    expect(await service.authorise(request(policy.passcode), context())).toMatchObject({
      ok: false,
      retryAfter: 1,
    })
    f.advance(1)
    expect(await service.authorise(request(policy.passcode), context())).toMatchObject({
      ok: true,
      role: 'owner',
      actor: { kind: 'break-glass' },
    })
    expect(await service.authorise(request(), context())).toMatchObject({
      ok: false,
      code: 'invalid_passcode',
    })
    const events = f.state.audit.read({ scope: { kind: 'platform' } })
    expect(events.filter((e) => e.action === 'break_glass.used')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain(policy.passcode)
    expect(JSON.stringify(f.database.all('SELECT * FROM break_glass_attempts'))).not.toContain(
      policy.passcode,
    )
  } finally {
    f.close()
  }
})

Deno.test('break-glass failures roll out of the ten minute window and do not use forwarding headers', async () => {
  const f = rbacFixture()
  try {
    const service = f.state.breakGlassService(policy)
    for (let i = 0; i < 4; i++) await service.authorise(request(), context())
    f.advance(600_000)
    expect(await service.authorise(request(), context())).toMatchObject({
      code: 'invalid_passcode',
    })
    expect(await service.authorise(request(policy.passcode), { ...context(), clientIp: undefined }))
      .toMatchObject({ ok: false, code: 'unavailable' })
    expect(
      await service.authorise(new Request('http://local/?passcode=test-only-passcode'), context()),
    )
      .toMatchObject({ ok: false, code: 'invalid_passcode' })
    expect(
      await f.state.breakGlassService({ ...policy, environment: 'production' }).authorise(
        request(policy.passcode),
        context(),
      ),
    )
      .toMatchObject({ ok: false, code: 'unavailable' })
  } finally {
    f.close()
  }
})

Deno.test('concurrent break-glass attempts retain one persistent lock across database restart', async () => {
  const path = Deno.makeTempFileSync()
  let database = new LocalRbacDatabase(path)
  const now = () => 1_000_000
  try {
    let state = new RbacState(database, now)
    state.migrate()
    await Promise.all(
      Array.from(
        { length: 12 },
        () => state.breakGlassService(policy).authorise(request(), context()),
      ),
    )
    expect(state.locks.lockedUntil('192.0.2.1')).toBe(1_600_000)
    expect(database.all('SELECT count(*) AS n FROM break_glass_attempts')).toEqual([{ n: 5 }])
    database.close()
    database = new LocalRbacDatabase(path)
    state = new RbacState(database, now)
    state.migrate()
    expect(await state.breakGlassService(policy).authorise(request(policy.passcode), context()))
      .toMatchObject({ code: 'locked', retryAfter: 600 })
    expect(
      await state.breakGlassService(policy).authorise(request(policy.passcode), {
        ...context(),
        clientIp: '192.0.2.2',
      }),
    ).toMatchObject({ ok: true })
  } finally {
    database.close()
    Deno.removeSync(path)
  }
})

Deno.test('audit failure rolls back fifth attempt and lock, and prevents successful authorisation', async () => {
  const f = rbacFixture()
  try {
    const service = f.state.breakGlassService(policy)
    for (let i = 0; i < 4; i++) await service.authorise(request(), context())
    f.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    )
    await expect(service.authorise(request(), context())).rejects.toThrow(AuditWriteError)
    expect(f.state.locks.lockedUntil('192.0.2.1')).toBeNull()
    expect(f.database.all('SELECT count(*) AS n FROM break_glass_attempts')).toEqual([{ n: 4 }])
    await expect(service.authorise(request(policy.passcode), context())).rejects.toThrow(
      AuditWriteError,
    )
    f.database.exec('DROP TRIGGER fail_audit')
    const session = { tenantId: 'tenant-1', oid: 'oid-1' }
    expect(await service.authorise(request(policy.passcode), { ...context(), session }))
      .toMatchObject({ ok: true })
    const event = f.state.audit.read({ scope: { kind: 'platform' } }).find((e) =>
      e.action === 'break_glass.used'
    )!
    expect(JSON.parse(event.detail_json)).toEqual({
      sessionOid: 'oid-1',
      sessionTenantId: 'tenant-1',
    })
    expect(BreakGlassService).toBeDefined()
  } finally {
    f.close()
  }
})
