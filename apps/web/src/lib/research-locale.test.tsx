import { expect } from '@std/expect'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createPortalLocale, PortalLocaleContext } from './portal-locale.tsx'
import { referenceListHtml } from './answer-export.ts'
import { AnswerText } from '../components/AnswerInline.tsx'
import { AssessmentQuiz } from '../components/AssessmentQuiz.tsx'
import { bylineFor } from '../components/Byline.tsx'
import { CurrencyNote } from '../components/CurrencyNote.tsx'
import { evidenceSummary, openLabel } from '../components/EvidenceTable.tsx'
import { auditSummary } from '../components/QualityGauge.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { cardinalityLabel } from '../pages/TaxonomyPage.tsx'
import type { ReactNode } from 'react'

function render(language: 'ja' | 'en', content: ReactNode): string {
  return renderToString(
    <PortalLocaleContext.Provider value={createPortalLocale(language)}>
      <MemoryRouter>{content}</MemoryRouter>
    </PortalLocaleContext.Provider>,
  )
}

Deno.test('research display helpers translate application labels and retain exact English defaults', () => {
  const { ui } = createPortalLocale('ja')
  expect(openLabel('pdf', 4)).toBe('Open PDF in the reader at page 4')
  expect(openLabel('pdf', 4, false, ui)).toBe('PDFの4ページを閲覧画面で開く')
  expect(evidenceSummary([{ id: 'a', title: 'Library', published: '2020' }], 1, ui))
    .toBe('取得1件 · 引用1件 · 2020')
  expect(cardinalityLabel({ multiple: false }, {}, 0, ui)).toBe('資料ごとに1つの値')
  expect(bylineFor({ authors: ['Library', 'Summary', 'Ask', 'Save'], journal: 'Summary' }, ui))
    .toEqual(['Library, Summary, Askほか', 'Summary'])
  expect(bylineFor({ authors: ['Library', 'Summary', 'Ask', 'Save'], journal: 'Summary' }))
    .toEqual(['Library, Summary, Ask et al.', 'Summary'])
})

Deno.test('Japanese citations preserve known catalog keys as source titles, body, IDs and literal braces', () => {
  const citations = [{ index: 1, resourceId: 'Library', title: 'Summary {count}' }]
  const html = render(
    'ja',
    (
      <AnswerText
        text='Library **Summary** {count} [1]'
        citations={citations}
        sources={[]}
        slug='Summary'
        streaming={false}
      />
    ),
  )
  expect(html).toContain('Library')
  expect(html).toContain('<strong><span>Summary</span></strong>')
  expect(html).toContain('{count}')
  expect(html).toContain('資料1、Summary {count}')
  expect(html).toContain('/t/Summary/library/Library')
  expect(html).not.toContain('<strong>要約</strong>')
  const exported = referenceListHtml(
    citations,
    [],
    (id) => `/t/Summary/library/${id}`,
    createPortalLocale('ja').ui,
  )
  expect(exported).toContain('<h3>参考資料</h3>')
  expect(exported).toContain('Summary {count}')
  expect(exported).toContain('/t/Summary/library/Library')
  expect(exported).toContain('ポータルで開く')
  expect(referenceListHtml(citations, [], (id) => `/t/Summary/library/${id}`))
    .toContain('<h3>References</h3>')
})

Deno.test('Japanese reader placeholder labels never translate an authored override', () => {
  expect(render('ja', <ResourceThumb slug='portal' id='Library' type='document' />)).toContain(
    '資料',
  )
  const html = render(
    'ja',
    <ResourceThumb slug='portal' id='Library' type='document' label='Summary' />,
  )
  expect(html).toContain('>Summary</span>')
  expect(html).not.toContain('>要約</span>')
})

Deno.test('quiz interface localises complete warnings while generated research stays verbatim', () => {
  const data = {
    requested: 3,
    omitted_questions: 1,
    questions: [{
      question: 'Summary {count}',
      options: ['Library', 'Save'],
      correct_index: 0,
      explanation: 'Original English evidence, 日本語の根拠。',
      topic: 'Summary',
      source_title: 'Library',
    }],
  }
  const ja = render('ja', <AssessmentQuiz data={data} />)
  expect(ja).toContain('指定した3問中1問が出典の検証に合格しました。')
  expect(ja).toContain(
    '原資料の報告内容ではなく参考文献一覧に基づく設問だったため、1問を除外しました。',
  )
  expect(ja).toContain('Summary {count}')
  expect(ja).toContain('Library')
  expect(ja).toContain('解答を提出')
  const en = render('en', <AssessmentQuiz data={data} />)
  expect(en).toContain('One of the 3 questions asked for survived the source check.')
  expect(en).toContain('Submit answers')
})

Deno.test('research confidence and source dates preserve numeric meaning across UI languages', () => {
  const audit = {
    figuresChecked: 1,
    figuresUnsupported: [],
    yearsUnsupported: [],
    contraindicationsUnsupported: [],
    sentencesChecked: 2,
    sentencesCited: 1,
  }
  expect(auditSummary(audit)).toBe(
    '1 figure found beside its claim in the cited passages; 1 of 2 sentences carry a citation.',
  )
  expect(auditSummary(audit, createPortalLocale('ja').ui))
    .toBe('引用本文の主張の近くで1個の数値を確認; 全2文中1文に出典あり.')
  const html = render('ja', <CurrencyNote sources={[{ published: '1998', title: 'Summary' }]} />)
  expect(html).toContain('引用資料の最新年：1998')
  expect(html).toContain('この回答は1998年までの資料に基づいており')
})
