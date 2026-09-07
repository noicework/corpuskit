import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { findPassageRange, normaliseText, passageNeedles } from './pdf-highlight.ts'

describe('normaliseText', () => {
  it('lowercases and collapses punctuation and whitespace', () => {
    expect(normaliseText('  Multi-day  cycles, (5–9 day)\nperiods. ')).toBe(
      'multi day cycles 5 9 day periods',
    )
  })
})

describe('passageNeedles', () => {
  it('returns longest-first candidates and drops fragments too short to be specific', () => {
    const needles = passageNeedles(
      'Seizure cycles are found at weekly and monthly periods in most people with epilepsy',
    )
    expect(needles[0]?.length).toBeGreaterThan(needles[1]?.length ?? 0)
    expect(needles.every((n) => n.length >= 12)).toBe(true)
    expect(passageNeedles('short')).toEqual([])
    expect(passageNeedles('')).toEqual([])
  })
})

describe('findPassageRange', () => {
  const items = [
    { str: 'INTRODUCTION' },
    { str: 'The propensity for seizures to follow circadian and' },
    { str: 'multiday (i.e., weekly, monthly, or seasonal)' },
    { str: 'rhythms has been documented for centuries (1, 2).' },
    { str: '' },
    { str: 'More recent findings from chronically recorded EEG' },
  ]

  it('finds the items that carry a passage that spans several text runs', () => {
    const range = findPassageRange(
      items,
      'seizures to follow circadian and multiday (i.e., weekly, monthly, or seasonal) rhythms has been',
    )
    expect(range).toEqual({ start: 1, end: 3 })
  })

  it('falls back to a shorter needle when the passage start is cut mid-word', () => {
    const range = findPassageRange(
      items,
      'cent findings from chronically recorded EEG in both human and animal studies',
    )
    expect(range).toEqual({ start: 5, end: 5 })
  })

  it('returns null when the passage is not on the page', () => {
    expect(
      findPassageRange(items, 'Antiseizure medication in pregnancy and the risk of malformations'),
    ).toBeNull()
    expect(findPassageRange([], 'anything at all that is long enough')).toBeNull()
  })
})
