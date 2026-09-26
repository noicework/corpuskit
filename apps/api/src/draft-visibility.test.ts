import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const DRAFT = 'Unreleased draft findings'
const PUBLISHED = 'Published report'

/**
 * A knowledge box with one published report and one hidden draft, answering as NucliaDB does:
 * `/catalog` returns hidden resources unless the request says `hidden=false`, and a single
 * resource read returns a resource whatever its visibility, with `hidden` among its basic fields.
 */
function draftBox() {
  const resources: Record<string, { title: string; hidden: boolean; created: string }> = {
    'pub-1': { title: PUBLISHED, hidden: false, created: '2026-09-01T00:00:00Z' },
    'draft-1': { title: DRAFT, hidden: true, created: '2026-09-02T00:00:00Z' },
  }
  const raw = (id: string) => ({
    id,
    title: resources[id]!.title,
    hidden: resources[id]!.hidden,
    created: resources[id]!.created,
    metadata: { status: 'PROCESSED' },
    usermetadata: {
      classifications: [
        { labelset: 'kind', label: 'report' },
        { labelset: 'topic', label: 'fisheries' },
      ],
    },
  })
  let created = 0
  const reply = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname.replace(/^.*\/kb\/test-kb/, '')
    if (path === '/catalog') {
      const hidden = url.searchParams.get('hidden')
      const ids = Object.keys(resources).filter((id) =>
        hidden === null || String(resources[id]!.hidden) === hidden
      )
      const facets: Record<string, Record<string, number>> = {}
      for (const faceted of url.searchParams.getAll('faceted')) {
        const labelset = faceted.split('/').pop()!
        const label = labelset === 'topic' ? 'fisheries' : 'report'
        facets[faceted] = { [`${faceted}/${label}`]: ids.length }
      }
      const listed = url.searchParams.get('page_size') === '0' ? [] : ids
      return reply({
        resources: Object.fromEntries(listed.map((id) => [id, raw(id)])),
        fulltext: { total: ids.length, facets },
      })
    }
    if (path === '/labelsets') {
      return reply({
        labelsets: {
          topic: { title: 'Topic', labels: [{ title: 'fisheries' }] },
          kind: { title: 'Kind', labels: [{ title: 'report' }] },
        },
      })
    }
    if (path === '/resources' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string; hidden?: boolean }
      const id = `new-${++created}`
      resources[id] = {
        title: body.title,
        hidden: body.hidden === true,
        created: '2026-09-03T00:00:00Z',
      }
      return reply({ uuid: id })
    }
    const single = /^\/resource\/([^/]+)$/.exec(path)
    if (single) {
      const id = single[1]!
      if (!resources[id]) return reply({ detail: 'Resource not found' }, 404)
      if (init?.method === 'DELETE') {
        delete resources[id]
        return reply({})
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { hidden?: boolean }
        if (body.hidden !== undefined) resources[id]!.hidden = body.hidden
        return reply({})
      }
      return reply(raw(id))
    }
    return reply({})
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'fixture',
    }),
    fetchImpl,
  })
  return { provider, resources }
}

const titles = (items: { title?: string }[]) => items.map((item) => item.title)

Deno.test('a hidden draft never reaches the catalogue, the library, the facets or a read by id', async () => {
  const { provider } = draftBox()
  const tenant = { slug: 'demo' } as TenantConfig
  expect(titles(await provider.listResources(tenant))).toEqual([PUBLISHED])
  expect(titles((await provider.catalog(tenant, { sortField: 'created' })).items)).toEqual([
    PUBLISHED,
  ])
  expect(titles((await provider.catalog(tenant, { sortField: 'published' })).items)).toEqual([
    PUBLISHED,
  ])
  expect(titles((await provider.catalog(tenant, { kindIds: ['report'] })).items)).toEqual([
    PUBLISHED,
  ])
  expect(await provider.facets(tenant, ['topic', 'kind'])).toEqual({
    kind: { report: 1 },
    topic: { fisheries: 1 },
  })
  expect(await provider.resource(tenant, 'draft-1')).toBeNull()
  // Only a caller managing content asks for it, and then it is there.
  expect((await provider.resource(tenant, 'draft-1', { hidden: true }))?.title).toBe(DRAFT)
  expect((await provider.resource(tenant, 'pub-1'))?.title).toBe(PUBLISHED)
})

