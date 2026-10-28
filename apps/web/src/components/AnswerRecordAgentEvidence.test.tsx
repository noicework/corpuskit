import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnswerRecord, AnswerRecordPassage } from '@research-portal/core'
import { AnswerRecordAgentEvidence } from './AnswerRecordAgentEvidence.tsx'
import { Passages } from '../pages/AnswerRecordPage.tsx'

function fixture(): AnswerRecord {
  return {
    version: 1,
    answerId: '00000000-0000-4000-8000-000000000001',
    at: '2026-10-28T00:00:00.000Z',
    portal: 'waters',
    surface: 'composed',
    question: 'How are coastal habitats changing?',
    status: 'answered',
    retrievalQueries: [],
    retrieved: [],
    cited: [],
    verification: {
      citationsSeen: 0,
      citationsDropped: 0,
      sentencesChecked: null,
      sentencesCited: null,
      sentencesDropped: 0,
      figuresDropped: [],
      unsupportedFigures: [],
      unsupportedYears: [],
      unsupportedContraindications: [],
      outcome: 'not_reported',
    },
    generation: {
      modelId: null,
      buildId: null,
      configurationIds: [],
      promptHashes: [],
      depth: 'default',
      images: false,
      topK: null,
      maxTokens: null,
    },
    quality: { answerRelevance: null, groundedness: null, contextRelevance: null },
    timing: {
      durationMs: 0,
      providerTotalSec: null,
      firstChunkSec: null,
      inputTokens: null,
      outputTokens: null,
    },
    calls: [],
    truncated: false,
    agent: {
      mode: 'orchestrated',
      sources: [
        { id: 'waters', label: 'Southern Waters Research Portal', kind: 'hosted', transport: 'kb' },
        { id: 'peer:soil', label: 'Soil Research Hub', kind: 'peer', transport: 'mcp' },
      ],
      steps: [{
        id: 'source/waters',
        module: 'search',
        title: 'Searching Southern Waters Research Portal',
        status: 'completed',
        durationMs: 0,
      }],
      lookups: [{ stepId: 'source/waters', sourceId: 'waters', question: 'Coastal habitats?' }],
      failedSources: [],
      citationCheck: 'not_reported',
      citationDecisions: [{ marker: '1', outcome: 'kept' }],
    },
  }
}

Deno.test('agent evidence uses plain labels and keeps step identifiers inside details', () => {
  const record = fixture()
  const before = JSON.stringify(record)
  const html = renderToStaticMarkup(<AnswerRecordAgentEvidence record={record} />)
  for (
    const label of [
      'Mode: Composed by the portal',
      'Hosted collection',
      'Partner collection',
      'Knowledge box search',
      'MCP server',
      'Searching Southern Waters Research Portal',
      'Completed · 0 ms',
    ]
  ) expect(html).toContain(label)
  expect(html).toMatch(/<details>.*Step details.*source\/waters · search.*<\/details>/)
  expect(html).not.toContain('(source/waters):')
  expect(html).not.toContain('Unknown')
  expect(JSON.stringify(record)).toBe(before)
  record.agent!.mode = 'agent'
  expect(renderToStaticMarkup(<AnswerRecordAgentEvidence record={record} />)).toContain(
    'Mode: Answered by the agent',
  )
})

Deno.test('missing agent fields are hidden and audit gaps are disclosed once per section', () => {
  const record = fixture()
  record.agent!.mode = null
  record.agent!.sources = record.agent!.sources.map((source) => ({
    ...source,
    kind: null,
    transport: null,
  }))
  record.agent!.steps[0]!.durationMs = null
  record.agent!.citationDecisions.push({ marker: '2', outcome: 'kept' })
  const html = renderToStaticMarkup(<AnswerRecordAgentEvidence record={record} />)
  expect(html).not.toContain('Mode:')
  expect(html).not.toContain('Unknown')
  expect(html).not.toContain('Not reported')
  expect(html.match(/This source does not report rejected citations\./g)).toHaveLength(1)
  expect(html.match(/Some sources do not report their collection type or connection method\./g))
    .toHaveLength(1)
})

Deno.test('passages hide unknown page and score, retain zero scores and show the step title', () => {
  const record = fixture()
  const unknown: AnswerRecordPassage = {
    resourceId: 'coastal-report',
    title: 'Coastal habitats',
    text: '',
    page: null,
    score: null,
    scoreScope: 'unknown',
    stepId: 'source/waters',
  }
  const before = JSON.stringify(unknown)
  const html = renderToStaticMarkup(
    <Passages
      title='Passages retrieved'
      passages={[unknown, unknown]}
      steps={record.agent!.steps}
    />,
  )
  expect(html).not.toContain('Page:')
  expect(html).not.toContain('Score:')
  expect(html).not.toContain('Unknown')
  expect(html).not.toContain('unknown')
  expect(html).toContain('Step: Searching Southern Waters Research Portal')
  expect(html).toContain('title="source/waters"')
  expect(html.match(/Some sources do not report passage text\./g)).toHaveLength(1)
  const scored = renderToStaticMarkup(
    <Passages title='Passages retrieved' passages={[{ ...unknown, page: 3, score: 0 }]} />,
  )
  expect(scored).toContain('Page: 3')
  expect(scored).toContain('Score: 0')
  expect(scored).not.toContain('(unknown)')
  const resource = renderToStaticMarkup(
    <Passages
      title='Passages retrieved'
      passages={[{ ...unknown, score: 0.8, scoreScope: 'resource' }]}
    />,
  )
  expect(resource).toContain('Score: 0.8 (Resource relevance)')
  expect(JSON.stringify(unknown)).toBe(before)
})
