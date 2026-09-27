import { expect } from '@std/expect'
import type {
  Enrichment,
  PortalLimits,
  RecentResource,
  ResourceSummary,
  TenantConfig,
} from '@research-portal/core'
import { AragApiError, AragProvider } from '@research-portal/retrieval'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { EnrichmentStore } from './enrichments.ts'
import { MEASURE_TIMEOUT } from './lifecycle-store.ts'
import { DECLARATIONS } from './permissions.ts'
import { issueScopedKey } from './scoped-keys.ts'
import { SUGGESTED_QUESTIONS_SCHEMA_ID } from './suggested-questions.ts'

/**
 * Deleting a document (`DELETE /api/admin/t/:slug/resources/:id`) through the whole route
 * middleware, on both storage adapters: the Durable Object and the local files. Store-level
 * checks alone missed an undeclared mutation before, so every case here goes through the guard,
 * the audit boundary and the adapter's own store wrappers.
 */

const ADAPTERS = ['durable', 'local'] as const
type Adapter = typeof ADAPTERS[number]

interface Doc {
  title: string
  hidden: boolean
  type: ResourceSummary['type']
}

const enrichment = (schemaId: string, title: string): Enrichment => ({
  schemaId,
  generatedAt: '2026-09-26T00:00:00.000Z',
  data: { title },
})

/**
 * The knowledge boxes of portals `a` and `b`, holding documents by id. Every read is answered from
 * the box of the portal that asks, as the platform answers from one box.
 */
function boxes() {
  const docs: Record<string, Map<string, Doc>> = { a: new Map(), b: new Map() }
  const box = {
    created: 0,
    deletes: [] as string[],
    reads: [] as string[],
    refuse: undefined as Error | undefined,
    unreadable: new Set<string>(),
    /** Ids whose next read answers 404 although the box still holds them. */
    transient404: new Set<string>(),
    /** When set, a delete waits for it before it lands, and can be cut off meanwhile. */
    gate: undefined as Promise<void> | undefined,
    /** A delete cut off in flight still lands on the platform. */
    landsWhenCut: false,
  }
  const portal = (tenant: TenantConfig) => docs[tenant.slug] ?? new Map<string, Doc>()
  class Reader extends DoubleProvider {
    override resource(
      tenant: TenantConfig,
      id: string,
      options: { hidden?: boolean } = {},
    ): Promise<ResourceSummary | null> {
      box.reads.push(`${tenant.slug}/${id}`)
      if (box.transient404.delete(id)) return Promise.resolve(null)
      if (box.unreadable.has(id)) {
        return Promise.reject(new AragApiError(503, `/resource/${id}`, 'unavailable'))
      }
      const doc = portal(tenant).get(id)
      if (!doc || (doc.hidden && options.hidden !== true)) return Promise.resolve(null)
      return Promise.resolve({
        id,
        title: doc.title,
        summary: doc.title,
        type: doc.type,
        topicIds: [],
        keyFacts: [],
        ...(doc.hidden ? { hidden: true as const } : {}),
      })
    }
  }
  const create = (tenant: TenantConfig, title: string, type: Doc['type'], hidden?: boolean) => {
    const id = `${type === 'web' ? 'link' : 'doc'}-${++box.created}`
    portal(tenant).set(id, { title, type, hidden: hidden === true })
    return Promise.resolve({ id })
  }
  const management = new AragProvider({ resolveBinding: () => undefined })
  Object.assign(management, {
    resourceCount: (tenant: TenantConfig) => Promise.resolve(portal(tenant).size),
    createText: (tenant: TenantConfig, input: { title: string; hidden?: boolean }) =>
      create(tenant, input.title, 'document', input.hidden),
    createLink: (tenant: TenantConfig, input: { url: string; hidden?: boolean }) =>
      create(tenant, input.url, 'web', input.hidden),
    setResourceHidden: (tenant: TenantConfig, id: string, hidden: boolean) => {
      const doc = portal(tenant).get(id)
      if (doc) doc.hidden = hidden
      return Promise.resolve()
    },
    deleteResource: async (
      tenant: TenantConfig,
      id: string,
      options: { signal?: AbortSignal } = {},
    ) => {
      box.deletes.push(`${tenant.slug}/${id}`)
      if (box.refuse) throw box.refuse
      if (box.gate) {
        const signal = options.signal
        const cut = new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => {
            if (box.landsWhenCut) portal(tenant).delete(id)
            reject(signal.reason)
          }, { once: true })
        )
        await Promise.race([box.gate, cut])
      }
      portal(tenant).delete(id)
    },
    // The ledger's reads of what a delete left behind, drafts included.
    resource: (tenant: TenantConfig, id: string) =>
      Promise.resolve(portal(tenant).has(id) ? { id } : null),
    resourceExtraction: () => Promise.resolve({ status: 'PENDING', text: '' }),
    recentResources: (tenant: TenantConfig, limit = 12) =>
      Promise.resolve(
        [...portal(tenant)].reverse().slice(0, limit).map(([id, doc]) => ({
          id,
          title: doc.title,
          status: 'processed',
          hidden: doc.hidden,
        })),
      ),
  })
  return { docs, box, provider: new Reader(), management }
}

