import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { assessConfidence, isThinlyGrounded } from './confidence.ts'

describe('assessConfidence', () => {
  describe('unscored', () => {
    it('is unscored when quality is undefined', () => {
      expect(assessConfidence(undefined).state).toBe('unscored')
    })

    it('is unscored when quality is null', () => {
      expect(assessConfidence(null).state).toBe('unscored')
    })

    it('is unscored when groundedness is null, even if other signals are present', () => {
      const result = assessConfidence({
        groundedness: null,
        answerRelevance: 5,
        contextRelevance: 5,
      })
      expect(result.state).toBe('unscored')
      expect(result.label).toBe('Confidence not scored')
    })
  })

  describe('low', () => {
    it('is low when groundedness is weak and nothing else is scored', () => {
      const result = assessConfidence({
        groundedness: 1,
        answerRelevance: null,
        contextRelevance: null,
      })
      expect(result.state).toBe('low')
      expect(result.label).toBe('Low confidence')
    })

    it('forces low from weak groundedness even when answer-relevance is high (key rule)', () => {
      const result = assessConfidence({
        groundedness: 1,
        answerRelevance: 5,
        contextRelevance: 5,
      })
      expect(result.state).toBe('low')
    })

    it('drops a moderately-grounded answer to low when answer-relevance is also weak', () => {
      const result = assessConfidence({
        groundedness: 3,
        answerRelevance: 1,
        contextRelevance: 5,
      })
      expect(result.state).toBe('low')
    })

    it('is low just below the 2.5 groundedness boundary', () => {
      const result = assessConfidence({
        groundedness: 2.49,
        answerRelevance: null,
        contextRelevance: null,
      })
      expect(result.state).toBe('low')
    })
  })

  describe('moderate', () => {
    it('is moderate when groundedness sits in the warn band alone', () => {
      const result = assessConfidence({
        groundedness: 3,
        answerRelevance: null,
        contextRelevance: null,
      })
      expect(result.state).toBe('moderate')
      expect(result.label).toBe('Moderate confidence')
    })

    it('is moderate exactly at the 2.5 groundedness boundary', () => {
      const result = assessConfidence({
        groundedness: 2.5,
        answerRelevance: null,
        contextRelevance: null,
      })
      expect(result.state).toBe('moderate')
    })

    it('is moderate just below the 4.0 groundedness boundary', () => {
      const result = assessConfidence({
        groundedness: 3.99,
        answerRelevance: 5,
        contextRelevance: 5,
      })
      expect(result.state).toBe('moderate')
    })

    it('caps a well-grounded answer at moderate when context-relevance is weak', () => {
      const result = assessConfidence({
        groundedness: 5,
        answerRelevance: 5,
        contextRelevance: 2,
      })
      expect(result.state).toBe('moderate')
    })

    it('caps a well-grounded answer at moderate when answer-relevance merely warns', () => {
      const result = assessConfidence({
        groundedness: 5,
        answerRelevance: 3,
        contextRelevance: 5,
      })
      expect(result.state).toBe('moderate')
    })
  })

  describe('high', () => {
    it('is high when every signal is strong', () => {
      const result = assessConfidence({
        groundedness: 5,
        answerRelevance: 5,
        contextRelevance: 5,
      })
      expect(result.state).toBe('high')
      expect(result.label).toBe('High confidence')
    })

    it('is high exactly at the 4.0 groundedness boundary with no other signals', () => {
      const result = assessConfidence({
        groundedness: 4,
        answerRelevance: null,
        contextRelevance: null,
      })
      expect(result.state).toBe('high')
    })
  })
})

describe('isThinlyGrounded', () => {
  it('offers a deep re-answer for the reported live case: groundedness 2.0 with citations', () => {
    // The exact miss that motivated the fix: a 2.0/5 answer showed the red
    // "Low confidence" banner but the old narrow trigger offered no re-answer.
    expect(
      isThinlyGrounded({ groundedness: 2, answerRelevance: 4, contextRelevance: 4 }),
    ).toBe(true)
  })

  it('offers a deep re-answer whenever the answer is low confidence (weak grounding)', () => {
    expect(
      isThinlyGrounded({ groundedness: 1, answerRelevance: 5, contextRelevance: 5 }),
    ).toBe(true)
  })

  it('offers a deep re-answer for a moderately-grounded but off-target answer (also low)', () => {
    expect(
      isThinlyGrounded({ groundedness: 3, answerRelevance: 1, contextRelevance: 5 }),
    ).toBe(true)
  })

  it('offers a deep re-answer just below the 2.5 groundedness boundary', () => {
    expect(
      isThinlyGrounded({ groundedness: 2.49, answerRelevance: null, contextRelevance: null }),
    ).toBe(true)
  })

  it('does NOT offer on a healthy high-confidence answer', () => {
    expect(
      isThinlyGrounded({ groundedness: 5, answerRelevance: 5, contextRelevance: 5 }),
    ).toBe(false)
  })

  it('does NOT offer on a moderate-confidence answer', () => {
    expect(
      isThinlyGrounded({ groundedness: 3, answerRelevance: null, contextRelevance: null }),
    ).toBe(false)
  })

  it('does NOT offer at the 2.5 groundedness boundary (moderate, not low)', () => {
    expect(
      isThinlyGrounded({ groundedness: 2.5, answerRelevance: null, contextRelevance: null }),
    ).toBe(false)
  })

  it('does NOT offer on an unscored answer (never guess without REMi)', () => {
    expect(isThinlyGrounded(undefined)).toBe(false)
    expect(isThinlyGrounded(null)).toBe(false)
    expect(
      isThinlyGrounded({ groundedness: null, answerRelevance: 5, contextRelevance: 5 }),
    ).toBe(false)
  })

  it('agrees with the low-confidence banner across the board', () => {
    const cases = [
      { groundedness: 0, answerRelevance: 0, contextRelevance: 0 },
      { groundedness: 2, answerRelevance: 4, contextRelevance: 4 },
      { groundedness: 3, answerRelevance: 5, contextRelevance: 5 },
      { groundedness: 4, answerRelevance: 5, contextRelevance: 5 },
      { groundedness: 5, answerRelevance: 2, contextRelevance: 5 },
    ]
    for (const quality of cases) {
      expect(isThinlyGrounded(quality)).toBe(assessConfidence(quality).state === 'low')
    }
  })
})
