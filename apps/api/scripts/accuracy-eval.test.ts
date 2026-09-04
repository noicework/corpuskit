import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { citationIntegrity, type QuestionResult, summarize } from './accuracy-eval.ts'

describe('citationIntegrity', () => {
  it('finds no markers and no unresolved ones in plain prose', () => {
    const { markers, unresolved } = citationIntegrity('Abalone stocks are stable.', new Set())
    expect(markers).toEqual([])
    expect(unresolved).toEqual([])
  })

  it('resolves every marker that has a matching citation index', () => {
    const { markers, unresolved } = citationIntegrity(
      'Stocks declined [1] but recovered by 2020 [2].',
      new Set([1, 2]),
    )
    expect(markers).toEqual([1, 2])
    expect(unresolved).toEqual([])
  })

  it('reports a marker with no matching citation as unresolved', () => {
    const { markers, unresolved } = citationIntegrity(
      'Stocks declined [1] and later collapsed [3].',
      new Set([1, 2]),
    )
    expect(markers).toEqual([1, 3])
    expect(unresolved).toEqual([3])
  })

  it('counts a repeated marker each time it appears', () => {
    const { markers, unresolved } = citationIntegrity(
      'Point A [1]. Point B [1]. Point C [4].',
      new Set([1]),
    )
    expect(markers).toEqual([1, 1, 4])
    expect(unresolved).toEqual([4])
  })
})

function fakeResult(overrides: Partial<QuestionResult>): QuestionResult {
  return {
    query: 'q',
    expectedTopic: 'topic',
    outOfCorpus: false,
    ok: true,
    sourcesCount: 3,
    refused: false,
    answerRelevance: 4,
    groundedness: 4.5,
    contextRelevance: 4,
    citationMarkers: 2,
    citationUnresolved: 0,
    firstTokenMs: 1200,
    totalMs: 8000,
    ...overrides,
  }
}

describe('summarize', () => {
  it('reports 100% answered and 100% correct refusal on an all-pass run', () => {
    const results: QuestionResult[] = [
      fakeResult({ query: 'a' }),
      fakeResult({ query: 'b' }),
      fakeResult({
        query: 'oos',
        outOfCorpus: true,
        refused: true,
        citationMarkers: 0,
        sourcesCount: 0,
      }),
    ]
    const s = summarize(results)
    expect(s.questionsTotal).toBe(3)
    expect(s.inCorpusTotal).toBe(2)
    expect(s.outOfCorpusTotal).toBe(1)
    expect(s.answeredCount).toBe(2)
    expect(s.answeredPct).toBe(100)
    expect(s.outOfCorpusRefusedCount).toBe(1)
    expect(s.outOfCorpusRefusedPct).toBe(100)
    expect(s.harnessErrors).toBe(0)
  })

  it('separates a harness-level failure from a genuine refusal', () => {
    const results: QuestionResult[] = [
      fakeResult({ query: 'a', ok: false, detail: 'HTTP 500' }),
      fakeResult({ query: 'b', refused: true }),
    ]
    const s = summarize(results)
    expect(s.harnessErrors).toBe(1)
    // A failed call isn't counted as "answered" or "refused" - it's a
    // separate signal so a broken deploy never reads as a wave of honest
    // refusals.
    expect(s.answeredCount).toBe(0)
    expect(s.refusedInCorpusCount).toBe(1)
    expect(s.answeredPct).toBe(0)
  })

  it('an out-of-corpus question that was answered (not refused) counts against out_of_corpus_refused_pct', () => {
    const results: QuestionResult[] = [
      fakeResult({ query: 'oos', outOfCorpus: true, refused: false }),
    ]
    const s = summarize(results)
    expect(s.outOfCorpusRefusedCount).toBe(0)
    expect(s.outOfCorpusRefusedPct).toBe(0)
  })

  it('computes citation coverage and integrity only over answered in-corpus questions', () => {
    const results: QuestionResult[] = [
      fakeResult({ query: 'clean', citationMarkers: 2, citationUnresolved: 0 }),
      fakeResult({ query: 'broken', citationMarkers: 1, citationUnresolved: 1 }),
      fakeResult({ query: 'no-citations', citationMarkers: 0, citationUnresolved: 0 }),
      fakeResult({ query: 'refused', refused: true, citationMarkers: 0 }),
    ]
    const s = summarize(results)
    // 3 answered questions, 2 of which carry at least one citation marker:
    // round(2/3 * 1000) / 10.
    expect(s.citationCoverageRate).toBe(66.7)
    // Of those 2, 1 is fully resolved.
    expect(s.citationIntegrityRate).toBe(50)
  })

  it('averages REMi scores only over answered questions with a non-null value', () => {
    const results: QuestionResult[] = [
      fakeResult({ query: 'a', groundedness: 5 }),
      fakeResult({ query: 'b', groundedness: 3 }),
      fakeResult({ query: 'c', groundedness: null }),
      fakeResult({ query: 'refused', refused: true, groundedness: 1 }),
    ]
    const s = summarize(results)
    // (5 + 3) / 2, the null and the refused question excluded.
    expect(s.meanGroundedness).toBe(4)
  })

  it('reports null aggregates rather than dividing by zero on an empty run', () => {
    const s = summarize([])
    expect(s.answeredPct).toBe(0)
    expect(s.outOfCorpusRefusedPct).toBe(0)
    expect(s.meanGroundedness).toBeNull()
    expect(s.citationCoverageRate).toBeNull()
    expect(s.citationIntegrityRate).toBeNull()
  })
})
