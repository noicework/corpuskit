import { expect } from '@std/expect'
import type { AssignmentInput } from './assignments.ts'
import { openLocalRbac } from './rbac-local.ts'
import { localOwnedStores } from './local-owned-stores.ts'
import { LocalIngress } from './local-ingress.ts'
import { TenantStore } from './tenants.ts'
import { buildApp } from './app.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { sessionFor } from './enforcement-fixture.ts'
import { issueScopedKey } from './scoped-keys.ts'
import {
  ACCESS_ROUTE_CASES,
  assertExpectedPermission,
  createEnforcementFixture,
} from './enforcement-fixture.ts'

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('real local access changes restore file and memory after append and actual COMMIT failures', async () => {
  const directory = Deno.makeTempDirSync({ prefix: 'access-ingress-' })
  const env = {
    DATA_DIR: directory,
    TENANTS_PATH: `${directory}/tenants.json`,
    ENTRA_TENANT_ID: 'tenant-1',
    ENVIRONMENT: 'development',
  }
  const { database, rbac } = openLocalRbac(env)
  try {
    let failure: 'named' | 'local' | 'commit' | undefined
    let observed = 0
    const owned = localOwnedStores(directory, database, {
      append(event) {
        if (event.action === 'tenant.access.update' || event.action === 'local.mutation') {
          expect(JSON.parse(Deno.readTextFileSync(env.TENANTS_PATH)).overrides.marine.accessMode)
            .toBe('restricted')
          if (
            (failure === 'named' && event.action === 'tenant.access.update') ||
            (failure === 'local' && event.action === 'local.mutation')
          ) {
            observed++
            throw new Error('fixture append')
          }
        }
        rbac.audit.append(event)
        if (failure === 'commit' && event.action === 'tenant.access.update') {
          observed++
          database.exec('INSERT INTO access_child VALUES (1)')
        }
      },
    }, env)
    const tenants = owned.tenants!
    tenants.patch('marine', { accessMode: 'public' })
    const before = Deno.readFileSync(env.TENANTS_PATH)
    database.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE access_parent(id INTEGER PRIMARY KEY); CREATE TABLE access_child(id INTEGER REFERENCES access_parent(id) DEFERRABLE INITIALLY DEFERRED)',
    )
    const ingress = new LocalIngress({ env, rbac, tenants })
    const app = buildApp({
      ...owned,
      tenants,
      rbac,
      audit: rbac.audit,
      configuredTenantId: env.ENTRA_TENANT_ID,
      audience: 'corpuskit',
      provider: new DoubleProvider(),
      breakGlass: ingress.breakGlass,
      requestContext: ingress.requestContext,
    })
    const invoke = () =>
      ingress.handle(
        new Request(
          'http://localhost/api/admin/t/marine/access',
          json('PATCH', { accessMode: 'restricted' }),
        ),
        (request) => app.fetch(request),
        { remoteAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 8791 } },
        sessionFor('owner', 'marine', Date.now()),
      )
    for (const mode of ['named', 'local', 'commit'] as const) {
      failure = mode
      expect((await invoke()).status).toBe(500)
      expect(Deno.readFileSync(env.TENANTS_PATH)).toEqual(before)
      expect(tenants.get('marine')!.accessMode).toBe('public')
      expect(new TenantStore(env).get('marine')!.accessMode).toBe('public')
      expect(database.all('SELECT * FROM access_child')).toEqual([])
      expect(
        rbac.audit.read({ scope: { kind: 'platform' } }).filter((event) =>
          event.action === 'tenant.access.update'
        ),
      ).toEqual([])
    }
    expect(observed).toBe(3)
    failure = undefined
    expect((await invoke()).status).toBe(200)
    expect(new TenantStore(env).get('marine')!.accessMode).toBe('restricted')
    expect(tenants.get('marine')!.accessMode).toBe('restricted')
  } finally {
    database.close()
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('access mode strict input, admin key refusal, durable rollback and completion semantics', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin')
    const invoke = (body: unknown) =>
      f.requestAs(admin, '/api/admin/t/a/access', json('PATCH', body))
    for (
      const body of [
        null,
        {},
        [],
        { accessMode: null },
        { accessMode: 'invalid' },
        { accessMode: 'public', scope: {} },
        { accessMode: 'public', actor: {} },
        { accessMode: 'public', subjectId: 'other' },
        { accessMode: 'public', unknown: true },
      ]
    ) expect((await invoke(body)).status).toBe(400)
    expect(
      (await f.requestAs(admin, '/api/admin/t/a/access', { method: 'PATCH', body: '{' })).status,
    ).toBe(400)
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'admin', role: 'portal-admin' },
      admin,
      f.authorityDependencies(),
    )
    prepared.commit()
    expect(
      (await f.requestAs(admin, '/api/admin/t/a/access', {
        ...json('PATCH', { accessMode: 'public' }),
        headers: { authorization: `Bearer ${prepared.key}` },
      })).status,
    ).toBe(403)
    for (const mode of ['named', 'local', 'commit']) {
      if (mode === 'commit') {
        f.database.exec(
          'PRAGMA foreign_keys=ON; CREATE TABLE access_parent(id INTEGER PRIMARY KEY); CREATE TABLE access_child(id INTEGER REFERENCES access_parent(id) DEFERRABLE INITIALLY DEFERRED)',
        )
      }
      f.database.exec(
        mode === 'commit'
          ? `CREATE TRIGGER access_failure AFTER INSERT ON audit_events WHEN NEW.action = 'tenant.access.update' BEGIN INSERT INTO access_child VALUES (1); END`
          : `CREATE TRIGGER access_failure BEFORE INSERT ON audit_events WHEN NEW.action = '${
            mode === 'named' ? 'tenant.access.update' : 'local.mutation'
          }' BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
      )
      expect((await invoke({ accessMode: 'public' })).status).toBe(500)
      expect(f.stores.tenants.get('a')!.accessMode).toBe('restricted')
      expect(
        f.rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
          event.action === 'tenant.access.update'
        ),
      ).toBe(false)
      f.database.exec('DROP TRIGGER access_failure')
    }
    f.database.exec(
      `CREATE TRIGGER completion_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'request.privileged' AND NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
    )
    expect((await invoke({ accessMode: 'public' })).status).toBe(500)
    expect(f.stores.tenants.get('a')!.accessMode).toBe('public')
    expect(
      f.rbac.audit.read({ scope: { kind: 'platform' } }).some((event) =>
        event.action === 'tenant.access.update' && event.outcome === 'success'
      ),
    ).toBe(true)
    f.database.exec('DROP TRIGGER completion_failure')
    expect((await invoke({ accessMode: 'public' })).status).toBe(200)
    expect(
      f.rbac.audit.read({ scope: { kind: 'platform' } }).filter((event) =>
        event.action === 'tenant.access.update' && event.outcome === 'success'
      ),
    ).toHaveLength(2)
    for (const slug of ['missing', 'corrupt']) {
      expect(
        (await f.requestAs(
          f.sessionFor('owner'),
          `/api/admin/t/${slug}/access`,
          json('PATCH', { accessMode: 'public' }),
        )).status,
      ).toBe(403)
    }
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('access mode requires behaviour authority and records the exact transition', async () => {
  const f = createEnforcementFixture()
  try {
    for (const session of [f.sessionFor('curator'), f.sessionFor('portal-admin', 'b'), null]) {
      const response = await f.requestAs(
        session,
        '/api/admin/t/a/access',
        json('PATCH', { accessMode: 'public' }),
      )
      expect(response.status).toBe(session ? 403 : 401)
      expect(f.stores.tenants.get('a')!.accessMode).toBe('restricted')
      f.assertNoProtectedDispatch()
    }
    const response = await f.requestAs(
      f.sessionFor('portal-admin'),
      '/api/admin/t/a/access',
      json('PATCH', { accessMode: 'public' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ slug: 'a', accessMode: 'public' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(f.stores.tenants.get('a')!.accessMode).toBe('public')
    expect(
      f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } }).filter((event) =>
        event.action === 'tenant.access.update' && event.outcome === 'success'
      ).map((event) => JSON.parse(event.detail_json)),
    ).toContainEqual({
      permission: 'behaviour.write',
      previousAccessMode: 'restricted',
      accessMode: 'public',
    })
    for (
      const [accessMode, anonymousStatus, signedStatus] of [['public', 200, 200], [
        'authenticated',
        401,
        200,
      ], ['restricted', 401, 403]] as const
    ) {
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin'),
          '/api/admin/t/a/access',
          json('PATCH', { accessMode }),
        )).status,
      ).toBe(200)
      expect((await f.requestAs(null, '/api/t/a/search?q=Abalone')).status).toBe(anonymousStatus)
      expect((await f.requestAs(f.unassigned, '/api/t/a/search?q=Abalone')).status).toBe(
        signedStatus,
      )
    }
  } finally {
    f.close()
  }
})

