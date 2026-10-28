import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { type AgentAskEvent, AgentAskEventSchema, type AgentSource } from '@research-portal/core'
import { AgentStreamNormaliser, normaliseAgentStream } from './agent-stream.ts'
import { AragProvider } from './index.ts'
import { AgentAskError } from '../../provider.ts'

const SOURCES: AgentSource[] = [
  { id: 'drv-fisheries', label: 'Fisheries research' },
  { id: 'drv-grains', label: 'Grains research' },
  { id: 'drv-rural', label: 'Rural industries research' },
]

/** A fixture's lines through the normaliser, on a clock that follows each line's `_t`. */
function normaliseFixture(name: string, sources: AgentSource[] = SOURCES): AgentAskEvent[] {
  const text = Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url))
  let clock = 0
  const normaliser = new AgentStreamNormaliser({ sources, now: () => clock })
  const events = [normaliser.start()]
  for (const line of text.split('\n').filter((line) => line.trim())) {
    clock = (JSON.parse(line) as { _t: number })._t
    events.push(...normaliser.push(line))
  }
  events.push(...normaliser.finish())
  return events
}

/** Lines pushed one by one, on a clock that stands still unless a test moves it. */
function normalise(lines: unknown[], options: { sources?: AgentSource[] } = {}): AgentAskEvent[] {
  const normaliser = new AgentStreamNormaliser({ ...options, now: () => 0 })
  return [...lines.flatMap((line) => normaliser.push(line)), ...normaliser.finish()]
}

const ofType = <T extends AgentAskEvent['type']>(events: AgentAskEvent[], type: T) =>
  events.filter((event): event is Extract<AgentAskEvent, { type: T }> => event.type === type)

/** Every step id opens once, before it closes at most once, and closes before the stream ends. */
function expectWellFormedSteps(events: AgentAskEvent[]) {
  const status = new Map<string, string>()
  for (const event of ofType(events, 'agent-step')) {
    const previous = status.get(event.id)
    if (event.status === 'started') expect(previous, event.id).toBeUndefined()
    else expect(previous, event.id).toBe('started')
    status.set(event.id, event.status)
  }
  for (const [id, last] of status) expect(last, id).not.toBe('started')
}

const step = (agent_path: string | undefined, extra: Record<string, unknown> = {}) => ({
  operation: 0,
  step: { module: 'basic_ask', title: `Step ${agent_path ?? 'basic_ask'}`, agent_path, ...extra },
})
const context = (id: string, extra: Record<string, unknown> = {}) => ({
  operation: 0,
  context: {
    id,
    agent: 'fisheries',
    agent_id: 'drv-fisheries',
    source: 'Fisheries stream label',
    question: 'A narrower question?',
    chunks: [
      { chunk_id: `${id}-a`, title: 'First', text: 'First passage.', url: 'https://example.org/a' },
      { chunk_id: `${id}-b`, title: 'Second', text: 'Second passage.' },
    ],
    ...extra,
  },
})