async function portal(
  adapter: Adapter,
  limits: PortalLimits | null = null,
  linkProvisionalBytes = 400,
) {
  const b = boxes()
  const f = createEnforcementFixture(
    { management: b.management, provider: b.provider, linkProvisionalBytes },
    adapter,
  )
  await f.stores.bindings.set('a', {
    baseUrl: 'https://example.test/kb/a',
    token: 'fixture',
    kbId: 'a',
  })
  f.stores.lifecycle.set('a', { status: 'active', limits })
  const curator = f.sessionFor('curator')
  const send = async (
    session: ReturnType<typeof f.sessionFor> | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) => {
    const response = await f.requestAs(session, path, {
      method,
      ...(signal ? { signal } : {}),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      requestId: response.headers.get('x-request-id') ?? '',
    }
  }
  const remove = (
    id: string,
    session: ReturnType<typeof f.sessionFor> | null = curator,
    signal?: AbortSignal,
  ) =>
    send(
      session,
      'DELETE',
      `/api/admin/t/a/resources/${encodeURIComponent(id)}`,
      undefined,
      {},
      signal,
    )
  const text = (title: string, bytes = 10) =>
    send(curator, 'POST', '/api/admin/t/a/resources/text', { title, body: 'n'.repeat(bytes) })
  const link = (name: string, hidden = false) =>
    send(curator, 'POST', '/api/admin/t/a/resources/link', {
      url: `https://example.test/${name}.pdf`,
      ...(hidden ? { hidden: true } : {}),
    })
  const events = (requestId: string) =>
    f.rbac.audit.read({ scope: { kind: 'platform' }, requestId, limit: 1000 })
  /** The request's `resource.delete` records: its intent and, once it ends, its completion. */
  const deletion = (requestId: string) => {
    const records = events(requestId).filter((event) => event.action === 'resource.delete')
    return [
      ...records.filter((event) => event.outcome === 'intent'),
      ...records.filter((event) => event.outcome !== 'intent'),
    ]
  }
  const capacity = () =>
    f.stores.lifecycle.state.get<{
      removed: { count: number }[]
      measuring?: Record<string, { at: number }>
      deleting?: Record<string, { at: number; missingSince?: number }>
    }>('portal-capacity:a', { removed: [] })
  /** Deletions the ledger has recorded that the box's count may not show yet. */
  const removals = () => capacity().removed.reduce((total, entry) => total + entry.count, 0)
  /** Make a link look as if it was added an hour ago. */
  const age = (id: string) => {
    const record = capacity()
    record.measuring![id]!.at -= MEASURE_TIMEOUT
    f.stores.lifecycle.state.put('portal-capacity:a', record)
  }
  /** Make a delete record's reads look as if they have answered 404 for an hour. */
  const lapse = (id: string) => {
    const record = capacity()
    const entry = record.deleting![id]!
    entry.missingSince = (entry.missingSince ?? Date.now()) - MEASURE_TIMEOUT
    f.stores.lifecycle.state.put('portal-capacity:a', record)
  }
  return {
    ...b,
    f,
    curator,
    send,
    remove,
    text,
    link,
    events,
    deletion,
    removals,
    age,
    lapse,
  }
}

/** Replace a store method with one that fails once, then gives the method back. */
function failOnce(store: object, method: string) {
  const target = store as Record<string, unknown>
  target[method] = () => {
    delete target[method]
    throw new Error('storage unavailable')
  }
}

Deno.test('a curator deletes a published document and a draft, releasing their bytes and enrichments, on every storage adapter', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 1_000 }, 300)
    try {
      const published = await p.text('Stock report', 100)
      expect(published.status, adapter).toBe(200)
      const draft = await p.link('draft', true)
      expect(draft.status, adapter).toBe(200)
      const [report, notes] = [published.body.id as string, draft.body.id as string]
      expect(p.docs.a!.get(notes)?.hidden, adapter).toBe(true)
      p.f.stores.enrichments.put('a', report, enrichment('research', 'Stock report'))
      p.f.stores.enrichments.put('a', report, enrichment(SUGGESTED_QUESTIONS_SCHEMA_ID, 'Q'))
      p.f.stores.enrichments.put('a', 'other-doc', enrichment('research', 'Other'))
      expect(p.f.stores.lifecycle.bytesUsed('a', 2), adapter).toBe(100 + 300)

      const first = await p.remove(report)
      expect(first, adapter).toMatchObject({ status: 200, body: { ok: true } })
      expect(p.docs.a!.has(report), adapter).toBe(false)
      expect(p.f.stores.lifecycle.tracksResource('a', report), adapter).toBe(false)
      expect(p.f.stores.enrichments.holdsResource('a', report), adapter).toBe(false)
      expect(p.f.stores.enrichments.holdsResource('a', 'other-doc'), adapter).toBe(true)
      const audited = p.deletion(first.requestId)
      expect(audited.map((event) => event.outcome), adapter).toEqual(['intent', 'success'])
      expect(audited[1], adapter).toMatchObject({
        scope_kind: 'portal',
        scope_slug: 'a',
        target_kind: 'resource',
        target_id: report,
      })
      expect(JSON.parse(audited[1]!.detail_json), adapter).toEqual({
        permission: 'content.write',
        resourceKind: 'document',
        draft: false,
      })
      expect(p.events(first.requestId), adapter).toContainEqual(
        expect.objectContaining({ action: 'request.privileged', outcome: 'success' }),
      )
      // The ledger's release is a declared, audited mutation of the request.
      const mutations = p.events(first.requestId)
        .filter((event) => event.action === 'local.mutation')
        .map((event) => JSON.parse(event.detail_json).mutation)
      expect(mutations, adapter).toContain('lifecycle.forgetResource')
      if (adapter === 'durable') expect(mutations).toContain('enrichments.forgetResource')

      // A draft is found and deleted too; the link frees its provisional bytes.
      const second = await p.remove(notes)
      expect(second.status, adapter).toBe(200)
      expect(JSON.parse(p.deletion(second.requestId)[1]!.detail_json), adapter).toEqual({
        permission: 'content.write',
        resourceKind: 'web',
        draft: true,
      })
      expect(p.docs.a!.size, adapter).toBe(0)
      expect(p.f.stores.lifecycle.bytesUsed('a', 0), adapter).toBe(0)
      expect(p.removals(), adapter).toBe(2)
      expect((await p.text('Fills the portal', 1_000)).status, adapter).toBe(200)
      // Deleted is deleted: the same id again is unknown.
      expect(await p.remove(report), adapter).toMatchObject({
        status: 404,
        body: { error: 'not_found' },
      })
      expect(p.box.deletes, adapter).toEqual([`a/${report}`, `a/${notes}`])
    } finally {
      p.f.close()
    }
  }
})

