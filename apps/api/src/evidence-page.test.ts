import { expect } from '@std/expect'
import { createEnforcementFixture } from './enforcement-fixture.ts'

Deno.test('a saved passage keeps its page, so the investigation reopens the PDF there', async () => {
  const f = createEnforcementFixture()
  const analyst = f.sessionFor('analyst')
  const send = async (path: string, body: unknown) => {
    const response = await f.requestAs(analyst, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    const created = await send('/api/t/a/investigations', { name: 'Stocks' })
    expect(created.status).toBe(200)
    const evidence = `/api/t/a/investigations/${created.body.id}/evidence`
    const passage = { resourceId: 'res-1', resourceTitle: 'Research', passage: 'A passage' }
    const kept = await send(evidence, { ...passage, page: 7 })
    expect(kept.status).toBe(200)
    expect(kept.body.page).toBe(7)
    // A passage with no page is saved without one, never as page zero.
    const unpaged = await send(evidence, { ...passage, passage: 'Another passage' })
    expect(unpaged.status).toBe(200)
    expect('page' in unpaged.body).toBe(false)
    for (const page of [0, -1, 1.5, '7']) {
      expect((await send(evidence, { ...passage, passage: `Page ${page}`, page })).status)
        .toBe(400)
    }
  } finally {
    f.close()
  }
})