describe('the happy-path fixture', () => {
  const events = normaliseFixture('agent-happy.ndjson')

  it('is a valid agent ask stream that starts with the configured sources and ends done', () => {
    for (const event of events) AgentAskEventSchema.parse(event)
    expect(events[0]).toEqual({ type: 'agent-start', sources: SOURCES })
    expect(events.at(-1)).toEqual({ type: 'done', elapsedMs: 89_800 })
    expect(ofType(events, 'error')).toEqual([])
    expectWellFormedSteps(events)
  })

  it('reports every step with the duration the agent measured', () => {
    const closed = ofType(events, 'agent-step').filter((event) => event.status !== 'started')
    expect(closed.length).toBe(12)
    expect(closed.every((event) => event.status === 'completed')).toBe(true)
    expect(closed.find((event) => event.id === 'context/ctx-grains')?.elapsedMs).toBe(27_200)
    expect(closed.find((event) => event.id === 'preprocess/rephrase')).toMatchObject({
      elapsedMs: 3050,
      reason: 'Restated as one question per collection so each source is searched on its own ' +
        'terms.',
    })
  })

  it("groups each lookup's passages under its source, on the lookup's step", () => {
    const found = ofType(events, 'agent-sources')
    expect(found.map((event) => [event.stepId, event.source.label, event.chunks.length])).toEqual([
      ['context/ctx-fisheries', 'Fisheries research', 3],
      ['context/ctx-grains', 'Grains research', 3],
      ['context/ctx-rural', 'Rural industries research', 2],
      ['context/ctx-rural-2', 'Rural industries research', 2],
    ])
    const started = new Set(
      ofType(events, 'agent-step').filter((e) => e.status === 'started').map((e) => e.id),
    )
    for (const event of found) expect(started.has(event.stepId)).toBe(true)
  })

  it('streams reasoning and the answer, and cites passages the sources returned', () => {
    expect(ofType(events, 'reasoning').filter((event) => event.last).length).toBe(3)
    const answer = ofType(events, 'delta').map((event) => event.text).join('')
    expect(answer).toMatch(/^Across the three collections/)
    const chunks = new Map(
      ofType(events, 'agent-sources').flatMap((event) =>
        event.chunks.map((chunk) => [chunk.id, event.source.id] as const)
      ),
    )
    const citations = ofType(events, 'citation')
    expect(citations.map((citation) => citation.marker)).toEqual([
      'block-AA',
      'block-AB',
      'block-AC',
      'block-AD',
      'block-AE',
      'block-AF',
    ])
    for (const citation of citations) {
      expect(answer).toContain(`[${citation.marker}]`)
      expect(chunks.get(citation.chunkId)).toBe(citation.sourceId)
      expect(citation.url).toMatch(/^https:\/\/example\.org\//)
    }
    // The answer is sent once: the final `answer` line repeats the streamed chunks.
    expect(answer.match(/Across the three collections/g)?.length).toBe(1)
    const lastDelta = events.findLastIndex((event) => event.type === 'delta')
    expect(events.findIndex((event) => event.type === 'citation')).toBeGreaterThan(lastDelta)
  })
})

describe('the other fixtures', () => {
  it('ends the error fixture with one upstream error and fails the lookups still open', () => {
    const events = normaliseFixture('agent-error.ndjson')
    for (const event of events) AgentAskEventSchema.parse(event)
    expectWellFormedSteps(events)
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'upstream',
      message: 'Retrieval driver drv-grains failed: 502 Bad Gateway',
      retryable: true,
    })
    const failed = ofType(events, 'agent-step').filter((event) => event.status === 'failed')
    expect(failed.map((event) => [event.id, event.elapsedMs])).toEqual([
      ['context/ctx-grains', 17_400],
      ['context/ctx-rural', 17_600],
    ])
    // The reasoning line after the error is not read.
    expect(ofType(events, 'reasoning').map((event) => event.text)).toEqual([
      'Each collection needs its own lookup.',
    ])
    expect(ofType(events, 'done')).toEqual([])
  })

  it('reports the slow start as the same stream, only later', () => {
    const events = normaliseFixture('agent-slow-start.ndjson')
    for (const event of events) AgentAskEventSchema.parse(event)
    expectWellFormedSteps(events)
    expect(ofType(events, 'citation').length).toBe(3)
    expect(events.at(-1)).toEqual({ type: 'done', elapsedMs: 46_800 })
  })
})

