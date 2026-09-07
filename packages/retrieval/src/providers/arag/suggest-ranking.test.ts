import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { rankSuggestedQuestions } from './suggest-ranking.ts'

const questions = [
  { id: 'q1', text: 'What are the latest therapeutic interventions for epilepsy?' },
  { id: 'q2', text: 'How do SCN1A variants shape Dravet syndrome?' },
  { id: 'q3', text: 'What does seizure forecasting need from wearables?' },
]

describe('rankSuggestedQuestions', () => {
  it('puts the questions that name the typed term first', () => {
    expect(rankSuggestedQuestions(questions, 'Dravet').map((q) => q.id)).toEqual([
      'q2',
      'q1',
      'q3',
    ])
    expect(rankSuggestedQuestions(questions, 'scn1a dravet').map((q) => q.id)[0]).toBe('q2')
  })
  it('leaves the configured order alone with no query or no overlap', () => {
    expect(rankSuggestedQuestions(questions).map((q) => q.id)).toEqual(['q1', 'q2', 'q3'])
    expect(rankSuggestedQuestions(questions, 'zzzz').map((q) => q.id)).toEqual(['q1', 'q2', 'q3'])
  })
})
