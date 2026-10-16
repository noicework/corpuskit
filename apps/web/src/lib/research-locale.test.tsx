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
import { sessionToWordHtml } from '../pages/AskPage.tsx'
import { tenantCopy } from './tenant-copy.ts'
import { suggestedTopicChips } from './generate-suggestions.ts'
import { SectionHeading } from '../pages/ExplorePage.tsx'
import type { ReactNode } from 'react'

function render(language: 'ja' | 'en', content: ReactNode): string {
  return renderToString(
    <PortalLocaleContext.Provider value={createPortalLocale(language)}>
      <MemoryRouter>{content}</MemoryRouter>
    </PortalLocaleContext.Provider>,
  )
}

Deno.test('research prompt scaffolding translates while authored topics, questions and overrides stay exact', () => {
  const locale = createPortalLocale('ja')
  const topics = [{ id: 'Library', label: 'Summary {count}' }, { id: 'Summary', label: 'Library' }]
  const config = { topics, suggestedQuestions: [{ id: 'original', text: 'Library {name}' }] }
  const copy = tenantCopy(config, locale)
  expect(copy.investigationExample).toBe('例: Library {name}')
  expect(copy.generateExample('comparison')).toBe('例: Summary {count}とLibraryを比較する')
  expect(copy.generateExample('briefing')).toBe('例: Summary {count}の現状をまとめる')
  expect(copy.generateExample('timeline')).toBe('例: Libraryに関する研究の年表')
  expect(copy.generateExample('proscons')).toBe('例: Summary {count}の主な手法の長所と短所')
  expect(copy.generateExample('faq')).toBe('例: Libraryに関するよくある質問')
  expect(copy.generateExample('assessment')).toBe('例: Summary {count}の基礎知識を確認する')
  expect(suggestedTopicChips('comparison', topics, locale.ui)).toEqual([{
    key: 'Library::Summary',
    text: 'Summary {count}とLibraryを比較する',
  }])
  for (
    const [kind, expected] of [
      ['briefing', 'Summary {count}についてまとめる'],
      ['timeline', 'Summary {count}の年表'],
      ['proscons', 'Summary {count}の長所と短所'],
      ['faq', 'Summary {count}に関するよくある質問'],
      ['assessment', 'Summary {count}の知識を確認する'],
    ] as const
  ) {
    expect(suggestedTopicChips(kind, topics, locale.ui)[0]).toEqual({
      key: 'Library',
      text: expected,
    })
  }
  const overrides = tenantCopy({
    ...config,
    copy: { investigationExample: 'Summary', generateExamples: { comparison: 'Library' } },
  }, locale)
  expect(overrides.investigationExample).toBe('Summary')
  expect(overrides.generateExample('comparison')).toBe('Library')
  const empty = tenantCopy({ topics: [], suggestedQuestions: [] }, locale)
  expect(empty.generateExample('comparison')).toBe('例: 研究資料にある2つの手法を比較する')
  expect(empty.generateExample('briefing')).toBe('例: 研究資料のトピックの現状をまとめる')
  expect(tenantCopy(config).generateExample('comparison')).toBe(
    'e.g. Compare summary {count} with library',
  )
})

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

Deno.test('Explore topic headings preserve exact authored catalog keys and braces', () => {
  for (const label of ['Library', 'Summary', 'Summary {count}']) {
    const html = render(
      'ja',
      <SectionHeading slug='portal' topicId='Library' label={label} count={2} />,
    )
    expect(html).toContain(`>${label}</h2>`)
    expect(html).toContain('すべて見る')
    expect(html).toContain('/t/portal/library?topic=Library')
  }
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

Deno.test('retained Ask export errors follow the current locale without translating research text', () => {
  const messages = [
    { id: 'q', author: 'USER' as const, text: 'Library {name}', citations: [], sources: [] },
    { id: 'a', author: 'AGENT' as const, text: 'Summary', citations: [], sources: [] },
    {
      id: 'e',
      author: 'AGENT' as const,
      text: '',
      error: 'Upstream English diagnostic',
      citations: [],
      sources: [],
    },
    {
      id: 'known',
      author: 'AGENT' as const,
      text: '',
      error: 'Stopped before an answer arrived.',
      citations: [],
      sources: [],
    },
  ]
  const ja = sessionToWordHtml(
    'Library',
    'Summary',
    messages,
    (id) => `/source/${id}`,
    createPortalLocale('ja').ui,
    'ja',
  )
  expect(ja).toContain('<h1>Library</h1>')
  expect(ja).toContain('<h2>Library {name}</h2>')
  expect(ja).toContain('Summary')
  expect(ja).toContain('回答サービスを利用できません。')
  expect(ja).toContain('回答が届く前に停止しました。')
  expect(ja).not.toContain('Upstream English diagnostic')
  const en = sessionToWordHtml('Library', 'Summary', messages, (id) => `/source/${id}`)
  expect(en).toContain('Upstream English diagnostic')
  expect(en).toContain('Stopped before an answer arrived.')
})
