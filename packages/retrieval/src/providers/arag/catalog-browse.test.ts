import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { CatalogItem } from '@research-portal/core'
import {
  catalogFilterExpression,
  matchesCatalogFilters,
  paginateCatalogItems,
  sortCatalogItems,
  untaggedFilterExpression,
} from './catalog-browse.ts'

const item = (over: Partial<CatalogItem>): CatalogItem => ({
  id: over.id ?? 'x',
  title: over.title ?? 'Title',
  status: 'processed',
  topicIds: over.topicIds ?? [],
  ...over,
})

describe('catalogFilterExpression', () => {
  it('sends nothing when no facet is selected', () => {
    expect(catalogFilterExpression({})).toBeUndefined()
    expect(catalogFilterExpression({ topicIds: [], formatIds: [] })).toBeUndefined()
  })

  it('ORs labels within one facet - Articles plus Video is either, never zero', () => {
    expect(catalogFilterExpression({ formatIds: ['article', 'media'] })).toEqual({
      resource: {
        or: [
          { prop: 'label', labelset: 'format', label: 'article' },
          { prop: 'label', labelset: 'format', label: 'media' },
        ],
      },
    })
  })

  it('ANDs across facets and collapses a single label to a bare predicate', () => {
    expect(
      catalogFilterExpression({ topicIds: ['genetics'], formatIds: ['article', 'supplement'] }),
    ).toEqual({
      resource: {
        and: [
          { prop: 'label', labelset: 'topic', label: 'genetics' },
          {
            or: [
              { prop: 'label', labelset: 'format', label: 'article' },
              { prop: 'label', labelset: 'format', label: 'supplement' },
            ],
          },
        ],
      },
    })
  })

  it('drops blanks and duplicates', () => {
    expect(catalogFilterExpression({ kindIds: ['protocol', '', 'protocol'] })).toEqual({
      resource: { prop: 'label', labelset: 'kind', label: 'protocol' },
    })
  })

  it('names the no-label predicate for the Untagged count', () => {
    expect(untaggedFilterExpression('topic')).toEqual({
      resource: { not: { prop: 'label', labelset: 'topic' } },
    })
  })
})

describe('matchesCatalogFilters', () => {
  const article = item({ topicIds: ['genetics', 'trials'], format: 'article', kind: 'protocol' })

  it('accepts everything with no filters', () => {
    expect(matchesCatalogFilters(article, {})).toBe(true)
  })

  it('ORs within a facet and ANDs across', () => {
    expect(matchesCatalogFilters(article, { formatIds: ['media', 'article'] })).toBe(true)
    expect(matchesCatalogFilters(article, { formatIds: ['media'] })).toBe(false)
    expect(matchesCatalogFilters(article, { topicIds: ['trials'], kindIds: ['protocol'] })).toBe(
      true,
    )
    expect(matchesCatalogFilters(article, { topicIds: ['trials'], kindIds: ['case-study'] }))
      .toBe(false)
  })

  it('never matches a kind or format filter on an unlabelled item', () => {
    expect(matchesCatalogFilters(item({}), { kindIds: ['protocol'] })).toBe(false)
    expect(matchesCatalogFilters(item({}), { formatIds: ['article'] })).toBe(false)
  })
})

describe('sortCatalogItems', () => {
  const dated = [
    item({ id: 'a', published: '2008-09-01', created: '2026-09-03T01:00:00' }),
    item({ id: 'b', published: '2024-02-10', created: '2026-09-03T02:00:00' }),
    item({ id: 'c', created: '2026-09-03T03:00:00' }),
    item({ id: 'd', published: '2016-05-20', created: '2026-09-03T04:00:00' }),
  ]

  it('orders newest published first with undated records last', () => {
    expect(sortCatalogItems(dated, 'published', 'desc').map((i) => i.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ])
  })

  it('keeps undated records last when ascending too', () => {
    expect(sortCatalogItems(dated, 'published', 'asc').map((i) => i.id)).toEqual([
      'a',
      'd',
      'b',
      'c',
    ])
  })

  it('sorts created and title the same way the platform does', () => {
    expect(sortCatalogItems(dated, 'created', 'desc').map((i) => i.id)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ])
    const titled = [item({ id: 'z', title: 'zeta' }), item({ id: 'a', title: 'Alpha' })]
    expect(sortCatalogItems(titled, 'title', 'asc').map((i) => i.id)).toEqual(['a', 'z'])
  })

  it('does not mutate its input', () => {
    const copy = [...dated]
    sortCatalogItems(dated, 'published', 'desc')
    expect(dated).toEqual(copy)
  })
})

describe('paginateCatalogItems', () => {
  it('slices by page and size and clamps a negative page to the first', () => {
    const list = [1, 2, 3, 4, 5]
    expect(paginateCatalogItems(list, 0, 2)).toEqual([1, 2])
    expect(paginateCatalogItems(list, 2, 2)).toEqual([5])
    expect(paginateCatalogItems(list, -1, 2)).toEqual([1, 2])
  })
})
