import { expect } from '@std/expect'
import type { AskEvent } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { AnswerRecorder } from './answer-recorder.ts'
import {
  AnswerRecordStore,
  FileAnswerRecordState,
  transientAnswerRecordStore,
} from './answer-record-store.ts'
import { answerRecordFixture } from './answer-record-fixture.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'
import { redactAnswerRecordText } from './answer-record-redaction.ts'
import { tenantConfig } from './tenants.ts'

const DAY = 86_400_000
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

Deno.test('recorder retains queries, passages, final citations, dropped sentences, quality, model and peer outcomes', async () => {
  let now = Date.now()
  const store = transientAnswerRecordStore(() => now)
  const recorder = new AnswerRecorder({
    store,
    portal: 'marine',
    question: 'Stock health?',
    surface: 'composed',
    modelId: 'research-model-v2',
    now: () => now,
  })
  const provider = recorder.provider(new DoubleProvider())
  const tenant = tenantConfig('marine')!
  await provider.search(tenant, 'stock survey')
  for await (
    const event of provider.ask(tenant, 'What affects stock health?', {
      depth: 'deep',
      prequeries: ['heat stress'],
      systemPrompt: 'private prompt text',
    })
  ) {
    recorder.observe(event)
  }
  recorder.providerEvent({
    type: 'citation',
    citation: {
      index: 2,
      resourceId: 'dropped',
      title: 'Dropped evidence',
      passage: 'Unverified detail',
    },
  })
  recorder.observe({
    type: 'audit',
    figuresChecked: 2,
    figuresUnsupported: [],
    yearsUnsupported: [],
    contraindicationsUnsupported: [],
    sentencesChecked: 3,
    sentencesCited: 1,
    sentencesRemoved: 1,
    figuresRemoved: ['99%'],
  })
  recorder.call({
    source: 'soil-peer',
    storeId: 'soil-store',
    operation: 'mcp.ask',
    status: 'error',
    durationMs: 25,
  })
  now += 50
  recorder.finish()
  const record = store.get('marine', recorder.answerId)!
  expect(record.retrievalQueries).toEqual([
    'stock survey',
    'What affects stock health?',
    'heat stress',
  ])
  expect(record.retrieved.length).toBeGreaterThan(0)
  expect(record.cited[0]).toMatchObject({
    resourceId: 'res-1',
    citationIndex: 1,
    scoreScope: 'resource',
  })
  expect(record.verification).toMatchObject({
    citationsSeen: 2,
    citationsDropped: 1,
    sentencesDropped: 1,
    figuresDropped: ['99%'],
    outcome: 'checked',
  })
  expect(record.generation.modelId).toBe('research-model-v2')
  expect(record.generation.promptHashes[0]).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(record)).not.toContain('private prompt text')
  expect(record.quality.groundedness).toBe(4.5)
  expect(record.timing.durationMs).toBe(50)
  expect(record.calls.map((c) => c.status)).toEqual(['ok', 'ok', 'error'])
  expect(recorder.finish()).toBe(recorder.answerId)
  expect(store.list('marine')).toHaveLength(1)
})

Deno.test('redaction omits identity fields, credentials, IP addresses and session identifiers from generic records', () => {
  const store = transientAnswerRecordStore()
  const record = answerRecordFixture()
  record.question =
    'Personal research question token=private-value session_id=secret-session 192.0.2.4 2001:db8::1 Bearer private-token'
  record.calls.push({
    source: 'https://user:pass@peer.example.test/mcp?token=private-query',
    storeId: null,
    operation: 'ask',
    status: 'ok',
    durationMs: 1,
  })
  store.record(
    'marine',
    { ...record, clientIp: '192.0.2.9', sessionId: 'hidden-session' } as typeof record,
  )
  const saved = JSON.stringify(store.get('marine', record.answerId))
  for (
    const secret of [
      'private-value',
      'secret-session',
      '192.0.2',
      '2001:db8',
      'private-token',
      'user:pass',
      'private-query',
      'clientIp',
      'sessionId',
    ]
  ) expect(saved).not.toContain(secret)
  expect(saved).toContain('Personal research question')
  expect(saved).toContain('https://peer.example.test/mcp')
  for (const suffix of ['-', '_', 'a']) {
    expect(redactAnswerRecordText('ck_' + 'a'.repeat(42) + suffix)).toBe('[redacted credential]')
  }
  expect(redactAnswerRecordText('::1')).toBe('[redacted address]')
  expect(redactAnswerRecordText('Ratios 1:2:3 at 12:30:00')).toBe('Ratios 1:2:3 at 12:30:00')
})