Deno.test('deleting a waiting or stuck link frees its bytes at once and lets the refused add through', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 1_000 }, 400)
    try {
      // A link still waiting to be measured holds 400 bytes: this add is told to wait.
      const waiting = await p.link('waiting')
      expect(waiting.status, adapter).toBe(200)
      expect(await p.text('Notes', 700), adapter).toMatchObject({
        status: 503,
        body: { error: 'links_pending' },
      })
      expect((await p.remove(waiting.body.id)).status, adapter).toBe(200)
      const notes = await p.text('Notes', 700)
      expect(notes.status, adapter).toBe(200)
      expect((await p.remove(notes.body.id)).status, adapter).toBe(200)

      // Links still unprocessed an hour after they were added are stuck: waiting will not help.
      // The box cannot even read the second one.
      const stuck = await p.link('stuck')
      const lost = await p.link('lost')
      expect([stuck.status, lost.status], adapter).toEqual([200, 200])
      p.box.unreadable.add(lost.body.id)
      p.age(stuck.body.id)
      p.age(lost.body.id)
      expect(await p.text('Notes', 700), adapter).toMatchObject({
        status: 413,
        body: { error: 'links_stuck' },
      })
      // Recent additions lists them, marked stuck, however many documents were added after them.
      // One the box cannot read is listed by its id, so each row can be told apart.
      for (let n = 0; n < 12; n++) expect((await p.text(`Later ${n}`)).status).toBe(200)
      const recent = await p.send(p.curator, 'GET', '/api/admin/t/a/recent')
      expect(recent.status, adapter).toBe(200)
      const rows = recent.body as RecentResource[]
      expect(rows.filter((row) => row.stuck), adapter).toEqual([{
        id: stuck.body.id,
        title: 'https://example.test/stuck.pdf',
        status: 'pending',
        hidden: false,
        stuck: true,
      }, {
        id: lost.body.id,
        title: `A link that could not be processed (${lost.body.id})`,
        status: 'pending',
        hidden: false,
        stuck: true,
      }])
      expect(rows.filter((row) => !row.stuck), adapter).toHaveLength(12)
      // The list is polled while additions process; stuck links are not read on every poll.
      const reads = p.box.reads.length
      const polled = await p.send(p.curator, 'GET', '/api/admin/t/a/recent')
      expect(polled.body, adapter).toEqual(recent.body)
      expect(p.box.reads.length, adapter).toBe(reads)

      // While the box cannot read it, a delete changes nothing; once it can, the delete goes.
      expect((await p.remove(lost.body.id)).status, adapter).toBe(502)
      p.box.unreadable.clear()
      for (const id of [stuck.body.id, lost.body.id]) {
        expect((await p.remove(id)).status, `${adapter} ${id}`).toBe(200)
      }
      expect(p.f.stores.lifecycle.stuckLinks('a'), adapter).toEqual([])
      // A ledger that cannot be read does not take the listing down with it.
      const ledger = p.f.stores.lifecycle.state.get<unknown>('portal-capacity:a', null)
      p.f.stores.lifecycle.state.put('portal-capacity:a', { v: 1, broken: true })
      const listed = await p.send(p.curator, 'GET', '/api/admin/t/a/recent')
      expect(listed.status, adapter).toBe(200)
      expect((listed.body as RecentResource[]).length, adapter).toBe(12)
      p.f.stores.lifecycle.state.put('portal-capacity:a', ledger)
      expect((await p.text('Notes', 700)).status, adapter).toBe(200)
      const after = await p.send(p.curator, 'GET', '/api/admin/t/a/recent')
      expect((after.body as RecentResource[]).some((row) => row.stuck), adapter).toBe(false)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('unknown, deleted and other portals’ documents answer 404 without a read of any other box', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter)
    try {
      p.docs.b!.set('b-report', { title: 'Portal b report', hidden: false, type: 'pdf' })
      const kept = await p.text('Kept')
      for (const id of ['missing', 'b-report', 'bad id', 'doc-1:x']) {
        const response = await p.remove(id)
        expect(response, `${adapter} ${id}`).toMatchObject({
          status: 404,
          body: { error: 'not_found' },
        })
        expect(p.events(response.requestId), `${adapter} ${id}`).toContainEqual(
          expect.objectContaining({ action: 'request.denied', outcome: 'denied' }),
        )
        expect(p.deletion(response.requestId), `${adapter} ${id}`).toEqual([])
      }
      expect(p.box.reads.every((read) => read.startsWith('a/')), adapter).toBe(true)
      expect(p.box.deletes, adapter).toEqual([])
      expect(p.docs.b!.has('b-report'), adapter).toBe(true)
      expect(p.docs.a!.has(kept.body.id), adapter).toBe(true)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('only a session with content.write deletes: viewers, analysts, visitors, other portals and keys are refused', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter)
    try {
      const doc = (await p.text('Report')).body.id as string
      const key = await issueScopedKey(
        { slug: 'a', label: 'Client', role: 'curator' },
        p.f.creator,
        p.f.authorityDependencies(),
      )
      key.commit()
      const refused = [
        ['viewer', p.f.sessionFor('viewer'), {}],
        ['analyst', p.f.sessionFor('analyst'), {}],
        ['another portal’s administrator', p.f.sessionFor('portal-admin', 'b'), {}],
        ['another portal’s curator', p.f.sessionFor('curator', 'b'), {}],
        ['a signed-in user with no role', p.f.unassigned, {}],
        ['an anonymous visitor', null, {}],
        ['another tenant', p.f.otherTenant, {}],
        ['a curator key', null, { authorization: `Bearer ${key.key}` }],
      ] as const
      const reads = p.box.reads.length
      for (const [who, session, headers] of refused) {
        const response = await p.send(
          session,
          'DELETE',
          `/api/admin/t/a/resources/${doc}`,
          undefined,
          headers,
        )
        expect([401, 403, 404], `${adapter} ${who}: ${response.status}`).toContain(
          response.status,
        )
        expect(p.deletion(response.requestId), `${adapter} ${who}`).toEqual([])
      }
      expect(p.box.reads.length, adapter).toBe(reads)
      expect(p.box.deletes, adapter).toEqual([])
      expect(p.docs.a!.has(doc), adapter).toBe(true)
      expect((await p.remove(doc)).status, adapter).toBe(200)
    } finally {
      p.f.close()
    }
  }
  // The MCP server offers no way to delete.
  expect(
    DECLARATIONS.filter((item) => item.kind === 'mcp').map((item) => item.path)
      .filter((name) => /delete|remove/i.test(name)),
  ).toEqual([])
})