describe('AgentStreamNormaliser', () => {
  it('opens and closes steps by agent path, falling back to the module', () => {
    const events = normalise([
      step('context/one'),
      step('context/two'),
      { operation: 0, step: { module: 'rerank', title: 'Ranking' } },
      step('context/two', { timeit: 2.5 }),
      { operation: 0, step: { module: 'rerank', title: 'Ranking', timeit: 0.25 } },
      step('context/one', { error: 'Driver failed', timeit: 4 }),
      { operation: 3 },
    ])
    expect(
      ofType(events, 'agent-step').map((e) => [e.id, e.module, e.status, e.elapsedMs]),
    ).toEqual([
      ['context/one', 'basic_ask', 'started', undefined],
      ['context/two', 'basic_ask', 'started', undefined],
      ['rerank', 'rerank', 'started', undefined],
      ['context/two', 'basic_ask', 'completed', 2500],
      ['rerank', 'rerank', 'completed', 250],
      ['context/one', 'basic_ask', 'failed', 4000],
    ])
  })

  it('opens and closes at once a step first seen finished, and numbers a repeated one', () => {
    const events = normalise([
      step('plan', { timeit: 1.2, reason: 'Because.' }),
      step('plan'),
      step('plan', { timeit: 0.5 }),
      step('fail', { error: 'Boom' }),
      { operation: 3 },
    ])
    expect(ofType(events, 'agent-step').map((e) => [e.id, e.status, e.reason])).toEqual([
      ['plan', 'started', 'Because.'],
      ['plan', 'completed', 'Because.'],
      ['plan#2', 'started', undefined],
      ['plan#2', 'completed', undefined],
      ['fail', 'started', undefined],
      ['fail', 'failed', undefined],
    ])
  })

  it('times a step the agent did not measure on its own clock', () => {
    let clock = 1000
    const normaliser = new AgentStreamNormaliser({ now: () => clock })
    normaliser.push(step('context/one'))
    clock = 4500
    expect(normaliser.push(step('context/one'))).toEqual([{
      type: 'agent-step',
      id: 'context/one',
      module: 'basic_ask',
      title: 'Step context/one',
      status: 'completed',
      elapsedMs: 3500,
    }])
    clock = 6000
    expect(normaliser.push({ operation: 3 })).toEqual([{ type: 'done', elapsedMs: 5000 }])
  })

  it("attaches a context to its lookup's step, and labels it from the configuration", () => {
    const events = normalise([
      step('context/c1'),
      step('postprocess/other'),
      context('c1'),
      { operation: 3 },
    ], { sources: [{ id: 'drv-fisheries', label: 'Configured fisheries' }] })
    expect(ofType(events, 'agent-sources')).toEqual([{
      type: 'agent-sources',
      stepId: 'context/c1',
      source: { id: 'drv-fisheries', label: 'Configured fisheries' },
      question: 'A narrower question?',
      chunks: [
        { id: 'c1-a', title: 'First', text: 'First passage.', url: 'https://example.org/a' },
        { id: 'c1-b', title: 'Second', text: 'Second passage.' },
      ],
    }])
    // Unconfigured, the stream's own label names the source.
    expect(ofType(normalise([context('c1')]), 'agent-sources')[0]?.source).toEqual({
      id: 'drv-fisheries',
      label: 'Fisheries stream label',
    })
  })

  it("groups a context's chunks by the driver each came from", () => {
    const events = normalise([{
      operation: 0,
      step: { module: 'basic_ask', title: 'Searching all', agent_path: 'context/mixed' },
      context: {
        id: 'mixed',
        agent_id: 'drv-fisheries',
        source: 'Fisheries research',
        chunks: [
          { chunk_id: 'f1', title: 'F1', text: 'f', origin_agent: null },
          { chunk_id: 'g1', title: '', text: 'g', origin_agent: 'drv-grains' },
          { chunk_id: 'f2', title: 'F2', text: 'f', url: 'javascript:alert(1)' },
          'not a chunk',
          {
            title: 'No id',
            text: 'n',
            origin_agent: 'drv-grains',
            origin_url: 'http://example.org/n',
          },
        ],
      },
    }], { sources: SOURCES })
    const found = ofType(events, 'agent-sources')
    expect(found.map((e) => [e.stepId, e.source.id, e.chunks.map((c) => c.id)])).toEqual([
      ['context/mixed', 'drv-fisheries', ['f1', 'f2']],
      ['context/mixed', 'drv-grains', ['g1', 'mixed/4']],
    ])
    // An untitled chunk takes its source's name; only http(s) links survive.
    expect(found[1]?.chunks[0]?.title).toBe('Grains research')
    expect(found[0]?.chunks[1]?.url).toBeUndefined()
    expect(found[1]?.chunks[1]?.url).toBe('http://example.org/n')
  })

  it('reports a lookup that found nothing as its source with no passages', () => {
    const found = ofType(normalise([context('empty', { chunks: [] })]), 'agent-sources')
    expect(found.map((event) => [event.source.id, event.chunks])).toEqual([['drv-fisheries', []]])
  })

  it('maps citations through their context and chunk, and drops those it cannot resolve', () => {
    const events = normalise([
      context('c1'),
      {
        operation: 0,
        answer: 'Answer [block-AA] [block-AB].',
        answer_citations: {
          metadata: {
            'block-AA': {
              context_id: 'c1',
              chunk_index: 1,
              origin_urls: ['ftp://x', 'https://example.org/b'],
            },
            'block-AB': { context_id: 'c1', chunk_index: 0, origin_urls: [] },
            'block-AC': { context_id: 'missing', chunk_index: 0 },
            'block-AD': { context_id: 'c1', chunk_index: 7 },
            'block-AE': { context_id: 'c1', chunk_index: '0' },
            'block-AF': 'not a citation',
          },
        },
      },
      {
        operation: 0,
        answer_citations: { metadata: { 'block-AA': { context_id: 'c1', chunk_index: 0 } } },
      },
      { operation: 3 },
    ])
    expect(ofType(events, 'citation')).toEqual([
      {
        type: 'citation',
        marker: 'block-AA',
        sourceId: 'drv-fisheries',
        chunkId: 'c1-b',
        title: 'Second',
        url: 'https://example.org/b',
      },
      {
        type: 'citation',
        marker: 'block-AB',
        sourceId: 'drv-fisheries',
        chunkId: 'c1-a',
        title: 'First',
        url: 'https://example.org/a',
      },
    ])
  })

  it('streams reasoning and answer chunks, sending a final answer only when nothing streamed', () => {
    const streamed = normalise([
      { operation: 7, reasoning: { text: 'Thinking.', last: false } },
      { operation: 7, reasoning: { text: 'Done thinking.', last: true } },
      { operation: 6, streaming_response_chunk: { text: 'Hello ', last: false } },
      { operation: 6, streaming_response_chunk: { text: '', last: false } },
      { operation: 6, streaming_response_chunk: { text: 'world.', last: true } },
      { operation: 0, answer: 'Hello world.' },
      { operation: 3 },
    ])
    expect(streamed.filter((e) => e.type === 'reasoning' || e.type === 'delta')).toEqual([
      { type: 'reasoning', text: 'Thinking.', last: false },
      { type: 'reasoning', text: 'Done thinking.', last: true },
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world.' },
    ])
    expect(ofType(normalise([{ answer: 'Whole answer.' }, { operation: 3 }]), 'delta')).toEqual([
      { type: 'delta', text: 'Whole answer.' },
    ])
  })

  it('ends with done on done or quit, closing the steps still open', () => {
    for (const operation of [1, 3]) {
      const events = normalise([step('open'), { operation }, step('late'), { operation: 6 }])
      expect(events.slice(-2)).toEqual([
        {
          type: 'agent-step',
          id: 'open',
          module: 'basic_ask',
          title: 'Step open',
          status: 'completed',
          elapsedMs: 0,
        },
        { type: 'done', elapsedMs: 0 },
      ])
    }
  })

  it('ends with an upstream error on an error line, worded from its exception', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ operation: 4, exception: { detail: 'Driver timed out' } }, 'Driver timed out'],
      [{ operation: 4, error: 'Plain error' }, 'Plain error'],
      [{ operation: 4, step: { module: 'm', error: 'Step error' } }, 'Step error'],
      [{ operation: 4 }, 'The agent reported an error.'],
    ]
    for (const [line, message] of cases) {
      expect(normalise([line]).at(-1)).toEqual({
        type: 'error',
        code: 'upstream',
        message,
        retryable: true,
      })
    }
  })

  it('reports a stream that broke off as an upstream error', () => {
    const events = normalise([step('open'), {
      operation: 6,
      streaming_response_chunk: { text: 'Half' },
    }])
    expect(events.slice(-2)).toEqual([
      {
        type: 'agent-step',
        id: 'open',
        module: 'basic_ask',
        title: 'Step open',
        status: 'failed',
        elapsedMs: 0,
      },
      {
        type: 'error',
        code: 'upstream',
        message: 'The agent stopped before it finished answering.',
        retryable: true,
      },
    ])
  })

  it('skips malformed lines and ignores fields and operations it does not know', () => {
    const events = normalise([
      'not json',
      '{"operation": 6, "streaming_response_chunk": {"text": "Raw line. "}}',
      '{"truncated": ',
      null,
      42,
      ['an', 'array'],
      { operation: 2, original_question_uuid: 'q', seqid: 1 },
      { operation: 5, agent_request: 'Which year?' },
      { operation: 99, streaming_response_chunk: { text: 'unknown op' } },
      { operation: 6, streaming_response_chunk: { text: 'Parsed.', extra: true }, novel: { a: 1 } },
      { operation: 6, streaming_response_chunk: { text: 7 } },
      { operation: 7, reasoning: 'not an object' },
      { operation: 0, step: 'not an object', context: [] },
      { operation: 3, seqid: 9 },
    ])
    expect(events).toEqual([
      { type: 'delta', text: 'Raw line. ' },
      { type: 'delta', text: 'Parsed.' },
      { type: 'done', elapsedMs: 0 },
    ])
  })
})

