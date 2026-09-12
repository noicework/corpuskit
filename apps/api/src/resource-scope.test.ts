import { expect } from '@std/expect'
import type { AragProvider } from '@research-portal/retrieval'
import type { ResourceContent, ResourceSummary } from '@research-portal/core'
import { assertExpectedPermission, createEnforcementFixture } from './enforcement-fixture.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { AUDIT_MAX_RESPONSE_BYTES } from './audit-execution.ts'
import type { AskEvent } from '@research-portal/core'

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Stream did not make progress')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

Deno.test('ordinary public ask streams before provider completion and stops consuming after cancellation', async () => {
  for (const path of ['ask', 'docs/ask']) {
    for (const cancel of ['none', 'reader', 'request']) {
      const f = createEnforcementFixture()
      const controller = new AbortController()
      let release!: () => void
      const gate = new Promise<void>((resolve) => release = resolve)
      let complete = false
      let closed!: () => void
      const closure = new Promise<void>((resolve) => closed = resolve)
      let afterGate = 0
      f.provider.ask = async function* (): AsyncIterable<AskEvent> {
        try {
          yield { type: 'stage', stage: 'retrieval', status: 'started' }
          await gate
          afterGate++
          yield { type: 'delta', text: 'Research evidence is available. ' }
          afterGate++
          yield { type: 'done', text: 'Research evidence is available.' }
          complete = true
        } finally {
          closed()
        }
      }
      try {
        const response = await promptly(f.requestAs(
          null,
          `/api/t/public-a/${path}`,
          {
            ...post({
              query: 'Explain this paper',
              ...(path === 'ask' ? { resourceId: 'res-1' } : {}),
            }),
            signal: controller.signal,
          },
        ))
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        const reader = response.body!.getReader()
        const first = await promptly(reader.read())
        expect(new TextDecoder().decode(first.value)).toContain('retrieval')
        expect(complete).toBe(false)
        if (cancel === 'reader') await reader.cancel()
        if (cancel === 'request') controller.abort()
        release()
        if (cancel === 'none') {
          let text = ''
          while (true) {
            const chunk = await promptly(reader.read())
            if (chunk.done) break
            text += new TextDecoder().decode(chunk.value)
          }
          expect(text).toContain('done')
          expect(complete).toBe(true)
        }
        await promptly(closure)
        if (cancel !== 'none') {
          expect(afterGate).toBe(1)
          expect(complete).toBe(false)
          if (cancel === 'request') expect((await promptly(reader.read())).done).toBe(true)
        }
      } finally {
        release()
        await promptly(closure)
        f.close()
      }
    }
  }
})

Deno.test('large public file remains a lazy unbuffered stream outside privileged staging', async () => {
  const bytes = AUDIT_MAX_RESPONSE_BYTES + 8192
  let pulls = 0
  const f = createEnforcementFixture({
    management: {
      resourceContent: () =>
        Promise.resolve({ id: 'res-1', files: [{ group: 'files', fieldId: 'original' }] }),
      fileStream: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls++
                if (pulls === 1) controller.enqueue(new Uint8Array([65]))
                else {
                  controller.enqueue(new Uint8Array(bytes - 1))
                  controller.close()
                }
              },
            }, { highWaterMark: 0 }),
          ),
        ),
    } as unknown as AragProvider,
  })
  try {
    const response = await f.requestAs(null, '/api/t/public-a/resources/res-1/file/original')
    expect(response.status).toBe(200)
    expect(pulls).toBe(0)
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([65]))
    expect(pulls).toBe(1)
    expect((await reader.read()).value?.length).toBe(bytes - 1)
    expect((await reader.read()).done).toBe(true)
  } finally {
    f.close()
  }
})

const askCases = [
  ['ask', { query: 'Explain this paper', resourceId: 'res-1' }],
  ['docs/ask', { query: 'How does the portal work?' }],
  ['route', { query: 'Research evidence' }],
  ['feedback', { learningId: 'learning-123', good: true }],
] as const

Deno.test('ask never adopts same-valued signed or anonymous session references', async () => {
  for (const adapter of ['local', 'durable'] as const) {
    const f = createEnforcementFixture({}, adapter)
    try {
      const user = f.sessionFor('viewer', 'public-a')
      const signedOwner = { kind: 'user' as const, tenantId: user.tenantId, oid: user.oid }
      const anonymousOwner = { kind: 'anonymous' as const, clientId: user.oid }
      const record = { id: 'same-session', updatedAt: '2026-09-12', messages: [] }
      f.stores.sessions.put('public-a', signedOwner, { ...record, title: 'Signed history' })
      f.stores.sessions.put('public-a', anonymousOwner, { ...record, title: 'Anonymous history' })
      for (const session of [null, user]) {
        for (const reference of ['sessionId', 'conversationId']) {
          f.providerCalls.length = 0
          const response = await f.requestAs(
            session,
            '/api/t/public-a/ask',
            post({ query: 'Continue', [reference]: 'same-session' }, { 'x-rp-client': user.oid }),
          )
          expect(response.status).toBe(400)
          f.assertNoProtectedDispatch()
        }
      }
      expect(f.stores.sessions.get('public-a', signedOwner, record.id)?.title).toBe(
        'Signed history',
      )
      expect(f.stores.sessions.get('public-a', anonymousOwner, record.id)?.title).toBe(
        'Anonymous history',
      )
    } finally {
      f.close()
    }
  }
})
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

