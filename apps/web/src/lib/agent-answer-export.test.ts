import { expect } from '@std/expect'
import type { AgentAskEvent } from '@research-portal/core'
import {
  agentAnswerHtml,
  agentReferencesHtml,
  agentTrailTitle,
  agentTrailToWordHtml,
  agentTurnHtml,
  applyAgentEvent,
  collectAgentAnswer,
  collectionsLine,
  emptyAgentAnswer,
  hasExportableAnswer,
  hasExportableTurn,
  numberCitations,
  referenceGroups,
  renumberedText,
  writerLine,
} from './agent-answer-export.ts'
import { createPortalLocale } from './portal-locale.tsx'

const portalUrl = (portal: string, id: string) => `https://portal.test/t/${portal}/library/${id}`

/** An agent's answer: two collections, `[block-XX]` markers, passages with their own addresses. */
const AGENT_EVENTS: AgentAskEvent[] = [
  {
    type: 'agent-start',
    mode: 'agent',
    sources: [
      { id: 'drv-marine', label: 'Marine research' },
      { id: 'drv-grains', label: 'Grains research' },
    ],
  },
  {
    type: 'agent-step',
    id: 'context/ctx-marine',
    module: 'basic_ask',
    title: 'Searching Marine research',
    status: 'started',
  },
  { type: 'reasoning', text: 'Two collections bear on this. ', last: true },
  {
    type: 'agent-sources',
    stepId: 'context/ctx-marine',
    source: { id: 'drv-marine', label: 'Marine research' },
    question: 'How are warmer waters changing disease pressure?',
    chunks: [
      {
        id: 'res-fish-0412/f/file/0-218',
        title: 'Summer mortality in farmed oysters: a ten-year review',
        text: 'Mortality events clustered in the warmest fortnight.',
        url: 'https://example.org/fish/res-fish-0412.pdf',
      },
      {
        id: 'res-fish-0099/f/file/0-10',
        title: 'Heat stress thresholds in cultured abalone',
        text: 'Feeding stopped above 24 degrees.',
      },
    ],
  },
  {
    type: 'agent-sources',
    stepId: 'context/ctx-grains',
    source: { id: 'drv-grains', label: 'Grains research' },
    chunks: [
      {
        id: 'res-grain-0007/f/file/0-3',
        title: 'Russian wheat aphid range expansion under warming',
        text: 'The aphid overwintered further south each year.',
        url: 'https://example.org/grains/res-grain-0007.pdf',
      },
    ],
  },
  { type: 'delta', text: 'In fisheries, warmer water is linked to ' },
  {
    type: 'delta',
    text:
      'more disease outbreaks [block-AB] and feeding stops above 24 degrees [block-AA]. Pests overwinter further south [block-AC], as earlier reviews found [16,17] and [block-ZZ].\n\n- Outbreaks cluster in the warmest fortnight [block-AB]',
  },
  {
    type: 'citation',
    marker: 'block-AA',
    sourceId: 'drv-marine',
    chunkId: 'res-fish-0099/f/file/0-10',
    title: 'Heat stress thresholds in cultured abalone',
  },
  {
    type: 'citation',
    marker: 'block-AB',
    sourceId: 'drv-marine',
    chunkId: 'res-fish-0412/f/file/0-218',
    title: 'Summer mortality in farmed oysters: a ten-year review',
    url: 'https://example.org/fish/res-fish-0412.pdf',
  },
  {
    type: 'citation',
    marker: 'block-AC',
    sourceId: 'drv-grains',
    chunkId: 'res-grain-0007/f/file/0-3',
    title: 'Russian wheat aphid range expansion under warming',
    url: 'https://example.org/grains/res-grain-0007.pdf',
  },
  { type: 'done', elapsedMs: 89_800 },
]

