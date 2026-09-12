import { expect } from '@std/expect'
import { type AuditEvent, createAuditEvent } from './audit.ts'
import {
  assertExpectedPermission,
  AUDIT_ROUTE_CASES,
  createEnforcementFixture,
} from './enforcement-fixture.ts'
import { AUDIT_PAGE_BYTES, auditCsvCell } from './audit-routes.ts'

function seed(
  f: ReturnType<typeof createEnforcementFixture>,
  id: string,
  slug: string | null = 'a',
  at = f.now(),
): AuditEvent {
  const event = createAuditEvent(
    {
      requestId: 'fixture-audit',
      actor: { kind: 'user', id: 'audit-subject' },
      action: 'request.privileged',
      scope: slug === null ? { kind: 'platform' } : { kind: 'portal', slug },
      target: { kind: 'request' },
      outcome: 'success',
    },
    () => at,
    () => id,
  )
  f.rbac.audit.append(event)
  return event
}

Deno.test('all four audit registrations enforce independent portal/platform role matrices', async () => {
  for (const [template, permission, scope] of AUDIT_ROUTE_CASES) {
    assertExpectedPermission('GET', template, permission, scope)
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
        const a = seed(f, 'portal-a')
        const b = seed(f, 'portal-b', 'b')
        const platform = seed(f, 'platform-event', null)
        const session = role === 'anonymous'
          ? null
          : role === 'other-tenant'
          ? f.otherTenant
          : role === 'wrong-portal'
          ? f.sessionFor('portal-admin', 'b')
          : f.sessionFor(role)
        const before = f.database.all('SELECT * FROM audit_query_snapshots')
        let eventQueries = 0
        const original = f.database.all.bind(f.database)
        f.database.all = (query, ...bindings) => {
          if (query.includes('SELECT audit_events.*')) eventQueries++
          return original(query, ...bindings)
        }
        const response = await f.requestAs(session, template.replace(':slug', 'a'))
        const allowed = ['owner', 'platform-admin', ...(scope === 'portal' ? ['portal-admin'] : [])]
          .includes(role)
        expect(response.status, `${role} ${template}`).toBe(
          allowed ? 200 : role === 'anonymous' ? 401 : 403,
        )
        const body = await response.json()
        if (allowed) {
          expect(body.items).toContainEqual(a)
          if (scope === 'platform') {
            expect(body.items).toContainEqual(b)
            expect(body.items).toContainEqual(platform)
          } else {
            expect(
              body.items.every((e: AuditEvent) =>
                e.scope_kind === 'portal' && e.scope_slug === 'a'
              ),
            ).toBe(true)
          }
          expect(body.complete).toBe(true)
          expect(body.nextCursor).toBe(null)
        } else {
          expect(f.database.all('SELECT * FROM audit_query_snapshots')).toEqual(before)
          expect(eventQueries).toBe(0)
        }
        f.assertNoProtectedDispatch()
      } finally {
        f.close()
      }
    }
  }
})

const opaque = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const unpack = (value: string) => JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')))

Deno.test('read and exports paginate fixed insertion membership with exact reordered filters', async () => {
  for (const [template] of AUDIT_ROUTE_CASES) {
    const f = createEnforcementFixture()
    try {
      for (const id of ['b', 'd', 'f']) seed(f, id)
      const path = template.replace(':slug', 'a')
      const session = f.sessionFor('owner')
      const filter =
        'requestId=fixture-audit&actorKind=user&actorId=audit-subject&action=request.privileged&outcome=success'
      let response = await f.requestAs(session, `${path}?${filter}&limit=1`)
      let page = await response.json()
      expect(page.items.map((e: AuditEvent) => e.id)).toEqual(['f'])
      expect(page.complete).toBe(false)
      const snapshot = page.snapshot
      for (const id of ['a', 'e', 'z']) seed(f, id)
      seed(f, 'backdated', 'a', f.now() - 1000)
      const ids = ['f']
      while (page.nextCursor) {
        response = await f.requestAs(
          session,
          `${path}?outcome=success&action=request.privileged&actorId=audit-subject&actorKind=user&requestId=fixture-audit&limit=1&cursor=${page.nextCursor}`,
        )
        expect(response.status).toBe(200)
        page = await response.json()
        expect(page.snapshot).toEqual(snapshot)
        ids.push(...page.items.map((e: AuditEvent) => e.id))
      }
      expect(ids).toEqual(['f', 'd', 'b'])
      expect(page.complete).toBe(true)
      // An unfiltered snapshot also excludes every subsequent page's own intent/completion.
      const initial = await f.requestAs(session, `${path}?limit=1`)
      let allPage = await initial.json()
      const saved = f.rbac.loadAuditSnapshot(
        allPage.snapshot.id,
        template.includes(':slug') ? { kind: 'portal', slug: 'a' } : { kind: 'platform' },
        {},
      )
      const expected = f.rbac.audit.read({
        scope: template.includes(':slug') ? { kind: 'portal', slug: 'a' } : { kind: 'platform' },
        snapshotSequence: saved.watermark,
        limit: 1000,
      }).map((e) => e.id)
      const collected = allPage.items.map((e: AuditEvent) => e.id)
      while (allPage.nextCursor) {
        allPage =
          await (await f.requestAs(session, `${path}?limit=1000&cursor=${allPage.nextCursor}`))
            .json()
        collected.push(...allPage.items.map((e: AuditEvent) => e.id))
      }
      expect(collected).toEqual(expected)
    } finally {
      f.close()
    }
  }
})

