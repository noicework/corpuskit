import { expect } from '@std/expect'
import type { AgentAskEvent } from '@research-portal/core'
import {
  activeStep,
  type AgentAskState,
  applyAgentAskEvent,
  chunkHref,
  citationHref,
  citationNumbers,
  citedSources,
  clockLabel,
  contributingSources,
  durationLabel,
  endAgentAsk,
  expectedStepCount,
  initialAgentAskState,
  phaseOf,
  sourceKindLabel,
  sourceState,
  splitAnswerMarkers,
  stepTotal,
} from './agent-ask-state.ts'

const fisheries = { id: 'drv-fisheries', label: 'Fisheries research' }
const grains = { id: 'drv-grains', label: 'Grains research' }
const marine = {
  id: 'marine',
  label: 'Southern Waters Research Portal',
  portal: 'marine',
  kind: 'hosted',
} as const
const soil = {
  id: 'peer:soil-partner',
  label: 'Soil partner collection',
  kind: 'peer',
  transport: 'kb',
} as const
const water = {
  id: 'peer:water-partner',
  label: 'Water partner collection',
  kind: 'peer',
  transport: 'mcp',
} as const

function fold(events: AgentAskEvent[], clock = () => 1000): AgentAskState {
  let state = initialAgentAskState()
  for (const event of events) state = applyAgentAskEvent(state, event, clock())
  return state
}

Deno.test('agent-start names the mode and every source before anything is searched', () => {
  const state = fold([{ type: 'agent-start', mode: 'agent', sources: [fisheries, grains] }])
  expect(state.status).toBe('streaming')
  expect(state.mode).toBe('agent')
  expect(state.sources.map((group) => group.source.id)).toEqual(['drv-fisheries', 'drv-grains'])
  expect(state.sources.map((group) => sourceState(group, state.steps))).toEqual([
    'queued',
    'queued',
  ])
})

Deno.test('steps open once, close at most once, and carry the agent reason', () => {
  let now = 0
  const state = fold([
    { type: 'agent-start', mode: 'agent', sources: [fisheries] },
    {
      type: 'agent-step',
      id: 'preprocess/rephrase',
      module: 'rephrase',
      title: 'Understanding the question',
      status: 'started',
    },
    {
      type: 'agent-step',
      id: 'preprocess/rephrase',
      module: 'rephrase',
      title: 'Understanding the question',
      status: 'started',
    },
    {
      type: 'agent-step',
      id: 'preprocess/rephrase',
      module: 'rephrase',
      title: 'Understanding the question',
      status: 'completed',
      elapsedMs: 3050,
      reason: 'Restated per collection.',
    },
    {
      type: 'agent-step',
      id: 'preprocess/rephrase',
      module: 'rephrase',
      title: 'Understanding the question',
      status: 'failed',
      elapsedMs: 9,
    },
    {
      type: 'agent-step',
      id: 'context/ctx-fisheries',
      module: 'basic_ask',
      title: 'Searching Fisheries research',
      status: 'started',
    },
  ], () => now += 500)
  expect(state.steps).toHaveLength(2)
  expect(state.steps[0]).toMatchObject({
    status: 'completed',
    elapsedMs: 3050,
    reason: 'Restated per collection.',
    phase: 'preparing',
  })
  expect(state.steps[1]).toMatchObject({ status: 'started', phase: 'searching' })
  expect(activeStep(state.steps)?.id).toBe('context/ctx-fisheries')
  // The open lookup is this source's: its title names the source.
  expect(sourceState(state.sources[0]!, state.steps)).toBe('searching')
})

Deno.test('a step closed without opening is still shown as having run', () => {
  const state = fold([
    { type: 'agent-start', mode: 'agent', sources: [] },
    {
      type: 'agent-step',
      id: 'postprocess/rerank',
      module: 'rerank',
      title: 'Ranking',
      status: 'completed',
      elapsedMs: 4300,
    },
  ])
  expect(state.steps).toEqual([
    expect.objectContaining({
      id: 'postprocess/rerank',
      status: 'completed',
      elapsedMs: 4300,
      phase: 'checking',
    }),
  ])
})

