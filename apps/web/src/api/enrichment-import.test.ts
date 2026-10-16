import { expect } from '@std/expect'
import {
  type EnrichmentArchive,
  EnrichmentImportError,
  importEnrichmentArchive,
  MAX_ENRICHMENT_ARCHIVE_BYTES,
  preflightEnrichmentArchive,
  readEnrichmentArchive,
} from './enrichment-import.ts'
import { AuthorityController } from './access-lifecycle.ts'
import { type AdminRequestAccess, assertResultCurrent, sessionAccess } from './break-glass.ts'

function enrichment(schemaId = 'research', summary = 'Reviewed source metadata') {
  return { schemaId, generatedAt: '2026-10-16T00:00:00.000Z', data: { summary } }
}
function archive(): EnrichmentArchive {
  return { research: { original: enrichment() } }
}
function success(imported = 1, skipped = 0) {
  return {
    ok: true,
    targetSlug: 'marine',
    collisionPolicy: 'skip',
    imported,
    skipped,
    overwritten: 0,
    reasons: { existing: skipped },
  }
}
function authority() {
  const result = new AuthorityController(() => 'fixture')
  result.setSession({
    authenticated: true,
    user: {
      id: 'person',
      tenantId: 'tenant',
      name: 'Person',
      email: 'person@example.test',
      roles: [],
      isAdmin: false,
    },
    effectiveRoles: { portalRoles: [{ slug: 'marine', role: 'curator' }] },
    provenance: [],
    claimAgeSeconds: 0,
    groupMappings: 'disabled',
    coarseAdminEligible: false,
    breakGlassEnabled: false,
    platformPermissions: [],
    portalAccess: {
      slug: 'marine',
      available: true,
      canEnable: false,
      effectiveRole: 'curator',
      permissions: ['portal.read', 'enrichments.write'],
    },
  }, 'marine')
  return result
}

Deno.test('archive review validates every record and returns safe counts without changing IDs', () => {
  const incoming = {
    research: { original: enrichment(), 'source/JA:02': enrichment() },
    other: { repeat: enrichment('other') },
  }
  const text = JSON.stringify(incoming)
  const result = preflightEnrichmentArchive(text)
  expect(result.archive).toEqual(incoming)
  expect(result.agentCount).toBe(2)
  expect(result.recordCount).toBe(3)
  expect(result.byteLength).toBe(new TextEncoder().encode(text).byteLength)
  expect(Object.getPrototypeOf(result.archive)).toBe(null)
  expect(Object.getPrototypeOf(result.archive.research!)).toBe(null)
})

Deno.test('archive review rejects invalid JSON, maps, IDs, schema mismatches and empty imports', () => {
  const bad = [
    'not JSON private payload',
    'null',
    '[]',
    '{}',
    '{"research":{}}',
    '{"research":[]}',
    '{"research":null}',
    JSON.stringify({ '': { original: enrichment('') } }),
    JSON.stringify({ ['a'.repeat(201)]: { original: enrichment('a'.repeat(201)) } }),
    JSON.stringify({ research: { '': enrichment() } }),
    JSON.stringify({ research: { ['r'.repeat(1001)]: enrichment() } }),
    JSON.stringify({ research: { original: enrichment('other') } }),
    JSON.stringify({ research: { original: { schemaId: 'research', data: {} } } }),
    ...['__proto__', 'prototype', 'constructor'].flatMap((key) => [
      JSON.stringify(Object.fromEntries([[key, { original: enrichment(key) }]])),
      JSON.stringify({ research: Object.fromEntries([[key, enrichment()]]) }),
    ]),
  ]
  for (const text of bad) {
    expect(() => preflightEnrichmentArchive(text)).toThrow(EnrichmentImportError)
  }
  try {
    preflightEnrichmentArchive('{"private-secret":false}')
  } catch (error) {
    expect((error as Error).message).not.toContain('private-secret')
  }
  const agent = 'a'.repeat(200), resource = 'r'.repeat(1000)
  expect(
    preflightEnrichmentArchive(
      JSON.stringify({ [agent]: { [resource]: enrichment(agent) } }),
    ).recordCount,
  ).toBe(1)
})

