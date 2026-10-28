import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  type AgentAskEvent,
  AgentAskEventSchema,
  type SearchResults,
  type TenantConfig,
} from '@research-portal/core'
import { AgentAskError, type ComposePassage } from '@research-portal/retrieval'
import {
  agentAnswer,
  type AgentAnswerOptions,
  composeAcross,
  NO_PASSAGES,
  NO_SUPPORTED_ANSWER,
} from './agent-compose.ts'
import { tenantConfig } from './tenants.ts'
import { DoubleProvider } from '../../../e2e/support/double-provider.ts'

const portal = (slug: string, productName: string): TenantConfig => {
  const base = tenantConfig('marine')!
  return { ...base, slug, branding: { ...base.branding, productName } }
}
const FISHERIES = portal('fisheries', 'Fisheries collection')
const GRAINS = portal('grains-col', 'Grains collection')
const RURAL = portal('rural', 'Rural collection')

const PASSAGES: Record<string, { id: string; title: string; text: string }[]> = {
  fisheries: [
    {
      id: 'f1',
      title: 'Oyster mortality review',
      text: 'Oyster mortality events clustered after ten warm days in shallow estuaries. ' +
        'Leases in sheltered water recovered last.',
    },
    {
      id: 'f2',
      title: 'Movement controls',
      text: 'Shellfish movement controls now follow water temperature thresholds.',
    },
  ],
  'grains-col': [
    {
      id: 'g1',
      title: 'Early rust epidemics',
      text: 'Warm, wet springs brought stripe rust infections forward by three weeks.',
    },
  ],
  rural: [
    {
      id: 'r1',
      title: 'Heat stress in livestock',
      text: 'Shade and reliable water reduced heat stress losses in livestock.',
    },
  ],
}

type Search = (config: TenantConfig) => Promise<SearchResults>
/** A provider whose portals return the passages above, with any portal's search replaced. */
class ComposeProvider extends DoubleProvider {
  composed: { host: string; passages: readonly ComposePassage[] }[] = []
  constructor(
    readonly searches: Record<string, Search> = {},
    readonly writer: (passages: readonly ComposePassage[]) => Promise<string> = (passages) =>
      new DoubleProvider().compose(FISHERIES, '', passages),
  ) {
    super()
  }
  override search(config: TenantConfig, query: string): Promise<SearchResults> {
    const replaced = this.searches[config.slug]
    if (replaced) return replaced(config)
    return Promise.resolve({
      query,
      relatedQuestions: [],
      resources: (PASSAGES[config.slug] ?? []).map((passage, rank) => ({
        id: passage.id,
        title: passage.title,
        summary: passage.text,
        type: 'pdf' as const,
        topicIds: [],
        keyFacts: [],
        relevance: 0.9 - rank * 0.1,
        citedCount: 0,
        matchedPassage: passage.text,
      })),
    })
  }
  override compose(
    host: TenantConfig,
    _question: string,
    passages: readonly ComposePassage[],
  ): Promise<string> {
    this.composed.push({ host: host.slug, passages })
    return this.writer(passages)
  }
}

async function collect(stream: AsyncIterable<AgentAskEvent>): Promise<AgentAskEvent[]> {
  const events: AgentAskEvent[] = []
  for await (const event of stream) events.push(AgentAskEventSchema.parse(event))
  return events
}
const run = (provider: ComposeProvider, extra: Partial<AgentAnswerOptions> = {}) =>
  collect(composeAcross({
    provider,
    host: FISHERIES,
    portals: [FISHERIES, GRAINS, RURAL],
    question: 'How is warming changing pests?',
    sourceTimeoutMs: 200,
    ...extra,
  }))
const ofType = <T extends AgentAskEvent['type']>(events: AgentAskEvent[], type: T) =>
  events.filter((event): event is Extract<AgentAskEvent, { type: T }> => event.type === type)
const answerOf = (events: AgentAskEvent[]) =>
  ofType(events, 'delta').map((event) => event.text).join('')