Deno.test('passages group by source across lookups, including a second lookup of the same source', () => {
  const chunk = (id: string, title: string) => ({
    id,
    title,
    text: `${title} text`,
    url: `https://example.org/${id}.pdf`,
  })
  const state = fold([
    { type: 'agent-start', mode: 'agent', sources: [fisheries, grains] },
    {
      type: 'agent-step',
      id: 'context/ctx-fisheries',
      module: 'basic_ask',
      title: 'Searching Fisheries research',
      status: 'started',
    },
    {
      type: 'agent-step',
      id: 'context/ctx-fisheries',
      module: 'basic_ask',
      title: 'Searching Fisheries research',
      status: 'completed',
      elapsedMs: 18500,
    },
    {
      type: 'agent-sources',
      stepId: 'context/ctx-fisheries',
      source: fisheries,
      question: 'How are warmer waters changing disease pressure?',
      chunks: [chunk('a', 'Oysters'), chunk('b', 'Triggers')],
    },
    {
      type: 'agent-sources',
      stepId: 'context/ctx-fisheries-2',
      source: fisheries,
      question: 'What about leases?',
      chunks: [chunk('c', 'Leases')],
    },
    // A source the start never announced is appended rather than lost.
    {
      type: 'agent-sources',
      stepId: 'context/extra',
      source: { id: 'drv-extra', label: 'Extra' },
      chunks: [chunk('d', 'Extra passage')],
    },
  ])
  expect(state.sources.map((group) => group.source.id)).toEqual([
    'drv-fisheries',
    'drv-grains',
    'drv-extra',
  ])
  const group = state.sources[0]!
  expect(group.lookups.map((lookup) => [lookup.question, lookup.chunks.length])).toEqual([
    ['How are warmer waters changing disease pressure?', 2],
    ['What about leases?', 1],
  ])
  expect(sourceState(group, state.steps)).toBe('found')
  expect(sourceState(state.sources[1]!, state.steps)).toBe('queued')
  expect(contributingSources(state).map((item) => item.source.id)).toEqual([
    'drv-fisheries',
    'drv-extra',
  ])
})

Deno.test('sources-failed marks the named sources and keeps the notice, with every reason', () => {
  const state = fold([
    {
      type: 'agent-start',
      mode: 'orchestrated',
      sources: [
        marine,
        {
          id: 'grains',
          label: 'Dryland Cropping Research Portal',
          portal: 'grains',
          kind: 'hosted',
        },
        soil,
        water,
      ],
    },
    {
      type: 'sources-failed',
      sources: [
        {
          id: 'grains',
          label: 'Dryland Cropping Research Portal',
          portal: 'grains',
          kind: 'hosted',
          reason: 'timeout',
        },
        { ...water, reason: 'unauthorised' },
      ],
    },
  ])
  expect(state.failedSources.map((source) => [source.id, source.reason])).toEqual([
    ['grains', 'timeout'],
    ['peer:water-partner', 'unauthorised'],
  ])
  expect(state.sources.map((group) => sourceState(group, state.steps))).toEqual([
    'queued',
    'failed',
    'queued',
    'failed',
  ])
  expect(sourceKindLabel(marine)).toBeUndefined()
  expect(sourceKindLabel(soil)).toBe('federated partner')
  expect(sourceKindLabel(water)).toBe('partner over MCP')
})

Deno.test('reasoning accumulates into runs closed by last; the stream end flushes an open run', () => {
  const state = fold([
    { type: 'agent-start', mode: 'agent', sources: [] },
    { type: 'reasoning', text: 'The question spans ', last: false },
    { type: 'reasoning', text: 'three collections.', last: true },
    { type: 'reasoning', text: 'Still thinking', last: false },
  ])
  expect(state.reasoning).toEqual(['The question spans three collections.'])
  expect(state.reasoningOpen).toBe('Still thinking')
  const done = applyAgentAskEvent(state, { type: 'done', elapsedMs: 10 }, 0)
  expect(done.reasoning).toEqual(['The question spans three collections.', 'Still thinking'])
  expect(done.reasoningOpen).toBe('')
})

