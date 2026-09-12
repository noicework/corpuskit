import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import type { ResourceContent, ResourceSummary } from '@research-portal/core'
import { createEnforcementFixture } from './enforcement-fixture.ts'

function scopedFixture() {
  const calls: string[] = []
  let contentId = 'same-id'
  let lookupError = false
  const management = {
    resourceContent: (config: { slug: string }, id: string) => {
      calls.push(`content:${config.slug}:${id}`)
      return Promise.resolve({
        id: contentId,
        title: 'Scoped paper',
        kind: 'pdf',
        texts: [],
        transcript: [],
        files: [{ group: 'files', fieldId: `${config.slug}-original` }],
        preview: { fieldId: `${config.slug}-preview` },
      } as ResourceContent)
    },
    fileStream: (config: { slug: string }, id: string, field: string, range?: string) => {
      calls.push(`file:${config.slug}:${id}:${field}:${range ?? ''}`)
      return Promise.resolve(
        new Response('authorised bytes', {
          status: range ? 206 : 200,
          headers: { etag: 'same-validator', 'content-range': 'bytes 0-15/16' },
        }),
      )
    },
    thumbnailResponse: () => {
      calls.push('thumbnail')
      return Promise.resolve(new Response('thumbnail'))
    },
  } as unknown as AragProvider
  const f = createEnforcementFixture({ management })
  f.provider.resource = (config, id) => {
    if (lookupError) throw new Error('lookup failed')
    return Promise.resolve(
      id === 'same-id' || (config.slug === 'b' && id === 'foreign')
        ? { id, title: `${config.slug} paper`, topicIds: [] } as unknown as ResourceSummary
        : id === 'mismatch'
        ? { id: 'foreign', title: 'Foreign', topicIds: [] } as unknown as ResourceSummary
        : null,
    )
  }
  return {
    ...f,
    calls,
    setContentId: (id: string) => contentId = id,
    failLookup: () => lookupError = true,
  }
}

