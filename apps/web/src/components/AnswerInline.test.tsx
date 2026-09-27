import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { AskEvent, ScoredResource } from '@research-portal/core'
import { applyAnswerEvent, EMPTY_ANSWER, type StreamedAnswer } from '../lib/answer-trust.ts'
import { AnswerText, AuditBadge } from './AnswerInline.tsx'
import { AnswerQualityDisclosure, ConfidenceIndicator } from './QualityGauge.tsx'

const RESOURCE: ScoredResource = {
  id: 'res-1',
  title: 'Abalone stock health',
  summary: 'Stock health.',
  type: 'pdf',
  topicIds: [],
  keyFacts: [],
  relevance: 0.9,
  citedCount: 1,
  matchedPassage: 'Abalone fell 12% after 2019.',
  matchedPage: 3,
}

const FINAL_TEXT = 'Abalone fell 12% after 2019 [1]. The first survey ran in 1987 [2].\n\n' +
  '*One sentence was removed because no retrieved passage carries its figures beside the ' +
  'claim (40%).*'

/** One `/ask` stream, in the order the server sends it (docs/TRUST-LAYER.md, section 8). */
function stream(audit: Partial<Extract<AskEvent, { type: 'audit' }>>): AskEvent[] {
  return [
    { type: 'stage', stage: 'retrieval', status: 'started' },
    { type: 'sources', resources: [RESOURCE] },
    { type: 'delta', text: 'Abalone fell 12% after 2019 [1]. ' },
    { type: 'delta', text: 'The first survey ran in 1987 [2]. It fell 40% [3].' },
    { type: 'stage', stage: 'auditing', status: 'started', figures: 4 },
    { type: 'stage', stage: 'auditing', status: 'completed' },
    { type: 'sources', resources: [RESOURCE] },
    {
      type: 'citation',
      citation: { index: 1, resourceId: 'res-1', title: 'Abalone stock health' },
    },
    {
      type: 'citation',
      citation: { index: 2, resourceId: 'res-1', title: 'Abalone stock health' },
    },
    // A repeated citation event is the same marker, never a second one.
    {
      type: 'citation',
      citation: { index: 2, resourceId: 'res-1', title: 'Abalone stock health' },
    },
    {
      type: 'audit',
      figuresChecked: 2,
      figuresUnsupported: [],
      yearsUnsupported: [],
      contraindicationsUnsupported: [],
      sentencesChecked: 3,
      sentencesCited: 2,
      sentencesRemoved: 1,
      figuresRemoved: ['40%'],
      figuresSecondhandRemoved: ['7%'],
      denominatorsCorrected: ['12% (n = 40)'],
      ...audit,
    },
    { type: 'done', refused: false, text: FINAL_TEXT, truncated: true },
    { type: 'stage', stage: 'validating', status: 'started' },
    { type: 'quality', answerRelevance: 4.6, groundedness: 4.5, contextRelevance: 4.4 },
  ]
}

function fold(events: AskEvent[]): StreamedAnswer {
  return events.reduce(applyAnswerEvent, EMPTY_ANSWER)
}

/** The confidence state each surface's own control reports for the answer. */
function confidenceOnEachSurface(answer: StreamedAnswer): { search: string; ask: string } {
  const state = (markup: string) => /data-confidence="([a-z]+)"/.exec(markup)?.[1] ?? 'missing'
  return {
    search: state(
      renderToStaticMarkup(<ConfidenceIndicator quality={answer.quality} audit={answer.audit} />),
    ),
    ask: state(
      renderToStaticMarkup(
        <AnswerQualityDisclosure quality={answer.quality} audit={answer.audit} />,
      ),
    ),
  }
}

function renderAnswer(answer: StreamedAnswer, streaming = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnswerText
        text={answer.text}
        citations={answer.citations}
        sources={answer.sources}
        slug='marine'
        audit={answer.audit}
        streaming={streaming}
      />
    </MemoryRouter>,
  )
}

const marks = (markup: string) =>
  [...markup.matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1])