Deno.test('done closes open steps as completed and error closes them as failed, keeping what arrived', () => {
  const events: AgentAskEvent[] = [
    { type: 'agent-start', mode: 'agent', sources: [fisheries] },
    {
      type: 'agent-step',
      id: 'generate/answer',
      module: 'generation',
      title: 'Writing the answer',
      status: 'started',
    },
    { type: 'delta', text: 'Warmer water ' },
    { type: 'delta', text: 'raises disease pressure [block-AA].' },
    {
      type: 'citation',
      marker: 'block-AA',
      sourceId: 'drv-fisheries',
      chunkId: 'x',
      title: 'Oysters',
      url: 'https://example.org/x.pdf',
    },
    {
      type: 'citation',
      marker: 'block-AA',
      sourceId: 'drv-fisheries',
      chunkId: 'x',
      title: 'Oysters',
      url: 'https://example.org/x.pdf',
    },
  ]
  let now = 0
  const streaming = fold(events, () => now += 1000)
  const done = applyAgentAskEvent(streaming, { type: 'done', elapsedMs: 89_800 }, 9000)
  expect(done.status).toBe('done')
  expect(done.elapsedMs).toBe(89_800)
  expect(done.steps[0]).toMatchObject({ status: 'completed', elapsedMs: 7000 })
  expect(done.text).toBe('Warmer water raises disease pressure [block-AA].')
  expect(done.citations).toHaveLength(1)

  // The server's citation-checked text replaces the provisional deltas.
  const checked = applyAgentAskEvent(streaming, {
    type: 'done',
    elapsedMs: 89_800,
    text: 'Warmer water raises disease pressure.',
  }, 9000)
  expect(checked.text).toBe('Warmer water raises disease pressure.')

  const failed = applyAgentAskEvent(streaming, {
    type: 'error',
    code: 'upstream',
    message: 'The agent stopped.',
    retryable: true,
  }, 9000)
  expect(failed.status).toBe('error')
  expect(failed.steps[0]).toMatchObject({ status: 'failed' })
  expect(failed.text).toBe('Warmer water raises disease pressure [block-AA].')
  expect(failed.error).toEqual({ code: 'upstream', message: 'The agent stopped.', retryable: true })
})

Deno.test('the reader ending the stream keeps what arrived', () => {
  let now = 0
  const streaming = fold([
    { type: 'agent-start', mode: 'agent', sources: [fisheries] },
    {
      type: 'agent-step',
      id: 'preprocess/plan',
      module: 'planner',
      title: 'Planning',
      status: 'started',
    },
    { type: 'reasoning', text: 'Half a thought', last: false },
  ], () => now += 100)
  const cancelled = endAgentAsk(streaming, { code: 'cancelled' }, 5000)
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.error).toBeNull()
  expect(cancelled.steps[0]).toMatchObject({ status: 'failed' })
  expect(cancelled.reasoning).toEqual(['Half a thought'])
  const timedOut = endAgentAsk(streaming, {
    code: 'timeout',
    message: 'No answer within five minutes.',
  }, 5000)
  expect(timedOut.status).toBe('error')
  expect(timedOut.error).toEqual({
    code: 'timeout',
    message: 'No answer within five minutes.',
    retryable: true,
  })
  // A stream already over is left alone.
  const done = applyAgentAskEvent(streaming, { type: 'done', elapsedMs: 1 }, 0)
  expect(endAgentAsk(done, { code: 'cancelled' }, 0)).toBe(done)
})

Deno.test('markers number by first appearance, agent or composed, and keep their number before the citation lands', () => {
  const agent =
    'In fisheries [block-AB]. In grains [block-AA], again [block-AB]. Unknown [block-ZZ].'
  const numbers = citationNumbers(agent, [
    { marker: 'block-AA', sourceId: 'g', chunkId: 'c', title: 'Rust' },
    { marker: 'block-AC', sourceId: 'r', chunkId: 'd', title: 'Never mentioned' },
  ])
  expect([...numbers.entries()]).toEqual([['block-AB', 1], ['block-AA', 2], ['block-ZZ', 3], [
    'block-AC',
    4,
  ]])
  expect([...citationNumbers('Composed [1] then [2] and [1] again.', []).entries()]).toEqual([[
    '1',
    1,
  ], ['2', 2]])
  expect(splitAnswerMarkers('Start [block-AA], middle [2] end.')).toEqual([
    { kind: 'text', text: 'Start ' },
    { kind: 'marker', marker: 'block-AA' },
    { kind: 'text', text: ', middle ' },
    { kind: 'marker', marker: '2' },
    { kind: 'text', text: ' end.' },
  ])
  expect(splitAnswerMarkers('No markers [inference] here.')).toEqual([{
    kind: 'text',
    text: 'No markers [inference] here.',
  }])
})

