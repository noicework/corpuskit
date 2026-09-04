import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { Topic } from '@research-portal/core'
import { topicsWithFacetCounts } from './topic-rows.ts'

const TOPICS: Topic[] = [
  { id: 'carp-control', label: 'Carp control' },
  { id: 'governance-reporting', label: 'Governance and reporting' },
  { id: 'research-development', label: 'Research and development' },
]

describe('topicsWithFacetCounts', () => {
  it('keeps only topics with a positive facet count, carrying the real count through', () => {
    const rows = topicsWithFacetCounts(TOPICS, {
      topic: { 'carp-control': 84, 'governance-reporting': 0, 'research-development': 883 },
    })
    expect(rows.map((r) => r.topic.id)).toEqual(['carp-control', 'research-development'])
    expect(rows.map((r) => r.count)).toEqual([84, 883])
  })

  it('a topic missing from the facets entirely is treated as zero, not shown', () => {
    const rows = topicsWithFacetCounts(TOPICS, { topic: { 'carp-control': 12 } })
    expect(rows.map((r) => r.topic.id)).toEqual(['carp-control'])
  })

  it('empty facets (the box genuinely has none) yields the Explore empty state, not a false row', () => {
    expect(topicsWithFacetCounts(TOPICS, {})).toEqual([])
    expect(topicsWithFacetCounts(TOPICS, { topic: {} })).toEqual([])
  })

  it('no configured topics yields no rows regardless of facets', () => {
    expect(topicsWithFacetCounts([], { topic: { 'carp-control': 84 } })).toEqual([])
  })
})
