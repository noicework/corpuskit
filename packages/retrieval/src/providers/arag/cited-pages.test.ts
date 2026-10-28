import { expect } from '@std/expect'
import type { Citation } from '@research-portal/core'
import { type CitedParagraph, citeParagraphs, isFileParagraph } from './cited-pages.ts'

const citations: Citation[] = [
  { index: 1, resourceId: 'r1', title: 'Survey report' },
  { index: 2, resourceId: 'r2', title: 'Field notes' },
]

Deno.test('only a stored file paragraph has a page', () => {
  expect(isFileParagraph('r1/f/report/120-480')).toBe(true)
  expect(isFileParagraph('r1/f/report/0/120-480')).toBe(true)
  expect(isFileParagraph('r1/t/body/120-480')).toBe(false)
  expect(isFileParagraph('r1/l/page/0-90')).toBe(false)
  expect(isFileParagraph('r1/t/native_source')).toBe(false)
  expect(isFileParagraph('USER_CONTEXT_0')).toBe(false)
})

Deno.test('each citation takes the text and page of the paragraph the answer cited', () => {
  const paragraphs = new Map<string, CitedParagraph>([
    ['r1/f/report/0-120', { text: 'Opening summary.', page: 1 }],
    ['r1/f/report/900-1400', { text: 'Losses rose 12% over winter.', page: 7 }],
    ['r2/f/notes/0-80', { text: 'Hives inspected weekly.', page: 2 }],
  ])
  // r1's best-scoring paragraph may be its opening; the answer cited page 7.
  expect(citeParagraphs(citations, ['r1/f/report/900-1400', 'r2/f/notes/0-80'], paragraphs))
    .toEqual([
      {
        index: 1,
        resourceId: 'r1',
        title: 'Survey report',
        passage: 'Losses rose 12% over winter.',
        page: 7,
      },
      {
        index: 2,
        resourceId: 'r2',
        title: 'Field notes',
        passage: 'Hives inspected weekly.',
        page: 2,
      },
    ])
})

Deno.test('the first cited paragraph wins, and one with a page wins over one without', () => {
  const paragraphs = new Map<string, CitedParagraph>([
    ['r1/t/abstract/0-60', { text: 'Abstract text.' }],
    ['r1/f/report/900-1400', { text: 'Losses rose 12% over winter.', page: 7 }],
    ['r1/f/report/2000-2400', { text: 'A later finding.', page: 9 }],
  ])
  const [cited] = citeParagraphs(
    citations,
    ['r1/t/abstract/0-60', 'r1/f/report/900-1400', 'r1/f/report/2000-2400'],
    paragraphs,
  )
  expect(cited).toEqual({
    index: 1,
    resourceId: 'r1',
    title: 'Survey report',
    passage: 'Losses rose 12% over winter.',
    page: 7,
  })
  // With no paged paragraph cited, the first cited text still travels, with no page.
  const [unpaged] = citeParagraphs(citations, ['r1/t/abstract/0-60'], paragraphs)
  expect(unpaged).toEqual({
    index: 1,
    resourceId: 'r1',
    title: 'Survey report',
    passage: 'Abstract text.',
  })
})

Deno.test('a cited paragraph retrieval never returned leaves the citation as it was', () => {
  const paragraphs = new Map<string, CitedParagraph>([
    ['r1/f/report/0-120', { text: 'Opening summary.', page: 1 }],
  ])
  expect(
    citeParagraphs(citations, ['r1/t/native_source', 'r2', 'USER_CONTEXT_0'], paragraphs),
  ).toEqual(citations)
})

Deno.test('a long cited paragraph is trimmed to what the reader matches on', () => {
  const text = 'word '.repeat(1000)
  const paragraphs = new Map<string, CitedParagraph>([['r1/f/report/0-5000', { text, page: 3 }]])
  const [cited] = citeParagraphs(citations, ['r1/f/report/0-5000'], paragraphs)
  expect(cited?.passage?.length).toBe(2000)
  expect(cited?.page).toBe(3)
})
