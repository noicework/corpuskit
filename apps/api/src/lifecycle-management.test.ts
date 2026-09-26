import { expect } from '@std/expect'
import {
  DOC_PAGES,
  docPageToMarkdown,
  type PortalLifecycle,
  type TenantConfig,
} from '@research-portal/core'
import { AragApiError, AragProvider } from '@research-portal/retrieval'
import { PortalLifecycleError } from './lifecycle-error.ts'
import { MAX_UNMEASURED_LINKS, MEASURE_TIMEOUT, PortalLifecycleStore } from './lifecycle-store.ts'
import {
  capacityUsage,
  DEFAULT_LINK_PROVISIONAL_BYTES,
  guardManagement,
  linkProvisionalBytes,
  precheckAdd,
  resetCapacityOnRebind,
  withinTimeout,
  withRequestAuthority,
} from './lifecycle-management.ts'

const config = { slug: 'test' } as TenantConfig
const text = { title: 'Title', body: 'Body' }
function store(
  status: PortalLifecycle['status'] = 'active',
  limits: PortalLifecycle['limits'] = null,
) {
  const lifecycle = new PortalLifecycleStore()
  lifecycle.set(config.slug, { status, limits })
  return lifecycle
}
async function denied(work: Promise<unknown>, status: number, error: string) {
  try {
    await work
    throw new Error('Expected denial')
  } catch (failure) {
    expect(failure).toBeInstanceOf(PortalLifecycleError)
    expect((failure as PortalLifecycleError).status).toBe(status)
    expect((failure as PortalLifecycleError).body.error).toBe(error)
    return (failure as PortalLifecycleError).body
  }
}
/** A knowledge box double: a settable resource count and numbered resources. */
function box(count = 0) {
  const state = { count, calls: 0, fail: false }
  const raw = {
    resourceCount: () => Promise.resolve(state.count),
    createText: () => {
      state.calls++
      if (state.fail) return Promise.reject(new Error('upstream failed'))
      return Promise.resolve({ id: `res-${state.calls}` })
    },
    uploadFile: () => {
      state.calls++
      return Promise.resolve({ id: `res-${state.calls}` })
    },
    createLink: () => {
      state.calls++
      return Promise.resolve({ id: `res-${state.calls}` })
    },
    deleteResource: () => Promise.resolve(),
  }
  return { state, raw: raw as unknown as AragProvider & typeof raw }
}
const upload = (size: number) => ({
  filename: 'a.txt',
  contentType: 'text/plain',
  bytes: new Uint8Array(size),
})