Deno.test('passages link to their own address, else the portal resource, and a partner passage to nothing', () => {
  expect(chunkHref(marine, { url: 'https://example.org/a.pdf', resourceId: 'res-1' })).toBe(
    'https://example.org/a.pdf',
  )
  expect(chunkHref(marine, { resourceId: 'res fish/1' })).toBe('/t/marine/library/res%20fish%2F1')
  expect(chunkHref(fisheries, { resourceId: 'res-1' })).toBeUndefined()
  expect(chunkHref(soil, { resourceId: 'soil-01' })).toBeUndefined()
  const state = fold([
    { type: 'agent-start', mode: 'orchestrated', sources: [marine, soil] },
    {
      type: 'agent-sources',
      stepId: 'source/marine',
      source: marine,
      chunks: [{
        id: 'marine/res-fish-0412',
        title: 'Oysters',
        text: 't',
        resourceId: 'res-fish-0412',
      }],
    },
    {
      type: 'agent-sources',
      stepId: 'source/peer:soil-partner',
      source: soil,
      chunks: [{ id: 'peer:soil-partner/soil-01', title: 'Soil moisture', text: 't' }],
    },
    {
      type: 'citation',
      marker: '1',
      sourceId: 'marine',
      chunkId: 'marine/res-fish-0412',
      title: 'Oysters',
    },
    {
      type: 'citation',
      marker: '2',
      sourceId: 'peer:soil-partner',
      chunkId: 'peer:soil-partner/soil-01',
      title: 'Soil moisture',
    },
    { type: 'citation', marker: '3', sourceId: 'marine', chunkId: 'never-seen', title: 'Lost' },
  ])
  expect(citationHref(state, state.citations[0]!)).toBe('/t/marine/library/res-fish-0412')
  expect(citationHref(state, state.citations[1]!)).toBeUndefined()
  expect(citationHref(state, state.citations[2]!)).toBeUndefined()
  expect(citedSources(state).map((group) => group.source.id)).toEqual([
    'marine',
    'peer:soil-partner',
  ])
})

Deno.test('phases come from the id prefix, then the module', () => {
  expect(phaseOf({ id: 'preprocess/rephrase', module: 'x' })).toBe('preparing')
  expect(phaseOf({ id: 'context/ctx-a/summary', module: 'summarize' })).toBe('summarising')
  expect(phaseOf({ id: 'odd', module: 'summarize' })).toBe('summarising')
  expect(phaseOf({ id: 'context/ctx-a', module: 'basic_ask' })).toBe('searching')
  expect(phaseOf({ id: 'source/marine', module: 'search' })).toBe('searching')
  expect(phaseOf({ id: 'postprocess/coverage', module: 'validation' })).toBe('checking')
  expect(phaseOf({ id: 'verify', module: 'verify' })).toBe('checking')
  expect(phaseOf({ id: 'compose', module: 'compose' })).toBe('writing')
  expect(phaseOf({ id: 'generate/answer', module: 'generation' })).toBe('writing')
  expect(phaseOf({ id: 'odd', module: 'rerank' })).toBe('checking')
  expect(phaseOf({ id: 'odd', module: 'unknown' })).toBe('preparing')
})

Deno.test('the step count starts from what agent-start promises and ends on what happened', () => {
  expect(expectedStepCount(null, 3)).toBe(0)
  expect(expectedStepCount('agent', 3)).toBe(11)
  expect(expectedStepCount('orchestrated', 3)).toBe(5)
  const started = fold([{ type: 'agent-start', mode: 'agent', sources: [fisheries, grains, soil] }])
  expect(stepTotal(started)).toBe(11)
  // More steps than the baseline: the count grows with them.
  let busy = started
  for (let index = 0; index < 12; index++) {
    busy = applyAgentAskEvent(
      busy,
      { type: 'agent-step', id: `s${index}`, module: 'x', title: 'Step', status: 'started' },
      0,
    )
  }
  expect(stepTotal(busy)).toBe(12)
  // Fewer than the baseline when the stream ends: the real count, never a promise unmet.
  const short = applyAgentAskEvent(
    applyAgentAskEvent(
      started,
      { type: 'agent-step', id: 'only', module: 'x', title: 'Step', status: 'started' },
      0,
    ),
    { type: 'done', elapsedMs: 1 },
    0,
  )
  expect(stepTotal(short)).toBe(1)
})

Deno.test('durations read as a person says them', () => {
  expect(clockLabel(0)).toBe('0:00')
  expect(clockLabel(65_400)).toBe('1:05')
  expect(durationLabel(3050)).toBe('3.1 s')
  expect(durationLabel(18_500)).toBe('19 s')
  expect(durationLabel(60_000)).toBe('1 min')
  expect(durationLabel(89_800)).toBe('1 min 30 s')
  expect(durationLabel(4300, { seconds: '秒', minutes: '分' })).toBe('4.3 秒')
})
