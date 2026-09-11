import { expect } from '@std/expect'
import {
  addPortal,
  connectKnowledgeBox,
  createAdminKb,
  createAdminLabelset,
  getAdminOverview,
  getSources,
  migrateKb,
  removePortal,
  revertKnowledgeBox,
  setPortalDisabled,
} from './client.ts'
import { AdminAccessError, runWithEmergencyAccess, sessionAccess } from './break-glass.ts'

Deno.test('platform and taxonomy operations require validated success before callbacks can run', async () => {
  const originalFetch = globalThis.fetch
  const status = { slug: 'marine', status: 'connected' }
  const operations = [
    {
      run: (access: typeof sessionAccess) => addPortal(access, { name: 'Research' }),
      success: { ok: true, slug: 'research' },
    },
    {
      run: (access: typeof sessionAccess) => createAdminKb('marine', access),
      success: { ok: true, status },
    },
    {
      run: (access: typeof sessionAccess) =>
        connectKnowledgeBox('marine', { url: 'fixture', token: 'fixture' }, access),
      success: { ok: true, status, resourceCount: 1 },
    },
    {
      run: (access: typeof sessionAccess) => revertKnowledgeBox('marine', access),
      success: { ok: true, status },
    },
    {
      run: (access: typeof sessionAccess) => removePortal('marine', access),
      success: { ok: true },
    },
    {
      run: (access: typeof sessionAccess) => setPortalDisabled('marine', access, true),
      success: { ok: true },
    },
    {
      run: (access: typeof sessionAccess) =>
        createAdminLabelset('marine', access, {
          title: 'Research',
          multiple: true,
          labels: ['Evidence'],
        }),
      success: { ok: true, id: 'evidence' },
    },
  ]
  try {
    for (const operation of operations) {
      for (const emergency of [false, true]) {
        for (
          const malformed of [
            null,
            {},
            { ...operation.success, ok: false },
            ...(Object.keys(operation.success).length > 1
              ? [{ ok: true }, { ok: true, slug: '', status: {}, id: '' }]
              : []),
          ]
        ) {
          let requests = 0
          let completed = false
          globalThis.fetch = () => {
            requests++
            return Promise.resolve(Response.json(malformed))
          }
          const invoke = () =>
            emergency
              ? runWithEmergencyAccess('fixture', operation.run)
              : operation.run(sessionAccess)
          await expect(
            invoke().then(() => {
              completed = true
            }),
          ).rejects.toBeInstanceOf(AdminAccessError)
          expect(completed).toBe(false)
          expect(requests).toBe(1)
        }
        globalThis.fetch = () => Promise.resolve(Response.json(operation.success))
        const result = emergency
          ? await runWithEmergencyAccess('fixture', operation.run)
          : await operation.run(sessionAccess)
        expect(result).toEqual(operation.success)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('invalid protected reads reject before replacing a populated snapshot', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (
      const read of [
        () => getAdminOverview(sessionAccess),
        () => getSources('marine', sessionAccess),
      ]
    ) {
      let snapshot: unknown = ['previous verified snapshot']
      for (const malformed of [null, {}, [null], [{ id: 'incomplete' }]]) {
        globalThis.fetch = () => Promise.resolve(Response.json(malformed))
        await expect(
          read().then((value) => {
            snapshot = value
          }),
        ).rejects.toBeInstanceOf(AdminAccessError)
        expect(snapshot).toEqual(['previous verified snapshot'])
      }
      globalThis.fetch = () => Promise.resolve(Response.json([]))
      expect(await read()).toEqual([])
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('migration publishes only a validated complete stream and never replays uncertainty', async () => {
  const originalFetch = globalThis.fetch
  const done = { type: 'done', copied: 1, skipped: 0, errors: 0 }
  const start = { type: 'start', total: 1 }
  try {
    for (
      const events of [
        [start, { type: 'done' }],
        [start, done, { type: 'error', message: 'fixture' }],
        [start],
        [start, done, done],
      ]
    ) {
      let requests = 0
      const received: unknown[] = []
      globalThis.fetch = () => {
        requests++
        return Promise.resolve(
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
        )
      }
      await expect(
        runWithEmergencyAccess(
          'fixture',
          (access) => migrateKb('marine', 'grains', access, (event) => received.push(event)),
        ),
      ).rejects.toBeInstanceOf(AdminAccessError)
      expect(received).toEqual([])
      expect(requests).toBe(1)
    }
    const received: unknown[] = []
    globalThis.fetch = () =>
      Promise.resolve(
        new Response([start, done].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
      )
    await migrateKb('marine', 'grains', sessionAccess, (event) => received.push(event))
    expect(received).toEqual([start, done])
  } finally {
    globalThis.fetch = originalFetch
  }
})
