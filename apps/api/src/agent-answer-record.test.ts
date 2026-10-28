import { expect } from '@std/expect'
import { type AgentAskEvent, AnswerRecordSchema, type TenantConfig } from '@research-portal/core'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'
import { recordAgentAnswer } from './agent-answer-record-stream.ts'
import { AgentAnswerRecorder } from './agent-answer-recorder.ts'
import { transientAnswerRecordStore } from './answer-record-store.ts'
import { tenantConfig } from './tenants.ts'
import { createEnforcementFixture } from './enforcement-fixture.ts'

const question = 'How do warm winters affect soil moisture?'
const passage = 'Warm, dry winters left less soil moisture for spring crops.'
const host: TenantConfig = {
  ...tenantConfig('marine')!,
  agentAsk: true,
  federation: {
    peers: [
      { id: 'soil', label: 'Soil Research Hub', kind: 'arag-kb', zone: 'test', kbId: 'soil-box' },
      { id: 'water', label: 'Water research', kind: 'arag-mcp', zone: 'test', kbId: 'water-box' },
    ],
  },
}
class RecordProvider extends DoubleProvider {
  override agentAsk(): AsyncIterable<AgentAskEvent> {
    throw new Error('No fixture agent')
  }
  generativeModel() {
    return Promise.resolve('fixture-model-v1')
  }
  storeIdentifier() {
    return 'fixture-host-box'
  }
  override search() {
    return Promise.resolve({
      query: question,
      relatedQuestions: [],
      resources: [{
        id: 'soil-report',
        title: 'Soil moisture review',
        summary: passage,
        type: 'pdf' as const,
        topicIds: [],
        keyFacts: [],
        relevance: 0.9,
        citedCount: 0,
        matchedPassage: passage,
      }],
    })
  }
  override compose() {
    return Promise.resolve(`${passage} [1]\n\nLosses fell by 37% across 120 farms. [2]`)
  }
}

Deno.test('agent composition records hosted and two peer sources, questions, passages, citation decisions and a failed peer', async () => {
  const store = transientAnswerRecordStore()
  const events: AgentAskEvent[] = []
  for await (
    const event of recordAgentAnswer({
      store,
      provider: new RecordProvider(),
      host,
      portals: [host],
      question,
      buildId: 'fixture-build',
      peers: [
        {
          source: { id: 'peer:soil', label: 'Soil Research Hub', kind: 'peer', transport: 'kb' },
          search: () =>
            Promise.resolve([{
              id: 'soil-chunk',
              title: 'Soil evidence',
              text: 'Cover crops protected soil structure.',
              url: 'https://example.test/report.pdf?secret=hidden#part',
            }]),
        },
        {
          source: { id: 'peer:water', label: 'Water research', kind: 'peer', transport: 'mcp' },
          search: () =>
            Promise.reject(
              Object.assign(new Error('private upstream detail'), { failure: 'unauthorised' }),
            ),
        },
      ],
    })
  ) {
    events.push(event)
    if (event.type === 'answer-record') expect(store.get(host.slug, event.answerId)).not.toBeNull()
  }
  expect(events.at(-2)?.type).toBe('answer-record')
  expect(events.at(-1)?.type).toBe('done')
  const record = AnswerRecordSchema.parse(store.list(host.slug)[0])
  expect(record.surface).toBe('composed')
  expect(record.agent?.mode).toBe('orchestrated')
  expect(record.agent?.sources.map((s) => [s.id, s.kind, s.transport, s.storeId])).toEqual([
    ['marine', 'hosted', 'kb', 'fixture-host-box'],
    ['peer:soil', 'peer', 'kb', 'soil-box'],
    ['peer:water', 'peer', 'mcp', 'water-box'],
  ])
  expect(record.agent?.sources[2]?.endpoint).toBe(
    'https://test.dp.progress.cloud/api/v1/kb/water-box/mcp',
  )
  expect(record.agent?.lookups.map((s) => s.question)).toEqual([question, question, question])
  expect(record.agent?.steps.every((s) => s.status !== 'started' && s.durationMs !== null)).toBe(
    true,
  )
  expect(record.retrieved).toHaveLength(2)
  expect(record.retrieved.find((p) => p.sourceId === 'peer:soil')).toMatchObject({
    sourceId: 'peer:soil',
    peerId: 'soil',
    chunkId: 'soil-chunk',
    url: 'https://example.test/report.pdf',
  })
  expect(record.cited[0]).toMatchObject({
    sourceId: 'marine',
    resourceId: 'soil-report',
    text: passage,
    marker: '1',
  })
  expect(record.agent?.citationDecisions).toEqual([
    {
      marker: '1',
      sourceId: 'marine',
      chunkId: 'marine/soil-report',
      finalMarker: '1',
      sentenceIndex: 0,
      outcome: 'kept',
    },
    {
      marker: '2',
      sourceId: 'peer:soil',
      chunkId: 'soil-chunk',
      sentenceIndex: 1,
      outcome: 'dropped',
    },
  ])
  expect(record.agent?.failedSources).toEqual([{ sourceId: 'peer:water', reason: 'unauthorised' }])
  expect(record.calls.map((s) => [s.source, s.status])).toEqual([['marine', 'ok'], [
    'peer:soil',
    'ok',
  ], ['peer:water', 'error']])
  expect(record.generation).toMatchObject({
    modelId: 'fixture-model-v1',
    buildId: 'fixture-build',
    configurationIds: ['portal-search', 'agent-compose-v1', 'citation-binding-v1'],
  })
  expect(record.verification).toMatchObject({
    outcome: 'checked',
    citationsSeen: 2,
    citationsDropped: 1,
    sentencesDropped: 1,
  })
  expect(record.timing.durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(record)).not.toContain('private upstream detail')
})