describe('composeAcross', () => {
  it('is labelled orchestrated and names each portal, by slug and label, as a source', async () => {
    const events = await run(new ComposeProvider())
    expect(events[0]).toEqual({
      type: 'agent-start',
      mode: 'orchestrated',
      sources: [
        { id: 'fisheries', label: 'Fisheries collection', portal: 'fisheries', kind: 'hosted' },
        { id: 'grains-col', label: 'Grains collection', portal: 'grains-col', kind: 'hosted' },
        { id: 'rural', label: 'Rural collection', portal: 'rural', kind: 'hosted' },
      ],
    })
    expect(ofType(events, 'agent-sources').map((e) => [e.stepId, e.source.portal, e.chunks.length]))
      .toEqual([['source/fisheries', 'fisheries', 2], ['source/grains-col', 'grains-col', 1], [
        'source/rural',
        'rural',
        1,
      ]])
    expect(ofType(events, 'agent-sources')[0]?.chunks[0]).toEqual({
      id: 'fisheries/f1',
      title: 'Oyster mortality review',
      text: PASSAGES.fisheries![0]!.text,
      resourceId: 'f1',
    })
    expect(ofType(events, 'sources-failed')).toEqual([])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('maps every citation to the portal its passage came from', async () => {
    const provider = new ComposeProvider()
    const events = await run(provider)
    const answer = answerOf(events)
    const chunks = new Map(
      ofType(events, 'agent-sources').flatMap((e) => e.chunks.map((c) => [c.id, e.source.id])),
    )
    const citations = ofType(events, 'citation')
    expect(citations.map((c) => [c.marker, c.sourceId, c.chunkId])).toEqual([
      ['1', 'fisheries', 'fisheries/f1'],
      ['2', 'fisheries', 'fisheries/f2'],
      ['3', 'grains-col', 'grains-col/g1'],
      ['4', 'rural', 'rural/r1'],
    ])
    for (const citation of citations) {
      expect(chunks.get(citation.chunkId)).toBe(citation.sourceId)
      expect(answer).toContain(`[${citation.marker}]`)
    }
    // The host portal's generation path writes it, from every passage, in the portals' order.
    expect(provider.composed.map((c) => [c.host, c.passages.map((p) => p.title)])).toEqual([[
      'fisheries',
      [
        'Oyster mortality review',
        'Movement controls',
        'Early rust epidemics',
        'Heat stress in livestock',
      ],
    ]])
    expect(provider.composed[0]!.passages[2]!.source).toBe('Grains collection')
  })

  it('numbers passages in the portals order, whichever answers first', async () => {
    const provider = new ComposeProvider({
      fisheries: (config) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new ComposeProvider().search(config, 'q')), 60)
        ),
    })
    const events = await run(provider)
    const completed = ofType(events, 'agent-step').filter((e) => e.status === 'completed')
    expect(completed[0]?.id).toBe('source/grains-col')
    expect(ofType(events, 'citation')[0]).toMatchObject({ marker: '1', chunkId: 'fisheries/f1' })
  })

  it('answers from the rest when a portal fails, and names the failed one', async () => {
    const events = await run(
      new ComposeProvider({ 'grains-col': () => Promise.reject(new Error('Upstream 502')) }),
    )
    const failedStep = ofType(events, 'agent-step').find((e) => e.status === 'failed')
    expect(failedStep).toMatchObject({
      id: 'source/grains-col',
      reason: 'The collection could not be searched.',
    })
    expect(ofType(events, 'sources-failed')).toEqual([{
      type: 'sources-failed',
      sources: [{
        id: 'grains-col',
        label: 'Grains collection',
        portal: 'grains-col',
        kind: 'hosted',
        reason: 'error',
      }],
    }])
    // Announced before the answer, which still cites the other two portals.
    const failedAt = events.findIndex((e) => e.type === 'sources-failed')
    expect(failedAt).toBeLessThan(events.findIndex((e) => e.type === 'delta'))
    expect(new Set(ofType(events, 'citation').map((c) => c.sourceId))).toEqual(
      new Set(['fisheries', 'rural']),
    )
    expect(events.at(-1)?.type).toBe('done')
  })

  it('gives each portal a time limit, and reports one that runs past it as timed out', async () => {
    const started = Date.now()
    const events = await run(
      new ComposeProvider({ rural: () => new Promise(() => {}) }),
      { sourceTimeoutMs: 80 },
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(ofType(events, 'agent-step').find((e) => e.status === 'failed')).toMatchObject({
      id: 'source/rural',
      reason: 'No answer within 80 milliseconds.',
    })
    expect(ofType(events, 'sources-failed')[0]?.sources).toEqual([
      {
        id: 'rural',
        label: 'Rural collection',
        portal: 'rural',
        kind: 'hosted',
        reason: 'timeout',
      },
    ])
    expect(ofType(events, 'citation').length).toBe(3)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('checks every citation against its passage before the reader sees it', async () => {
    const provider = new ComposeProvider({}, () =>
      Promise.resolve(
        // Supported, then cited to the wrong passage, then out of range, then a made-up figure.
        'Oyster mortality events clustered after ten warm days in shallow estuaries. [1] ' +
          'Warm, wet springs brought stripe rust infections forward by three weeks. [4] ' +
          'Shade and reliable water reduced heat stress losses in livestock. [9]\n\n' +
          'Losses fell by 37% across 120 farms. [2]',
      ))
    const events = await run(provider)
    const answer = answerOf(events)
    expect(answer).not.toContain('37%')
    expect(answer).not.toContain('[9]')
    const citations = ofType(events, 'citation')
    // Each surviving marker names a passage that carries its sentence.
    for (const citation of citations) {
      const passage = PASSAGES[citation.sourceId]!.find((p) =>
        citation.chunkId === `${citation.sourceId}/${p.id}`
      )!
      const sentence = answer.split(/(?<=\])\s*/).find((s) => s.includes(`[${citation.marker}]`))!
      expect(passage.text.startsWith(sentence.replace(/\s*\[\d+\]/g, '').slice(0, 30))).toBe(true)
    }
    expect(citations.map((c) => c.chunkId)).toEqual(['fisheries/f1', 'grains-col/g1'])
    const verify = ofType(events, 'agent-step').find((e) =>
      e.id === 'verify' && e.status !== 'started'
    )
    expect(verify?.reason).toMatch(
      /citations? removed.*1 sentence with an unsupported figure removed/,
    )
  })

  it('declines rather than show an answer none of its citations support', async () => {
    const events = await run(
      new ComposeProvider({}, () => Promise.resolve('Nothing here matches a passage. [1]')),
    )
    expect(answerOf(events)).toBe(NO_SUPPORTED_ANSWER)
    expect(ofType(events, 'citation')).toEqual([])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('says so when no portal has a passage, without composing', async () => {
    const empty = () => Promise.resolve({ query: 'q', resources: [], relatedQuestions: [] })
    const provider = new ComposeProvider({ fisheries: empty, 'grains-col': empty, rural: empty })
    const events = await run(provider)
    expect(answerOf(events)).toBe(NO_PASSAGES)
    expect(provider.composed).toEqual([])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('ends with an error when every portal fails', async () => {
    const fail = () => Promise.reject(new Error('down'))
    const provider = new ComposeProvider({ fisheries: fail, 'grains-col': fail, rural: fail })
    const events = await run(provider)
    expect(ofType(events, 'sources-failed')[0]?.sources.length).toBe(3)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'upstream', retryable: true })
    expect(provider.composed).toEqual([])
  })

  it('reports a composition that fails or runs out of time', async () => {
    const failing = await run(new ComposeProvider({}, () => Promise.reject(new Error('412'))))
    expect(ofType(failing, 'agent-step').find((e) => e.id === 'compose' && e.status === 'failed'))
      .toBeDefined()
    expect(failing.at(-1)).toMatchObject({ type: 'error', code: 'upstream' })
    const slow = await run(new ComposeProvider({}, () => new Promise(() => {})), {
      composeTimeoutMs: 50,
    })
    expect(slow.at(-1)).toMatchObject({ type: 'error', code: 'timeout', retryable: true })
  })

  it('leaves out a portal that stopped taking part while its search ran', async () => {
    let grainsParticipates = true
    const provider = new ComposeProvider({
      'grains-col': async (config) => {
        const results = await new ComposeProvider().search(config, 'q')
        grainsParticipates = false
        return results
      },
    })
    const events = await run(provider, {
      stillParticipates: (slug) => slug !== 'grains-col' || grainsParticipates,
    })
    expect(provider.composed[0]!.passages.map((p) => p.source)).not.toContain('Grains collection')
    expect(ofType(events, 'citation').some((c) => c.sourceId === 'grains-col')).toBe(false)
  })

  it('stops as soon as the reader goes away', async () => {
    const reader = new AbortController()
    const provider = new ComposeProvider({ rural: () => new Promise(() => {}) })
    const stream = composeAcross({
      provider,
      host: FISHERIES,
      portals: [FISHERIES, RURAL],
      question: 'q',
      signal: reader.signal,
      sourceTimeoutMs: 60_000,
    })
    const seen: string[] = []
    for await (const event of stream) {
      seen.push(event.type)
      if (event.type === 'agent-sources') reader.abort()
    }
    expect(seen.at(-1)).toBe('agent-sources')
    expect(provider.composed).toEqual([])
  })
})

describe('agentAnswer', () => {
  const options = (provider: DoubleProvider): AgentAnswerOptions => ({
    provider,
    host: FISHERIES,
    portals: [FISHERIES, GRAINS],
    question: 'Why? #fast',
  })

  it("uses the host's agent when it starts, and composes nothing", async () => {
    const provider = new ComposeProvider()
    const events = await collect(agentAnswer(options(provider)))
    expect(events[0]).toMatchObject({ type: 'agent-start', mode: 'agent' })
    expect(events.at(-1)?.type).toBe('done')
    expect(provider.composed).toEqual([])
  })

  it('composes instead when the host has no agent, or its session is refused', async () => {
    for (
      const refusal of [
        new AgentAskError('not_configured', 'No agent'),
        new Error('Session refused (503)'),
      ]
    ) {
      const provider = Object.assign(new ComposeProvider(), {
        // deno-lint-ignore require-yield
        agentAsk: async function* () {
          throw refusal
        },
      })
      const events = await collect(agentAnswer(options(provider)))
      expect(events[0]).toMatchObject({ type: 'agent-start', mode: 'orchestrated' })
      expect(provider.composed.length).toBe(1)
    }
  })

  it('reports an agent failure as it is when there is no composer to fall back on', async () => {
    const provider = Object.assign(new DoubleProvider(), {
      agentAsk: () => {
        throw new AgentAskError('not_configured', 'No agent')
      },
      compose: undefined,
    })
    await expect(collect(agentAnswer(options(provider)))).rejects.toThrow(AgentAskError)
  })
})
