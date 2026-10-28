import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import {
  AcceptanceCollection,
  ORIGINAL_TEXT,
  UPDATED_TEXT,
} from '../../../e2e/support/acceptance-collection.ts'

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`AT4: ${adapter} admin content lifecycle is portal-scoped, audited and denied to viewers`, async () => {
    const collection = new AcceptanceCollection()
    collection.plant('b', 'foreign-marker', 'Other portal survey', ORIGINAL_TEXT)
    const f = createEnforcementFixture({
      provider: collection,
      management: collection.management(),
    }, adapter)
    const update = (resourceId: string) => post({ resourceId, html: `<p>${UPDATED_TEXT}</p>` })
    try {
      const admin = f.sessionFor('portal-admin')
      for (
        const [path, init] of [
          ['resources/text', post({ title: 'Nursery survey', body: ORIGINAL_TEXT })],
          ['reingest', update('document-1')],
          ['resources/document-1', { method: 'DELETE' }],
        ] as const
      ) {
        const response = await f.requestAs(f.sessionFor('viewer'), `/api/admin/t/a/${path}`, init)
        expect(response.status).toBe(403)
        await response.body?.cancel()
      }
      expect(collection.writes).toEqual([])
      f.assertNoProtectedDispatch()
      const added = await f.requestAs(
        admin,
        '/api/admin/t/a/resources/text',
        post({
          title: 'Nursery survey',
          body: ORIGINAL_TEXT,
        }),
      )
      expect(added.status).toBe(200)
      const { id } = await added.json()
      // Another portal's resource cannot be used to update a document in this portal.
      const foreign = await f.requestAs(admin, '/api/admin/t/a/reingest', update('foreign-marker'))
      expect(foreign.status).toBe(404)
      await foreign.body?.cancel()
      expect(collection.writes).toHaveLength(1)

      const changed = await f.requestAs(admin, '/api/admin/t/a/reingest', update(id))
      expect(changed.status).toBe(200)
      const { newId } = await changed.json()
      expect(newId).not.toBe(id)
      expect(collection.writes.map((w) => w.method)).toEqual([
        'createText',
        'createText',
        'deleteResource',
      ])
      expect(collection.writes[1]?.text).toBe(UPDATED_TEXT)
      const read = await f.requestAs(f.sessionFor('viewer'), `/api/t/a/resources/${newId}`)
      expect(read.status).toBe(200)
      expect((await read.json()).summary).toBe(UPDATED_TEXT)
      const retired = await f.requestAs(admin, `/api/admin/t/a/resources/${newId}`, {
        method: 'DELETE',
      })
      expect(retired.status).toBe(200)
      await retired.body?.cancel()
      const list = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/resources')
      expect(await list.json()).toEqual([])
      expect(collection.writes.every((w) => w.slug === 'a')).toBe(true)
      expect(await collection.resource(f.stores.tenants.get('b')!, 'foreign-marker')).not.toBeNull()
      const events = f.rbac.audit.read({ scope: { kind: 'platform' } })
      expect(events.some((e) => e.action === 'resource.delete' && e.outcome === 'success')).toBe(
        true,
      )
      expect(events.some((e) => e.action === 'request.denied')).toBe(true)
      expect(JSON.stringify(events)).not.toContain(ORIGINAL_TEXT)
      expect(JSON.stringify(events)).not.toContain(UPDATED_TEXT)
    } finally {
      f.close()
    }
  })

  Deno.test(`AT4: ${adapter} failed replacement and read-only lifecycle leave the original document intact`, async () => {
    const collection = new AcceptanceCollection()
    collection.plant('a', 'original-marker', 'Nursery survey', ORIGINAL_TEXT, true)
    const f = createEnforcementFixture({
      provider: collection,
      management: collection.management(),
    }, adapter)
    try {
      const admin = f.sessionFor('portal-admin')
      const update = () =>
        f.requestAs(
          admin,
          '/api/admin/t/a/reingest',
          post({
            resourceId: 'original-marker',
            html: `<p>${UPDATED_TEXT}</p>`,
          }),
        )
      collection.failCreate = true
      const failed = await update()
      expect(failed.status).toBe(500)
      await failed.body?.cancel()
      expect(collection.writes).toEqual([])
      const config = f.stores.tenants.get('a')!
      expect((await collection.resource(config, 'original-marker', { hidden: true }))?.summary)
        .toBe(ORIGINAL_TEXT)
      collection.failCreate = false
      f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
      const paused = await update()
      expect(paused.status).toBe(423)
      await paused.body?.cancel()
      expect(collection.writes).toEqual([])
      f.stores.lifecycle.set('a', { status: 'active', limits: null })
      const updated = await update()
      expect(updated.status).toBe(200)
      const { newId } = await updated.json()
      expect((await collection.resource(config, newId, { hidden: true }))?.hidden).toBe(true)
      expect(await collection.resource(config, newId)).toBeNull()
      expect(await collection.resource(config, 'original-marker', { hidden: true })).toBeNull()
    } finally {
      f.close()
    }
  })
}
