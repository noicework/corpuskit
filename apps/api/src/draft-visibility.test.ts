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
function draftBox(
  /** Answer the nth summary read of a resource with a 503, as a platform under strain can. */
  failRead: (id: string, nth: number) => boolean = () => false,
) {
  const summaryReads = new Map<string, number>()
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
      if (url.search === '?show=basic&show=extra&show=origin') {
        const nth = (summaryReads.get(id) ?? 0) + 1
        summaryReads.set(id, nth)
        if (failRead(id, nth)) return reply({ detail: 'upstream timeout' }, 503)
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

Deno.test('reingest takes visibility from one read of the document, and changes nothing when it fails', async () => {
  const paragraph = '<p>' + 'The findings are set out here in full detail. '.repeat(12) + '</p>'
  const html = `<html><body><main><h1>Findings</h1>${paragraph.repeat(3)}</main></body></html>`
  const reingest = (f: ReturnType<typeof createEnforcementFixture>, id: string) =>
    f.requestAs(f.sessionFor('portal-admin'), '/api/admin/t/a/reingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: id, html }),
    })
  // A failure on a second read of a published document no longer makes it a draft.
  {
    const { provider, resources } = draftBox((id, nth) => id === 'pub-1' && nth === 2)
    const f = createEnforcementFixture({ provider, management: provider })
    try {
      const response = await reingest(f, 'pub-1')
      expect(response.status).toBe(200)
      const { newId } = await response.json() as { newId: string }
      expect(resources[newId]?.hidden).toBe(false)
      const list = await (await f.requestAs(f.sessionFor('viewer'), '/api/t/a/resources')).json()
      expect(titles(list)).toEqual([PUBLISHED])
    } finally {
      f.close()
    }
  }
  // When the one read fails, the answer says so and the document is left as it was.
  {
    const { provider, resources } = draftBox((id, nth) => id === 'pub-1' && nth === 1)
    const f = createEnforcementFixture({ provider, management: provider })
    try {
      const response = await reingest(f, 'pub-1')
      expect(response.status).toBe(502)
      expect((await response.json()).error).toBe('upstream_unavailable')
      expect(Object.keys(resources).sort()).toEqual(['draft-1', 'pub-1'])
      expect(resources['pub-1']!.hidden).toBe(false)
    } finally {
      f.close()
    }
  }
})

Deno.test('an investigation citing a document that is unpublished keeps working without it', async () => {
  const { provider } = draftBox()
  const prompts: string[] = []
  Object.assign(provider, {
    askStructured: (_config: unknown, _schema: unknown, prompt: string) => {
      prompts.push(prompt)
      return Promise.resolve({
        object: { summary: 'The findings hold [1].', supported: [], contested: [], gaps: [] },
      })
    },
  })
  const f = createEnforcementFixture({ provider, management: provider })
  const manager = f.sessionFor('portal-admin')
  const analyst = f.sessionFor('analyst')
  const send = async (
    session: typeof analyst,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const response = await f.requestAs(session, path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const visibility = (id: string, hidden: boolean) =>
    send(manager, 'POST', `/api/admin/t/a/resources/${id}/hidden`, { hidden })
  try {
    // Both documents are published while the analyst keeps a passage from each.
    expect((await visibility('draft-1', false)).status).toBe(200)
    const created = await send(analyst, 'POST', '/api/t/a/investigations', { name: 'Stocks' })
    expect(created.status).toBe(200)
    const base = `/api/t/a/investigations/${created.body.id}`
    const keep = async (resourceId: string, title: string, passage: string) => {
      const kept = await send(analyst, 'POST', `${base}/evidence`, {
        resourceId,
        resourceTitle: title,
        passage,
      })
      expect(kept.status, resourceId).toBe(200)
      return kept.body.id as string
    }
    const fromReport = await keep('pub-1', PUBLISHED, 'The report sets the catch at 40 tonnes.')
    const fromFindings = await keep('draft-1', DRAFT, 'The findings put stocks at a low.')
    // The report is unpublished.
    expect((await visibility('pub-1', true)).status).toBe(200)
    // Its evidence can still be judged, saved in an artefact, and synthesis goes on without it.
    expect(
      (await send(analyst, 'PATCH', `${base}/evidence/${fromReport}`, { verdict: 'supports' }))
        .status,
    ).toBe(200)
    const artefact = await send(analyst, 'POST', `${base}/artefacts`, {
      kind: 'note',
      title: 'Passages',
      data: { evidenceIds: [fromReport, fromFindings] },
    })
    expect(artefact.status).toBe(200)
    const synthesis = await send(analyst, 'POST', `${base}/synthesise`)
    expect(synthesis.status).toBe(200)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('The findings put stocks at a low.')
    expect(prompts[0]).not.toContain('40 tonnes')
    expect(JSON.stringify(synthesis.body.artefact.data.references)).not.toContain('pub-1')
    // A direct reference to the unpublished document still reads as unknown, so an artefact
    // cannot be used to tell whether it exists.
    const direct = await send(analyst, 'POST', `${base}/artefacts`, {
      kind: 'note',
      title: 'Direct',
      data: { resourceId: 'pub-1' },
    })
    expect(direct.status).toBe(404)
    // Marking it not relevant and removing it work too.
    expect(
      (await send(analyst, 'PATCH', `${base}/evidence/${fromReport}`, { verdict: 'not-relevant' }))
        .status,
    ).toBe(200)
    expect((await send(analyst, 'DELETE', `${base}/evidence/${fromReport}`)).status).toBe(200)
    const after = await send(analyst, 'GET', base)
    expect(after.body.evidence.map((item: { id: string }) => item.id)).toEqual([fromFindings])
  } finally {
    f.close()
  }
})

Deno.test('a synthesis whose document cannot be read right now fails rather than leaving it out', async () => {
  let failing = false
  const { provider } = draftBox((id) => failing && id === 'draft-1')
  const prompts: string[] = []
  Object.assign(provider, {
    askStructured: (_config: unknown, _schema: unknown, prompt: string) => {
      prompts.push(prompt)
      return Promise.resolve({
        object: { summary: 'Both hold [1] [2].', supported: [], contested: [], gaps: [] },
      })
    },
  })
  const f = createEnforcementFixture({ provider, management: provider })
  const manager = f.sessionFor('portal-admin')
  const analyst = f.sessionFor('analyst')
  const send = async (session: typeof analyst, method: string, path: string, body?: unknown) => {
    const response = await f.requestAs(session, path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    // Two published documents, a passage kept from each.
    expect(
      (await send(manager, 'POST', '/api/admin/t/a/resources/draft-1/hidden', {
        hidden: false,
      })).status,
    ).toBe(200)
    const created = await send(analyst, 'POST', '/api/t/a/investigations', { name: 'Stocks' })
    const base = `/api/t/a/investigations/${created.body.id}`
    for (
      const [resourceId, resourceTitle, passage] of [
        ['pub-1', PUBLISHED, 'The report sets the catch at 40 tonnes.'],
        ['draft-1', DRAFT, 'The findings put stocks at a low.'],
      ]
    ) {
      expect(
        (await send(analyst, 'POST', `${base}/evidence`, { resourceId, resourceTitle, passage }))
          .status,
      ).toBe(200)
    }
    // One of them cannot be read for a moment: nothing is generated, and the answer says why.
    failing = true
    const refused = await send(analyst, 'POST', `${base}/synthesise`)
    expect(refused.status).toBe(502)
    expect(refused.body.error).toBe('upstream_unavailable')
    expect(prompts).toEqual([])
    // Once it can be read again, both passages are synthesised.
    failing = false
    const synthesis = await send(analyst, 'POST', `${base}/synthesise`)
    expect(synthesis.status).toBe(200)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('40 tonnes')
    expect(prompts[0]).toContain('stocks at a low')
  } finally {
    f.close()
  }
})

Deno.test('a synthesis reads documents only until it has the passages it uses, in evidence order', async () => {
  const prompts: string[] = []
  const f = createEnforcementFixture({
    management: {
      askStructured: (_config: unknown, _schema: unknown, prompt: string) => {
        prompts.push(prompt)
        return Promise.resolve({ object: { summary: 'Held [1].' } })
      },
    } as unknown as AragProvider,
  })
  try {
    const reads: string[] = []
    const resolve = f.provider.resource.bind(f.provider)
    // Every document is readable; the first ten are drafts readers cannot see.
    f.provider.resource = async (config, id) => {
      reads.push(id)
      const n = Number(id.split('-')[1])
      if (n <= 10) return null
      const resource = await resolve(config, 'res-1')
      return resource && { ...resource, id }
    }
    const analyst = f.sessionFor('analyst')
    const owner = { kind: 'user' as const, tenantId: analyst.tenantId, oid: analyst.oid }
    const investigation = f.stores.investigations.create('a', owner, { name: 'Many' })
    for (let n = 1; n <= 60; n++) {
      f.stores.investigations.addEvidence('a', owner, investigation.id, {
        resourceId: `doc-${n}`,
        resourceTitle: `Document ${n}`,
        passage: `Passage number ${n}.`,
        score: null,
        question: '',
        verdict: null,
        aiRelevance: null,
        note: '',
        tags: [],
      })
    }
    const response = await f.requestAs(
      analyst,
      `/api/t/a/investigations/${investigation.id}/synthesise`,
      { method: 'POST', headers: { 'x-rp-client': analyst.oid } },
    )
    expect(response.status).toBe(200)
    // Passages 11 to 50 are used, in order; documents past them are barely read.
    expect(prompts[0]).toContain('Passage number 11.')
    expect(prompts[0]).toContain('Passage number 50.')
    expect(prompts[0]).not.toContain('Passage number 10.')
    expect(prompts[0]).not.toContain('Passage number 51.')
    expect(prompts[0]!.indexOf('Passage number 11.')).toBeLessThan(
      prompts[0]!.indexOf('Passage number 12.'),
    )
    expect(new Set(reads).size).toBe(reads.length)
    expect(reads.length).toBeLessThanOrEqual(53)
    expect(reads.length).toBeGreaterThanOrEqual(50)
  } finally {
    f.close()
  }
})
