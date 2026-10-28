import { expect } from '@std/expect'
import { type DuplicateItem } from '@research-portal/core'
import {
  findCandidates,
  matchItems,
  normaliseOrigin,
  normaliseTitle,
} from './duplicate-matching.ts'
import { overlapCsv } from './duplicate-routes.ts'

const item: DuplicateItem = {
  id: 'one',
  title: 'Coastal habitat recovery in sheltered waters',
  summary:
    'Repeated surveys measure coastal habitat recovery after restoration in sheltered waters.',
}

Deno.test('normalisation preserves meaningful URL queries and handles accents and punctuation', () => {
  expect(normaliseTitle('  COASTAL: café research! ')).toBe('coastal cafe research')
  expect(normaliseOrigin('https://Example.test/paper/?utm_source=feed&b=2&a=1#part'))
    .toBe('example.test/paper?a=1&b=2')
  expect(normaliseOrigin('file:///private/file')).toBe('')
  expect(normaliseOrigin('not a URL')).toBe('')
  expect(normaliseOrigin('https://example.test/?id=1'))
    .not.toBe(normaliseOrigin('https://example.test/?id=2'))
})

Deno.test('candidate evidence distinguishes exact metadata and possible dated versions', () => {
  const pair = matchItems(
    {
      ...item,
      sourceName: 'report.pdf',
      originUrl: 'https://example.test/report',
      published: '2023-01-01',
    },
    {
      ...item,
      id: 'two',
      title: item.title + ' version 2',
      sourceName: 'report.pdf',
      originUrl: 'https://example.test/report?utm_source=feed',
      published: '2024-01-01',
    },
  )!
  expect(pair.signals).toEqual(['url', 'filename', 'similarity'])
  expect(pair.score).toBe(0.98)
  expect(pair.reasons).toContain('Different publication dates: possible versions')
  expect(pair.reasons).toContain('Same source file name (file bytes have not been compared)')
  expect(matchItems(item, { ...item, id: 'two', title: item.title.toUpperCase() })!.signals)
    .toContain('title')
  expect(
    matchItems(item, {
      ...item,
      id: 'unrelated',
      title: 'Soil moisture',
      summary: 'Rainfall trials',
    }),
  )
    .toBeNull()
  expect(
    matchItems({ ...item, title: '', summary: '' }, { ...item, id: 'two', title: '', summary: '' }),
  )
    .toBeNull()
})

Deno.test('blocking finds each pair once, excludes within-collection overlap and reports bounded work', () => {
  const items = [item, { ...item, id: 'two' }, { ...item, id: 'three' }]
  expect(findCandidates(items).candidates).toHaveLength(3)
  const cross = findCandidates(items, 2)
  expect(cross.candidates).toHaveLength(2)
  expect(cross.candidates.every((p) => p.right.id === 'three')).toBe(true)
  const capped = findCandidates(Array.from({ length: 110 }, (_, i) => ({ ...item, id: String(i) })))
  expect(capped.limited).toBe(true)
  expect(capped.candidates).toHaveLength(5_000)
})

Deno.test('CSV includes pair counts and quotes formulas, quotes, newlines and delimiters', () => {
  const pair = matchItems({ ...item, title: '=SUM(1,2)\n"trial"' }, {
    ...item,
    id: 'two',
    title: '=SUM(1,2)\n"trial"',
  })!
  const csv = overlapCsv({
    generatedAt: '2026-10-28T00:00:00Z',
    page: 1,
    pageSize: 50,
    totalRows: 1,
    rows: [{
      left: 'first',
      right: 'second',
      leftCount: 1,
      rightCount: 1,
      sharedTitles: 1,
      sharedUrls: 0,
      highSimilarity: 1,
      matchingPairs: 1,
      limited: false,
      examples: [pair],
    }],
  })
  expect(csv).toContain('Shared title pairs')
  expect(csv).toContain('"\'=SUM(1,2)\n""trial""')
  expect(csv.endsWith('\r\n')).toBe(true)
})