Deno.test('management guards every content and configuration writer before dispatch', async () => {
  const names = [
    'registerExtractionMethod',
    'patchResourceClassifications',
    'createLabelset',
    'updateLabelset',
    'startAgent',
    'patchResourceMeta',
    'deleteResource',
    'setResourceHidden',
    'purgeFailedResources',
    'ensureSearchConfigs',
    'ingestDocumentation',
    'deleteAgent',
    'createText',
    'createLink',
    'uploadFile',
  ]
  for (const status of ['read_only', 'suspended'] as const) {
    let calls = 0
    const raw = Object.fromEntries(names.map((name) => [name, () => calls++]))
    const guarded = guardManagement(raw as unknown as AragProvider, store(status))
    for (const name of names) {
      const method =
        (guarded as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!
      await denied(method(config, undefined), 423, `portal_${status}`)
    }
    expect(calls).toBe(0)
  }
})

Deno.test('only a platform request writes to a suspended portal, and reads retain provider this', async () => {
  class Provider {
    private value = 'fixture'
    resourceCount() {
      return Promise.resolve(0)
    }
    createText() {
      return Promise.resolve({ id: this.value })
    }
    search() {
      return Promise.resolve({ value: this.value })
    }
  }
  const raw = new Provider() as unknown as AragProvider
  const lifecycle = store('suspended')
  const guarded = guardManagement(raw, lifecycle, { platformRequests: true })
  expect(
    await withRequestAuthority(true, () => guarded.createText(config, text)),
  ).toEqual({ id: 'fixture' })
  expect(await guarded.search(config, 'read')).toEqual({ value: 'fixture' })
  // A request for anyone else, and any write made outside a request, is refused.
  await denied(
    withRequestAuthority(false, () => guarded.createText(config, text)),
    423,
    'portal_suspended',
  )
  await denied(guarded.createText(config, text), 423, 'portal_suspended')
  // The authority follows the request's own asynchronous work, not whichever ran last.
  let release!: () => void
  const gate = new Promise<void>((resolve) => release = resolve)
  const platformWrite = withRequestAuthority(true, async () => {
    await gate
    return await guarded.createText(config, text)
  })
  const otherWrite = withRequestAuthority(false, async () => {
    await gate
    return await guarded.createText(config, text)
  })
  release()
  expect(await platformWrite).toEqual({ id: 'fixture' })
  await denied(otherWrite, 423, 'portal_suspended')
  lifecycle.set('test', { status: 'read_only', limits: null })
  await denied(
    withRequestAuthority(true, () => guarded.createText(config, text)),
    423,
    'portal_read_only',
  )
  // Unattended callers never write to a suspended portal, even inside a platform request.
  lifecycle.set('test', { status: 'suspended', limits: null })
  await denied(
    withRequestAuthority(true, () => guardManagement(raw, lifecycle).createText(config, text)),
    423,
    'portal_suspended',
  )
})

Deno.test('a request suspended mid-operation refuses its later writes unless it is a platform request', async () => {
  for (const platform of [false, true]) {
    const lifecycle = store('active')
    let writes = 0
    const raw = {
      resourceCount: () => Promise.resolve(0),
      createText: () => {
        writes++
        // The operator pauses the portal while the request is still writing.
        if (writes === 1) lifecycle.set('test', { status: 'suspended', limits: null })
        return Promise.resolve({ id: `res-${writes}` })
      },
    } as unknown as AragProvider
    const guarded = guardManagement(raw, lifecycle, { platformRequests: true })
    const run = withRequestAuthority(platform, async () => {
      for (let i = 0; i < 3; i++) await guarded.createText(config, text)
    })
    if (platform) {
      await run
      expect(writes).toBe(3)
    } else {
      await denied(run, 423, 'portal_suspended')
      expect(writes).toBe(1)
    }
  }
})

Deno.test('agent limits stop actual starts including calls inside compound operations', async () => {
  let calls = 0
  class Provider {
    startAgent() {
      calls++
      return Promise.resolve('started')
    }
    updateLabelset(config: TenantConfig) {
      return (this.startAgent as (...args: unknown[]) => Promise<string>)(config)
    }
  }
  const guarded = guardManagement(
    new Provider() as unknown as AragProvider,
    store('active', { agentsEnabled: false }),
  )
  await denied(guarded.startAgent(config, {} as never), 403, 'agents_disabled')
  await denied(guarded.updateLabelset(config, {} as never), 403, 'agents_disabled')
  expect(calls).toBe(0)
  // Only an explicit false disables agents.
  await guardManagement(new Provider() as unknown as AragProvider, store('active', {}))
    .startAgent(config, {} as never)
  expect(calls).toBe(1)
})

Deno.test('resource reservations stop concurrent adds while counters lag and survive restart', async () => {
  let counting = false
  let countCalls = 0
  const { state, raw } = box()
  raw.resourceCount = async () => {
    expect(counting).toBe(false)
    counting = true
    await Promise.resolve()
    counting = false
    countCalls++
    return 0
  }
  const lifecycle = store('active', { maxResources: 2 })
  const guarded = guardManagement(raw, lifecycle)
  const results = await Promise.allSettled([
    guarded.createText(config, text),
    guarded.createText(config, text),
    guarded.createText(config, text),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
  expect(state.calls).toBe(2)
  expect(countCalls).toBe(3)
  // The box has still not counted either add: a new process keeps both slots taken.
  const restarted = new PortalLifecycleStore(lifecycle.state)
  const body = await denied(
    guardManagement(raw, restarted).createText(config, text),
    413,
    'limit_exceeded',
  )
  expect(body).toEqual({ error: 'limit_exceeded', limit: 'maxResources', value: 3, max: 2 })
  expect(state.calls).toBe(2)
})

Deno.test('counted additions reconcile reservations and deletions reclaim capacity', async () => {
  const { state, raw } = box()
  const lifecycle = store('active', { maxResources: 2 })
  const guarded = guardManagement(raw, lifecycle)
  await guarded.createText(config, text)
  state.count = 1
  await guarded.createText(config, text)
  state.count = 2
  await denied(guarded.createText(config, text), 413, 'limit_exceeded')
  // Deleting through the portal frees the slot before the box has counted the deletion.
  await guarded.deleteResource(config, 'res-1')
  await guarded.createText(config, text)
  expect(state.calls).toBe(3)
  // The box then counts both changes, and the ledger reconciles to the real total.
  state.count = 2
  await denied(guarded.createText(config, text), 413, 'limit_exceeded')
})

Deno.test('failed writes release their reservation and unknown counts never dispatch', async () => {
  const { state, raw } = box()
  const lifecycle = store('active', { maxResources: 1 })
  state.fail = true
  await expect(guardManagement(raw, lifecycle).createText(config, text)).rejects.toThrow(
    'upstream failed',
  )
  state.fail = false
  await guardManagement(raw, lifecycle).createText(config, text)
  expect(state.calls).toBe(2)
  for (const observed of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    raw.resourceCount = () => Promise.resolve(observed)
    await denied(
      guardManagement(raw, store('active', { maxResources: 2 })).createText(config, text),
      503,
      'usage_unavailable',
    )
  }
  raw.resourceCount = () => Promise.reject(new Error('private upstream detail'))
  const failure = await denied(
    guardManagement(raw, store('active', { maxResources: 5 })).createText(config, text),
    503,
    'usage_unavailable',
  )
  expect(JSON.stringify(failure)).not.toContain('private')
  expect(state.calls).toBe(2)
})

Deno.test('an unlimited portal keeps adding when the box cannot be counted', async () => {
  const { state, raw } = box(3)
  raw.resourceCount = () => Promise.reject(new Error('unavailable'))
  const lifecycle = store('active', null)
  await guardManagement(raw, lifecycle).createText(config, text)
  expect(state.calls).toBe(1)
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
  // The ledger starts at the next observation and cannot size what came before it.
  raw.resourceCount = () => Promise.resolve(4)
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 4, bytes: null })
})

Deno.test('lifecycle and stricter limits are rechecked after counter awaits', async () => {
  for (
    const change of [
      { status: 'read_only' as const, limits: { maxResources: 5 } },
      { status: 'active' as const, limits: { maxResources: 0 } },
      { status: 'active' as const, limits: { maxResources: 5, maxBytes: 1 } },
    ]
  ) {
    const lifecycle = store('active', { maxResources: 5 })
    const { state, raw } = box()
    raw.resourceCount = async () => {
      await Promise.resolve()
      lifecycle.set('test', change)
      return 0
    }
    await denied(
      guardManagement(raw, lifecycle).createText(config, text),
      change.status === 'read_only' ? 423 : 413,
      change.status === 'read_only' ? 'portal_read_only' : 'limit_exceeded',
    )
    expect(state.calls).toBe(0)
  }
})

Deno.test('byte ledger counts source bytes, refuses the add that would exceed, and frees on delete', async () => {
  const { state, raw } = box(0)
  const lifecycle = store('active', { maxBytes: 10 })
  const guarded = guardManagement(raw, lifecycle)
  await guarded.uploadFile(config, upload(6))
  await guarded.createText(config, { title: 'a', body: 'abc' })
  state.count = 2
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 2, bytes: 9 })
  expect(await denied(guarded.uploadFile(config, upload(2)), 413, 'limit_exceeded')).toEqual({
    error: 'limit_exceeded',
    limit: 'maxBytes',
    value: 11,
    max: 10,
  })
  // Multi-byte text is measured in UTF-8 bytes.
  await denied(guarded.createText(config, { title: 'a', body: 'éé' }), 413, 'limit_exceeded')
  await guarded.deleteResource(config, 'res-1')
  await guarded.uploadFile(config, upload(7))
  expect(state.calls).toBe(3)
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 2, bytes: 10 })
})