Deno.test('a delete the platform refuses or cannot confirm answers 502 and changes nothing', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 1_000 })
    try {
      const doc = (await p.text('Report', 100)).body.id as string
      p.f.stores.enrichments.put('a', doc, enrichment('research', 'Report'))
      for (
        const [refusal, outcome] of [
          [new AragApiError(403, `/resource/${doc}`, 'Forbidden'), 'failure'],
          [new AragApiError(503, `/resource/${doc}`, 'Unavailable'), 'uncertain'],
          [new TypeError('network connection lost'), 'uncertain'],
        ] as const
      ) {
        p.box.refuse = refusal
        const response = await p.remove(doc)
        expect(response, `${adapter} ${refusal.message}`).toMatchObject({
          status: 502,
          body: { error: 'delete_failed' },
        })
        expect(p.deletion(response.requestId).map((event) => event.outcome), adapter).toEqual([
          'intent',
          outcome,
        ])
        expect(p.docs.a!.has(doc), adapter).toBe(true)
        expect(p.f.stores.lifecycle.tracksResource('a', doc), adapter).toBe(true)
        expect(p.f.stores.lifecycle.bytesUsed('a', 1), adapter).toBe(100)
        expect(p.f.stores.enrichments.holdsResource('a', doc), adapter).toBe(true)
        expect(p.removals(), adapter).toBe(0)
      }
      p.box.refuse = undefined
      // A read of the document that fails changes nothing either, and sends no delete.
      p.box.unreadable.add(doc)
      const deletes = p.box.deletes.length
      expect(await p.remove(doc), adapter).toMatchObject({
        status: 502,
        body: { error: 'upstream_unavailable' },
      })
      expect(p.box.deletes.length, adapter).toBe(deletes)
      p.box.unreadable.clear()
      expect((await p.remove(doc)).status, adapter).toBe(200)
      expect(p.f.stores.lifecycle.bytesUsed('a', 0), adapter).toBe(0)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('a delete whose clean-up fails is uncertain, and deleting it again finishes the clean-up once', async () => {
  for (const adapter of ADAPTERS) {
    for (const store of ['lifecycle', 'enrichments'] as const) {
      const label = `${adapter} ${store}`
      const p = await portal(adapter, { maxResources: 5, maxBytes: 1_000 })
      try {
        const doc = (await p.text('Report', 100)).body.id as string
        p.f.stores.enrichments.put('a', doc, enrichment('research', 'Report'))
        failOnce(p.f.stores[store], 'forgetResource')
        const first = await p.remove(doc)
        // Both adapters say the same: the document was deleted, and a retry finishes the rest.
        expect(first, label).toMatchObject({
          status: 500,
          body: {
            error: 'cleanup_incomplete',
            message:
              'The document was deleted, but some of what the portal kept for it could not be cleared. Try again to finish.',
          },
        })
        // The document is gone from the box, and the audit says the delete is uncertain.
        expect(p.docs.a!.has(doc), label).toBe(false)
        expect(p.deletion(first.requestId).map((event) => event.outcome), label).toEqual([
          'intent',
          'uncertain',
        ])
        expect(p.f.stores.lifecycle.tracksResource('a', doc), label).toBe(store === 'lifecycle')
        expect(p.f.stores.enrichments.holdsResource('a', doc), label).toBe(
          store === 'enrichments',
        )
        const counted = p.removals()
        // Deleting it again clears only what the portal kept, and counts nothing twice.
        const retry = await p.remove(doc)
        expect(retry, label).toMatchObject({ status: 200, body: { ok: true } })
        const audited = p.deletion(retry.requestId)
        expect(audited.map((event) => event.outcome), label).toEqual(['intent', 'success'])
        expect(JSON.parse(audited[1]!.detail_json), label).toEqual({
          permission: 'content.write',
          cleanupOnly: true,
        })
        // The retry asks the box again, which answers as for a document already gone.
        expect(p.box.deletes, label).toEqual([`a/${doc}`, `a/${doc}`])
        expect(p.f.stores.lifecycle.tracksResource('a', doc), label).toBe(false)
        expect(p.f.stores.enrichments.holdsResource('a', doc), label).toBe(false)
        expect(p.removals(), label).toBe(counted)
        expect(p.f.stores.lifecycle.bytesUsed('a', 0), label).toBe(0)
        // Once finished, the id is unknown, and the ledger is whole: the portal fills exactly.
        expect((await p.remove(doc)).status, label).toBe(404)
        expect((await p.text('Fills the portal', 1_000)).status, label).toBe(200)
        expect((await p.text('One byte too many', 1)).status, label).toBe(413)
      } finally {
        p.f.close()
      }
    }
  }
})

Deno.test('a delete never races an add or a measurement into an inconsistent ledger', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 1_000 }, 400)
    try {
      // The platform has created the document, but the add that created it has not settled.
      let settle!: () => void
      const createText = p.management.createText.bind(p.management)
      Object.assign(p.management, {
        createText: async (
          tenant: TenantConfig,
          input: Parameters<AragProvider['createText']>[1],
        ) => {
          const created = await createText(tenant, input)
          if (input.title === 'Slow') await new Promise<void>((resolve) => settle = resolve)
          return created
        },
      })
      const adding = p.text('Slow', 200)
      while (![...p.docs.a!.values()].some((doc) => doc.title === 'Slow')) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const [slow] = [...p.docs.a!].find(([, doc]) => doc.title === 'Slow')!
      // A curator deletes it first. The add then settles for a resource that is gone: it records
      // nothing, so no space stays held for it.
      expect(await p.remove(slow), adapter).toMatchObject({ status: 200, body: { ok: true } })
      expect(p.docs.a!.has(slow), adapter).toBe(false)
      settle()
      expect((await adding).status, adapter).toBe(200)
      expect(p.f.stores.lifecycle.tracksResource('a', slow), adapter).toBe(false)
      expect(p.f.stores.lifecycle.bytesUsed('a', 0), adapter).toBe(0)
      const filled = await p.text('Fills the portal', 1_000)
      expect(filled.status, adapter).toBe(200)
      expect((await p.remove(filled.body.id)).status, adapter).toBe(200)

      // A link is being read for its size when it is deleted. What the read finds afterwards is
      // not recorded: the link stays released.
      const link = (await p.link('measured')).body.id as string
      let answer!: () => void
      Object.assign(p.management, {
        resourceExtraction: () =>
          new Promise((resolve) =>
            answer = () => resolve({ status: 'PROCESSED', text: 'x'.repeat(50) })
          ),
      })
      const usage = p.send(p.f.sessionFor('platform-admin'), 'GET', '/api/admin/t/a/usage')
      while (!answer) await new Promise((resolve) => setTimeout(resolve, 5))
      expect((await p.remove(link)).status, adapter).toBe(200)
      answer()
      expect((await usage).status, adapter).toBe(200)
      expect((await p.text('Next', 10)).status, adapter).toBe(200)
      expect(p.f.stores.lifecycle.tracksResource('a', link), adapter).toBe(false)
      expect(p.f.stores.lifecycle.bytesUsed('a', 1), adapter).toBe(10)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('a read-only or paused portal refuses a delete before anything is read or removed', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter)
    try {
      const doc = (await p.text('Report')).body.id as string
      const reads = p.box.reads.length
      for (
        const [status, error] of [['read_only', 'portal_read_only'], [
          'suspended',
          'portal_suspended',
        ]] as const
      ) {
        p.f.stores.lifecycle.set('a', { status, limits: null })
        expect(await p.remove(doc), `${adapter} ${status}`).toMatchObject({
          status: 423,
          body: { error },
        })
      }
      expect(p.box.reads.length, adapter).toBe(reads)
      expect(p.box.deletes, adapter).toEqual([])
      p.f.stores.lifecycle.set('a', { status: 'active', limits: null })
      expect((await p.remove(doc)).status, adapter).toBe(200)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('an add that never settled does not stop documents being deleted', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxResources: 100 })
    try {
      // A document from before the portal's ledger began, and an add whose request died after
      // it was admitted, so its reservation lingers.
      p.docs.a!.set('legacy-1', { title: 'Older report', hidden: false, type: 'pdf' })
      expect((await p.text('Starts the ledger')).status, adapter).toBe(200)
      p.f.stores.lifecycle.reserveAdd('a', { observed: p.docs.a!.size, bytes: 10 })
      expect(await p.remove('legacy-1'), adapter).toMatchObject({
        status: 200,
        body: { ok: true },
      })
      expect(p.docs.a!.has('legacy-1'), adapter).toBe(false)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('a delete whose request ends while it waits its turn is never sent', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 1_000 })
    try {
      const doc = (await p.text('Report', 600)).body.id as string
      // An add holds the capacity step while it reads the box's count.
      let counted!: () => void
      const counting = new Promise<void>((resolve) => counted = resolve)
      const count = p.management.resourceCount.bind(p.management)
      let hold = true
      Object.assign(p.management, {
        resourceCount: async (tenant: TenantConfig) => {
          if (hold) await counting
          return count(tenant)
        },
      })
      const add = p.text('Holds the capacity step', 10)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const ended = new AbortController()
      const pending = p.remove(doc, p.curator, ended.signal).catch(() => null)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(p.box.deletes, adapter).toEqual([])
      ended.abort()
      await pending
      hold = false
      counted()
      await add
      await new Promise((resolve) => setTimeout(resolve, 20))
      // Nothing was sent after the request ended: the document and its space are untouched,
      // and nothing is left to settle.
      expect(p.box.deletes, adapter).toEqual([])
      expect(p.docs.a!.has(doc), adapter).toBe(true)
      expect(p.f.stores.lifecycle.tracksResource('a', doc), adapter).toBe(true)
      expect(p.f.stores.lifecycle.pendingDeletes('a'), adapter).toEqual([])
      expect((await p.remove(doc)).status, adapter).toBe(200)
      expect(p.f.stores.lifecycle.bytesUsed('a', 1), adapter).toBe(10)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('a delete cut off in flight is cancelled at the platform, and the portal settles what landed', async () => {
  for (const adapter of ADAPTERS) {
    for (const lands of [false, true]) {
      const label = `${adapter} ${lands ? 'landed' : 'cancelled'}`
      const p = await portal(adapter, { maxBytes: 1_000 })
      try {
        const doc = (await p.text('Report', 600)).body.id as string
        p.box.landsWhenCut = lands
        p.box.gate = new Promise<void>(() => {})
        const ended = new AbortController()
        const pending = p.remove(doc, p.curator, ended.signal).catch(() => null)
        while (p.box.deletes.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        ended.abort()
        await pending
        p.box.gate = undefined
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(p.docs.a!.has(doc), label).toBe(!lands)
        // The release could not be recorded after the request ended; the ledger remembers the
        // delete was sent, so the document's space is not lost for good.
        expect(p.f.stores.lifecycle.pendingDeletes('a'), label).toEqual([doc])
        expect(p.f.stores.lifecycle.bytesUsed('a', lands ? 0 : 1), label).toBe(600)
        if (!lands) {
          // The box still has it: a delete sent again goes through as usual.
          expect((await p.remove(doc)).status, label).toBe(200)
        } else {
          // An add that does not fit reads the box for it. One 404 is no proof...
          expect((await p.text('Needs the space', 500)).status, label).toBe(413)
          expect(p.f.stores.lifecycle.pendingDeletes('a'), label).toEqual([doc])
          // ...an hour of them is: the space is freed without anyone finding the id.
          p.lapse(doc)
          expect((await p.text('Needs the space', 500)).status, label).toBe(200)
        }
        expect(p.f.stores.lifecycle.pendingDeletes('a'), label).toEqual([])
        expect(p.f.stores.lifecycle.tracksResource('a', doc), label).toBe(false)
      } finally {
        p.f.close()
      }
    }
  }
})

Deno.test('a delete is sent even when a single read says the document is gone', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter, { maxBytes: 10_000 })
    try {
      const doc = (await p.text('Report', 100)).body.id as string
      p.box.transient404.add(doc)
      expect(await p.remove(doc), adapter).toMatchObject({ status: 200, body: { ok: true } })
      expect(p.box.deletes, adapter).toEqual([`a/${doc}`])
      expect(p.docs.a!.has(doc), adapter).toBe(false)
      expect(p.f.stores.lifecycle.tracksResource('a', doc), adapter).toBe(false)
      expect((await p.text('Anything', 10)).status, adapter).toBe(200)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('an enrichment written while the box deletes the document goes with it', async () => {
  for (const adapter of ADAPTERS) {
    const p = await portal(adapter)
    try {
      const doc = (await p.text('Report')).body.id as string
      let land!: () => void
      p.box.gate = new Promise<void>((resolve) => land = resolve)
      const pending = p.remove(doc)
      while (p.box.deletes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
      p.f.stores.enrichments.put('a', doc, enrichment('research', 'Written by a run meanwhile'))
      land()
      p.box.gate = undefined
      expect((await pending).status, adapter).toBe(200)
      expect(p.f.stores.enrichments.holdsResource('a', doc), adapter).toBe(false)
      expect((await p.remove(doc)).status, adapter).toBe(404)
    } finally {
      p.f.close()
    }
  }
})

Deno.test('a purge through the route deletes five at a time again', async () => {
  const junk = Array.from({ length: 7 }, (_, n) => `junk-${n + 1}`)
  const live = new Set(junk)
  let inFlight = 0
  let peak = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname.replace(/^.*\/kb\/test-kb/, '')
    if (path === '/catalog') {
      return Response.json({
        resources: Object.fromEntries(
          [...live].map((id) => [id, { id, title: '', metadata: { status: 'ERROR' } }]),
        ),
      })
    }
    if (path === '/counters') return Response.json({ resources: live.size })
    const single = /^\/resource\/([^/]+)$/.exec(path)
    if (single && init?.method === 'DELETE') {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      live.delete(single[1]!)
      return Response.json({})
    }
    return Response.json({})
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'fixture',
    }),
    fetchImpl,
  })
  for (const adapter of ADAPTERS) {
    junk.forEach((id) => live.add(id))
    peak = 0
    const f = createEnforcementFixture({ provider, management: provider }, adapter)
    try {
      await f.stores.bindings.set('a', {
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
        token: 'fixture',
        kbId: 'test-kb',
      })
      const response = await f.requestAs(f.sessionFor('curator'), '/api/admin/t/a/purge-failed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      })
      const body = await response.text()
      expect(response.status, adapter).toBe(200)
      expect(body, adapter).toContain('"deleted":7')
      expect(body, adapter).toContain('"notAttempted":0')
      expect(live.size, adapter).toBe(0)
      expect(peak, adapter).toBe(5)
    } finally {
      f.close()
    }
  }
})

/**
 * A knowledge box behind the real provider, so the provider's own caches are in play: the
 * catalogue, search results and page summaries it keeps, and the facet counts the app keeps.
 */
function cachedBox() {
  const docs = new Map([
    ['keep-1', 'Abalone stock report'],
    ['gone-1', 'Abalone heatwave study'],
  ])
  const calls: string[] = []
  const raw = (id: string) => ({
    id,
    title: docs.get(id),
    metadata: { status: 'PROCESSED' },
    usermetadata: { classifications: [{ labelset: 'topic', label: 'fisheries' }] },
  })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname.replace(/^.*\/kb\/test-kb/, '')
    calls.push(`${init?.method ?? 'GET'} ${path}${url.search}`)
    const reply = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))
    if (path === '/catalog') {
      const listed = url.searchParams.get('page_size') === '0' ? [] : [...docs.keys()]
      const facets: Record<string, Record<string, number>> = {}
      for (const faceted of url.searchParams.getAll('faceted')) {
        facets[faceted] = { [`${faceted}/fisheries`]: docs.size }
      }
      return reply({
        resources: Object.fromEntries(listed.map((id) => [id, raw(id)])),
        fulltext: { total: docs.size, facets },
      })
    }
    if (path === '/find') {
      return reply({
        resources: Object.fromEntries([...docs.keys()].map((id) => [id, {
          ...raw(id),
          fields: {
            't/body': {
              paragraphs: { p1: { score: 0.9, text: `${docs.get(id)} findings on abalone.` } },
            },
          },
        }])),
      })
    }
    if (path === '/labelsets') {
      return reply({ labelsets: { topic: { title: 'Topic', labels: [{ title: 'fisheries' }] } } })
    }
    if (path === '/counters') return reply({ resources: docs.size })
    const single = /^\/resource\/([^/]+)$/.exec(path)
    if (single) {
      const id = single[1]!
      if (!docs.has(id)) return reply({ detail: 'Resource not found' }, 404)
      if (init?.method === 'DELETE') {
        docs.delete(id)
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
  return { docs, calls, provider }
}

Deno.test('after a delete, the cached catalogue, search results and facet counts no longer carry the document', async () => {
  for (const adapter of ADAPTERS) {
    const { calls, provider } = cachedBox()
    const f = createEnforcementFixture({ provider, management: provider }, adapter)
    try {
      await f.stores.bindings.set('a', {
        baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
        token: 'fixture',
        kbId: 'test-kb',
      })
      const viewer = f.sessionFor('viewer')
      const read = async (path: string) => {
        const response = await f.requestAs(viewer, `/api/t/a${path}`)
        expect(response.status, `${adapter} ${path}`).toBe(200)
        return JSON.stringify(await response.json())
      }
      const surfaces = ['/resources', '/search?q=abalone', '/facets?labelsets=topic']
      for (const path of surfaces) {
        expect(await read(path), `${adapter} ${path}`).toContain(
          path.startsWith('/facets') ? '"fisheries":2' : 'Abalone heatwave study',
        )
      }
      // Read again: the listing, the search and the facet counts come from the caches.
      const cached = (call: string) => /\/find|page_size=200|faceted=/.test(call)
      const before = calls.length
      for (const path of surfaces) await read(path)
      expect(calls.slice(before).filter(cached), adapter).toEqual([])

      const response = await f.requestAs(
        f.sessionFor('curator'),
        '/api/admin/t/a/resources/gone-1',
        { method: 'DELETE' },
      )
      expect(response.status, adapter).toBe(200)
      expect(calls, adapter).toContain('DELETE /resource/gone-1')
      const deleted = calls.length
      for (const path of surfaces) {
        const body = await read(path)
        expect(body, `${adapter} ${path}`).not.toContain('Abalone heatwave study')
        if (path.startsWith('/facets')) expect(body, adapter).toContain('"fisheries":1')
        else expect(body, `${adapter} ${path}`).toContain('Abalone stock report')
      }
      // Each was read from the box afresh.
      expect(calls.slice(deleted).filter(cached).length, adapter).toBeGreaterThanOrEqual(3)
    } finally {
      f.close()
    }
  }
})

Deno.test('the file enrichment store forgets every agent’s record of a deleted document, once', () => {
  const directory = Deno.makeTempDirSync()
  try {
    const store = new EnrichmentStore(directory)
    store.put('a', 'doc-1', enrichment('research', 'Doc'))
    store.put('a', 'doc-1', enrichment(SUGGESTED_QUESTIONS_SCHEMA_ID, 'Q'))
    store.put('a', 'doc-2', enrichment('research', 'Other'))
    expect(store.holdsResource('a', 'doc-1')).toBe(true)
    expect(store.forgetResource('a', 'doc-1')).toBe(2)
    expect(store.forgetResource('a', 'doc-1')).toBe(0)
    // A fresh store reads what was written: the removal is on disk.
    const reread = new EnrichmentStore(directory)
    expect(reread.holdsResource('a', 'doc-1')).toBe(false)
    expect(reread.get('a', 'doc-2', 'research')?.data).toEqual({ title: 'Other' })
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

Deno.test('the Durable Object enrichment store forgets a deleted document in its table and its pre-table record', () => {
  const f = createEnforcementFixture()
  try {
    f.state.put('enrichments:a', { research: { 'doc-1': enrichment('research', 'Legacy') } })
    f.stores.enrichments.put('a', 'doc-1', enrichment(SUGGESTED_QUESTIONS_SCHEMA_ID, 'Q'))
    f.stores.enrichments.put('a', 'doc-2', enrichment('research', 'Other'))
    expect(f.stores.enrichments.holdsResource('a', 'doc-1')).toBe(true)
    expect(f.stores.enrichments.forgetResource('a', 'doc-1')).toBe(2)
    expect(f.stores.enrichments.holdsResource('a', 'doc-1')).toBe(false)
    expect(f.stores.enrichments.forgetResource('a', 'doc-1')).toBe(0)
    expect(f.state.get('enrichments:a', null)).toBeNull()
    expect(f.stores.enrichments.get('a', 'doc-2', 'research')?.data).toEqual({ title: 'Other' })
  } finally {
    f.close()
  }
})

Deno.test('a delete drops the cached entity groups, so a deleted document’s entities do not linger', async () => {
  const calls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^.*\/kb\/test-kb/, '')
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/entitiesgroups') {
      return Promise.resolve(Response.json({
        groups: { Species: { entities: { Abalone: {} } } },
      }))
    }
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const provider = new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'fixture',
    }),
    fetchImpl,
  })
  const tenant = { slug: 'a' } as TenantConfig
  const reads = () => calls.filter((call) => call === 'GET /entitiesgroups').length
  await provider.entityGroups(tenant)
  await provider.entityGroups(tenant)
  expect(reads()).toBe(1)
  await provider.deleteResource(tenant, 'doc-1')
  await provider.entityGroups(tenant)
  expect(reads()).toBe(2)
})
