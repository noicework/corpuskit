import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { dedupeResourceFamilies } from './resource-groups.ts'

function ids(titles: string[], priorities: number[] = []): string[] {
  return dedupeResourceFamilies(titles.map((title, index) => ({
    id: `res-${index}`,
    title,
    ...(priorities[index] !== undefined ? { priority: priorities[index] } : {}),
  }))).map((resource) => resource.id)
}

describe('dedupeResourceFamilies', () => {
  it('keeps the primary report instead of adjacent Part A and Part B cards', () => {
    expect(ids([
      '2013-233-DLD.pdf',
      '2013-233-Part A.pdf',
      '2013-233-PART B.pdf',
    ])).toEqual(['res-0'])
  })

  it('uses Part 1 as the browse representative when a scan has no primary file', () => {
    expect(ids(['1989-063Part2of2-DLD', '1989-063Part1of2-DLD'])).toEqual(['res-1'])
  })

  it('groups observed appendix, supplementary and product file forms', () => {
    expect(ids(['2017-215-DLD.pdf', '2017-215-App-1', '2017-215-App-2'])).toEqual(['res-0'])
    expect(ids(['2016-066-DLD.pdf', '2016-066-DLD-Supplementary Report'])).toEqual(['res-0'])
    expect(ids(['1981-069-Product-2', '1981-069-Product'])).toEqual(['res-1'])
  })

  it('groups two-digit dot variants under their project family', () => {
    expect(ids(['1992-125.10-DLD', '1992-125.02-DLD', '1992-125-DLD.pdf'])).toEqual(['res-2'])
  })

  it('lets a more relevant secondary part win in search results', () => {
    expect(ids(
      ['2013-233-DLD.pdf', '2013-233-Part A.pdf', '2013-233-Part B.pdf'],
      [0.62, 0.71, 0.96],
    )).toEqual(['res-2'])
  })

  it('keeps a lone marked file because there is no duplicate to remove', () => {
    expect(ids(['2019-051-Examining impacts-PART A-SRL-larval-stages'])).toEqual(['res-0'])
  })

  it('keeps legitimate near-misses for every matched word pattern', () => {
    expect(ids([
      'Part A of the Fisheries Management Act',
      'Supplementary feeding strategies for abalone',
      'Seafood product quality and market access',
      '2019-051-Participation in a fisheries workshop',
      '2019-052-Productivity review',
      '2019-053-Application of acoustic tags',
      'Water temperature changed by 0.20 degrees',
    ])).toEqual(['res-0', 'res-1', 'res-2', 'res-3', 'res-4', 'res-5', 'res-6'])
  })

  it('does not group unrelated project codes or single-digit dot suffixes', () => {
    expect(ids(['2013-233-Part A.pdf', '2013-234-Part B.pdf', '1992-125.2-DLD'])).toEqual([
      'res-0',
      'res-1',
      'res-2',
    ])
  })
})