/** A knowledge box whose crawled links report a processing status and their extracted text. */
function crawling(count = 0) {
  const { state, raw } = box(count)
  const extractions = new Map<string, { status: string; text: string } | 'missing' | 'fail'>()
  const reads: string[] = []
  const measured = Object.assign(raw, {
    resourceExtraction: (_config: TenantConfig, id: string) => {
      reads.push(id)
      const value = extractions.get(id)
      if (value === 'missing') {
        return Promise.reject(new AragApiError(404, `/resource/${id}`, 'not found'))
      }
      if (value === 'fail') return Promise.reject(new Error('upstream unavailable'))
      return Promise.resolve(value ?? { status: 'PENDING', text: '' })
    },
  })
  return { state, raw: measured, extractions, reads }
}

Deno.test('a crawled link holds provisional bytes until it is measured, and a report shows only stored bytes', async () => {
  const { state, raw, extractions, reads } = crawling()
  const lifecycle = store('active', { maxBytes: 1_000 })
  const guarded = guardManagement(raw, lifecycle, { linkProvisionalBytes: 100 })
  await guarded.createText(config, { title: 'a', body: 'x'.repeat(800) })
  state.count = 1
  // The portal cannot see a crawled document before the platform processes it, so the link
  // holds its provisional bytes against the limit from admission until it is measured. They
  // are a reservation, not stored content, so a usage report never counts them.
  await guarded.createLink(config, { url: 'https://example.test/report.pdf' })
  state.count = 2
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 2, bytes: 800 })
  expect(lifecycle.bytesUsed('test', 2)).toBe(900)
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-2'])
  // An add that fits is admitted without reading anything.
  reads.length = 0
  await guarded.createText(config, { title: 'b', body: 'y'.repeat(50) })
  state.count = 3
  expect(reads).toEqual([])
  // One that would fit but for the waiting link reads it first, then waits for it: the portal
  // is not full, so the refusal says so.
  await denied(
    guarded.createText(config, { title: 'c', body: 'w'.repeat(60) }),
    503,
    'links_pending',
  )
  expect(reads).toEqual(['res-2'])
  // Once processed, a report counts its extracted text without recording it, and the next add
  // records what the report found without reading again.
  extractions.set('res-2', { status: 'PROCESSED', text: 'z'.repeat(40) })
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 3, bytes: 890 })
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-2'])
  reads.length = 0
  await guarded.createText(config, { title: 'c', body: 'w'.repeat(60) })
  state.count = 4
  expect(reads).toEqual([])
  expect(lifecycle.pendingMeasurements('test')).toEqual([])
  // A portal with no room for a link's own provisional bytes is full: that is a limit.
  expect(
    await denied(
      guarded.createLink(config, { url: 'https://example.test/more' }),
      413,
      'limit_exceeded',
    ),
  ).toEqual({ error: 'limit_exceeded', limit: 'maxBytes', value: 1_050, max: 1_000 })
  // A settled status counts the text the resource holds. A 404 proves nothing yet, since a box
  // that has not caught up with a write can answer it: that link keeps its provisional bytes.
  lifecycle.set('test', { status: 'active', limits: { maxBytes: 1_300 } })
  await guarded.createLink(config, { url: 'https://example.test/broken' })
  await guarded.createLink(config, { url: 'https://example.test/blocked' })
  await guarded.createLink(config, { url: 'https://example.test/lagging' })
  state.count = 7
  extractions.set('res-5', { status: 'ERROR', text: '' })
  extractions.set('res-6', { status: 'BLOCKED', text: 'b'.repeat(7) })
  extractions.set('res-7', 'missing')
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 7, bytes: 957 })
  await guarded.createText(config, { title: 'd', body: 'v'.repeat(100) })
  state.count = 8
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-7'])
  expect(lifecycle.bytesUsed('test', 8)).toBe(1_157)
  extractions.set('res-7', { status: 'PROCESSED', text: 'q'.repeat(3) })
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 8, bytes: 1_060 })
  // The resource limit still applies to links.
  lifecycle.set('test', { status: 'active', limits: { maxResources: 8 } })
  await denied(
    guarded.createLink(config, { url: 'https://example.test/ninth' }),
    413,
    'limit_exceeded',
  )
  // Without a byte limit an add reads nothing, but it records what earlier reads found, and a
  // link still holds provisional bytes for a byte limit set later.
  reads.length = 0
  lifecycle.set('test', { status: 'active', limits: null })
  await guarded.createLink(config, { url: 'https://example.test/unlimited' })
  state.count = 9
  expect(reads).toEqual([])
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-9'])
  lifecycle.set('test', { status: 'active', limits: { maxBytes: 1_160 } })
  await denied(guarded.createText(config, { title: 'e', body: 'u' }), 503, 'links_pending')
  expect(reads).toEqual(['res-9'])
  extractions.set('res-9', { status: 'PROCESSED', text: 'q' })
  await guarded.createText(config, { title: 'e', body: 'u' })
  state.count = 10
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 10, bytes: 1_062 })
  expect(lifecycle.bytesUsed('test', 10)).toBe(1_062)
  expect(state.calls).toBe(10)
})