/** A composed answer: sources are portals, one timed out, citations name the portal slug. */
const COMPOSED_EVENTS: AgentAskEvent[] = [
  {
    type: 'agent-start',
    mode: 'orchestrated',
    sources: [
      { id: 'marine', label: 'Southern Waters Research Portal', portal: 'marine' },
      { id: 'grains', label: 'Dryland Cropping Research Portal', portal: 'grains' },
      { id: 'rural', label: 'Rural Industries Research Portal', portal: 'rural' },
    ],
  },
  {
    type: 'agent-sources',
    stepId: 'source/marine',
    source: { id: 'marine', label: 'Southern Waters Research Portal', portal: 'marine' },
    chunks: [
      {
        id: 'marine/res-fish-0412',
        title: 'Summer mortality in farmed oysters: a ten-year review',
        text: 'Mortality events clustered in the warmest fortnight.',
        resourceId: 'res-fish-0412',
      },
    ],
  },
  {
    type: 'agent-sources',
    stepId: 'source/rural',
    source: { id: 'rural', label: 'Rural Industries Research Portal', portal: 'rural' },
    chunks: [
      {
        id: 'rural/res-rural-0001',
        title: 'Heat load in pastured poultry',
        text: 'Laying fell in heatwaves.',
        resourceId: 'res-rural-0001',
      },
      {
        id: 'rural/res-rural-0002',
        title: 'Shade and water for free-range flocks',
        text: 'Shade halved the loss.',
        resourceId: 'res-rural-0002',
      },
    ],
  },
  {
    type: 'sources-failed',
    sources: [
      {
        id: 'grains',
        label: 'Dryland Cropping Research Portal',
        portal: 'grains',
        reason: 'timeout',
      },
    ],
  },
  {
    type: 'delta',
    text: 'Mortality events in farmed oysters clustered in the warmest fortnight.[1]',
  },
  { type: 'delta', text: ' Laying fell during heatwaves.[2]\n\n' },
  {
    type: 'citation',
    marker: '1',
    sourceId: 'marine',
    chunkId: 'marine/res-fish-0412',
    title: 'Summer mortality in farmed oysters: a ten-year review',
  },
  {
    type: 'citation',
    marker: '2',
    sourceId: 'rural',
    chunkId: 'rural/res-rural-0001',
    title: 'Heat load in pastured poultry',
  },
  { type: 'done', elapsedMs: 18_030 },
]

/** A composed answer over the host and two federated partners, one of which refused its key. */
const PEER_EVENTS: AgentAskEvent[] = [
  {
    type: 'agent-start',
    mode: 'orchestrated',
    sources: [
      { id: 'marine', label: 'Southern Waters Research Portal', portal: 'marine', kind: 'hosted' },
      { id: 'peer:partner-a', label: 'Partner A research', kind: 'peer', transport: 'kb' },
      { id: 'peer:partner-b', label: 'Partner B research', kind: 'peer', transport: 'mcp' },
    ],
  },
  {
    type: 'agent-sources',
    stepId: 'source/marine',
    source: {
      id: 'marine',
      label: 'Southern Waters Research Portal',
      portal: 'marine',
      kind: 'hosted',
    },
    chunks: [
      {
        id: 'marine/res-fish-0412',
        title: 'Summer mortality in farmed oysters: a ten-year review',
        text: 'Mortality events clustered in the warmest fortnight.',
        resourceId: 'res-fish-0412',
      },
    ],
  },
  {
    type: 'agent-sources',
    stepId: 'source/peer:partner-a',
    source: { id: 'peer:partner-a', label: 'Partner A research', kind: 'peer', transport: 'kb' },
    chunks: [
      {
        id: 'peer:partner-a/doc-7/0',
        title: 'Heat stress in hatchery stock',
        text: '  Larval survival fell  sharply\nabove 26 degrees in every trial year.  ',
      },
    ],
  },
  {
    type: 'sources-failed',
    sources: [
      {
        id: 'peer:partner-b',
        label: 'Partner B research',
        kind: 'peer',
        transport: 'mcp',
        reason: 'unauthorised',
      },
    ],
  },
  {
    type: 'delta',
    text:
      'Oyster mortality follows the warmest fortnight.[1] Hatchery survival falls above 26 degrees.[2]',
  },
  {
    type: 'citation',
    marker: '1',
    sourceId: 'marine',
    chunkId: 'marine/res-fish-0412',
    title: 'Summer mortality in farmed oysters: a ten-year review',
  },
  {
    type: 'citation',
    marker: '2',
    sourceId: 'peer:partner-a',
    chunkId: 'peer:partner-a/doc-7/0',
    title: 'Heat stress in hatchery stock',
  },
  { type: 'done', elapsedMs: 9_000 },
]

