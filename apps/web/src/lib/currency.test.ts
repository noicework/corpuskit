import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { assessCurrency, CURRENCY_CAVEAT_MAX_AGE_YEARS, sourceYear, yearOf } from './currency.ts'

// A fixed "now" so the age-threshold boundary is deterministic.
const NOW = 2026

describe('yearOf', () => {
  it('reads a bare four-digit year', () => {
    expect(yearOf('1998')).toBe(1998)
  })

  it('reads the year from a full ISO date', () => {
    expect(yearOf('1998-06-01')).toBe(1998)
  })

  it('reads a year embedded in surrounding text', () => {
    expect(yearOf('Published 2011 (revised)')).toBe(2011)
  })

  it('returns undefined for an absent date', () => {
    expect(yearOf(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(yearOf('')).toBeUndefined()
  })

  it('returns undefined when there is no plausible year', () => {
    expect(yearOf('n/a')).toBeUndefined()
    expect(yearOf('12/06')).toBeUndefined()
  })

  it('does not treat a bare project code as a year', () => {
    // A four-digit run glued to more digits is not a standalone year.
    expect(yearOf('19981234')).toBeUndefined()
  })
})

describe('sourceYear (layered fallback)', () => {
  it('prefers real published metadata over the project code and title', () => {
    expect(
      sourceYear({
        published: '2010-01-01',
        sourceName: '1975-022-DLD.pdf',
        title: 'Project 1975-022',
      }),
    ).toBe(2010)
  })

  it('falls back to the year in the project code when published is absent', () => {
    // The historical-archive case: no published date, year in the project code prefix.
    expect(sourceYear({ sourceName: '1975-022-DLD.pdf', title: 'Project 1975-022' })).toBe(1975)
  })

  it('falls back to the title when neither published nor project code carries a year', () => {
    expect(sourceYear({ sourceName: 'DLD-report.pdf', title: 'Barramundi survey 2003' })).toBe(2003)
  })

  it('is undefined when no field yields a plausible year', () => {
    expect(sourceYear({ sourceName: 'report.pdf', title: 'Barramundi survey' })).toBeUndefined()
  })
})

describe('assessCurrency', () => {
  describe('no usable years -> silent', () => {
    it('shows nothing when there are no sources at all', () => {
      const result = assessCurrency([], NOW)
      expect(result.recencyLabel).toBeUndefined()
      expect(result.span).toBeUndefined()
      expect(result.mostRecentYear).toBeUndefined()
      expect(result.datedCount).toBe(0)
      expect(result.showCaveat).toBe(false)
      expect(result.caveatText).toBeUndefined()
    })

    it('shows nothing when no source carries a year', () => {
      const result = assessCurrency([{}, { published: undefined }, { published: 'n/a' }], NOW)
      expect(result.recencyLabel).toBeUndefined()
      expect(result.span).toBeUndefined()
      expect(result.showCaveat).toBe(false)
    })
  })

  describe('date span', () => {
    it('computes the earliest and latest year across many sources', () => {
      const result = assessCurrency(
        [{ published: '1985-01-01' }, { published: '1971' }, { published: '1998-12-31' }],
        NOW,
      )
      expect(result.span).toEqual({ earliest: 1971, latest: 1998 })
      expect(result.mostRecentYear).toBe(1998)
      expect(result.datedCount).toBe(3)
      expect(result.recencyLabel).toBe('Cited sources: 1971-1998')
    })

    it('ignores sources without a year but keeps the span from the dated ones', () => {
      const result = assessCurrency(
        [{ published: '2001' }, {}, { published: 'unknown' }, { published: '2019' }],
        NOW,
      )
      expect(result.span).toEqual({ earliest: 2001, latest: 2019 })
      expect(result.datedCount).toBe(2)
      expect(result.recencyLabel).toBe('Cited sources: 2001-2019')
    })
  })

  describe('single source / single year', () => {
    it('uses the "Most recent cited source" phrasing when only one year is present', () => {
      const result = assessCurrency([{ published: '2019-03-01' }], NOW)
      expect(result.span).toEqual({ earliest: 2019, latest: 2019 })
      expect(result.recencyLabel).toBe('Most recent cited source: 2019')
      expect(result.showCaveat).toBe(false)
    })

    it('uses the single-year phrasing when many sources share one year', () => {
      const result = assessCurrency([{ published: '2005' }, { published: '2005-08' }], NOW)
      expect(result.recencyLabel).toBe('Most recent cited source: 2005')
    })
  })

  describe('age threshold boundary', () => {
    it('does NOT caveat exactly at the threshold (newest source == max age)', () => {
      // now - year == 8, not strictly greater than 8.
      const result = assessCurrency(
        [{ published: String(NOW - CURRENCY_CAVEAT_MAX_AGE_YEARS) }],
        NOW,
      )
      expect(result.mostRecentYear).toBe(NOW - CURRENCY_CAVEAT_MAX_AGE_YEARS)
      expect(result.showCaveat).toBe(false)
      expect(result.caveatText).toBeUndefined()
    })

    it('does NOT caveat one year inside the threshold', () => {
      const result = assessCurrency(
        [{ published: String(NOW - CURRENCY_CAVEAT_MAX_AGE_YEARS + 1) }],
        NOW,
      )
      expect(result.showCaveat).toBe(false)
    })

    it('DOES caveat one year past the threshold', () => {
      const result = assessCurrency(
        [{ published: String(NOW - CURRENCY_CAVEAT_MAX_AGE_YEARS - 1) }],
        NOW,
      )
      expect(result.showCaveat).toBe(true)
    })

    it('caveats a clearly historical answer with the specific newest year', () => {
      const result = assessCurrency([{ published: '1971' }, { published: '1998' }], NOW)
      expect(result.showCaveat).toBe(true)
      expect(result.caveatText).toBe(
        'This answer draws on sources up to 1998 and may not reflect developments since.',
      )
    })

    it('the caveat names the NEWEST year, not the oldest', () => {
      const result = assessCurrency([{ published: '1975' }, { published: '2004' }], NOW)
      expect(result.caveatText).toContain('up to 2004')
    })

    it('the newest DATED source decides the caveat even when an undated source is present', () => {
      const result = assessCurrency([{ published: '1990' }, {}], NOW)
      expect(result.showCaveat).toBe(true)
      expect(result.caveatText).toContain('up to 1990')
    })
  })

  describe('real-corpus shape (year only in project code / title)', () => {
    it('builds the span from project-code sources that have no published date', () => {
      // Exactly the live-corpus case that first rendered nothing: empty published,
      // year in the project code.
      const result = assessCurrency(
        [
          { sourceName: '1975-022-DLD.pdf', title: 'Project 1975-022' },
          { sourceName: '2003-051-DLD.pdf', title: 'Project 2003-051' },
        ],
        NOW,
      )
      expect(result.span).toEqual({ earliest: 1975, latest: 2003 })
      expect(result.recencyLabel).toBe('Cited sources: 1975-2003')
      expect(result.showCaveat).toBe(true)
      expect(result.caveatText).toContain('up to 2003')
    })

    it('ignores an implausible future year (e.g. a target year in a title)', () => {
      const result = assessCurrency(
        [{ title: 'Project 1998-014' }, { title: 'Aquaculture 2050 strategy targets' }],
        NOW,
      )
      // 2050 is in the future, so it must not freshen the span.
      expect(result.span).toEqual({ earliest: 1998, latest: 1998 })
      expect(result.mostRecentYear).toBe(1998)
    })
  })

  describe('recent answers stay quiet', () => {
    it('a current-year source shows the recency line but no caveat', () => {
      const result = assessCurrency([{ published: String(NOW) }], NOW)
      expect(result.recencyLabel).toBe(`Most recent cited source: ${NOW}`)
      expect(result.showCaveat).toBe(false)
    })
  })
})