Deno.test('links waiting to be measured are capped, tried in turn, and stop counting as in flight when stuck', async () => {
  let now = Date.UTC(2026, 8, 26)
  const lifecycle = new PortalLifecycleStore(undefined, () => now)
  lifecycle.set(config.slug, { status: 'active', limits: { maxBytes: 1_000_000 } })
  const { state, raw, extractions, reads } = crawling()
  const guarded = guardManagement(raw, lifecycle, { linkProvisionalBytes: 10 })
  const link = (n: number) => guarded.createLink(config, { url: `https://example.test/${n}` })
  const stored = () =>
    lifecycle.state.get<{ measuring?: Record<string, { unsized?: true }> }>(
      'portal-capacity:test',
      {},
    ).measuring ?? {}
  for (let n = 1; n <= MAX_UNMEASURED_LINKS; n++) {
    await link(n)
    state.count = n
  }
  expect(reads).toEqual([])
  // The next link waits for earlier ones: measuring finds none of them processed yet.
  await denied(link(21), 503, 'links_pending')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.length).toBeLessThan(MAX_UNMEASURED_LINKS)
  // Other additions are not held back by links waiting to be measured.
  await guarded.createText(config, text)
  state.count = 21
  // The least recently tried go first, so links that stay unprocessed never keep a processed
  // one from being measured.
  extractions.set('res-20', { status: 'PROCESSED', text: 'p'.repeat(5) })
  reads.length = 0
  await link(22)
  state.count = 22
  expect(reads).toContain('res-20')
  expect(reads).not.toContain('res-1')
  expect(Object.keys(stored())).not.toContain('res-20')
  // Past the timeout, a link still unprocessed stops counting as in flight, but it keeps its
  // provisional bytes until it is measured or removed.
  now += MEASURE_TIMEOUT
  await link(23)
  state.count = 23
  const unsized = Object.entries(stored()).filter(([, entry]) => entry.unsized)
  expect(unsized.length).toBeGreaterThan(0)
  const held = lifecycle.bytesUsed('test', 23)!
  const [stuck] = unsized[0]!
  await guarded.deleteResource(config, stuck)
  state.count = 22
  expect(lifecycle.bytesUsed('test', 22)).toBe(held - 10)
  // One that is processed after all is still measured: a report counts it, and the next add
  // records it in place of its provisional bytes.
  const [late] = unsized[1]!
  extractions.set(late, { status: 'PROCESSED', text: 'L' })
  const before = (await capacityUsage(raw, lifecycle, config)).bytes!
  extractions.delete(late)
  expect(Object.keys(stored())).toContain(late)
  await guarded.createText(config, text)
  state.count = 23
  expect(Object.keys(stored())).not.toContain(late)
  expect(lifecycle.bytesUsed('test', 23)).toBe(held - 10 - 10 + 1 + 4)
  expect((await capacityUsage(raw, lifecycle, config)).bytes).toBe(before + 4)
})