const QUESTION = 'How is a warmer climate changing pest and disease pressure?'

Deno.test('the events fold into one record: sources, passages, failures, text and citations', () => {
  const record = collectAgentAnswer(QUESTION, COMPOSED_EVENTS)
  expect(record.mode).toBe('orchestrated')
  expect(record.sources.map((source) => source.id)).toEqual(['marine', 'grains', 'rural'])
  expect(record.passages['marine']).toHaveLength(1)
  expect(record.passages['rural']).toHaveLength(2)
  expect(record.passages['grains']).toBeUndefined()
  expect(record.failed).toEqual([
    {
      id: 'grains',
      label: 'Dryland Cropping Research Portal',
      portal: 'grains',
      reason: 'timeout',
    },
  ])
  expect(record.text).toContain('warmest fortnight.[1] Laying fell')
  expect(record.citations.map((citation) => citation.marker)).toEqual(['1', '2'])
  expect(record.status).toBe('done')
  expect(hasExportableAnswer(record)).toBe(true)
})

Deno.test('a repeated passage is held once and an unannounced source joins the list', () => {
  let record = emptyAgentAnswer(QUESTION)
  const sources: AgentAskEvent = {
    type: 'agent-sources',
    stepId: 'context/late',
    source: { id: 'drv-late', label: 'Late source' },
    chunks: [{ id: 'c1', title: 'One', text: '...' }],
  }
  record = applyAgentEvent(record, sources)
  record = applyAgentEvent(record, sources)
  expect(record.sources).toEqual([{ id: 'drv-late', label: 'Late source' }])
  expect(record.passages['drv-late']).toHaveLength(1)
  // Steps and reasoning change nothing the brief keeps.
  const before = record
  record = applyAgentEvent(record, { type: 'reasoning', text: 'Hmm', last: true })
  expect(record).toEqual(before)
})

Deno.test('a stream that ends in an error, or has not finished, is not exportable', () => {
  const failed = collectAgentAnswer(QUESTION, [
    AGENT_EVENTS[0]!,
    { type: 'delta', text: 'Half an answer' },
    {
      type: 'error',
      code: 'upstream',
      message: 'The agent stopped before an answer.',
      retryable: true,
    },
  ])
  expect(failed.status).toBe('error')
  expect(failed.error).toEqual({ code: 'upstream', message: 'The agent stopped before an answer.' })
  expect(hasExportableAnswer(failed)).toBe(false)
  const streaming = collectAgentAnswer(QUESTION, AGENT_EVENTS.slice(0, -1))
  expect(hasExportableAnswer(streaming)).toBe(false)
  expect(hasExportableTurn([failed, streaming])).toBe(false)
  expect(hasExportableTurn([failed, collectAgentAnswer(QUESTION, AGENT_EVENTS)])).toBe(true)
})

Deno.test('agent markers are numbered by first appearance and rewritten in the text', () => {
  const record = collectAgentAnswer(QUESTION, AGENT_EVENTS)
  const numbered = numberCitations(record)
  expect(numbered.map((citation) => [citation.number, citation.marker])).toEqual([
    [1, 'block-AB'],
    [2, 'block-AA'],
    [3, 'block-AC'],
  ])
  const text = renumberedText(record, numbered)
  expect(text).toContain('more disease outbreaks [1] and feeding stops above 24 degrees [2].')
  expect(text).toContain('further south [3], as earlier reviews found [16,17] and .')
  expect(text).toContain('warmest fortnight [1]')
  expect(text).not.toContain('block-')
})

