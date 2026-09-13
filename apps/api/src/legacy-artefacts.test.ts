import { expect } from '@std/expect'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEnforcementFixture } from './enforcement-fixture.ts'

// D13 (D10 compatibility): research trails, investigations and watches saved before phase 3 by
// anonymous browsers on a public portal remain readable and updatable by the same browser
// client id. The web app mints 32-hex client ids, which the old segment mapping preserved.
const client = '0123456789abcdef0123456789abcdef'
const other = 'fedcba9876543210fedcba9876543210'
const legacySession = {
  id: 'trail-1',
  title: 'Legacy trail',
  updatedAt: '2026-06-01T00:00:00.000Z',
  messages: [{ role: 'user', text: 'Abalone' }],
}
const legacyInvestigation = {
  id: 'inv1',
  name: 'Legacy investigation',
  question: 'Abalone?',
  notes: '',
  status: 'active' as const,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  evidence: [],
  artefacts: [],
}
const legacyWatch = {
  id: 'watch-1',
  clientId: client,
  query: 'abalone',
  createdAt: '2026-06-01T00:00:00.000Z',
  lastRun: null,
  fingerprint: null,
  changed: false,
}
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter} pre-phase anonymous artefacts stay readable and updatable by the same client id`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const legacyPaths = {
        session: join(f.directory, 'sessions', 'public-a', client, 'trail-1.json'),
        investigation: join(f.directory, 'investigations', 'public-a', client, 'inv1.json'),
        unknown: join(f.directory, 'sessions', 'public-a', 'unknown', 'shared.json'),
      }
      if (adapter === 'durable') {
        f.state.put(`session:public-a:${client}:trail-1`, legacySession)
        f.state.put(`investigation:public-a:${client}:inv1`, legacyInvestigation)
        f.state.put('watches:public-a', [legacyWatch])
        f.state.put('session:public-a:unknown:shared', { ...legacySession, id: 'shared' })
      } else {
        writeJson(legacyPaths.session, legacySession)
        writeJson(legacyPaths.investigation, legacyInvestigation)
        writeJson(join(f.directory, 'watches', 'public-a.json'), [legacyWatch])
        writeJson(legacyPaths.unknown, { ...legacySession, id: 'shared' })
      }
      // A signed reader whose oid is also presented as a client id must stay separate.
      const signed = f.sessionFor('viewer', 'public-a')
      f.stores.sessions.put('public-a', {
        kind: 'user',
        tenantId: signed.tenantId,
        oid: signed.oid,
      }, {
        id: 'signed-1',
        title: 'Signed trail',
        updatedAt: '2026-07-01T00:00:00.000Z',
        messages: [],
      })
      const denials = () =>
        f.database.all("SELECT id FROM audit_events WHERE action='request.denied'").length
      const before = denials()
      const as = (id: string, init: RequestInit = {}): RequestInit => ({
        ...init,
        headers: { 'x-rp-client': id, ...(init.headers ?? {}) },
      })
      const titles = async (response: Response) => {
        expect(response.status).toBe(200)
        return ((await response.json()) as { id: string }[]).map((row) => row.id).sort()
      }

      // Reads by the same client id find the pre-phase records; nobody else does.
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as(client)))).toEqual(
        ['trail-1'],
      )
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as(other)))).toEqual(
        [],
      )
      expect(await titles(await f.requestAs(signed, '/api/t/public-a/sessions'))).toEqual([
        'signed-1',
      ])
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as(signed.oid))))
        .toEqual([])
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as('unknown'))))
        .toEqual([])
      const trail = await f.requestAs(null, '/api/t/public-a/sessions/trail-1', as(client))
      expect(trail.status).toBe(200)
      expect(await trail.json()).toEqual(legacySession)
      expect((await f.requestAs(null, '/api/t/public-a/sessions/trail-1', as(other))).status).toBe(
        404,
      )
      expect((await f.requestAs(signed, '/api/t/public-a/sessions/trail-1')).status).toBe(404)
      expect(
        (await f.requestAs(null, '/api/t/public-a/sessions/shared', as('unknown'))).status,
      ).toBe(404)

      expect(await titles(await f.requestAs(null, '/api/t/public-a/investigations', as(client))))
        .toEqual(['inv1'])
      expect(await titles(await f.requestAs(null, '/api/t/public-a/investigations', as(other))))
        .toEqual([])
      expect(await titles(await f.requestAs(signed, '/api/t/public-a/investigations'))).toEqual(
        [],
      )
      const investigation = await f.requestAs(
        null,
        '/api/t/public-a/investigations/inv1',
        as(client),
      )
      expect(investigation.status).toBe(200)
      expect(await investigation.json()).toEqual(legacyInvestigation)
      expect(
        (await f.requestAs(null, '/api/t/public-a/investigations/inv1', as(other))).status,
      ).toBe(404)

      expect(await titles(await f.requestAs(null, '/api/t/public-a/watches', as(client)))).toEqual(
        ['watch-1'],
      )
      expect(await titles(await f.requestAs(null, '/api/t/public-a/watches', as(other)))).toEqual(
        [],
      )
      expect(await titles(await f.requestAs(signed, '/api/t/public-a/watches'))).toEqual([])
      // Legacy rows on another portal's collection never leak across portals.
      expect(await titles(await f.requestAs(null, '/api/t/public-b/watches', as(client)))).toEqual(
        [],
      )
      expect(await titles(await f.requestAs(null, '/api/t/public-b/sessions', as(client)))).toEqual(
        [],
      )
      // Allowed reads write no denial; only the four generic not-found responses above do.
      expect(denials()).toBe(before + 4)

      // Updates by the same client go to the new namespace and shadow the legacy record.
      const renamed = { ...legacySession, title: 'Renamed trail', updatedAt: '2026-09-12' }
      const put = await f.requestAs(
        null,
        '/api/t/public-a/sessions/trail-1',
        as(client, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(renamed),
        }),
      )
      expect(put.status).toBe(200)
      const updated = await f.requestAs(null, '/api/t/public-a/sessions/trail-1', as(client))
      expect(await updated.json()).toEqual(renamed)
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as(client)))).toEqual(
        ['trail-1'],
      )
      const owner = { kind: 'anonymous' as const, clientId: client }
      expect(f.stores.investigations.update('public-a', owner, 'inv1', { name: 'Renamed' })?.name)
        .toBe('Renamed')
      expect(f.stores.investigations.get('public-a', owner, 'inv1')?.name).toBe('Renamed')
      expect(f.stores.investigations.list('public-a', owner).map((row) => row.id)).toEqual(['inv1'])
      f.stores.watches.update('public-a', 'watch-1', { changed: true }, owner)
      expect(f.stores.watches.list('public-a', owner).map((watch) => watch.changed)).toEqual([true])
      expect(f.stores.watches.list('public-a', { kind: 'anonymous', clientId: other })).toEqual([])

      // Deleting by the same client removes the record for good, in both namespaces.
      const removed = await f.requestAs(
        null,
        '/api/t/public-a/sessions/trail-1',
        as(client, { method: 'DELETE' }),
      )
      expect(removed.status).toBe(200)
      expect((await f.requestAs(null, '/api/t/public-a/sessions/trail-1', as(client))).status).toBe(
        404,
      )
      expect(await titles(await f.requestAs(null, '/api/t/public-a/sessions', as(client)))).toEqual(
        [],
      )
      f.stores.investigations.remove('public-a', owner, 'inv1')
      expect(f.stores.investigations.get('public-a', owner, 'inv1')).toBeNull()
      expect(f.stores.investigations.list('public-a', owner)).toEqual([])
      f.stores.watches.remove('public-a', owner, 'watch-1')
      expect(f.stores.watches.list('public-a', owner)).toEqual([])
      if (adapter === 'durable') {
        expect(f.state.get(`session:public-a:${client}:trail-1`, undefined)).toBeUndefined()
        expect(f.state.get(`investigation:public-a:${client}:inv1`, undefined)).toBeUndefined()
        expect(f.state.get('session:public-a:unknown:shared', undefined)).toBeDefined()
      } else {
        expect(existsSync(legacyPaths.session)).toBe(false)
        expect(existsSync(legacyPaths.investigation)).toBe(false)
        expect(existsSync(legacyPaths.unknown)).toBe(true)
      }
      expect(await titles(await f.requestAs(signed, '/api/t/public-a/sessions'))).toEqual([
        'signed-1',
      ])
      // One more not-found after the deletion; the update and delete themselves were allowed.
      expect(denials()).toBe(before + 5)
      f.assertNoProtectedDispatch()
    } finally {
      f.close()
    }
  })
}