Deno.test('agent records project credentials and headers away and redact every evidence field before truncation', () => {
  const store = transientAnswerRecordStore()
  const recorder = new AgentAnswerRecorder({
    store,
    portal: 'marine',
    question: 'Study token=private-query',
    surface: 'agent',
  })
  const source = {
    id: 'peer:soil',
    label: 'Soil Research Hub',
    kind: 'peer' as const,
    transport: 'mcp' as const,
    token: 'plain-secret-key',
    headers: { Authorization: 'custom-header-secret' },
  }
  recorder.observeAgent({ type: 'agent-start', mode: 'agent', sources: [source] })
  recorder.observeAgent({
    type: 'agent-step',
    id: 'lookup',
    module: 'search',
    title: 'Soil lookup',
    status: 'started',
  })
  recorder.observeAgent({
    type: 'agent-sources',
    stepId: 'lookup',
    source,
    question: 'Soil?\nAuthorization: Custom header-credential\nCookie: session=hidden-cookie',
    chunks: [{
      id: 'chunk',
      title: 'Review',
      text: 'api_key=private-key Bearer hidden-bearer',
      url: 'https://user:pass@example.test/report?signature=private-signature',
    }],
  })
  recorder.observeAgent({
    type: 'citation',
    marker: 'block-AA',
    sourceId: source.id,
    chunkId: 'chunk',
    title: 'Review',
  })
  recorder.observeAgent({ type: 'done', elapsedMs: 25 })
  recorder.finish()
  const record = store.list('marine')[0]!
  expect(record.agent?.mode).toBe('agent')
  expect(record.agent?.citationCheck).toBe('not_reported')
  expect(record.cited[0]?.marker).toBe('block-AA')
  const saved = JSON.stringify(record)
  for (
    const secret of [
      'plain-secret-key',
      'custom-header-secret',
      'header-credential',
      'hidden-cookie',
      'private-key',
      'hidden-bearer',
      'private-signature',
      'user:pass',
      'private-query',
      'Authorization',
      'headers',
    ]
  ) expect(saved).not.toContain(secret)
  expect(saved).toContain('https://example.test/report')
})

Deno.test('agent evidence follows the 384 KiB bound and identifies truncated fields', () => {
  const store = transientAnswerRecordStore()
  const recorder = new AgentAnswerRecorder({ store, portal: 'marine', question, surface: 'agent' })
  const source = {
    id: 'soil',
    label: 'Soil Research Hub',
    kind: 'hosted' as const,
    portal: 'marine',
  }
  recorder.observeAgent({ type: 'agent-start', mode: 'agent', sources: [source] })
  for (let i = 0; i < 240; i++) {
    recorder.observeAgent({
      type: 'agent-step',
      id: `step/${i}`,
      module: 'search',
      title: 'Lookup',
      status: 'started',
    })
    recorder.observeAgent({
      type: 'agent-sources',
      stepId: `step/${i}`,
      source,
      question: 'Study '.repeat(1500),
      chunks: [{ id: `chunk/${i}`, title: 'Long report', text: 'Evidence '.repeat(1000) }],
    })
  }
  recorder.finish('cancelled')
  const record = store.list('marine')[0]!
  expect(record.truncated).toBe(true)
  expect(record.truncatedFields).toContain('text')
  expect(record.truncatedFields).toContain('retrieved')
  expect(record.truncatedFields).toContain('agent.steps')
  expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThanOrEqual(384 * 1024)
})