Deno.test('a 404 stays pending at first, and a link that answers only 404 for the whole wait holds nothing', async () => {
  const start = Date.UTC(2026, 8, 26)
  let now = start
  const lifecycle = new PortalLifecycleStore(undefined, () => now)
  lifecycle.set(config.slug, { status: 'active', limits: { maxBytes: 1_000 } })
  const { state, raw, extractions } = crawling()
  const guarded = guardManagement(raw, lifecycle, { linkProvisionalBytes: 100 })
  const stored = () =>
    lifecycle.state.get<{ measuring?: Record<string, Record<string, unknown>> }>(
      'portal-capacity:test',
      {},
    ).measuring ?? {}
  await guarded.createLink(config, { url: 'https://example.test/report' })
  state.count = 1
  extractions.set('res-1', 'missing')
  // Right after an add a box can answer 404 for a resource it has: that proves nothing yet, so
  // the link keeps its provisional bytes and an add that needs its room waits.
  const note = { title: 't', body: 'x'.repeat(950) }
  await denied(guarded.createText(config, note), 503, 'links_pending')
  expect(stored()['res-1']).toMatchObject({ reserved: 100, missingSince: start })
  // Answering nothing but 404 for the whole wait, it is gone: it holds nothing, and the add
  // goes through. Deleting a stuck link's resource on the platform releases it this way.
  now += MEASURE_TIMEOUT
  await guarded.createText(config, note)
  state.count = 2
  expect(stored()['res-1']).toBeUndefined()
  expect(lifecycle.bytesUsed('test', 2)).toBe(950)
})

