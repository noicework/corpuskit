import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuestionHeading, UserBubble } from './AskPage.tsx'

const question = {
  id: 'first-question',
  author: 'USER' as const,
  text:
    'How are marine heatwaves affecting abalone populations along the southern coast, and which monitored reefs show recovery after the longest warm periods?',
  citations: [],
  sources: [],
}

Deno.test('the question heading keeps the full question rather than the shortened session title', () => {
  const html = renderToStaticMarkup(<QuestionHeading question={question.text} />)
  expect(html).toContain(question.text)
  expect(html).toContain('<h1')
  expect(html).toContain('rp-answer-question-clamped')
  expect(html).not.toContain('…')
  // An overflow control is added only after the browser measures an actual overflow.
  expect(html).not.toContain('aria-expanded')
})

Deno.test('the first question is not repeated in a bubble once it is the heading', () => {
  const html = renderToStaticMarkup(
    <UserBubble message={question} showQuestion={false} onAskSubquery={() => {}} />,
  )
  expect(html).toBe('')
})

Deno.test('removing the first question bubble preserves its researched sub-questions', () => {
  const subquery = 'Which reefs have the longest heatwave records?'
  const html = renderToStaticMarkup(
    <UserBubble
      message={{ ...question, subqueries: [subquery] }}
      showQuestion={false}
      onAskSubquery={() => {}}
    />,
  )
  expect(html).not.toContain(question.text)
  expect(html).toContain(subquery)
  expect(html).toContain('Searched for 1 sub-questions')
  expect(html).toContain('<button')
})

Deno.test('subsequent questions still appear in their own full bubbles', () => {
  const html = renderToStaticMarkup(
    <UserBubble message={question} onAskSubquery={() => {}} />,
  )
  expect(html).toContain(question.text)
  expect(html).not.toContain('rp-answer-question-clamped')
})