const seed = (f: ReturnType<typeof createEnforcementFixture>, input: AssignmentInput) => {
  const outcome = f.rbac.assignmentService(f.tenantId, f.audience).create(input, {
    requestId: 'seed',
    actor: { kind: 'system' },
  })
  if (!outcome.ok) throw new Error('seed failed')
  return outcome.value
}
const localOwner = (f: ReturnType<typeof createEnforcementFixture>, subjectId = f.unassigned.oid) =>
  seed(f, { subjectId, subjectKind: 'active-oid', role: 'owner', scope: { kind: 'platform' } })

Deno.test('platform final-owner refusals and successful changes retain transactional audit', async () => {
  for (const method of ['PATCH', 'DELETE']) {
    const f = createEnforcementFixture()
    try {
      f.database.exec('DELETE FROM rbac_owner_evidence')
      const owner = localOwner(f)
      const service = f.rbac.assignmentService(f.tenantId, f.audience)
      const path = `/api/admin/people/${owner.id}`
      const init = json(method, method === 'PATCH' ? { role: 'platform-admin' } : {})
      seed(f, {
        subjectKind: 'pending-email',
        subjectId: 'pending@example.test',
        role: 'owner',
        scope: { kind: 'platform' },
      })
      let response = await f.requestAs(f.unassigned, path, init)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'last_owner' })
      const refusal = f.rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: response.headers.get('x-request-id')!,
      }).find((event) => event.action === 'assignment.denied')
      expect(refusal).toMatchObject({
        actor_kind: 'user',
        actor_id: f.unassigned.oid,
        outcome: 'denied',
        target_id: owner.id,
      })
      expect(JSON.parse(refusal!.detail_json)).toEqual({ code: 'last_owner' })
      const before = service.list()
      f.database.exec(
        "CREATE TRIGGER fail_refusal BEFORE INSERT ON audit_events WHEN NEW.action = 'assignment.denied' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
      expect((await f.requestAs(f.unassigned, path, init)).status).toBe(500)
      expect(service.list()).toEqual(before)
      f.database.exec('DROP TRIGGER fail_refusal')
      localOwner(f, 'second-owner')
      const two = service.list()
      f.database.exec(
        "CREATE TRIGGER fail_success BEFORE INSERT ON audit_events WHEN NEW.action IN ('assignment.update','assignment.delete') BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
      expect((await f.requestAs(f.unassigned, path, init)).status).toBe(500)
      expect(service.list()).toEqual(two)
      f.database.exec('DROP TRIGGER fail_success')
      response = await f.requestAs(f.unassigned, path, init)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: owner.id,
        role: method === 'PATCH' ? 'platform-admin' : 'owner',
      })
      expect((await f.requestAs(f.unassigned, '/api/admin/people')).status).toBe(403)
    } finally {
      f.close()
    }
  }
})

