import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { projectNumber } from './ResourceDetailPage.tsx'

describe('projectNumber', () => {
  it('reads a project code from any funding body, not one hard-coded acronym', () => {
    expect(projectNumber('Final report SWRI 2018-190')).toBe('2018-190')
    expect(projectNumber('SWRI 2021-044 Southern bluefin tuna survey')).toBe('2021-044')
    expect(projectNumber('DCRA2019-007-final.pdf')).toBe('2019-007')
    expect(projectNumber('Project US 1975-022')).toBe('1975-022')
  })

  it('does not claim a project number from a bare year range', () => {
    // A date span or a page range is not a project code. Without the acronym
    // there is nothing to tell them apart, so nothing is claimed.
    expect(projectNumber('Yield trends 2018-190 sites surveyed')).toBe(null)
    expect(projectNumber('Annual report 2018-190')).toBe(null)
  })

  it('ignores codes that are not a plausible project year', () => {
    expect(projectNumber('ABC 1875-022 historical note')).toBe(null)
    expect(projectNumber('ABC 2118-022 speculative')).toBe(null)
  })

  it('requires an acronym of two to six letters', () => {
    expect(projectNumber('A 2018-190')).toBe(null)
    expect(projectNumber('ABCDEFG 2018-190')).toBe(null)
  })
})
