import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  bulkImportDay,
  DEFAULT_SORT,
  facetsFromUrl,
  formatLabel,
  SORT_OPTIONS,
} from './LibraryPage.tsx'
import { cardinalityLabel, labelsetHasCounts } from './TaxonomyPage.tsx'

describe('library sort', () => {
  it('opens on newest published, and offers the publication-date sorts', () => {
    expect(DEFAULT_SORT).toBe('published')
    expect(SORT_OPTIONS.published).toEqual({
      label: 'Newest published',
      sort: 'published',
      order: 'desc',
    })
    expect(SORT_OPTIONS.oldestPublished.sort).toBe('published')
    expect(SORT_OPTIONS.oldestPublished.order).toBe('asc')
  })
})

describe('formatLabel', () => {
  it('badges by format, naming a video for what it is', () => {
    expect(formatLabel('article', 'document')).toBe('Article')
    expect(formatLabel('supplement', 'pdf')).toBe('Supplement')
    expect(formatLabel('media', 'video')).toBe('Video')
    expect(formatLabel('media', 'document')).toBe('Media')
    expect(formatLabel(undefined, 'pdf')).toBeNull()
  })
})

describe('bulkImportDay', () => {
  const same = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ created: `2026-09-03T06:0${i % 10}:00` }))

  it('finds the day four in five items share', () => {
    expect(bulkImportDay([...same(9), { created: '2026-09-10T01:00:00' }])).toBe('2026-09-03')
  })

  it('returns null for a small page or a genuinely varied listing', () => {
    expect(bulkImportDay(same(4))).toBeNull()
    expect(
      bulkImportDay([
        { created: '2026-01-01' },
        { created: '2026-02-01' },
        { created: '2026-03-01' },
        { created: '2026-04-01' },
        { created: '2026-05-01' },
      ]),
    ).toBeNull()
  })
})

describe('taxonomy cards', () => {
  it('hides a labelset with no indexed value', () => {
    expect(labelsetHasCounts({ a: 0, b: 0 })).toBe(false)
    expect(labelsetHasCounts({ a: 0, b: 2 })).toBe(true)
    expect(labelsetHasCounts(undefined)).toBe(false)
  })

  it('reports observed multi-valued topics and passage-level counts honestly', () => {
    expect(cardinalityLabel({ multiple: false }, { a: 600, b: 500 }, 981)).toBe(
      'Multiple values per resource (observed in the index)',
    )
    expect(cardinalityLabel({ multiple: false }, { a: 600, b: 300 }, 981)).toBe(
      'Single value per resource',
    )
    expect(cardinalityLabel({ multiple: true, kind: 'PARAGRAPHS' }, { a: 2269 }, 981)).toBe(
      'Applied to passages, not whole resources',
    )
  })
})

describe('facet deep links (D1-19)', () => {
  it('reads the singular and the plural form, comma-separated, without duplicates', () => {
    const params = new URLSearchParams('topics=clinical-trials,neuroimaging,clinical-trials')
    expect(facetsFromUrl(params, 'topic', 'topics')).toEqual(['clinical-trials', 'neuroimaging'])
    expect(facetsFromUrl(new URLSearchParams('kind=cohort-study'), 'kind', 'kinds')).toEqual([
      'cohort-study',
    ])
    expect(facetsFromUrl(new URLSearchParams('formats=article'), 'format', 'formats')).toEqual([
      'article',
    ])
  })

  it('the singular form wins when both are present, and nothing is nothing', () => {
    const params = new URLSearchParams('topic=biomarkers&topics=neuroimaging')
    expect(facetsFromUrl(params, 'topic', 'topics')).toEqual(['biomarkers'])
    expect(facetsFromUrl(new URLSearchParams(''), 'topic', 'topics')).toEqual([])
  })
})