Deno.test('ask family authorises before any dispatch and rejects unsupported owner and portal references', async () => {
  let feedback = 0
  const f = createEnforcementFixture({
    management: {
      feedback: () => {
        feedback++
        return Promise.resolve()
      },
      rephrase: () => Promise.resolve(null),
      resourceExtraction: () =>
        Promise.resolve({
          status: 'PROCESSED',
          text: 'Evidence about abalone stock health in southern waters.',
          chars: 53,
          paragraphs: 1,
          tableRows: 0,
        }),
    } as unknown as AragProvider,
  })
  try {
    const prepared = await issueScopedKey(
      { slug: 'a', label: 'Viewer', role: 'viewer' },
      f.creator,
      f.authorityDependencies(),
    )
    prepared.commit()
    for (const [path, body] of askCases) {
      assertExpectedPermission('POST', `/api/t/:slug/${path}`, 'portal.ask', 'portal')
      for (
        const [slug, session] of [
          ['a', null],
          ['a', f.sessionFor('viewer', 'b')],
          ['authenticated-a', null],
          ['authenticated-a', f.otherTenant],
          ['disabled', null],
          ['corrupt', null],
        ] as const
      ) {
        f.providerCalls.length = 0
        feedback = 0
        const response = await f.requestAs(session, `/api/t/${slug}/${path}`, post(body))
        expect(response.status).toBe(session ? 403 : 401)
        expect(feedback).toBe(0)
        f.assertNoProtectedDispatch()
      }
      for (
        const [slug, session, headers] of [
          ['public-a', null, {}],
          ['authenticated-a', f.unassigned, {}],
          ['a', f.sessionFor('viewer'), {}],
          ['a', null, { authorization: `Bearer ${prepared.key}` }],
        ] as const
      ) {
        f.providerCalls.length = 0
        feedback = 0
        const response = await f.requestAs(session, `/api/t/${slug}/${path}`, post(body, headers))
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text.length).toBeGreaterThan(0)
        if (path.includes('ask')) {
          expect(f.providerCalls.some((call) => call.method === 'ask')).toBe(true)
        }
        if (path === 'feedback') expect(feedback).toBe(1)
        if (path === 'route') expect(JSON.parse(text).intent).toBeDefined()
      }
      for (
        const extra of [
          { slug: 'b' },
          { resourceIds: ['foreign'] },
          { sessionId: 'same-id' },
          { conversationId: 'same-id' },
          { owner: f.creator.oid },
          { clientId: f.creator.oid },
          { actor: 'system' },
        ]
      ) {
        f.providerCalls.length = 0
        feedback = 0
        const response = await f.requestAs(
          f.creator,
          `/api/t/a/${path}`,
          post({ ...body, ...extra }, {
            authorization: `Bearer ${prepared.key}`,
            'x-rp-client': f.creator.oid,
          }),
        )
        expect(response.status).toBe(400)
        f.assertNoProtectedDispatch()
        expect(feedback).toBe(0)
      }
      f.failAudit()
      f.providerCalls.length = 0
      feedback = 0
      expect((await f.requestAs(null, `/api/t/a/${path}`, post(body))).status).toBe(500)
      f.assertNoProtectedDispatch()
      expect(feedback).toBe(0)
      f.recoverAudit()
    }
    f.stores.mcpKeys.revoke('a', prepared.credential.id, new Date(f.now()).toISOString())
    for (const [path, body] of askCases) {
      f.providerCalls.length = 0
      feedback = 0
      expect(
        (await f.requestAs(
          f.creator,
          `/api/t/a/${path}`,
          post(body, { authorization: `Bearer ${prepared.key}` }),
        )).status,
      ).toBe(403)
      f.assertNoProtectedDispatch()
      expect(feedback).toBe(0)
    }
  } finally {
    f.close()
  }
})

Deno.test('ask checks current and history resource references and topic labels before retrieval', async () => {
  const f = scopedFixture()
  try {
    for (
      const body of [
        { resourceId: 'foreign' },
        { resourceId: 'same-id/../foreign' },
        { context: [{ author: 'AGENT', text: 'Earlier answer', resourceIds: ['foreign'] }] },
        { topicIds: ['foreign-topic'] },
      ]
    ) {
      f.providerCalls.length = 0
      expect(
        (await f.requestAs(
          f.sessionFor('viewer'),
          '/api/t/a/ask',
          post({ query: 'Explain evidence', ...body }),
        )).status,
      ).toBe(404)
      expect(f.providerCalls.filter((call) => !['resource', 'labelsets'].includes(call.method)))
        .toEqual([])
      expect(f.calls).toEqual([])
    }
    for (const path of ['ask', 'docs/ask']) {
      f.providerCalls.length = 0
      expect(
        (await f.requestAs(
          f.sessionFor('viewer'),
          `/api/t/a/${path}`,
          post({
            query: 'Evidence',
            context: [{ author: 'USER', text: 'Earlier', sessionId: 'other' }],
          }),
        )).status,
      ).toBe(400)
      f.assertNoProtectedDispatch()
    }
  } finally {
    f.close()
  }
})

function scopedFixture() {
  const calls: string[] = []
  let contentId: string | null = 'same-id'
  let lookupError = false
  const management = {
    resourceContent: (config: { slug: string }, id: string) => {
      calls.push(`content:${config.slug}:${id}`)
      if (contentId === null) return Promise.resolve(null)
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
    setContentId: (id: string | null) => contentId = id,
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
    f.setContentId(null)
    f.calls.length = 0
    expect((await f.requestAs(user, '/api/t/a/resources/same-id/file/a-original')).status).toBe(404)
    expect(f.calls).toEqual(['content:a:same-id'])
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