Deno.test('a citation whose marker never appears closes the numbering', () => {
  const record = collectAgentAnswer(QUESTION, [
    ...COMPOSED_EVENTS.slice(0, -1),
    {
      type: 'citation',
      marker: '9',
      sourceId: 'marine',
      chunkId: 'marine/res-fish-0412',
      title: 'Extra',
    },
    { type: 'done', elapsedMs: 1 },
  ])
  expect(numberCitations(record).map((citation) => [citation.number, citation.marker])).toEqual([
    [1, '1'],
    [2, '2'],
    [3, '9'],
  ])
})

Deno.test('the answer body renders through the block parser with numbered superscripts', () => {
  const html = agentAnswerHtml(collectAgentAnswer(QUESTION, AGENT_EVENTS))
  expect(html).toContain(
    'more disease outbreaks <sup>[1]</sup> and feeding stops above 24 degrees <sup>[2]</sup>.',
  )
  expect(html).toContain(
    '<ul><li>Outbreaks cluster in the warmest fortnight <sup>[1]</sup></li></ul>',
  )
  // The paper's own bracketed numbers are dropped, as on the page, and the unresolved marker is gone.
  expect(html).not.toContain('[16,17]')
  expect(html).not.toContain('block-ZZ')
})

Deno.test('references group by collection in announcement order, linking to passages or portal resources', () => {
  const agent = referenceGroups(collectAgentAnswer(QUESTION, AGENT_EVENTS), portalUrl)
  expect(agent.map((group) => group.source.label)).toEqual(['Marine research', 'Grains research'])
  expect(agent[0]!.entries.map((entry) => [entry.number, entry.href, entry.portalLink])).toEqual([
    [1, 'https://example.org/fish/res-fish-0412.pdf', false],
    [2, undefined, false],
  ])
  // A passage with nothing to open is quoted in the entry; a linked one is not.
  expect(agent[0]!.entries[0]!.passage).toBeUndefined()
  expect(agent[0]!.entries[1]!.passage).toBe('Feeding stopped above 24 degrees.')
  expect(agent[1]!.entries.map((entry) => entry.number)).toEqual([3])

  const composed = referenceGroups(collectAgentAnswer(QUESTION, COMPOSED_EVENTS), portalUrl)
  // The portal that timed out has no group; the uncited rural passage is not a reference.
  expect(composed.map((group) => group.source.label)).toEqual([
    'Southern Waters Research Portal',
    'Rural Industries Research Portal',
  ])
  expect(composed[0]!.entries[0]).toMatchObject({
    number: 1,
    href: 'https://portal.test/t/marine/library/res-fish-0412',
    portalLink: true,
  })
  expect(composed[1]!.entries[0]).toMatchObject({
    number: 2,
    href: 'https://portal.test/t/rural/library/res-rural-0001',
    portalLink: true,
  })
})

Deno.test('a citation from a collection the stream never announced is grouped under its id', () => {
  const record = collectAgentAnswer(QUESTION, [
    ...AGENT_EVENTS.slice(0, -1),
    { type: 'citation', marker: 'block-AD', sourceId: 'drv-ghost', chunkId: 'g1', title: 'Ghost' },
    { type: 'done', elapsedMs: 1 },
  ])
  const groups = referenceGroups(record, portalUrl)
  expect(groups.map((group) => group.source.id)).toEqual(['drv-marine', 'drv-grains', 'drv-ghost'])
  expect(groups[2]!.source.label).toBe('drv-ghost')
})

