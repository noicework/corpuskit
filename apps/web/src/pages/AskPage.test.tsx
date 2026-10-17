import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CopyAnswer,
  FeedbackControl,
  FeedbackStatusMessage,
  QuestionHeading,
  sessionHeading,
  UserBubble,
} from './AskPage.tsx'

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

Deno.test('a restored automatic session title expands to the whole first question', () => {
  expect(sessionHeading({ messages: [question] })).toBe(question.text)
  expect(sessionHeading({
    messages: [question],
    title: `${question.text.slice(0, 60)}…`,
  })).toBe(question.text)
})

Deno.test('a renamed session keeps its name and the first question remains in the conversation', () => {
  const heading = sessionHeading({ messages: [question], title: 'Southern coast recovery' })
  expect(heading).toBe('Southern coast recovery')
  const html = renderToStaticMarkup(
    <UserBubble
      message={question}
      showQuestion={heading !== question.text}
      onAskSubquery={() => {}}
    />,
  )
  expect(html).toContain(question.text)
})

Deno.test('submitted ratings remain focusable with the selected thumb exposed', () => {
  for (const good of [true, false]) {
    const html = renderToStaticMarkup(
      <FeedbackControl
        message={{
          ...question,
          learningId: 'answer-learning',
          feedbackSubmitted: true,
          feedbackGood: good,
        }}
        onFeedback={() => Promise.resolve(true)}
        onStatus={() => {}}
      />,
    )
    expect(html.match(/<button /g)?.length).toBe(2)
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(2)
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1)
    expect(html).not.toMatch(/\sdisabled=/)
    expect(html).not.toContain('tabindex="-1"')
  }
})

Deno.test('feedback live regions exist before feedback and retain their semantics for success and errors', () => {
  for (
    const status of [null, { text: 'Thanks - your feedback was sent.' }, {
      text: 'Could not send feedback - try again.',
      error: true,
    }]
  ) {
    const html = renderToStaticMarkup(<FeedbackStatusMessage status={status} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    if (status) expect(html).toContain(status.text)
    if (status?.error) expect(html).toContain('text-[var(--rp-bad-ink)]')
  }
})

Deno.test('copy is an action with an existing live region rather than a pressed toggle', () => {
  const html = renderToStaticMarkup(<CopyAnswer text='Abalone recovery evidence.' />)
  expect(html).toContain('aria-label="Copy the answer"')
  expect(html).toContain('role="status"')
  expect(html).not.toContain('aria-pressed')
})

Deno.test('session export shares the question action row', () => {
  const html = renderToStaticMarkup(
    <QuestionHeading question={question.text} actions={<button type='button'>Export</button>} />,
  )
  expect(html).toContain('rp-answer-question-actions')
  expect(html).toContain('>Export</button></div>')
})
