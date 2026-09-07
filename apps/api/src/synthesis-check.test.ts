import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { citedReferences, passageDenominators, unusedReferences } from './synthesis-check.ts'

describe('unusedReferences', () => {
  it('lists the references the brief never cites, reading grouped markers too', () => {
    const brief = {
      summary: 'BRV 71.1% (n = 1644) [1]; PER 64.2% (2698/4201) [2].',
      supported: ['Retention differs [1, 2].'],
      contested: [],
      gaps: [],
    }
    expect([...citedReferences(brief)].sort()).toEqual([1, 2])
    expect(unusedReferences(brief, 3)).toEqual([3])
    expect(unusedReferences(brief, 2)).toEqual([])
  })
})

describe('passageDenominators', () => {
  it('finds n = x, a/b and counts with a unit word', () => {
    expect(
      passageDenominators(
        'Retention at 3, 6, and 12 months was 90.5% (4273/4721), 79.8% (3603/4516), and 64.2% (2698/4201). Analyses included 1644 adults; n = 1,644.',
      ),
    ).toEqual(['4273/4721', '3603/4516', '2698/4201', '1644 adults', 'n = 1,644'])
    expect(passageDenominators('No figures here.')).toEqual([])
  })
})