Deno.test('the reference section names failed collections and says why', () => {
  const html = agentReferencesHtml(collectAgentAnswer(QUESTION, COMPOSED_EVENTS), portalUrl)
  expect(html).toContain('<h3>References</h3>')
  expect(html).toContain(
    '<h4>Southern Waters Research Portal</h4><p>[1] <em>Summer mortality in farmed oysters: a ten-year review</em>. <a href="https://portal.test/t/marine/library/res-fish-0412">Open in the portal</a>.</p>',
  )
  expect(html).toContain(
    '<h4>Rural Industries Research Portal</h4><p>[2] <em>Heat load in pastured poultry</em>.',
  )
  expect(html).toContain(
    '<h4>Collections not searched</h4><ul><li>Dryland Cropping Research Portal - No answer within the time limit</li></ul>',
  )
  expect(html.indexOf('Rural Industries')).toBeLessThan(html.indexOf('Collections not searched'))

  const agentHtml = agentReferencesHtml(collectAgentAnswer(QUESTION, AGENT_EVENTS), portalUrl)
  // An outside address is printed in full so it survives on paper; a passage with none has title only.
  expect(agentHtml).toContain(
    '<a href="https://example.org/fish/res-fish-0412.pdf">https://example.org/fish/res-fish-0412.pdf</a>.',
  )
  expect(agentHtml).toContain(
    '<p>[2] <em>Heat stress thresholds in cultured abalone</em>.</p><blockquote>Feeding stopped above 24 degrees.</blockquote>',
  )
  expect(agentHtml).not.toContain('Collections not searched')

  expect(agentReferencesHtml(emptyAgentAnswer(QUESTION), portalUrl)).toBe('')
})

Deno.test('a federated partner is named by its transport, its passage quoted with no link, and a refused key explained', () => {
  const record = collectAgentAnswer(QUESTION, PEER_EVENTS)
  expect(collectionsLine(record)).toBe(
    'Southern Waters Research Portal (1 passage) \u00b7 Partner A research (federated partner, 1 passage) \u00b7 Partner B research (partner over MCP, This partner could not be reached)',
  )
  const html = agentReferencesHtml(record, portalUrl)
  expect(html).toContain(
    '<h4>Southern Waters Research Portal</h4><p>[1] <em>Summer mortality in farmed oysters: a ten-year review</em>. <a href="https://portal.test/t/marine/library/res-fish-0412">Open in the portal</a>.</p>',
  )
  expect(html).toContain(
    '<h4>Partner A research (federated partner)</h4><p>[2] <em>Heat stress in hatchery stock</em>.</p><blockquote>Larval survival fell sharply above 26 degrees in every trial year.</blockquote>',
  )
  expect(html).toContain(
    '<h4>Collections not searched</h4><ul><li>Partner B research (partner over MCP) - This partner could not be reached</li></ul>',
  )
  // The partner entry has no link at all.
  const partner = html.slice(html.indexOf('<h4>Partner A'), html.indexOf('<h4>Collections'))
  expect(partner).not.toContain('<a ')
  // A partner that allows origin links gets the link and no quoted passage.
  const linked = collectAgentAnswer(
    QUESTION,
    PEER_EVENTS.map((event) =>
      event.type === 'citation' && event.marker === '2'
        ? { ...event, url: 'https://partner-a.example/doc-7' }
        : event
    ),
  )
  const linkedHtml = agentReferencesHtml(linked, portalUrl)
  expect(linkedHtml).toContain(
    '<a href="https://partner-a.example/doc-7">https://partner-a.example/doc-7</a>.</p>',
  )
  expect(linkedHtml).not.toContain('<blockquote>')
})

Deno.test('the writer and collections lines say who answered and what each collection gave', () => {
  const composed = collectAgentAnswer(QUESTION, COMPOSED_EVENTS)
  expect(writerLine(composed, 'CorpusKit')).toBe('Composed by CorpusKit across 3 collections')
  expect(collectionsLine(composed)).toBe(
    'Southern Waters Research Portal (1 passage) · Dryland Cropping Research Portal (No answer within the time limit) · Rural Industries Research Portal (2 passages)',
  )
  const agent = collectAgentAnswer(QUESTION, AGENT_EVENTS)
  expect(writerLine(agent, 'CorpusKit')).toBe('Answered by a retrieval agent across 2 collections')
  expect(writerLine({ ...agent, sources: agent.sources.slice(0, 1) }, 'CorpusKit')).toBe(
    'Answered by a retrieval agent from one collection',
  )
  expect(writerLine({ ...composed, sources: [] }, 'CorpusKit')).toBe('Composed by CorpusKit')
})