Deno.test('file storage survives restart, respects portal scope, retention bounds and physical erasure', () => {
  const directory = Deno.makeTempDirSync({ prefix: 'answer-record-test-' })
  let now = Date.now()
  try {
    const create = () => new AnswerRecordStore(new FileAnswerRecordState(directory), () => now)
    let store = create()
    const first = answerRecordFixture('alpha', now)
    store.record('alpha', first)
    store.record('beta', answerRecordFixture('beta', now))
    store = create()
    expect(store.retention('alpha')).toBe(90)
    expect(store.get('beta', first.answerId)).toBeNull()
    expect(() => store.record('beta', first)).toThrow('portal mismatch')
    expect(() => store.record('alpha', first)).toThrow('already exists')
    for (const value of [0, 366, 1.5, NaN]) {
      expect(() => store.setRetention('alpha', value)).toThrow()
    }
    store.setRetention('alpha', 1)
    now += DAY
    expect(store.get('alpha', first.answerId)).toBeNull()
    expect(store.purgeExpired()).toBe(1)
    expect(store.list('beta')).toHaveLength(1)
    expect(store.erase('alpha')).toBe(1)
    expect(store.erase('alpha')).toBe(0)
    expect(store.retention('alpha')).toBe(90)
    expect(store.list('beta')).toHaveLength(1)
    expect(() => store.list('../other')).toThrow()
    const corrupt = answerRecordFixture('alpha', now)
    store.record('alpha', corrupt)
    Deno.writeTextFileSync(`${directory}/answer-records/alpha/${corrupt.answerId}.json`, '{broken')
    expect(() => store.list('alpha')).toThrow('unavailable')
    expect(store.erase('alpha')).toBe(1)
  } finally {
    Deno.removeSync(directory, { recursive: true })
  }
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter}: answer record routes enforce curator scope, key denial, retention, exports and lifecycle`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const record = answerRecordFixture('a')
      f.stores.answerRecords.record('a', record)
      const base = '/api/admin/t/a/answer-records'
      const curator = f.sessionFor('curator')
      const issued = await f.requestAs(
        f.sessionFor('portal-admin'),
        '/api/t/a/mcp/keys',
        json('POST', { label: 'Evidence client', role: 'curator' }),
      )
      expect(issued.status).toBe(201)
      const credential = (await issued.json()).key
      const deniedKey = await f.requestAs(null, `${base}/records/${record.answerId}`, {
        headers: { Authorization: `Bearer ${credential}` },
      })
      expect([401, 403]).toContain(deniedKey.status)

      for (const role of ['viewer', 'analyst'] as const) {
        expect((await f.requestAs(f.sessionFor(role), `${base}/records/${record.answerId}`)).status)
          .toBe(
            403,
          )
      }
      expect(
        (await f.requestAs(f.sessionFor('curator', 'b'), `${base}/records/${record.answerId}`))
          .status,
      )
        .toBe(403)
      const detail = await f.requestAs(curator, `${base}/records/${record.answerId}`)
      expect(detail.status).toBe(200)
      expect(await detail.json()).toEqual(record)
      expect(detail.headers.get('Cache-Control')).toContain('no-store')
      expect(
        (await f.requestAs(curator, `${base.replace('/a/', '/b/')}/records/${record.answerId}`))
          .status,
      ).toBe(403)
      expect(
        (await f.requestAs(
          f.sessionFor('platform-admin'),
          `${base.replace('/a/', '/b/')}/records/${record.answerId}`,
        )).status,
      ).toBe(404)
      const exported = await f.requestAs(
        curator,
        `${base}/records/${record.answerId}/export?format=json`,
      )
      expect((await exported.json()).records).toEqual([record])
      const csv = await f.requestAs(
        curator,
        `${base}/export?format=csv&from=${encodeURIComponent(record.at)}&to=${
          encodeURIComponent(record.at)
        }`,
      )
      expect(csv.status).toBe(200)
      expect(await csv.text()).toContain(record.question)
      expect(csv.headers.get('Content-Type')).toContain('text/csv')
      expect((await f.requestAs(curator, `${base}/export?format=xml`)).status).toBe(400)
      expect((await f.requestAs(curator, `${base}/retention`, json('PUT', { days: 30 }))).status)
        .toBe(403)
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin'),
          `${base}/retention`,
          json('PUT', { days: 30 }),
        )).status,
      ).toBe(200)
      f.stores.lifecycle.set('a', { status: 'read_only', limits: null })
      expect((await f.requestAs(curator, `${base}/records/${record.answerId}`)).status).toBe(200)
      expect(
        (await f.requestAs(
          f.sessionFor('portal-admin'),
          `${base}/retention`,
          json('PUT', { days: 90 }),
        )).status,
      ).toBe(423)
      f.stores.lifecycle.set('a', { status: 'suspended', limits: null })
      expect((await f.requestAs(curator, `${base}/records/${record.answerId}`)).status).toBe(423)
      const audits = f.rbac.audit.read({ scope: { kind: 'portal', slug: 'a' } })
      expect(audits.some((a) => a.action === 'request.privileged' && a.outcome === 'success')).toBe(
        true,
      )
      expect(JSON.stringify(audits)).not.toContain(record.question)
    } finally {
      f.close()
    }
  })
}

Deno.test('portal ask and document chat persist before done and return an answer id', async () => {
  const f = createEnforcementFixture()
  try {
    for (const resourceId of [undefined, 'res-1']) {
      const response = await f.requestAs(
        f.sessionFor('viewer'),
        '/api/t/a/ask',
        json('POST', {
          query: 'What affects abalone populations?',
          ...(resourceId ? { resourceId } : {}),
        }),
      )
      const events = (await response.text()).split('\n').filter((s) => s.startsWith('data: '))
        .map((s) => JSON.parse(s.slice(6)) as AskEvent)
      const index = events.findIndex((e) => e.type === 'answer-record')
      expect(index).toBeGreaterThan(-1)
      expect(events.findIndex((e) => e.type === 'done')).toBeGreaterThan(index)
      const event = events[index] as Extract<AskEvent, { type: 'answer-record' }>
      const saved = f.stores.answerRecords.get('a', event.answerId)!
      expect(saved.surface).toBe(resourceId ? 'document' : 'ask')
      expect(saved.question).toBe('What affects abalone populations?')
      expect(saved.retrieved.length).toBeGreaterThan(0)
      expect(saved.calls.some((c) => c.operation === 'ask' && c.status === 'ok')).toBe(true)
    }
  } finally {
    f.close()
  }
})

Deno.test('date-range JSON and CSV pagination retain all records and neutralise formula questions', async () => {
  const f = createEnforcementFixture()
  try {
    const ids: string[] = []
    for (let index = 0; index < 8; index++) {
      const record = answerRecordFixture('a')
      record.question = '=SUM(1,2) ' + 'Evidence question '.repeat(9000)
      ids.push(record.answerId)
      f.stores.answerRecords.record('a', record)
    }
    const base = '/api/admin/t/a/answer-records/export'
    const curator = f.sessionFor('curator')
    const seen: string[] = []
    let cursor: string | null = null, pages = 0
    do {
      const response = await f.requestAs(
        curator,
        `${base}?format=json${cursor ? `&cursor=${cursor}` : ''}`,
      )
      expect(response.status).toBe(200)
      const page = await response.json()
      seen.push(...page.records.map((r: { answerId: string }) => r.answerId))
      cursor = page.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBeGreaterThan(1)
    expect(seen.sort()).toEqual(ids.sort())
    const csv = await f.requestAs(curator, `${base}?format=csv`)
    const body = await csv.text()
    expect(body).toContain('"\'=SUM(1,2)')
    expect(csv.headers.get('X-Answer-Records-Next')).toBeTruthy()
    expect((await f.requestAs(curator, `${base}?from=invalid`)).status).toBe(400)
    expect((await f.requestAs(curator, `${base}?format=csv&format=json`)).status).toBe(400)
  } finally {
    f.close()
  }
})

Deno.test('a failed evidence write prevents successful stream completion', async () => {
  const f = createEnforcementFixture()
  f.stores.answerRecords.record = () => {
    throw new Error('Private storage failure')
  }
  try {
    const response = await f.requestAs(
      f.sessionFor('viewer'),
      '/api/t/a/ask',
      json('POST', { query: 'What affects abalone populations?' }),
    )
    const body = await response.text()
    expect(body).toContain('"type":"error"')
    expect(body).not.toContain('"type":"done"')
    expect(body).not.toContain('Private storage failure')
  } finally {
    f.close()
  }
})

Deno.test('estate fan-out records each separately grounded source in its own portal', async () => {
  const f = createEnforcementFixture()
  try {
    const response = await f.requestAs(
      f.sessionFor('platform-admin'),
      '/api/ask-estate',
      json('POST', {
        query: 'What affects abalone populations?',
        slugs: ['a', 'b'],
      }),
    )
    const body = await response.text()
    expect(body).toContain('"type":"estate-done"')
    expect(body.match(/"type":"answer-record"/g)).toHaveLength(2)
    for (const slug of ['a', 'b']) {
      const records = f.stores.answerRecords.list(slug)
      expect(records).toHaveLength(1)
      expect(records[0]!.surface).toBe('composed')
      expect(records[0]!.calls[0]).toMatchObject({ source: slug, operation: 'ask', status: 'ok' })
    }
  } finally {
    f.close()
  }
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter}: shortening retention restores deleted evidence if mutation audit fails`, async () => {
    const f = createEnforcementFixture({}, adapter)
    try {
      const record = answerRecordFixture('a', Date.now() - 60 * DAY)
      f.stores.answerRecords.record('a', record)
      f.database.exec(
        "CREATE TRIGGER evidence_fail_local_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'local.mutation' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
      )
      const response = await f.requestAs(
        f.sessionFor('portal-admin'),
        '/api/admin/t/a/answer-records/retention',
        json('PUT', { days: 30 }),
      )
      expect(response.status).toBe(500)
      expect(f.stores.answerRecords.retention('a')).toBe(90)
      expect(f.stores.answerRecords.get('a', record.answerId)).toEqual(record)
    } finally {
      f.close()
    }
  })
}