Deno.test('archive review enforces byte, file, agent, record and individual record limits', async () => {
  const text = JSON.stringify(archive())
  expect(
    preflightEnrichmentArchive(
      text.padEnd(MAX_ENRICHMENT_ARCHIVE_BYTES, ' '),
    ).byteLength,
  ).toBe(MAX_ENRICHMENT_ARCHIVE_BYTES)
  expect(() => preflightEnrichmentArchive(text.padEnd(MAX_ENRICHMENT_ARCHIVE_BYTES + 1, ' ')))
    .toThrow('8 MiB')
  // Character count alone would allow this multi-byte file.
  expect(() => preflightEnrichmentArchive('あ'.repeat(MAX_ENRICHMENT_ARCHIVE_BYTES / 2)))
    .toThrow('8 MiB')
  let read = false
  await expect(readEnrichmentArchive({
    size: MAX_ENRICHMENT_ARCHIVE_BYTES + 1,
    text() {
      read = true
      return Promise.resolve(text)
    },
  })).rejects.toThrow('8 MiB')
  expect(read).toBe(false)
  for (const size of [-1, NaN, Infinity, 1.5]) {
    expect(() => preflightEnrichmentArchive(text, size)).toThrow(EnrichmentImportError)
  }
  await expect(readEnrichmentArchive({
    size: 1,
    text: () => Promise.resolve(' '.repeat(MAX_ENRICHMENT_ARCHIVE_BYTES + 1)),
  })).rejects.toThrow('8 MiB')
  await expect(readEnrichmentArchive({
    size: text.length,
    text: () => Promise.reject(new Error('private file details')),
  })).rejects.toThrow('The archive could not be read.')
  expect((await readEnrichmentArchive(new File([text], 'archive.json'))).recordCount).toBe(1)

  const agents = Object.fromEntries(Array.from({ length: 100 }, (_, i) => {
    const id = `agent-${i}`
    return [id, { original: enrichment(id) }]
  }))
  expect(preflightEnrichmentArchive(JSON.stringify(agents)).agentCount).toBe(100)
  expect(() => preflightEnrichmentArchive(JSON.stringify({ ...agents, extra: {} })))
    .toThrow('100 agents')
  const records = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`r${i}`, enrichment()]),
  )
  expect(preflightEnrichmentArchive(JSON.stringify({ research: records })).recordCount).toBe(10_000)
  expect(() =>
    preflightEnrichmentArchive(
      JSON.stringify({ research: { ...records, extra: enrichment() } }),
    )
  ).toThrow('10,000 records')
  const overhead = JSON.stringify(enrichment('research', '')).length
  const atLimit = enrichment('research', 'a'.repeat(1024 * 1024 - overhead))
  expect(
    preflightEnrichmentArchive(JSON.stringify({ research: { original: atLimit } })).recordCount,
  )
    .toBe(1)
  expect(() =>
    preflightEnrichmentArchive(JSON.stringify({
      research: { original: enrichment('research', 'a'.repeat(1024 * 1024 - overhead + 1)) },
    }))
  ).toThrow('1 MiB')
})