Deno.test('a turn that failed is written as unavailable with the portal wording', () => {
  const failed = collectAgentAnswer('Why?', [
    {
      type: 'error',
      code: 'timeout',
      message: 'Stopped before an answer arrived.',
      retryable: true,
    },
  ])
  const en = agentTurnHtml(failed, 'CorpusKit', portalUrl)
  expect(en).toBe(
    '<h2>Why?</h2><p><em>Answer unavailable - Stopped before an answer arrived.</em></p>',
  )
  const ja = agentTurnHtml(failed, 'CorpusKit', portalUrl, createPortalLocale('ja').ui, 'ja')
  expect(ja).toContain('回答が届く前に停止しました。')
  expect(ja).not.toContain('Stopped before')
})

Deno.test('the whole brief is a Word document: portal, date, each turn with its references', () => {
  const turns = [
    collectAgentAnswer(QUESTION, COMPOSED_EVENTS),
    collectAgentAnswer('And for poultry?', AGENT_EVENTS),
  ]
  const html = agentTrailToWordHtml(
    'Research Portal',
    agentTrailTitle(turns),
    turns,
    portalUrl,
    undefined,
    'en',
    new Date('2026-10-28T09:00:00Z'),
  )
  expect(html.startsWith('<html xmlns:o="urn:schemas-microsoft-com:office:office"')).toBe(true)
  expect(html).toContain('<w:WordDocument>')
  expect(html).toContain(`<title>${QUESTION}</title>`)
  expect(html).toContain('<h1>Research Portal</h1>')
  expect(html).toContain(`<p>${QUESTION} &middot; Evidence brief &middot; 28 October 2026</p>`)
  expect(html).toContain(
    `<h2>${QUESTION}</h2><p><em>Composed by Research Portal across 3 collections</em></p>`,
  )
  expect(html).toContain('<p>Collections: Southern Waters Research Portal (1 passage)')
  expect(html).toContain(
    '<h2>And for poultry?</h2><p><em>Answered by a retrieval agent across 2 collections</em></p>',
  )
  // Two turns, two reference sections, in order.
  expect(html.split('<h3>References</h3>')).toHaveLength(3)
  expect(html.indexOf('Collections not searched')).toBeLessThan(html.indexOf('And for poultry?'))
  // Nothing authored leaks unescaped.
  const spiky = collectAgentAnswer('<b>Q</b> & "A"', [
    { type: 'delta', text: 'Yes <script>alert(1)</script>' },
    { type: 'done', elapsedMs: 1 },
  ])
  const escaped = agentTrailToWordHtml('P', '<t>', [spiky], portalUrl)
  expect(escaped).toContain('<h2>&lt;b&gt;Q&lt;/b&gt; &amp; &quot;A&quot;</h2>')
  expect(escaped).toContain('Yes &lt;script&gt;')
  expect(escaped).toContain('<title>&lt;t&gt;</title>')
})

Deno.test('the brief translates its own copy and leaves authored text alone', () => {
  const { ui } = createPortalLocale('ja')
  const turns = [collectAgentAnswer(QUESTION, COMPOSED_EVENTS)]
  const html = agentTrailToWordHtml('Portal', 'Summary', turns, portalUrl, ui, 'ja')
  expect(html).toContain('参考資料')
  expect(html).toContain('ポータルで開く')
  expect(html).toContain('Southern Waters Research Portal')
  expect(html).toContain(QUESTION)
  expect(html).not.toContain('Composed by')
  expect(html).not.toContain('Collections not searched')
  expect(html).not.toContain('Open in the portal')
  expect(html).not.toContain('References')
})

Deno.test('the trail title is the first question, cut to a line', () => {
  expect(agentTrailTitle([emptyAgentAnswer('  Short?  ')])).toBe('Short?')
  const long = 'A '.repeat(60).trim()
  expect(agentTrailTitle([emptyAgentAnswer(''), emptyAgentAnswer(long)])).toHaveLength(80)
  expect(agentTrailTitle([])).toBe('')
})