Deno.test('invalid audit queries and scope/filter/cursor changes never query protected events', async () => {
  const f = createEnforcementFixture()
  try {
    seed(f, 'a')
    seed(f, 'b')
    const session = f.sessionFor('owner')
    const base = '/api/admin/t/a/audit'
    const page = await (await f.requestAs(session, `${base}?requestId=fixture-audit&limit=1`))
      .json()
    const cursor = unpack(page.nextCursor)
    let queries = 0
    const original = f.database.all.bind(f.database)
    f.database.all = (query, ...bindings) => {
      if (query.includes('SELECT audit_events.*')) queries++
      return original(query, ...bindings)
    }
    const invalid = [
      '?scope=b',
      '?format=csv',
      '?actorKind=owner',
      '?action=made.up',
      '?outcome=ok',
      '?actorId=' + 'x'.repeat(161),
      '?requestId=',
      '?from=2026-01-01',
      '?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      '?limit=0',
      '?limit=1001',
      '?limit=1.5',
      '?limit=01',
      '?limit=1&limit=2',
      '?cursor=!',
      '?cursor=',
      '?cursor=' + 'a'.repeat(1025),
      '?cursor=' + opaque({ ...cursor, v: 2 }),
      '?cursor=' + opaque({ ...cursor, scope: 'b' }),
      '?cursor=' + opaque({ ...cursor, last: { at: 'yesterday', id: 'b' } }),
      '?cursor=' + opaque({ ...cursor, last: { at: cursor.last.at, id: 'x'.repeat(161) } }),
      '?cursor=' + opaque({ ...cursor, last: null }),
      '?cursor=' + opaque({ ...cursor, snapshotId: 12 }),
      '?cursor=' + page.nextCursor,
      '?requestId=other&cursor=' + page.nextCursor,
    ]
    for (const suffix of invalid) {
      const response = await f.requestAs(session, base + suffix)
      expect(response.status, suffix).toBe(400)
      expect(queries).toBe(0)
    }
    for (const path of ['/api/admin/t/b/audit', '/api/admin/audit']) {
      expect(
        (await f.requestAs(session, `${path}?requestId=fixture-audit&cursor=${page.nextCursor}`))
          .status,
      ).toBe(400)
      expect(queries).toBe(0)
    }
    expect(
      (await f.requestAs(
        session,
        `${base}?requestId=fixture-audit&cursor=${
          opaque({ ...cursor, snapshotId: crypto.randomUUID() })
        }`,
      )).status,
    ).toBe(410)
    f.advance(15 * 60_000)
    expect(
      (await f.requestAs(session, `${base}?requestId=fixture-audit&cursor=${page.nextCursor}`))
        .status,
    ).toBe(410)
    expect(queries).toBe(0)
    expect((await f.requestAs(session, `${base}/export?format=xml`)).status).toBe(400)
  } finally {
    f.close()
  }
})

Deno.test('continuation reauthorises current assignments and cannot use keys on admin routes', async () => {
  const f = createEnforcementFixture()
  try {
    seed(f, 'a')
    seed(f, 'b')
    const session = f.sessionFor('portal-admin')
    const path = '/api/admin/t/a/audit?requestId=fixture-audit&limit=1'
    const page = await (await f.requestAs(session, path)).json()
    f.database.exec('DELETE FROM role_assignments WHERE subject_id = ?', session.oid)
    const response = await f.requestAs(session, `${path}&cursor=${page.nextCursor}`)
    expect(response.status).toBe(403)
    expect(
      (await f.requestAs(f.sessionFor('owner'), path, {
        headers: { authorization: 'Bearer ck_invalid' },
      })).status,
    ).toBe(403)
    f.assertNoProtectedDispatch()
  } finally {
    f.close()
  }
})