describe('the answer Ask and Search fold from one stream', () => {
  it('keeps every audit field, the gated text and the truncation', () => {
    const answer = fold(stream({ yearsUnsupported: ['1987'] }))
    expect(answer.text).toBe(FINAL_TEXT)
    expect(answer.truncated).toBe(true)
    expect(answer.refused).toBe(false)
    expect(answer.citations.map((citation) => citation.index)).toEqual([1, 2])
    expect(answer.audit).toEqual({
      figuresChecked: 2,
      figuresUnsupported: [],
      yearsUnsupported: ['1987'],
      contraindicationsUnsupported: [],
      sentencesChecked: 3,
      sentencesCited: 2,
      denominatorsMissing: [],
      attributionsCorrected: [],
      sentencesRemoved: 1,
      figuresRemoved: ['40%'],
      figuresRescued: [],
      sentencesReplaced: 0,
      figuresSecondhandRemoved: ['7%'],
      denominatorsCorrected: ['12% (n = 40)'],
    })
    expect(answer.quality).toEqual({
      answerRelevance: 4.6,
      groundedness: 4.5,
      contextRelevance: 4.4,
    })
  })

  it('reads Low on both surfaces when the audit could not verify a year', () => {
    // The platform scores this answer 4.5 for groundedness; before the audit
    // reached Search, Search called it Moderate while Ask called it Low.
    expect(confidenceOnEachSurface(fold(stream({ yearsUnsupported: ['1987'] })))).toEqual({
      search: 'low',
      ask: 'low',
    })
  })

  it('reaches High on both surfaces only when the audit verified every figure', () => {
    const verified = stream({ sentencesRemoved: 0, figuresRemoved: [], sentencesCited: 3 })
    expect(confidenceOnEachSurface(fold(verified))).toEqual({ search: 'high', ask: 'high' })
    // The same scores without an audit stay Moderate: High is earned by the check alone.
    const unaudited = fold(verified.filter((event) => event.type !== 'audit'))
    expect(confidenceOnEachSurface(unaudited)).toEqual({ search: 'moderate', ask: 'moderate' })
  })

  it('marks the unverified figure and keeps the removal note', () => {
    const markup = renderAnswer(fold(stream({ yearsUnsupported: ['1987'] })))
    expect(marks(markup)).toEqual(['1987'])
    expect(markup).toContain('Not found beside this claim in the cited passages')
    expect(markup).toMatch(/<em[^>]*><span>One sentence was removed because/)
    expect([...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/t/marine/library/res-1?passage=Abalone%20fell%2012%25%20after%202019.&amp;page=3',
      '/t/marine/library/res-1?passage=Abalone%20fell%2012%25%20after%202019.&amp;page=3',
    ])
  })

  it('shows no provisional marker while the answer streams', () => {
    const streamed = fold(stream({}).slice(0, 4))
    expect(streamed.citations).toEqual([])
    const markup = renderAnswer(streamed, true)
    expect(markup).not.toContain('[1]')
    expect(markup).not.toContain('[3]')
    expect(markup).toContain('It fell 40%')
  })

  it('names what the audit could not verify on the badge', () => {
    const markup = renderToStaticMarkup(
      <AuditBadge audit={fold(stream({ yearsUnsupported: ['1987'] })).audit} />,
    )
    expect(markup).toContain('data-audit-badge')
    expect(markup).toContain('unverified')
    expect(markup).toContain('Years the cited resources do not carry: 1987.')
  })

  it('treats a malformed audit as no audit: never a crash, never High', () => {
    const malformed = [
      // The lists missing altogether.
      { type: 'audit', figuresChecked: 2 },
      // A count that is not a number.
      {
        type: 'audit',
        figuresChecked: '2',
        figuresUnsupported: [],
        yearsUnsupported: [],
        contraindicationsUnsupported: [],
      },
      // A list that holds something other than figures.
      {
        type: 'audit',
        figuresChecked: 1,
        figuresUnsupported: [{ figure: '12%' }],
        yearsUnsupported: [],
        contraindicationsUnsupported: [],
      },
    ] as unknown as AskEvent[]
    for (const event of malformed) {
      const answer = fold([
        { type: 'delta', text: 'Abalone fell 12% after 2019.' },
        event,
        { type: 'done', refused: false, text: 'Abalone fell 12% after 2019.' },
        { type: 'quality', answerRelevance: 4.8, groundedness: 4.8, contextRelevance: 4.8 },
      ])
      expect(answer.audit).toBeUndefined()
      // With no audit the platform score decides, and it never reaches High on its own.
      expect(confidenceOnEachSurface(answer)).toEqual({ search: 'moderate', ask: 'moderate' })
      expect(marks(renderAnswer(answer))).toEqual([])
      expect(renderToStaticMarkup(<AuditBadge audit={answer.audit} />)).toBe('')
    }
    // A malformed audit after a good one withdraws it rather than keeping a stale verdict.
    const withdrawn = fold([...stream({ yearsUnsupported: ['1987'] }), malformed[0]!])
    expect(withdrawn.audit).toBeUndefined()
  })

  it('starts a fresh answer when the server falls back to another configuration', () => {
    const answer = fold([
      { type: 'sources', resources: [RESOURCE] },
      { type: 'delta', text: 'The data sheets hold no answer.' },
      { type: 'fallback', from: 'data', to: null, reason: 'Nothing usable.' },
      { type: 'delta', text: 'Abalone fell 12% after 2019.' },
    ])
    expect(answer.text).toBe('Abalone fell 12% after 2019.')
    expect(answer.sources).toEqual([])
  })
})

describe('both research surfaces fold and render through the shared modules', () => {
  it('Ask and Search each read the stream with applyAnswerEvent and draw it with AnswerText', async () => {
    for (const file of ['../pages/AskPage.tsx', './SearchAnswer.tsx']) {
      const source = await Deno.readTextFile(new URL(file, import.meta.url))
      expect(source).toContain('applyAnswerEvent(')
      expect(source).toContain('<AnswerText')
      expect(source).toContain('<AuditBadge')
      expect(source).toContain('<TruncatedNotice')
      expect(source).not.toMatch(/function renderCitationMarkers|function renderInline/)
    }
    const search = await Deno.readTextFile(new URL('./SearchAnswer.tsx', import.meta.url))
    expect(search).toContain('<ConfidenceIndicator quality={quality} audit={audit} />')
  })
})