describe('normaliseAgentStream', () => {
  it('announces the sources before the first line arrives', async () => {
    const never: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    }
    const stream = normaliseAgentStream(never, { sources: SOURCES })
    expect((await stream.next()).value).toEqual({ type: 'agent-start', sources: SOURCES })
  })

  it('stops reading the upstream at the end of the answer', async () => {
    let returned = false
    let read = 0
    async function* upstream() {
      try {
        for (
          const line of [{ operation: 6, streaming_response_chunk: { text: 'A.' } }, {
            operation: 3,
          }]
        ) {
          read++
          yield line
        }
        read++
        yield { operation: 6, streaming_response_chunk: { text: 'Never read.' } }
      } finally {
        returned = true
      }
    }
    const events: AgentAskEvent[] = []
    for await (const event of normaliseAgentStream(upstream(), { now: () => 0 })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['agent-start', 'delta', 'done'])
    expect(read).toBe(2)
    expect(returned).toBe(true)
  })

  it('reports an upstream that ends early', async () => {
    async function* upstream() {
      yield { operation: 6, streaming_response_chunk: { text: 'A.' } }
    }
    const events: AgentAskEvent[] = []
    for await (const event of normaliseAgentStream(upstream())) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'upstream', retryable: true })
  })
})

describe('AragProvider.agentAsk', () => {
  it('reports not_configured until a retrieval agent is wired in, without calling upstream', () => {
    let fetched = 0
    const provider = new AragProvider({
      resolveBinding: () => ({ baseUrl: 'https://example.invalid/api/v1', kbId: 'kb', token: 't' }),
      fetchImpl: () => {
        fetched++
        return Promise.reject(new Error('no network in tests'))
      },
    })
    const tenant = { slug: 'a' } as Parameters<AragProvider['agentAsk']>[0]
    let thrown: unknown
    try {
      provider.agentAsk(tenant, 'Why?')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentAskError)
    expect(thrown).toMatchObject({ code: 'not_configured', retryable: false })
    expect(fetched).toBe(0)
  })
})