for (const adapter of ['durable', 'local'] as const) {
  Deno.test(`${adapter}: both agent routes persist host records and curator exports preserve agent columns`, async () => {
    const f = createEnforcementFixture({ provider: new RecordProvider() }, adapter)
    try {
      for (const slug of ['a', 'b']) f.stores.tenants.patch(slug, { agentAsk: true })
      for (const path of ['/api/t/a/ask-agent', '/api/ask-agent']) {
        const response = await f.requestAs(f.sessionFor('platform-admin'), path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: question,
            ...(path === '/api/ask-agent' ? { slugs: ['a', 'b'] } : {}),
          }),
        })
        const events = (await response.text()).split('\n').filter((s) => s.startsWith('data: '))
          .map((s) => JSON.parse(s.slice(6)))
        expect(events.at(-2)?.type).toBe('answer-record')
        expect(events.at(-1)?.type).toBe('done')
        const id = events.at(-2).answerId
        const base = `/api/admin/t/a/answer-records/records/${id}`
        const curator = f.sessionFor('curator')
        const detail = await f.requestAs(curator, base)
        expect(detail.status).toBe(200)
        expect((await detail.json()).agent.mode).toBe('orchestrated')
        const exported = await f.requestAs(curator, `${base}/export?format=json`)
        expect((await exported.json()).records[0].agent.sources[0].kind).toBe('hosted')
        const csv = await (await f.requestAs(curator, `${base}/export?format=csv`)).text()
        for (
          const column of [
            'mode',
            'sources',
            'steps',
            'sourceQuestions',
            'citationDecisions',
            'failedSources',
            'truncatedFields',
          ]
        ) expect(csv.split('\r\n')[0]).toContain(`"${column}"`)
        expect(csv).toContain('""kind"":""hosted""')
        expect(csv).toContain('""transport"":""kb""')
        expect(f.stores.answerRecords.list('b')).toHaveLength(0)
      }
      f.stores.answerRecords.record = () => {
        throw new Error('private-write-error')
      }
      const failed = await f.requestAs(f.sessionFor('viewer'), '/api/t/a/ask-agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: question }),
      })
      const body = await failed.text()
      expect(body).toContain('"type":"error"')
      expect(body).not.toContain('"type":"done"')
      expect(body).not.toContain('"type":"answer-record"')
      expect(body).not.toContain('private-write-error')
    } finally {
      f.close()
    }
  })
}

Deno.test('agent failures and early iterator closure retain error and cancelled records', async () => {
  const store = transientAnswerRecordStore()
  const provider = Object.assign(new DoubleProvider(), {
    agentAsk: async function* (): AsyncGenerator<AgentAskEvent> {
      yield {
        type: 'agent-start',
        mode: 'agent',
        sources: [{ id: 'driver', label: 'Soil Research Hub' }],
      }
      throw new Error('private-agent-failure')
    },
  })
  const options = { store, provider, host, portals: [host], question }
  const cancelled = recordAgentAnswer(options)
  expect((await cancelled.next()).value?.type).toBe('agent-start')
  await cancelled.return(undefined)
  expect(store.list(host.slug)[0]?.status).toBe('cancelled')
  await expect((async () => {
    for await (const _event of recordAgentAnswer(options)) { /* Drain. */ }
  })()).rejects.toThrow('private-agent-failure')
  expect(store.list(host.slug).map((r) => r.status).sort()).toEqual(['cancelled', 'error'])
  expect(JSON.stringify(store.list(host.slug))).not.toContain('private-agent-failure')
})

Deno.test('the citation record distinguishes the same marker kept and dropped on different sentences', async () => {
  const store = transientAnswerRecordStore()
  const provider = Object.assign(new RecordProvider(), {
    compose: () => Promise.resolve(`${passage} [1]\n\nLosses fell by 37% across 120 farms. [1]`),
  })
  for await (
    const _event of recordAgentAnswer({ store, provider, host, portals: [host], question })
  ) { /* Drain. */ }
  const decisions = store.list(host.slug)[0]!.agent!.citationDecisions
  expect(decisions.map((d) => [d.marker, d.sentenceIndex, d.outcome])).toEqual([
    ['1', 0, 'kept'],
    ['1', 1, 'dropped'],
  ])
})
