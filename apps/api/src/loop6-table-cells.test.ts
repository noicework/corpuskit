/**
 * Loop 6 D6-16a: How this works promises that a table keeps every row with
 * any cell the check could not verify marked "not verified". A cell reading
 * "FAS" or "not reported" under a column that asked for a figure is exactly
 * such a cell (review loop 6).
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { markUnverifiableCells } from './answer-gate.ts'
import { blankedNote } from './ask-grounding.ts'

describe('a cell the check cannot read is marked, not left looking like a value', () => {
  it('marks an analysis set and a "not reported" under a quantity column', () => {
    const table = [
      '| Drug | Study Name/Design | n | 12-Month Retention | 12-Month Seizure Freedom |',
      '|-------------|-------------------|------|--------------------|------------------------|',
      '| Brivaracetam| EXPERIENCE | FAS | 71.1% (FAS) | 11.7% (FAS) [1] |',
      '| Perampanel | Global Pooled Analysis | not reported | not reported | 23.2% [2] |',
      '| Lacosamide | Cohort Study | not reported | not reported | 4% [3] |',
    ].join('\n')
    const out = markUnverifiableCells(table)
    expect(out.marked).toBe(5)
    expect(out.text).toContain('| Brivaracetam| EXPERIENCE | not verified | 71.1% (FAS) |')
    expect(out.text).toContain(
      '| Perampanel | Global Pooled Analysis | not verified | not verified | 23.2% [2] |',
    )
    // The design and drug columns are prose: they are never marked.
    expect(out.text).toContain('| Lacosamide | Cohort Study |')
    expect(out.text).toContain('EXPERIENCE')
    // One note covers both kinds of marked cell, never two notes.
    expect(blankedNote([{ figures: ['71.1%'] }], out.marked)).toBe(
      '*6 table cells were marked "not verified": one whose figure (71.1%) could not be tied to ' +
        'the cited passage for that row, and 5 that stated an analysis set or "not reported" ' +
        'where the column asked for a figure.*',
    )
    expect(blankedNote([], 0)).toBeUndefined()
  })

  it('leaves a table whose cells all state values alone, and leaves prose alone', () => {
    const table = [
      '| Drug | n | 12-month retention |',
      '| --- | --- | --- |',
      '| Brivaracetam | 1111 | 71.1% |',
    ].join('\n')
    expect(markUnverifiableCells(table)).toEqual({ text: table, marked: 0 })
    const prose = 'Retention was not reported for perampanel in the cited sources.'
    expect(markUnverifiableCells(prose)).toEqual({ text: prose, marked: 0 })
  })

  it('starts a new heading row for a second table in the same answer', () => {
    const text = [
      '| Drug | n |',
      '| --- | --- |',
      '| Brivaracetam | not reported |',
      '',
      '| Study | Design |',
      '| --- | --- |',
      '| EXPERIENCE | not reported |',
    ].join('\n')
    const out = markUnverifiableCells(text)
    expect(out.marked).toBe(1)
    expect(out.text).toContain('| EXPERIENCE | not reported |')
  })
})
