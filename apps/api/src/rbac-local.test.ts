import { expect } from '@std/expect'
import { LocalRbacDatabase } from './rbac-local.ts'
import { RbacState } from './rbac-state.ts'

Deno.test('local RBAC reopens audit, assignments, lockouts, evidence and durable markers', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'corpuskit-rbac-' })
  const path = `${dir}/rbac.sqlite`
  let db = new LocalRbacDatabase(path)
  try {
    const state = new RbacState(db, () => 10)
    state.migrate()
    db.exec(
      "INSERT INTO role_assignments VALUES ('a','tid','pending-email','person@example.test','platform','','owner',NULL,1,1)",
    )
    db.exec("INSERT INTO break_glass_attempts VALUES ('attempt-1','127.0.0.1',1)")
    db.exec("INSERT INTO break_glass_locks VALUES ('127.0.0.1',600001)")
    db.exec("INSERT INTO rbac_owner_evidence VALUES ('tid','oid','[]','[]','disabled',1,2,1)")
    db.exec("INSERT INTO rbac_group_capabilities (audience) VALUES ('corpuskit')")
    db.exec('INSERT INTO rbac_unknown_roles VALUES (?,1)', 'a'.repeat(64))
    db.exec(
      "INSERT INTO audit_events VALUES ('audit-1','1970-01-01T00:00:00.001Z','request-1','system',NULL,NULL,'maintenance.run','platform',NULL,'maintenance',NULL,'success','{}')",
    )
    db.close()
    db = new LocalRbacDatabase(path)
    new RbacState(db, () => 20).migrate()
    for (
      const table of [
        'role_assignments',
        'break_glass_attempts',
        'break_glass_locks',
        'rbac_owner_evidence',
        'rbac_group_capabilities',
        'rbac_unknown_roles',
        'audit_events',
      ]
    ) {
      expect(db.all(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 1 }])
    }
    expect(db.all('SELECT status, verified_at FROM rbac_group_capabilities')).toEqual([{
      status: 'disabled',
      verified_at: null,
    }])
    expect(db.all('SELECT name, completed_at FROM rbac_migrations ORDER BY name')).toEqual([
      { name: 'rbac-audit-actors-v2', completed_at: 10 },
      { name: 'rbac-audit-order-v1', completed_at: 10 },
      { name: 'rbac-schema-v1', completed_at: 10 },
    ])
  } finally {
    db.close()
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('local transactions roll back errors, forbid async work and remain reusable', () => {
  const db = new LocalRbacDatabase(':memory:')
  try {
    db.exec('CREATE TABLE fixture (value TEXT)')
    expect(() =>
      db.transactionSync(() => {
        db.exec("INSERT INTO fixture VALUES ('x')")
        throw new Error('fixture')
      })
    ).toThrow('fixture')
    expect(() =>
      db.transactionSync(async () => {
        await Promise.resolve()
        db.exec("INSERT INTO fixture VALUES ('async')")
      })
    ).toThrow('synchronous')
    expect(() =>
      db.transactionSync(() => {
        db.exec("INSERT INTO fixture VALUES ('thenable')")
        return { then() {} }
      })
    ).toThrow('synchronous')
    expect(() => db.transactionSync(() => db.transactionSync(() => 1))).toThrow()
    expect(db.all('SELECT * FROM fixture')).toEqual([])
    expect(db.transactionSync(() => {
      db.exec("INSERT INTO fixture VALUES ('ok')")
      return 42
    })).toBe(42)
    expect(db.all('SELECT * FROM fixture')).toEqual([{ value: 'ok' }])
  } finally {
    db.close()
  }
  expect(() => db.all('SELECT 1')).toThrow()
})