Deno.test('any reading other than 404 starts the wait again, and a later 404 never undercuts a measurement', async () => {
  const start = Date.UTC(2026, 8, 26)
  let now = start
  const lifecycle = new PortalLifecycleStore(undefined, () => now)
  lifecycle.set(config.slug, { status: 'active', limits: { maxBytes: 1_000 } })
  const { state, raw, extractions } = crawling()
  const guarded = guardManagement(raw, lifecycle, { linkProvisionalBytes: 100 })
  const stored = () =>
    lifecycle.state.get<{ measuring?: Record<string, Record<string, unknown>> }>(
      'portal-capacity:test',
      {},
    ).measuring ?? {}
  const note = { title: 't', body: 'x'.repeat(950) }
  await guarded.createLink(config, { url: 'https://example.test/report' })
  state.count = 1
  extractions.set('res-1', 'missing')
  await denied(guarded.createText(config, note), 503, 'links_pending')
  // The resource is there after all, still processing: the 404s stop counting.
  now += 30 * 60_000
  extractions.set('res-1', { status: 'PENDING', text: '' })
  await denied(guarded.createText(config, note), 503, 'links_pending')
  expect(stored()['res-1']?.missingSince).toBeUndefined()
  // A 404 past the hour starts a new wait, so the link is held, now as a stuck one.
  now += 31 * 60_000
  extractions.set('res-1', 'missing')
  await denied(guarded.createText(config, note), 413, 'links_stuck')
  expect(stored()['res-1']).toMatchObject({ missingSince: now, unsized: true, reserved: 100 })
  // A link measured once keeps what it measured, whatever its reads answer later.
  lifecycle.set(config.slug, { status: 'active', limits: { maxBytes: 10_000 } })
  await guarded.createLink(config, { url: 'https://example.test/measured' })
  state.count = 2
  extractions.set('res-2', { status: 'PROCESSED', text: 'm'.repeat(40) })
  expect((await capacityUsage(raw, lifecycle, config)).bytes).toBe(40)
  await guarded.createText(config, { title: 'u', body: 'u' })
  state.count = 3
  expect(Object.keys(stored())).not.toContain('res-2')
  extractions.set('res-2', 'missing')
  now += 2 * MEASURE_TIMEOUT
  expect((await capacityUsage(raw, lifecycle, config)).bytes).toBe(41)
  await guarded.createText(config, { title: 'v', body: 'v' })
  state.count = 4
  // Meanwhile the stuck link has answered 404 for more than the wait, so it now holds nothing.
  expect(Object.keys(stored())).toEqual([])
  expect(lifecycle.bytesUsed('test', 4)).toBe(40 + 1 + 1)
})

Deno.test('deleting a link still being measured releases its bytes, and a failed read is retried later', async () => {
  const { state, raw, extractions } = crawling()
  const lifecycle = store('active', { maxBytes: 100 })
  const guarded = guardManagement(raw, lifecycle, { linkProvisionalBytes: 30 })
  await guarded.createLink(config, { url: 'https://example.test/one' })
  await guarded.createLink(config, { url: 'https://example.test/two' })
  state.count = 2
  extractions.set('res-1', 'fail')
  extractions.set('res-2', 'fail')
  // A read that fails is not a measurement: the links keep their provisional bytes, and a
  // report counts neither as stored.
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 2, bytes: 0 })
  expect(lifecycle.bytesUsed('test', 2)).toBe(60)
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-1', 'res-2'])
  await guarded.deleteResource(config, 'res-1')
  state.count = 1
  expect(lifecycle.pendingMeasurements('test')).toEqual(['res-2'])
  expect(lifecycle.bytesUsed('test', 1)).toBe(30)
  extractions.set('res-2', { status: 'PROCESSED', text: 'abc' })
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 1, bytes: 3 })
})

Deno.test('a read that never answers is given up at its timeout, even if it ignores its signal', async () => {
  let seen: AbortSignal | undefined
  const never = withinTimeout((signal) => {
    seen = signal
    return new Promise<never>(() => {})
  }, 10)
  await expect(never).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(seen?.aborted).toBe(true)
  // One that answers in time is unaffected, and leaves no timer behind.
  expect(await withinTimeout(() => Promise.resolve('read'), 60_000)).toBe('read')
})

Deno.test('measurement reads and the resource count can be given up', async () => {
  const signals: { read: AbortSignal[]; count: AbortSignal[] } = { read: [], count: [] }
  const { state, raw } = crawling()
  const timed = Object.assign(raw, {
    resourceCount: (_config: TenantConfig, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.count.push(options.signal)
      return Promise.resolve(state.count)
    },
    resourceExtraction: (
      _config: TenantConfig,
      _id: string,
      options?: { signal?: AbortSignal },
    ) => {
      if (options?.signal) signals.read.push(options.signal)
      return Promise.resolve({ status: 'PENDING', text: '' })
    },
  })
  const lifecycle = store('active', { maxBytes: 100 })
  const guarded = guardManagement(timed, lifecycle, { linkProvisionalBytes: 60 })
  await guarded.createLink(config, { url: 'https://example.test/one' })
  state.count = 1
  await denied(
    guarded.createText(config, { title: 't', body: 'x'.repeat(50) }),
    503,
    'links_pending',
  )
  expect(signals.count.length).toBeGreaterThan(0)
  expect(signals.read).toHaveLength(1)
  expect(signals.read[0]!.aborted).toBe(false)
})

