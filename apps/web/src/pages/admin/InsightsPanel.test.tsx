import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { AnswerFeedbackSummary } from '../../api/client.ts'
import { UnhelpfulAnswers } from './InsightsPanel.tsx'

function render(feedback: AnswerFeedbackSummary): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <UnhelpfulAnswers slug='marine' feedback={feedback} />
    </MemoryRouter>,
  )
}

const now = new Date().toISOString()

describe('Insights: answers marked unhelpful', () => {
  it('lists each flagged answer with the reader comment and a way to ask it again', () => {
    const markup = render({
      helpful: 2,
      unhelpful: 2,
      flagged: [
        {
          question: 'What caused the 2019 abalone decline?',
          askedAt: now,
          ratedAt: now,
          comment: 'It gave the year as 1987. <script>alert(1)</script>',
        },
        { question: 'Which heatwave?', askedAt: now, ratedAt: now, comment: null },
      ],
    })
    expect(markup).toContain('2 of 4 rated answers marked unhelpful')
    expect(markup).toContain('What caused the 2019 abalone decline?')
    expect(markup).toMatch(/<blockquote[^>]*>It gave the year as 1987\./)
    // A reader's words are shown as text, never as markup.
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('No comment left.')
    expect(markup).toContain(
      'href="/t/marine/ask?ask=What%20caused%20the%202019%20abalone%20decline%3F"',
    )
    expect(markup).toContain('aria-label="Ask again: Which heatwave?"')
    expect(markup).toContain('Marked unhelpful just now')
  })

  it('says so when nothing has been marked unhelpful', () => {
    expect(render({ helpful: 0, unhelpful: 0, flagged: [] })).toContain('No answers rated yet')
    const markup = render({ helpful: 1, unhelpful: 0, flagged: [] })
    expect(markup).toContain('0 of 1 rated answer marked unhelpful')
    expect(markup).toContain('No answer has been marked unhelpful in the last 90 days.')
  })
})