Deno.test('a viewer, signed in or anonymous, never sees a hidden draft; a manager sees and publishes it', async () => {
  const { provider, resources } = draftBox()
  const f = createEnforcementFixture({ provider, management: provider })
  try {
    const readers = [
      ['a signed-in viewer', f.sessionFor('viewer'), 'a'],
      ['an anonymous visitor', null, 'public-a'],
    ] as const
    for (const [who, session, slug] of readers) {
      const read = async (path: string) => {
        const response = await f.requestAs(session, `/api/t/${slug}${path}`)
        return { status: response.status, body: await response.json() }
      }
      const list = await read('/resources')
      expect(list.status, who).toBe(200)
      expect(titles(list.body), who).toEqual([PUBLISHED])
      for (const query of ['sort=published', 'kind=report', 'sort=created']) {
        const page = await read(`/catalog?${query}`)
        expect(page.status, `${who}, ${query}`).toBe(200)
        expect(titles(page.body.items), `${who}, ${query}`).toEqual([PUBLISHED])
      }
      const facets = await read('/facets?labelsets=topic,kind')
      expect(facets.body.topic, who).toEqual({ fisheries: 1 })
      expect(facets.body.kind, who).toEqual({ report: 1 })
      for (const path of ['/resources/draft-1', '/resources/draft-1/content']) {
        const response = await read(path)
        expect(response.status, `${who}, ${path}`).toBe(404)
        expect(JSON.stringify(response.body), `${who}, ${path}`).not.toContain(DRAFT)
      }
      expect((await read('/resources/pub-1')).status, who).toBe(200)
    }
    // A manager sees the draft among recent additions and publishes it.
    const manager = f.sessionFor('portal-admin')
    const recent = await f.requestAs(manager, '/api/admin/t/a/recent')
    expect(await recent.json()).toContainEqual(
      expect.objectContaining({ id: 'draft-1', title: DRAFT, hidden: true }),
    )
    const published = await f.requestAs(manager, '/api/admin/t/a/resources/draft-1/hidden', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hidden: false }),
    })
    expect(published.status).toBe(200)
    expect(resources['draft-1']!.hidden).toBe(false)
    // Once published, viewers see it like any other document.
    const viewer = f.sessionFor('viewer')
    const list = await (await f.requestAs(viewer, '/api/t/a/resources')).json()
    expect(titles(list).sort()).toEqual([PUBLISHED, DRAFT].sort())
    expect((await f.requestAs(viewer, '/api/t/a/resources/draft-1')).status).toBe(200)
  } finally {
    f.close()
  }
})

Deno.test('reingesting a draft keeps it a draft, and a published document stays published', async () => {
  const { provider, resources } = draftBox()
  const f = createEnforcementFixture({ provider, management: provider })
  const paragraph = '<p>' + 'The findings are set out here in full detail. '.repeat(12) + '</p>'
  const html = `<html><body><main><h1>Findings</h1>${paragraph.repeat(3)}</main></body></html>`
  try {
    const manager = f.sessionFor('portal-admin')
    for (const [id, hidden] of [['draft-1', true], ['pub-1', false]] as const) {
      const response = await f.requestAs(manager, '/api/admin/t/a/reingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceId: id, html }),
      })
      expect(response.status, id).toBe(200)
      const { newId } = await response.json() as { newId: string }
      expect(resources[newId]?.hidden, id).toBe(hidden)
      expect(resources[id], id).toBeUndefined()
    }
    // Viewers see the reingested published document, never the draft.
    const list = await (await f.requestAs(f.sessionFor('viewer'), '/api/t/a/resources')).json()
    expect(titles(list)).toEqual([PUBLISHED])
  } finally {
    f.close()
  }
})
