import { expect } from '@std/expect'
import type { Citation } from '@research-portal/core'
import {
  answerHtml,
  formatAuthors,
  inlineHtml,
  referenceEntries,
  referenceListHtml,
} from './answer-export.ts'

const citations: Citation[] = [
  { index: 2, resourceId: 'r2', title: 'Fenfluramine in Lennox-Gastaut syndrome' },
  { index: 1, resourceId: 'r1', title: 'Long-term safety of fenfluramine' },
]

const sources = [
  {
    id: 'r1',
    title: 'Long-term safety and efficacy of fenfluramine',
    authors: ['Knupp KG', 'Scheffer IE', 'Ceulemans B', 'Sullivan J'],
    journal: 'Epilepsia',
    year: '2023',
    doi: '10.1111/epi.17431',
  },
  { id: 'r2', title: 'Fenfluramine in Lennox-Gastaut syndrome' },
]

Deno.test('the export renders Markdown through the same block parser as the page (P9-12)', () => {
  const html = answerHtml(
    '### Efficacy\n\nSeizure frequency fell by **28.6%** [1] versus placebo [2].\n\n- Median reduction 26.5% [1]\n- Placebo 7.6% [2]\n\n| Arm | Change |\n|---|---|\n| 0.7 mg/kg | -28.6% |',
    citations,
  )
  expect(html).toContain('<h3>Efficacy</h3>')
  expect(html).toContain('<strong>28.6%</strong>')
  expect(html).toContain('<sup>[1]</sup>')
  expect(html).toContain('<ul><li>Median reduction 26.5% <sup>[1]</sup></li>')
  expect(html).toContain('<table><thead><tr><th>Arm</th><th>Change</th></tr></thead>')
  expect(html).not.toContain('###')
  expect(html).not.toContain('**')
})

Deno.test('unbound bracket numbers are dropped and inference is marked, as on the page', () => {
  expect(inlineHtml('as reported [16,17] and [9]', citations)).toBe('as reported  and ')
  expect(inlineHtml('likely [inference]', citations)).toBe('likely <em>(inference)</em>')
  expect(inlineHtml('a < b & c', [])).toBe('a &lt; b &amp; c')
})

Deno.test('references are numbered in marker order from the citation metadata', () => {
  const entries = referenceEntries(citations, sources)
  expect(entries.map((e) => e.index)).toEqual([1, 2])
  expect(entries[0]).toEqual({
    index: 1,
    resourceId: 'r1',
    title: 'Long-term safety and efficacy of fenfluramine',
    authors: ['Knupp KG', 'Scheffer IE', 'Ceulemans B', 'Sullivan J'],
    journal: 'Epilepsia',
    year: '2023',
    doi: '10.1111/epi.17431',
  })
  const html = referenceListHtml(
    citations,
    sources,
    (id) => `https://portal.test/t/x/library/${id}`,
  )
  expect(html).toContain('<h3>References</h3><ol>')
  expect(html).toContain('Knupp KG, Scheffer IE, Ceulemans B et al. <em>')
  expect(html).not.toContain('et al..')
  expect(html).toContain('<em>Long-term safety and efficacy of fenfluramine</em>. Epilepsia, 2023.')
  expect(html).toContain('<a href="https://doi.org/10.1111/epi.17431">')
  expect(html).toContain('<a href="https://portal.test/t/x/library/r2">Open in the portal</a>')
  // The second entry has no bibliographic record: title and link only, no dangling fields.
  expect(html).toContain('<li><em>Fenfluramine in Lennox-Gastaut syndrome</em>. <a href=')
})

Deno.test('a duplicate marker index yields one reference', () => {
  const entries = referenceEntries([...citations, citations[0]!], sources)
  expect(entries).toHaveLength(2)
  expect(referenceListHtml([], sources, (id) => id)).toBe('')
})

Deno.test('authors format for one, three and many', () => {
  expect(formatAuthors(['A'])).toBe('A')
  expect(formatAuthors(['A', 'B', 'C'])).toBe('A, B and C')
  expect(formatAuthors(['A', 'B', 'C', 'D'])).toBe('A, B, C et al.')
  expect(formatAuthors(undefined)).toBe('')
})