Deno.test('import uses the supplied normal session access and explicit skip route', async () => {
  const original = globalThis.fetch
  const controller = authority()
  let requests = 0
  globalThis.fetch = (input, init) => {
    requests++
    expect(String(input)).toBe('/api/admin/t/marine/enrichments/import?collision=skip')
    expect(init?.method).toBe('POST')
    expect(init?.cache).toBe('no-store')
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-admin-passcode')).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual(archive())
    return Promise.resolve(Response.json(success()))
  }
  try {
    const result = await importEnrichmentArchive('marine', archive(), sessionAccess, {
      authority: controller,
      context: controller.context,
    })
    expect(result).toEqual(success())
    expect(requests).toBe(1)
    controller.invalidate('changed before completion')
    expect(() => assertResultCurrent(result)).toThrow('Access changed')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('import validates input before dispatch and accepts only complete exact skip results', async () => {
  let requests = 0
  let body: unknown = success()
  const access: AdminRequestAccess = {
    request() {
      requests++
      return Promise.resolve(Response.json(body))
    },
  }
  for (const slug of ['', 'other/redirect', 'x'.repeat(65)]) {
    await expect(importEnrichmentArchive(slug, archive(), access)).rejects.toThrow(
      EnrichmentImportError,
    )
  }
  await expect(importEnrichmentArchive('marine', {} as EnrichmentArchive, access)).rejects
    .toThrow('at least one')
  expect(requests).toBe(0)
  for (
    const invalid of [
      null,
      {},
      { ...success(), ok: false },
      { ...success(), targetSlug: 'other' },
      { ...success(), imported: -1 },
      { ...success(), imported: 1.5 },
      { ...success(), imported: 10_001 },
      { ...success(), imported: 0 },
      { ...success(), skipped: 1 },
      { ...success(), overwritten: 1 },
      { ...success(), collisionPolicy: 'overwrite' },
      { ...success(0, 1), reasons: { existing: 0 } },
      { ...success(), reasons: { existing: 0, private: 'secret' } },
      { ...success(), payload: 'private secret' },
    ]
  ) {
    body = invalid
    await expect(importEnrichmentArchive('marine', archive(), access)).rejects
      .toThrow('could not be confirmed')
  }
  body = success(0, 1)
  expect(await importEnrichmentArchive('marine', archive(), access)).toEqual(success(0, 1))
})

Deno.test('import errors expose useful fixed messages and retain standard access invalidation', async () => {
  for (const status of [400, 401, 403, 413, 423, 429, 500]) {
    const controller = authority()
    const access: AdminRequestAccess = {
      request: () =>
        Promise.resolve(Response.json({ message: 'private server payload' }, { status })),
    }
    try {
      await importEnrichmentArchive('marine', archive(), access, { authority: controller })
      throw new Error('Expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(EnrichmentImportError)
      expect((error as EnrichmentImportError).status).toBe(status)
      expect((error as Error).message).not.toContain('private')
      expect((error as Error).message).not.toContain('Emergency')
    }
    if (status === 401 || status === 403) expect(controller.status).toBe('unavailable')
  }
  for (
    const access of [
      { request: () => Promise.resolve(new Response('private malformed JSON')) },
      { request: () => Promise.reject(new Error('private network details')) },
    ]
  ) {
    await expect(importEnrichmentArchive('marine', archive(), access)).rejects
      .toThrow('could not be confirmed')
  }
})

Deno.test('import rejects stale identity before dispatch and while parsing completion', async () => {
  const controller = authority()
  const context = controller.context
  let requests = 0
  const access: AdminRequestAccess = {
    request() {
      requests++
      return Promise.resolve(Response.json(success()))
    },
  }
  controller.invalidate('changed')
  await expect(importEnrichmentArchive('marine', archive(), access, {
    authority: controller,
    context,
  })).rejects.toThrow('Access changed')
  expect(requests).toBe(0)

  const current = authority()
  let release!: () => void
  let started!: () => void
  const reading = new Promise<void>((resolve) => started = resolve)
  const body = new Promise<void>((resolve) => release = resolve)
  const response = Response.json(success())
  response.json = async () => {
    started()
    await body
    return success()
  }
  const pending = importEnrichmentArchive('marine', archive(), {
    request: () => Promise.resolve(response),
  }, { authority: current, context: current.context })
  await reading
  current.invalidate('different identity')
  release()
  await expect(pending).rejects.toHaveProperty('name', 'AbortError')
})
