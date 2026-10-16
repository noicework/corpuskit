import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { askError } from '../api/client.ts'
import { AnswerErrorCard } from './AskPage.tsx'

const MESSAGE = 'This trial has used its questions. Talk to us about keeping it.'

Deno.test('a question refused by the portal limit shows the portal message as a notice, with no countdown', async () => {
  const error = await askError(
    Response.json({
      error: 'ask_quota_exceeded',
      limit: 0,
      resetsAt: '2026-10-17T00:00:00.000Z',
      message: MESSAGE,
    }, { status: 429 }),
    'Unavailable',
  )
  const html = renderToStaticMarkup(
    <AnswerErrorCard
      message={error.message}
      rateLimited={false}
      limitReached={error.code === 'ask_quota_exceeded'}
      onRetry={() => {}}
    />,
  )
  expect(html).toContain('Question limit reached')
  expect(html).toContain(MESSAGE.replace("'", '&#x27;'))
  expect(html).not.toContain('Something went wrong')
  expect(html).not.toContain('Retrying in')
  expect(html).not.toContain('Try again after')
  expect(html).toContain('var(--rp-warn-bg)')
  expect(html).toContain('rp-btn-outline')
})

Deno.test('a failed answer and a busy portal keep their own cards', () => {
  const failed = renderToStaticMarkup(
    <AnswerErrorCard message='The answer failed.' rateLimited={false} onRetry={() => {}} />,
  )
  expect(failed).toContain('Something went wrong')
  expect(failed).toContain('var(--rp-bad-bg)')
  const busy = renderToStaticMarkup(
    <AnswerErrorCard message='Busy.' rateLimited retryAfterSec={5} onRetry={() => {}} />,
  )
  expect(busy).toContain('The portal is busy')
  expect(busy).toContain('Retrying in')
})
