import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { nextRetry, type RetryContext } from './ask-retry.ts'

const base: RetryContext = {
  documentScope: false,
  extraAttemptUsed: false,
  pinnedIds: [],
  citedIds: [],
  supplementsOnly: false,
  currentIntent: 'general',
  defaultIntent: 'general',
  prequeries: 0,
  bestRelevance: 0.5,
  strongMatch: 0.9,
}

describe('nextRetry - one extra ask at most (D3-05)', () => {
  it('accepts a refusal on the default configuration with nothing narrower to drop', () => {
    expect(nextRetry({ ...base, bestRelevance: 0.96 }, 'refused')).toBeNull()
  })

  it("drops the earlier turns' pins when a pinned follow-up refuses over a strong match (D4-07)", () => {
    expect(nextRetry({ ...base, bestRelevance: 0.99, priorPinned: true }, 'refused')).toBe(
      'unpinned',
    )
    expect(nextRetry({ ...base, bestRelevance: 0.4, priorPinned: true }, 'refused')).toBeNull()
    expect(nextRetry({ ...base, bestRelevance: 0.99, priorPinned: true }, 'uncited')).toBeNull()
  })
  it('re-asks on the general configuration when a supplements-only intent refuses', () => {
    expect(nextRetry({ ...base, currentIntent: 'data', supplementsOnly: true }, 'refused')).toBe(
      'supplements',
    )
  })

  it('reads the named paper directly when the first pass never cited it', () => {
    expect(nextRetry({ ...base, pinnedIds: ['p1'] }, 'refused')).toBe('pinned')
    expect(nextRetry({ ...base, pinnedIds: ['p1'] }, 'uncited')).toBe('pinned')
  })

  it('does not read the pinned paper again when the first pass already cited it', () => {
    expect(nextRetry({ ...base, pinnedIds: ['p1'], citedIds: ['p1'] }, 'uncited')).toBeNull()
    expect(nextRetry({ ...base, pinnedIds: ['p1'], citedIds: ['p1'] }, 'refused')).toBeNull()
  })

  it('drops the prequeries or a narrower intent only over a strong match', () => {
    expect(nextRetry({ ...base, prequeries: 2, bestRelevance: 0.95 }, 'refused')).toBe(
      'prequeries',
    )
    expect(nextRetry({ ...base, currentIntent: 'clinical', bestRelevance: 0.95 }, 'refused'))
      .toBe('prequeries')
    expect(nextRetry({ ...base, prequeries: 2, bestRelevance: 0.7 }, 'refused')).toBeNull()
    // An uncited answer is not a generator refusal: prequeries are not the cause.
    expect(nextRetry({ ...base, prequeries: 2, bestRelevance: 0.95 }, 'uncited')).toBeNull()
  })

  it('never retries twice, and never in document chat', () => {
    expect(nextRetry({ ...base, pinnedIds: ['p1'], extraAttemptUsed: true }, 'refused')).toBeNull()
    expect(nextRetry({ ...base, pinnedIds: ['p1'], documentScope: true }, 'refused')).toBeNull()
  })
})

describe('nextRetry - loop 5 (D5-06, D5-09)', () => {
  it('reads the earlier paper alone when a scoped follow-up refuses over a strong match, else asks the whole collection', () => {
    expect(nextRetry({ ...base, priorPinned: true, priorScoped: true }, 'refused')).toBe('unpinned')
    expect(
      nextRetry({ ...base, priorPinned: true, priorScoped: true, bestRelevance: 0.99 }, 'refused'),
    )
      .toBe('pinned')
    expect(
      nextRetry(
        { ...base, priorPinned: true, priorScoped: true, extraAttemptUsed: true },
        'refused',
      ),
    )
      .toBeNull()
  })

  it("reads the paper that carries a terse question's own terms when nothing was pinned", () => {
    expect(nextRetry({ ...base, topicPinId: 'icv' }, 'refused')).toBe('pinned')
    expect(nextRetry({ ...base, topicPinId: 'icv' }, 'uncited')).toBe('pinned')
    // Already read: reading it again produces the figures the gate rejected.
    expect(nextRetry({ ...base, topicPinId: 'icv', citedIds: ['icv'] }, 'uncited')).toBeNull()
    // A study-guard pin takes precedence.
    expect(nextRetry({ ...base, topicPinId: 'icv', pinnedIds: ['p1'] }, 'refused')).toBe('pinned')
  })
})
