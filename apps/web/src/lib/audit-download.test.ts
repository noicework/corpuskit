import { expect } from '@std/expect'
import { AuthorityController } from '../api/access-lifecycle.ts'
import { exportAuditPage } from '../api/audit.ts'
import { AuditDownload, type AuditDownloadSink } from './audit-download.ts'
import { createEnforcementFixture } from '../../../api/src/enforcement-fixture.ts'
import { createAuditEvent } from '../../../api/src/audit.ts'

function authority() {
  const a = new AuthorityController(() => 'browser')
  a.setSession({
    authenticated: true,
    user: {
      id: 'person',
      tenantId: 'tenant',
      name: 'Person',
      email: 'person@example.test',
      roles: [],
      isAdmin: false,
    },
    effectiveRoles: { portalRoles: [{ slug: 'a', role: 'portal-admin' }] },
    provenance: [],
    claimAgeSeconds: 0,
    groupMappings: 'disabled',
    breakGlassEnabled: false,
    platformPermissions: [],
    portalAccess: {
      slug: 'a',
      available: true,
      canEnable: false,
      effectiveRole: 'portal-admin',
      permissions: ['portal.read', 'audit.export'],
    },
  }, 'a')
  return a
}
const scope = { kind: 'portal' as const, slug: 'a' }
function seed(f: ReturnType<typeof createEnforcementFixture>) {
  for (let i = 0; i < 3; i++) {
    f.rbac.audit.append(
      createAuditEvent(
        {
          requestId: `export-${i}`,
          actor: { kind: 'user', id: 'subject', label: '@formula' },
          action: 'request.privileged',
          scope,
          target: { kind: 'request' },
          outcome: 'success',
        },
        () => f.now() - i,
        () => `seed-${i}`,
      ),
    )
  }
}
Deno.test('audit exports preserve real backend CSV escaping, complete and partial snapshots', async () => {
  const f = createEnforcementFixture(), original = globalThis.fetch
  seed(f)
  try {
    const a = authority(), session = f.sessionFor('portal-admin', 'a')
    globalThis.fetch = (input) => f.requestAs(session, String(input))
    for (const format of ['csv', 'json'] as const) {
      const first = await exportAuditPage(
        scope,
        { actorId: 'subject', limit: 2 },
        format,
        undefined,
        { authority: a },
      )
      expect(first.complete).toBe(false)
      expect(first.nextCursor).toBeTruthy()
      const text = new TextDecoder().decode(first.bytes)
      expect(text).toContain(format === 'csv' ? `"'@formula"` : '"actor_label":"@formula"')
      const second = await exportAuditPage(
        scope,
        { actorId: 'subject', limit: 2 },
        format,
        first.nextCursor!,
        { authority: a },
      )
      expect(second.complete).toBe(true)
      expect(second.nextCursor).toBeNull()
      expect(second.snapshot).toEqual(first.snapshot)
    }
  } finally {
    globalThis.fetch = original
    f.close()
  }
})
Deno.test('download controller discards delayed bodies on stop or identity loss and revokes URLs', async () => {
  const f = createEnforcementFixture(), original = globalThis.fetch
  seed(f)
  try {
    const body = await (await f.requestAs(
      f.sessionFor('portal-admin', 'a'),
      '/api/admin/t/a/audit/export?actorId=subject&format=json&limit=2',
    )).text()
    for (const mode of ['stop', 'identity', 'before-click', 'success'] as const) {
      const a = authority(), entered = Promise.withResolvers<void>()
      const calls: string[] = []
      let finish: () => void = () => {}
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body.slice(0, 20)))
                finish = () => {
                  controller.enqueue(new TextEncoder().encode(body.slice(20)))
                  controller.close()
                }
              },
              pull() {
                entered.resolve()
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      const sink: AuditDownloadSink = {
        create: () => {
          calls.push('create')
          if (mode === 'before-click') a.invalidate('revoked')
          return 'blob:test'
        },
        click: () => {
          calls.push('click')
        },
        revoke: () => {
          calls.push('revoke')
        },
      }
      const download = new AuditDownload(a, scope, { actorId: 'subject', limit: 2 }, 'json', sink)
      const result = download.download()
      await entered.promise
      if (mode === 'stop') download.stop()
      if (mode === 'identity') a.invalidate('changed')
      if (mode === 'success' || mode === 'before-click') finish()
      if (mode === 'success') {
        expect((await result).complete).toBe(false)
        expect(calls).toEqual(['create', 'click', 'revoke'])
      } else {
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(calls.includes('click')).toBe(false)
      }
      download.dispose()
      if (mode === 'before-click') expect(calls).toEqual(['create', 'revoke'])
    }
  } finally {
    globalThis.fetch = original
    f.close()
  }
})
Deno.test('export validation withholds malformed, oversized, failed and denied output', async () => {
  const f = createEnforcementFixture(), original = globalThis.fetch
  seed(f)
  try {
    const real = await f.requestAs(
      f.sessionFor('portal-admin', 'a'),
      '/api/admin/t/a/audit/export?actorId=subject&format=csv&limit=2',
    )
    const body = await real.text(), headers = new Headers(real.headers)
    for (
      const mode of ['snapshot', 'complete', 'cursor', 'size', '410', '429', '500', '401', '403']
    ) {
      const a = authority(), calls: string[] = []
      const download = new AuditDownload(a, scope, { actorId: 'subject', limit: 2 }, 'csv', {
        create: () => {
          calls.push('create')
          return 'blob:test'
        },
        click: () => {
          calls.push('click')
        },
        revoke: () => {},
      })
      const changed = new Headers(headers)
      if (mode === 'snapshot') changed.set('x-audit-snapshot-id', 'invalid')
      if (mode === 'complete') changed.set('x-audit-complete', 'true')
      if (mode === 'cursor') changed.delete('x-audit-next-cursor')
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(mode === 'size' ? 'x'.repeat(512 * 1024 + 1) : body, {
            headers: changed,
            status: /^\d+$/.test(mode) ? Number(mode) : 200,
          }),
        )
      await expect(download.download()).rejects.toThrow()
      expect(calls).toEqual([])
      if (mode === '401' || mode === '403') expect(a.status).toBe('unavailable')
      download.dispose()
    }
  } finally {
    globalThis.fetch = original
    f.close()
  }
})
