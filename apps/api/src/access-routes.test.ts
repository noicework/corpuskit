import { expect } from '@std/expect'
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

Deno.test('every access registration has a real allow body and independent denial matrix', async () => {
  for (const route of ACCESS_ROUTE_CASES) {
    assertExpectedPermission(route.method, route.path, 'members.manage', 'portal')
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
          scope: { kind: 'portal', slug: 'a' },
          role: 'viewer',
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
        const allowed = ['owner', 'platform-admin', 'portal-admin'].includes(role)
        expect(response.status, `${role} ${route.method} ${path}`).toBe(
          allowed ? route.method === 'POST' ? 201 : 200 : role === 'anonymous' ? 401 : 403,
        )
        const body = await response.json()
        if (allowed) {
          if (route.method === 'GET') expect(body.items).toContainEqual(seeded.value)
          else {expect(body).toMatchObject({
              subjectKind: group ? 'group' : 'active-oid',
              scope: { kind: 'portal', slug: 'a' },
              role: route.method === 'PATCH' ? 'curator' : 'viewer',
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