Deno.test('snapshot allocation limit is explicit and retention cannot resurrect paged events', async () => {
  const f = createEnforcementFixture()
  try {
    const session = f.sessionFor('owner')
    seed(f, 'a', 'a', f.now() - 401 * 86400_000)
    seed(f, 'b', 'a', f.now() - 401 * 86400_000)
    const path = '/api/admin/t/a/audit?requestId=fixture-audit&limit=1'
    const page = await (await f.requestAs(session, path)).json()
    f.rbac.retainAudit(400)
    const remaining = await (await f.requestAs(session, `${path}&cursor=${page.nextCursor}`)).json()
    expect(remaining.items).toEqual([])
    expect(remaining.complete).toBe(true)
    for (let n = 1; n < 128; n++) f.rbac.createAuditSnapshot({ kind: 'platform' }, {})
    expect((await f.requestAs(session, path)).status).toBe(429)
    expect((await f.requestAs(session, `${path}&cursor=${page.nextCursor}`)).status).toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('required intent and completion audit failures withhold JSON and CSV output', async () => {
  for (const [template] of AUDIT_ROUTE_CASES) {
    for (const outcome of ['intent', 'success']) {
      const f = createEnforcementFixture()
      try {
        seed(f, 'protected-row')
        f.database.exec(
          `CREATE TRIGGER fail_export BEFORE INSERT ON audit_events WHEN NEW.action = 'request.privileged' AND NEW.outcome = '${outcome}' BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
        )
        const path = template.replace(':slug', 'a') +
          (template.endsWith('/export') ? '?format=csv' : '')
        const response = await f.requestAs(f.sessionFor('owner'), path)
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'audit_write_failed' })
        if (outcome === 'intent') {
          expect(f.database.all('SELECT * FROM audit_query_snapshots')).toEqual([])
        }
        f.assertNoProtectedDispatch()
      } finally {
        f.close()
      }
    }
  }
})

Deno.test('CSV quotes every cell and neutralises formulas, controls and embedded delimiters', async () => {
  for (
    const value of [
      '=1+1',
      '+1',
      '-1',
      '@cmd',
      '\ttext',
      '\rtext',
      '\ntext',
      '\u0000text',
      '\u200b=1',
      '  =1',
    ]
  ) expect(auditCsvCell(value)).toBe(`"'${value}"`)
  expect(auditCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"')
  const f = createEnforcementFixture()
  try {
    const event = seed(f, 'csv-row')
    // Historical D7 rows can contain text predating current write validation.
    f.database.exec(
      'UPDATE audit_events SET actor_label = ? WHERE id = ?',
      '=HYPERLINK("bad")',
      event.id,
    )
    const response = await f.requestAs(
      f.sessionFor('owner'),
      '/api/admin/t/a/audit/export?format=csv&requestId=fixture-audit',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="audit.csv"')
    expect(response.headers.get('x-audit-complete')).toBe('true')
    expect(response.headers.get('x-audit-next-cursor')).toBe('')
    expect(response.headers.get('x-audit-snapshot-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await response.text()).toContain('"\'=HYPERLINK(""bad"")"')
  } finally {
    f.close()
  }
})

Deno.test('JSON and CSV exports enforce byte and row limits with explicit continuation and oversize error', async () => {
  for (const format of ['json', 'csv']) {
    const f = createEnforcementFixture()
    try {
      const event = seed(f, 'large-0')
      // Use valid preserved D7 strings to exercise UTF-8 byte accounting beyond character counts.
      f.database.exec(
        'UPDATE audit_events SET detail_json = ? WHERE id = ?',
        JSON.stringify({ old: '界'.repeat(1000) }),
        event.id,
      )
      f.database.transactionSync(() => {
        for (let n = 1; n < 1001; n++) {
          f.database.exec(
            'INSERT INTO audit_events SELECT ?,at,request_id,actor_kind,actor_id,actor_label,action,scope_kind,scope_slug,target_kind,target_id,outcome,detail_json FROM audit_events WHERE id = ?',
            `large-${n}`,
            event.id,
          )
        }
      })
      const session = f.sessionFor('owner')
      const path = `/api/admin/t/a/audit/export?format=${format}&requestId=fixture-audit&limit=1000`
      let cursor: string | null = null
      let total = 0
      do {
        const response = await f.requestAs(session, path + (cursor ? `&cursor=${cursor}` : ''))
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(AUDIT_PAGE_BYTES)
        if (format === 'json') {
          const page = JSON.parse(text)
          total += page.items.length
          cursor = page.nextCursor
          expect(page.complete).toBe(cursor === null)
        } else {
          total += text.split('\r\n').length - 2
          cursor = response.headers.get('x-audit-next-cursor') || null
          expect(response.headers.get('x-audit-complete')).toBe(String(cursor === null))
        }
      } while (cursor)
      expect(total).toBe(1001)
      f.database.exec(
        'UPDATE audit_events SET detail_json = ? WHERE id = ?',
        JSON.stringify({ old: 'x'.repeat(AUDIT_PAGE_BYTES) }),
        event.id,
      )
      const oversized = await f.requestAs(
        session,
        path + '&actorId=audit-subject&from=1970-01-01T00:00:00.000Z',
      )
      // Oversized records later in a page remain a continuation, then fail explicitly on their page.
      let response = oversized
      while (response.status === 200) {
        const next = format === 'json'
          ? (await response.json()).nextCursor
          : response.headers.get('x-audit-next-cursor')
        expect(next).toBeTruthy()
        response = await f.requestAs(
          session,
          `${path}&actorId=audit-subject&from=1970-01-01T00:00:00.000Z&cursor=${next}`,
        )
      }
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'audit_record_too_large' })
    } finally {
      f.close()
    }
  }
})