Deno.test('platform owner evidence expires, concurrent removals serialise and pending email needs activation', async () => {
  const f = createEnforcementFixture()
  try {
    f.database.exec('DELETE FROM rbac_owner_evidence')
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    let owner = localOwner(f)
    const appOwner = {
      ...f.unassigned,
      oid: 'app-owner',
      roles: ['CorpusKit.Owner'],
      expiresAt: f.now() + 100,
    }
    expect(service.observeSession(appOwner)).toBe(true)
    expect(
      (await f.requestAs(f.unassigned, `/api/admin/people/${owner.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200)
    owner = localOwner(f)
    f.advance(101)
    expect(
      (await f.requestAs(f.unassigned, `/api/admin/people/${owner.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(409)
    const pending = await f.requestAs(
      f.unassigned,
      '/api/admin/people',
      json('POST', {
        subjectKind: 'pending-email',
        subjectId: ' New@Example.test ',
        role: 'owner',
      }),
    )
    expect(pending.status).toBe(201)
    expect((await pending.json()).subjectId).toBe('new@example.test')
    expect(
      (await f.requestAs(f.unassigned, `/api/admin/people/${owner.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(409)
    const newSession = { ...f.unassigned, oid: 'new-owner', email: 'NEW@example.test' }
    expect(
      service.activate(newSession, {
        requestId: 'verified-activation',
        actor: { kind: 'user', id: newSession.oid },
      }).ok,
    ).toBe(true)
    const activated = service.list().find((row) => row.subjectId === newSession.oid)!
    const results = await Promise.all(
      [owner, activated].map((row) =>
        f.requestAs(f.unassigned, `/api/admin/people/${row.id}`, { method: 'DELETE' })
      ),
    )
    expect(results.map((response) => response.status).sort()).toEqual([200, 409])
    expect(service.list().filter((row) => row.role === 'owner' && row.subjectKind === 'active-oid'))
      .toHaveLength(1)
  } finally {
    f.close()
  }
})

Deno.test('every access route withholds output on required audit failure and rolls back assignment writes', async () => {
  for (const route of ACCESS_ROUTE_CASES) {
    const f = createEnforcementFixture()
    try {
      f.database.exec(
        "INSERT OR REPLACE INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',0)",
      )
      const platform = !route.path.includes(':slug')
      const row = seed(f, {
        subjectKind: route.path.includes('/groups') ? 'group' : 'active-oid',
        subjectId: 'existing',
        role: platform ? 'platform-admin' : 'viewer',
        scope: platform ? { kind: 'platform' } : { kind: 'portal', slug: 'a' },
      })
      const before = f.rbac.assignments.list(f.tenantId)
      f.database.exec(
        "CREATE TRIGGER fail_access BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'assignment.%' OR (NEW.action = 'request.privileged' AND NEW.outcome = 'success') BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
      const response = await f.requestAs(
        f.sessionFor('owner'),
        route.path.replace(':slug', 'a').replace(':id', row.id),
        'body' in route ? json(route.method, route.body) : { method: route.method },
      )
      expect(response.status, `${route.method} ${route.path}`).toBe(500)
      expect(await response.json()).toEqual({ error: 'audit_write_failed' })
      expect(f.rbac.assignments.list(f.tenantId)).toEqual(before)
      f.assertNoProtectedDispatch()
    } finally {
      f.close()
    }
  }
})

Deno.test('access response completion failure hides output while retaining a committed assignment event', async () => {
  const f = createEnforcementFixture()
  try {
    f.database.exec(
      "CREATE TRIGGER fail_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'request.privileged' AND NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    const response = await f.requestAs(
      f.sessionFor('owner'),
      '/api/admin/people',
      json('POST', { subjectKind: 'active-oid', subjectId: 'committed', role: 'platform-admin' }),
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'audit_write_failed' })
    expect(f.rbac.assignments.list(f.tenantId).some((row) => row.subjectId === 'committed')).toBe(
      true,
    )
    expect(
      f.rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: response.headers.get('x-request-id')!,
      }).some((event) => event.action === 'assignment.create' && event.outcome === 'success'),
    ).toBe(true)
  } finally {
    f.close()
  }
})
Deno.test('platform group activity and explicit break-glass cannot bypass final owner protection', async () => {
  const f = createEnforcementFixture({
    breakGlassPolicy: { environment: 'test', passcode: 'fixture' },
  })
  try {
    f.database.exec('DELETE FROM rbac_owner_evidence')
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const invoke = (path: string, method: string, body?: unknown) =>
      f.requestAs(null, path, {
        ...(body === undefined ? { method } : json(method, body)),
        headers: { 'x-admin-passcode': 'fixture', 'content-type': 'application/json' },
      })
    const group = seed(f, {
      subjectKind: 'group',
      subjectId: 'owners',
      role: 'owner',
      scope: { kind: 'platform' },
    })
    expect((await invoke(`/api/admin/groups/${group.id}`, 'DELETE')).status).toBe(200)
    expect(
      (await invoke('/api/admin/groups', 'POST', { subjectId: 'owners', role: 'owner' })).status,
    ).toBe(403)
    f.database.exec(
      "INSERT OR REPLACE INTO rbac_group_capabilities VALUES ('corpuskit','verified-supported',0)",
    )
    const created = await invoke('/api/admin/groups', 'POST', {
      subjectId: 'owners',
      role: 'owner',
    })
    expect(created.status).toBe(201)
    const active = await created.json()
    service.observeSession({ ...f.unassigned, groups: ['owners'], groupStatus: 'complete' })
    for (const method of ['PATCH', 'DELETE']) {
      expect(
        (await invoke(
          `/api/admin/groups/${active.id}`,
          method,
          method === 'PATCH' ? { role: 'platform-admin' } : {},
        )).status,
      ).toBe(409)
    }
    f.database.exec("UPDATE rbac_group_capabilities SET status = 'disabled'")
    expect(
      (await invoke(`/api/admin/groups/${active.id}`, 'PATCH', { role: 'platform-admin' })).status,
    ).toBe(403)
    expect((await invoke(`/api/admin/groups/${active.id}`, 'DELETE')).status).toBe(200)
    const only = localOwner(f)
    expect((await invoke(`/api/admin/people/${only.id}`, 'DELETE')).status).toBe(409)
    localOwner(f, 'backup')
    const response = await invoke(`/api/admin/people/${only.id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(
      f.rbac.audit.read({
        scope: { kind: 'platform' },
        requestId: response.headers.get('x-request-id')!,
      }).filter((event) => event.action === 'assignment.delete'),
    ).toMatchObject([{ actor_kind: 'break-glass' }])
  } finally {
    f.close()
  }
})

Deno.test('platform lists and IDs stay tenant scoped and separate from portal and group families', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('owner')
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const rows = [
      seed(f, {
        subjectKind: 'active-oid',
        subjectId: 'platform-person',
        role: 'platform-admin',
        scope: { kind: 'platform' },
      }),
      seed(f, {
        subjectKind: 'group',
        subjectId: 'platform-group',
        role: 'platform-admin',
        scope: { kind: 'platform' },
      }),
      seed(f, {
        subjectKind: 'active-oid',
        subjectId: 'portal-person',
        role: 'viewer',
        scope: { kind: 'portal', slug: 'a' },
      }),
    ]
    const foreign = f.rbac.assignmentService('foreign-tenant', f.audience).create({
      subjectKind: 'active-oid',
      subjectId: 'foreign',
      role: 'platform-admin',
      scope: { kind: 'platform' },
    }, { requestId: 'seed', actor: { kind: 'system' } })
    if (!foreign.ok) throw new Error('seed failed')
    expect(await (await f.requestAs(admin, '/api/admin/people')).json()).toEqual({
      items: [rows[0]],
    })
    expect(await (await f.requestAs(admin, '/api/admin/groups')).json()).toEqual({
      items: [rows[1]],
      capability: 'disabled',
    })
    const before = service.list()
    for (
      const [family, row] of [['people', rows[1]], ['people', rows[2]], ['groups', rows[0]], [
        'people',
        foreign.value,
      ]] as const
    ) {
      for (const method of ['PATCH', 'DELETE']) {
        expect(
          (await f.requestAs(
            admin,
            `/api/admin/${family}/${row!.id}`,
            json(method, method === 'PATCH' ? { role: 'owner' } : {}),
          )).status,
        ).toBe(404)
      }
    }
    for (
      const field of [
        'scope',
        'tenantId',
        'subjectId',
        'subjectKind',
        'actor',
        'effectiveRoles',
        'unknown',
      ]
    ) {
      expect(
        (await f.requestAs(
          admin,
          `/api/admin/people/${rows[0]!.id}`,
          json('PATCH', { role: 'owner', [field]: 'override' }),
        )).status,
      ).toBe(400)
    }
    for (const role of ['viewer', 'analyst', 'curator', 'portal-admin', 'system']) {
      expect(
        (await f.requestAs(
          admin,
          '/api/admin/people',
          json('POST', { subjectKind: 'active-oid', subjectId: 'invalid', role }),
        )).status,
      ).toBe(400)
    }
    expect(service.list()).toEqual(before)
    const email = seed(f, {
      subjectKind: 'pending-email',
      subjectId: 'bound@example.test',
      role: 'platform-admin',
      scope: { kind: 'platform' },
    })
    const verified = { ...f.unassigned, oid: 'bound-person', email: 'bound@example.test' }
    expect(
      service.activate(verified, {
        requestId: 'activation',
        actor: { kind: 'user', id: verified.oid },
      }).ok,
    ).toBe(true)
    expect(
      (await f.requestAs(
        admin,
        '/api/admin/people',
        json('POST', {
          subjectKind: 'pending-email',
          subjectId: 'bound@example.test',
          role: 'owner',
        }),
      )).status,
    ).toBe(201)
    expect(
      service.activate({ ...verified, oid: 'different-person' }, {
        requestId: 'conflict',
        actor: { kind: 'user', id: 'different-person' },
      }),
    ).toMatchObject({ ok: false, code: 'email_conflict' })
    expect(service.list().find((row) => row.id === email.id)).toMatchObject({
      subjectId: 'bound-person',
      role: 'platform-admin',
    })
  } finally {
    f.close()
  }
})

Deno.test('every access registration has a real allow body and independent denial matrix', async () => {
  for (const route of ACCESS_ROUTE_CASES) {
    const platform = !route.path.includes(':slug')
    const scope = platform ? { kind: 'platform' as const } : { kind: 'portal' as const, slug: 'a' }
    assertExpectedPermission(
      route.method,
      route.path,
      platform ? 'platform.members.manage' : 'members.manage',
      platform ? 'platform' : 'portal',
    )
    for (
      const role of [
        'owner',
        'platform-admin',
        'portal-admin',
        'curator',
        'analyst',
        'viewer',
        'wrong-portal',
        'anonymous',
        'other-tenant',
      ] as const
    ) {
      const f = createEnforcementFixture()
      try {
        f.database.exec(
          "INSERT OR REPLACE INTO rbac_group_capabilities (audience,status,verified_at) VALUES ('corpuskit','verified-supported',0)",
        )
        const service = f.rbac.assignmentService(f.tenantId, f.audience)
        const group = route.path.includes('/groups')
        const seeded = service.create({
          subjectKind: group ? 'group' : 'active-oid',
          subjectId: 'existing-target',
          scope,
          role: platform ? 'platform-admin' : 'viewer',
        }, { requestId: 'seed', actor: { kind: 'system' } })
        if (!seeded.ok) throw new Error('seed failed')
        const before = service.list()
        const session = role === 'anonymous'
          ? null
          : role === 'other-tenant'
          ? f.otherTenant
          : role === 'wrong-portal'
          ? f.sessionFor('portal-admin', 'b')
          : f.sessionFor(role)
        const path = route.path.replace(':slug', 'a').replace(':id', seeded.value.id)
        const response = await f.requestAs(
          session,
          path,
          'body' in route ? json(route.method, route.body) : { method: route.method },
        )
        const allowed = (platform ? ['owner'] : ['owner', 'platform-admin', 'portal-admin'])
          .includes(role)
        expect(response.status, `${role} ${route.method} ${path}`).toBe(
          allowed ? route.method === 'POST' ? 201 : 200 : role === 'anonymous' ? 401 : 403,
        )
        const body = await response.json()
        if (allowed) {
          if (route.method === 'GET') expect(body.items).toContainEqual(seeded.value)
          else {expect(body).toMatchObject({
              subjectKind: group ? 'group' : 'active-oid',
              scope,
              role: platform
                ? route.method === 'PATCH' ? 'owner' : 'platform-admin'
                : route.method === 'PATCH'
                ? 'curator'
                : 'viewer',
            })}
        } else {
          expect(service.list()).toEqual(before)
          expect(
            f.rbac.audit.read({
              scope: { kind: 'platform' },
              requestId: response.headers.get('x-request-id')!,
            }).some((event) => event.outcome === 'denied'),
          ).toBe(true)
        }
        f.assertNoProtectedDispatch()
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('portal access validation, inactive groups and assignment audit failures preserve rows', async () => {
  const f = createEnforcementFixture()
  try {
    const admin = f.sessionFor('portal-admin')
    const service = f.rbac.assignmentService(f.tenantId, f.audience)
    const path = '/api/admin/t/a/members'
    const valid = {
      subjectKind: 'pending-email',
      subjectId: ' Target@Example.test ',
      role: 'analyst',
    }
    const created = await f.requestAs(admin, path, json('POST', valid))
    expect(created.status).toBe(201)
    const row = await created.json()
    expect(row.subjectId).toBe('target@example.test')
    for (
      const body of [
        { ...valid, role: 'owner' },
        { ...valid, role: 'system' },
        { ...valid, subjectKind: 'group' },
        { ...valid, subjectId: 'invalid' },
        { ...valid, tenantId: 'other' },
        { ...valid, scope: { kind: 'platform' } },
        { ...valid, actor: {} },
        { ...valid, effectiveRoles: {} },
        { ...valid, unknown: true },
      ]
    ) expect((await f.requestAs(admin, path, json('POST', body))).status).toBe(400)
    const group = service.create({
      subjectKind: 'group',
      subjectId: 'inactive',
      role: 'viewer',
      scope: { kind: 'portal', slug: 'a' },
    }, { requestId: 'seed', actor: { kind: 'system' } })
    if (!group.ok) throw new Error('seed failed')
    expect(await (await f.requestAs(admin, '/api/admin/t/a/groups')).json()).toEqual({
      items: [group.value],
      capability: 'disabled',
    })
    expect(
      (await f.requestAs(
        admin,
        '/api/admin/t/a/groups',
        json('POST', { subjectId: 'new', role: 'viewer' }),
      )).status,
    ).toBe(403)
    expect(
      (await f.requestAs(
        admin,
        `/api/admin/t/a/groups/${group.value.id}`,
        json('PATCH', { role: 'curator' }),
      )).status,
    ).toBe(403)
    expect(
      (await f.requestAs(admin, `/api/admin/t/a/groups/${group.value.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200)
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const before = service.list()
      f.database.exec(
        "CREATE TRIGGER assignment_fail BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'assignment.%' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      )
      const response = await f.requestAs(
        admin,
        method === 'POST' ? path : `${path}/${row.id}`,
        json(
          method,
          method === 'POST'
            ? { ...valid, subjectId: 'next@example.test' }
            : method === 'PATCH'
            ? { role: 'viewer' }
            : {},
        ),
      )
      expect(response.status).toBe(500)
      expect(service.list()).toEqual(before)
      f.database.exec('DROP TRIGGER assignment_fail')
    }
    f.failAudit()
    expect((await f.requestAs(admin, path)).status).toBe(500)
    expect((await f.requestAs(f.sessionFor('viewer'), path)).status).toBe(500)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('portal access routes perform real CRUD with immutable scope and strict families', async () => {
  const f = createEnforcementFixture()
  try {
    f.database.exec(
      "INSERT OR REPLACE INTO rbac_group_capabilities (audience,status,verified_at) VALUES ('corpuskit','verified-supported',0)",
    )
    const admin = f.sessionFor('portal-admin')
    for (const family of ['members', 'groups']) {
      const path = `/api/admin/t/a/${family}`
      const body = {
        subjectId: `target-${family}`,
        role: 'viewer',
        ...(family === 'members' ? { subjectKind: 'active-oid' } : {}),
      }
      const created = await f.requestAs(admin, path, json('POST', body))
      expect(created.status).toBe(201)
      const row = await created.json()
      expect(row).toMatchObject({
        ...body,
        tenantId: f.tenantId,
        scope: { kind: 'portal', slug: 'a' },
      })
      const listed = await f.requestAs(admin, path)
      expect(listed.status).toBe(200)
      expect(listed.headers.get('cache-control')).toContain('no-store')
      expect((await listed.json()).items).toContainEqual(row)
      const updated = await f.requestAs(
        admin,
        `${path}/${row.id}`,
        json('PATCH', { role: 'curator' }),
      )
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ id: row.id, role: 'curator' })
      expect((await f.requestAs(admin, path, json('POST', body))).status).toBe(409)
      for (
        const field of ['tenantId', 'scope', 'actor', 'effectiveRoles', 'subjectId', 'subjectKind']
      ) {
        expect(
          (await f.requestAs(
            admin,
            `${path}/${row.id}`,
            json('PATCH', { role: 'viewer', [field]: 'other' }),
          )).status,
        ).toBe(400)
      }
      for (
        const otherPath of [
          `/api/admin/t/b/${family}`,
          `/api/admin/t/a/${family === 'groups' ? 'members' : 'groups'}`,
        ]
      ) {
        expect(
          (await f.requestAs(f.sessionFor('owner'), `${otherPath}/${row.id}`, { method: 'DELETE' }))
            .status,
        ).toBe(404)
      }
      expect((await f.requestAs(admin, `${path}/${row.id}`, { method: 'DELETE' })).status).toBe(200)
      expect((await f.requestAs(admin, `${path}/${row.id}`, { method: 'DELETE' })).status).toBe(404)
    }
  } finally {
    f.close()
  }
})