Deno.test('LINK_PROVISIONAL_BYTES is a whole number of bytes, otherwise 10 MB', () => {
  expect(DEFAULT_LINK_PROVISIONAL_BYTES).toBe(10 * 1024 * 1024)
  expect(linkProvisionalBytes(undefined)).toBe(DEFAULT_LINK_PROVISIONAL_BYTES)
  expect(linkProvisionalBytes(' 5000000 ')).toBe(5_000_000)
  for (const value of ['', '0', '-1', '1.5', '10MB', '1e6']) {
    expect(linkProvisionalBytes(value), value).toBe(DEFAULT_LINK_PROVISIONAL_BYTES)
  }
})

Deno.test('changing or removing a knowledge box starts a fresh ledger whichever path writes it', async () => {
  const lifecycle = store('active')
  const records = new Map<string, { baseUrl: string }>()
  const bindings = resetCapacityOnRebind({
    get: (slug: string) => records.get(slug),
    set: (slug: string, binding: { baseUrl: string }) => void records.set(slug, binding),
    remove: (slug: string) => void records.delete(slug),
    status: (slug: string) => (records.has(slug) ? 'bound' : 'unbound'),
  }, lifecycle)
  const started = () => {
    lifecycle.reserveAdd('test', { observed: 0, bytes: 1 })
    expect(lifecycle.hasCapacityLedger('test')).toBe(true)
  }
  bindings.set('test', { baseUrl: 'https://example.test/kb/one' })
  started()
  // Reconnecting the same box keeps the ledger.
  bindings.set('test', { baseUrl: 'https://example.test/kb/one' })
  expect(lifecycle.hasCapacityLedger('test')).toBe(true)
  bindings.set('test', { baseUrl: 'https://example.test/kb/two' })
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
  started()
  bindings.remove('test')
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
  expect(bindings.status('test')).toBe('unbound')
  // An asynchronous binding store resets once its write has landed.
  const pending = resetCapacityOnRebind({
    get: (slug: string) => records.get(slug),
    set: async (slug: string, binding: { baseUrl: string }) => {
      await Promise.resolve()
      records.set(slug, binding)
    },
    remove: (slug: string) => void records.delete(slug),
  }, lifecycle)
  started()
  const write = pending.set('test', { baseUrl: 'https://example.test/kb/three' })
  expect(lifecycle.hasCapacityLedger('test')).toBe(true)
  await write
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
})

Deno.test('a withheld knowledge box binding can be replaced or removed and starts a fresh ledger', async () => {
  const lifecycle = store('active')
  const withheld = new Set(['test'])
  const records = new Map<string, { baseUrl: string }>()
  // Like the sealed binding store: reading a record it cannot open throws, writing replaces it.
  const bindings = resetCapacityOnRebind({
    get: (slug: string) => {
      if (withheld.has(slug)) throw new Error('binding_unavailable')
      return records.get(slug)
    },
    set: async (slug: string, binding: { baseUrl: string }) => {
      await Promise.resolve()
      records.set(slug, binding)
      withheld.delete(slug)
    },
    remove: (slug: string) => {
      records.delete(slug)
      withheld.delete(slug)
    },
  }, lifecycle)
  lifecycle.reserveAdd('test', { observed: 0, bytes: 1 })
  await bindings.set('test', { baseUrl: 'https://example.test/kb/one' })
  expect(records.get('test')?.baseUrl).toBe('https://example.test/kb/one')
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
  lifecycle.reserveAdd('test', { observed: 0, bytes: 1 })
  withheld.add('test')
  bindings.remove('test')
  expect(records.has('test')).toBe(false)
  expect(lifecycle.hasCapacityLedger('test')).toBe(false)
})

Deno.test('byte limits fail closed while the portal cannot know its bytes', async () => {
  const { state, raw } = box(7)
  const lifecycle = store('active', { maxBytes: 1_000 })
  const guarded = guardManagement(raw, lifecycle)
  // The box already held seven resources the ledger never sized.
  await denied(guarded.createText(config, text), 503, 'usage_unavailable')
  await denied(
    guarded.createLink(config, { url: 'https://example.test' }),
    503,
    'usage_unavailable',
  )
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 7, bytes: null })
  expect(state.calls).toBe(0)
  // Clearing the byte limit lets content in again without inventing a byte count.
  lifecycle.set('test', { status: 'active', limits: null })
  await guarded.createText(config, text)
  expect(state.calls).toBe(1)
  state.count = 8
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 8, bytes: null })
})

