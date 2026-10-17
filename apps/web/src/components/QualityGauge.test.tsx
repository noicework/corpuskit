import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnswerAudit } from '../lib/answer-marks.ts'
import { createPortalLocale, PortalLocaleContext } from '../lib/portal-locale.tsx'
import { AnswerQualityDisclosure, type QualityScores } from './QualityGauge.tsx'

const VERIFIED: AnswerAudit = {
  figuresChecked: 1,
  figuresUnsupported: [],
  yearsUnsupported: [],
  contraindicationsUnsupported: [],
}

Deno.test('the confidence badge shows every verdict and keeps its complete accessible name', () => {
  const good: QualityScores = { answerRelevance: 4.5, groundedness: 4.5, contextRelevance: 4 }
  const cases = [
    { quality: null, audit: undefined, state: 'unscored', label: 'Confidence not scored' },
    {
      quality: { ...good, groundedness: 1 },
      audit: undefined,
      state: 'low',
      label: 'Low confidence',
    },
    { quality: good, audit: undefined, state: 'moderate', label: 'Moderate confidence' },
    { quality: good, audit: VERIFIED, state: 'high', label: 'High confidence' },
  ]
  for (const { quality, audit, state, label } of cases) {
    const html = renderToStaticMarkup(<AnswerQualityDisclosure quality={quality} audit={audit} />)
    expect(html).toContain(`data-confidence="${state}"`)
    expect(html).toContain(`aria-label="${label}. Answer quality details."`)
    expect(html).toContain(`title="${label} - answer quality"`)
    expect(html).toContain(`>${label}</span>`)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/<button /g)?.length).toBe(1)
    expect(html).not.toContain('role="dialog"')
  }
})

Deno.test('confidence localisation includes the visible verdict and its accessible name', () => {
  const html = renderToStaticMarkup(
    <PortalLocaleContext.Provider value={createPortalLocale('ja')}>
      <AnswerQualityDisclosure quality={null} audit={VERIFIED} />
    </PortalLocaleContext.Provider>,
  )
  expect(html).toContain('data-confidence="high"')
  expect(html).toContain('aria-label="信頼度が高い。回答の品質の詳細。"')
  expect(html).toContain('title="信頼度が高い - 回答の品質"')
  expect(html).toContain('>信頼度が高い</span>')
})