Deno.test('resource references resolve before content, thumbnail, file and questions dispatch', async () => {
  const f = scopedFixture()
  try {
    const viewer = f.sessionFor('viewer')
    for (
      const id of ['foreign', 'missing', 'mismatch', 'same-id%2F..%2Fforeign', 'same-id%5Cforeign']
    ) {
      for (const suffix of ['', '/content', '/thumbnail', '/file/a-original', '/questions']) {
        f.calls.length = 0
        const response = await f.requestAs(viewer, `/api/t/a/resources/${id}${suffix}`)
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(f.calls).toEqual([])
      }
    }
    expect((await f.requestAs(f.sessionFor('viewer', 'b'), '/api/t/b/resources/foreign')).status)
      .toBe(200)
    f.failLookup()
    expect((await f.requestAs(viewer, '/api/t/a/resources/same-id/content')).status).toBe(404)
    expect(f.calls).toEqual([])
    expect(
      f.rbac.audit.read({ scope: { kind: 'platform' } }).filter((event) =>
        event.action === 'request.denied'
      ).length,
    ).toBeGreaterThan(0)
    f.failAudit()
    expect((await f.requestAs(viewer, '/api/t/a/resources/missing/content')).status).toBe(500)
    expect(f.calls).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('file fields require exact original or preview association and recheck access on Range replay', async () => {
  const f = scopedFixture()
  try {
    const viewer = f.sessionFor('viewer')
    for (const field of ['a-original', 'a-preview']) {
      for (const range of [undefined, 'bytes=0-15']) {
        f.calls.length = 0
        const response = await f.requestAs(viewer, `/api/t/a/resources/same-id/file/${field}`, {
          headers: range ? { range } : {},
        })
        expect(response.status).toBe(range ? 206 : 200)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(await response.text()).toBe('authorised bytes')
        expect(f.calls).toEqual(['content:a:same-id', `file:a:same-id:${field}:${range ?? ''}`])
      }
    }
    for (const field of ['b-original', 'b-preview', 'absent', 'a-original%2F..%2Fb-original']) {
      f.calls.length = 0
      expect((await f.requestAs(viewer, `/api/t/a/resources/same-id/file/${field}`)).status).toBe(
        404,
      )
      expect(f.calls.filter((c) => c.startsWith('file:'))).toEqual([])
    }
    f.setContentId('foreign')
    for (const suffix of ['/content', '/file/a-original', '/file/a-preview']) {
      f.calls.length = 0
      const response = await f.requestAs(viewer, `/api/t/a/resources/same-id${suffix}`)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('Scoped paper')
      expect(f.calls.filter((c) => c.startsWith('file:'))).toEqual([])
    }
    f.database.exec('DELETE FROM role_assignments WHERE subject_id = ?', viewer.oid)
    f.calls.length = 0
    const denied = await f.requestAs(viewer, '/api/t/a/resources/same-id/file/a-original', {
      headers: { range: 'bytes=0-15', 'if-none-match': 'same-validator' },
    })
    expect(denied.status).toBe(403)
    expect(f.calls).toEqual([])
  } finally {
    f.close()
  }
})

Deno.test('topics, labelsets and entity references resolve in the portal catalogue before dispatch', async () => {
  const calls: string[] = []
  const f = createEnforcementFixture({
    management: {
      entityGroups: (config: { slug: string }) =>
        Promise.resolve([{ group: 'Research', entities: [`${config.slug}-entity`] }]),
      relationsGraph: () => {
        calls.push('relations')
        return Promise.resolve({ nodes: [], edges: [] })
      },
      listAgents: () => Promise.resolve([]),
      graphData: () => {
        calls.push('graph')
        return Promise.resolve({ nodes: [], edges: [] })
      },
    } as unknown as AragProvider,
  })
  f.provider.labelsets = (config) =>
    Promise.resolve([
      { id: `${config.slug}-labels`, title: 'Labels', multiple: true, labels: [] },
      { id: 'topic', title: 'Topic', multiple: true, labels: [`${config.slug}-topic`] },
    ])
  try {
    const user = f.sessionFor('viewer')
    for (
      const path of [
        'topics/b-topic/resources',
        'facets?labelsets=b-labels',
        'graph?primary=b-labels&secondary=topic',
        'entity?name=b-entity',
        'graph/relations?entity=b-entity',
      ]
    ) {
      f.providerCalls.length = 0
      expect((await f.requestAs(user, `/api/t/a/${path}`)).status).toBe(404)
      expect(calls).toEqual([])
      expect(f.providerCalls.filter((call) => call.method !== 'labelsets')).toEqual([])
    }
    for (
      const path of [
        'topics/a-topic/resources',
        'facets?labelsets=a-labels',
        'graph?primary=a-labels&secondary=topic',
        'graph/relations?entity=a-entity',
      ]
    ) {
      expect((await f.requestAs(user, `/api/t/a/${path}`)).status).toBe(200)
    }
    expect(calls).toEqual(['graph', 'relations'])
    expect(f.providerCalls.some((call) => call.method === 'topicResources')).toBe(true)
    expect(f.providerCalls.some((call) => call.method === 'facets')).toBe(true)
  } finally {
    f.close()
  }
})

Deno.test('missing authoritative content never opens a file and valid content and thumbnails remain available', async () => {
  const f = scopedFixture()
  try {
    const user = f.sessionFor('viewer')
    expect((await f.requestAs(user, '/api/t/a/resources/same-id/content')).status).toBe(200)
    expect((await f.requestAs(user, '/api/t/a/resources/same-id/thumbnail')).status).toBe(200)
    f.setContentId('unresolved')
    f.calls.length = 0
    f.failAudit()
    expect((await f.requestAs(user, '/api/t/a/resources/same-id/file/a-original')).status).toBe(500)
    expect(f.calls).toEqual(['content:a:same-id'])
  } finally {
    f.close()
  }
  const noManagement = createEnforcementFixture()
  try {
    expect(
      (await noManagement.requestAs(
        noManagement.sessionFor('viewer'),
        '/api/t/a/resources/res-1/file/arbitrary',
      )).status,
    ).toBe(404)
  } finally {
    noManagement.close()
  }
})