Deno.test('resources added outside the portal make bytes unknown until they are removed', async () => {
  const { state, raw } = box(0)
  const lifecycle = store('active', null)
  const guarded = guardManagement(raw, lifecycle)
  await guarded.createText(config, text)
  state.count = 1
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 1, bytes: 4 })
  // Two resources appear that this portal never added.
  state.count = 3
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 3, bytes: null })
  lifecycle.set('test', { status: 'active', limits: { maxBytes: 100 } })
  await denied(guarded.createText(config, text), 503, 'usage_unavailable')
  // Removing them through the portal restores a known byte count.
  lifecycle.set('test', { status: 'active', limits: null })
  await guarded.deleteResource(config, 'outside-1')
  await guarded.deleteResource(config, 'outside-2')
  state.count = 1
  expect(await capacityUsage(raw, lifecycle, config)).toEqual({ resources: 1, bytes: 4 })
})

Deno.test('an add whose size cannot be read is refused rather than admitted unmeasured', async () => {
  const { state, raw } = box(0)
  const guarded = guardManagement(raw, store('active', null))
  await denied(
    guarded.uploadFile(config, { filename: 'a', contentType: 'text/plain' } as never),
    503,
    'usage_unavailable',
  )
  expect(state.calls).toBe(0)
})

Deno.test('documentation admits each new page and updates existing pages without a slot', async () => {
  const writes: string[] = []
  let existing = false
  const lifecycle = store('active', { maxResources: 1 })
  const raw = new AragProvider({
    resolveBinding: () => ({ baseUrl: 'https://fixture.invalid/kb/test', token: 'fixture' }),
    fetchImpl: (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/counters')) {
        return Promise.resolve(Response.json({ resources: existing ? 1 : 0 }))
      }
      if (path.includes('/slug/')) {
        return Promise.resolve(
          existing ? Response.json({ id: 'existing' }) : Response.json({}, { status: 404 }),
        )
      }
      writes.push(`${init?.method} ${path}`)
      return Promise.resolve(Response.json({ uuid: 'abc123' }))
    },
  })
  const guarded = guardManagement(raw, lifecycle)
  await denied(guarded.ingestDocumentation(config, DOC_PAGES.slice(0, 2)), 413, 'limit_exceeded')
  expect(writes).toHaveLength(1)
  existing = true
  await guarded.ingestDocumentation(config, DOC_PAGES.slice(0, 1))
  expect(writes).toHaveLength(2)
  expect(writes[1]).toContain('PATCH')
  // The created page was sized under the id the box returned.
  const bytes = new TextEncoder().encode(docPageToMarkdown(DOC_PAGES[0]!)).byteLength
  expect(lifecycle.bytesUsed('test', 1)).toBe(bytes)
})

Deno.test('provider resource count rejects absent or malformed upstream counts', async () => {
  for (const resources of [undefined, null, -1, 0.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    const raw = new AragProvider({
      resolveBinding: () => ({ baseUrl: 'https://fixture.invalid/kb/test', token: 'fixture' }),
      fetchImpl: () => Promise.resolve(Response.json({ resources })),
    })
    await denied(capacityUsage(raw, store(), config), 503, 'usage_unavailable')
  }
})

Deno.test('a precheck refuses a full portal before remote work and reserves nothing', async () => {
  const { state, raw } = box(2)
  let counted = 0
  raw.resourceCount = () => {
    counted++
    return Promise.resolve(state.count)
  }
  // Without capacity limits the precheck never needs the box.
  await precheckAdd(raw, store('active', null), config)
  expect(counted).toBe(0)
  const lifecycle = store('active', { maxResources: 3 })
  await precheckAdd(raw, lifecycle, config)
  await precheckAdd(raw, lifecycle, config)
  // Nothing was reserved, so the one remaining slot is still free.
  await guardManagement(raw, lifecycle).createText(config, text)
  state.count = 3
  expect(await denied(precheckAdd(raw, lifecycle, config), 413, 'limit_exceeded')).toEqual({
    error: 'limit_exceeded',
    limit: 'maxResources',
    value: 4,
    max: 3,
  })
  await denied(precheckAdd(raw, store('read_only', null), config), 423, 'portal_read_only')
  // A portal whose storage is exactly full refuses too: any page brings at least one byte.
  const bytes = store('active', { maxBytes: 4 })
  state.count = 0
  await precheckAdd(raw, bytes, config)
  await guardManagement(raw, bytes).createText(config, text)
  state.count = 1
  expect(await denied(precheckAdd(raw, bytes, config), 413, 'limit_exceeded')).toMatchObject({
    limit: 'maxBytes',
    value: 5,
    max: 4,
  })
  expect(state.calls).toBe(2)
})
