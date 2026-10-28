import { expect } from '@std/expect'
import {
  buildSuggestions,
  flattenSuggestions,
  highlightRuns,
  matchText,
  type SuggestSources,
} from './search-suggest.ts'

const SOURCES: SuggestSources = {
  documents: [
    { id: 'd1', title: 'Colony loss rates across managed hives', kind: 'research-report' },
    { id: 'd2', title: 'Winter colony survival and loss', type: 'pdf' },
    { id: 'd3', title: 'Pollination services in orchards' },
    { id: 'd4', title: 'Colony health monitoring guide' },
    { id: 'd5', title: 'Varroa mite and colony collapse' },
    { id: 'd6', title: 'Colony' },
    { id: 'd7', title: 'Recolonising empty hives' },
  ],
  topics: [
    { id: 'colony-health', label: 'Colony health' },
    { id: 'pollination', label: 'Pollination' },
  ],
  questions: [
    { id: 'q1', text: 'What colony loss rates were reported last winter?' },
    { id: 'q2', text: 'How does pollination affect orchard yield?' },
  ],
}

Deno.test('matchText ranks the whole text, a prefix, a word start, then a substring', () => {
  const exact = matchText('Colony', 'colony')!
  const prefix = matchText('Colony health', 'colony')!
  const word = matchText('Winter colony survival', 'colony')!
  const inside = matchText('Recolonising hives', 'colon')!
  expect(exact.score).toBeGreaterThan(prefix.score)
  expect(prefix.score).toBeGreaterThan(word.score)
  expect(word.score).toBeGreaterThan(inside.score)
  expect(word.ranges).toEqual([[7, 13]])
  expect(inside.ranges).toEqual([[2, 7]])
})

Deno.test('matchText ignores case and spacing, and needs a word start for two letters', () => {
  expect(matchText('Colony Loss', '  COLONY   loss ')!.ranges).toEqual([[0, 11]])
  expect(matchText('Habitat survey', 'ab')).toBeNull()
  expect(matchText('Abalone survey', 'ab')!.ranges).toEqual([[0, 2]])
  expect(matchText('Anything', ' ')).toBeNull()
})

Deno.test('matchText matches every word of a query in any order', () => {
  const match = matchText('Colony loss rates across managed hives', 'hives colony')!
  expect(match).not.toBeNull()
  expect(match.ranges).toEqual([[0, 6], [33, 38]])
  expect(matchText('Colony loss rates', 'colony bees')).toBeNull()
})

Deno.test('matchText finds a match inside text written without spaces', () => {
  expect(matchText('養蜂の群れの損失率', '損失')!.ranges).toEqual([[6, 8]])
})

Deno.test('buildSuggestions is empty below two characters', () => {
  expect(buildSuggestions(SOURCES, 'c')).toEqual([])
  expect(buildSuggestions(SOURCES, '   ')).toEqual([])
})

Deno.test('buildSuggestions leads with search then ask, and caps the list at eight rows', () => {
  const groups = buildSuggestions(SOURCES, 'colony')
  expect(groups.map((group) => group.id)).toEqual(['actions', 'documents', 'topics', 'questions'])
  expect(groups[0]!.items).toEqual([
    { type: 'search', text: 'colony' },
    { type: 'ask', text: 'colony' },
  ])
  const rows = flattenSuggestions(groups)
  expect(rows.length).toBe(8)
  // Four documents, best first: the exact title, then the prefixes (shorter first), then a word
  // start. The substring match inside "Recolonising" does not make the cut.
  const documents = groups[1]!.items.map((item) => item.type === 'document' ? item.id : '')
  expect(documents).toEqual(['d6', 'd4', 'd1', 'd2'])
  expect(groups[2]!.items).toEqual([
    { type: 'topic', id: 'colony-health', text: 'Colony health', ranges: [[0, 6]] },
  ])
  expect(groups[3]!.items.map((item) => item.type === 'question' ? item.id : '')).toEqual(['q1'])
})

Deno.test('buildSuggestions keeps the document kind and type for the secondary text', () => {
  const groups = buildSuggestions(SOURCES, 'loss rates')
  const documents = groups.find((group) => group.id === 'documents')!.items
  expect(documents[0]).toEqual({
    type: 'document',
    id: 'd1',
    text: 'Colony loss rates across managed hives',
    ranges: [[7, 17]],
    kind: 'research-report',
  })
})

Deno.test('buildSuggestions gives free rows to whichever lists still have matches', () => {
  const groups = buildSuggestions(SOURCES, 'pollination')
  expect(groups.map((group) => [group.id, group.items.length])).toEqual([
    ['actions', 2],
    ['documents', 1],
    ['topics', 1],
    ['questions', 1],
  ])
  const many: SuggestSources = {
    documents: Array.from({ length: 20 }, (_, index) => ({
      id: `d${index}`,
      title: `Soil carbon study ${index}`,
    })),
    topics: [],
    questions: [],
  }
  const documentsOnly = buildSuggestions(many, 'soil')
  expect(documentsOnly[1]!.items.length).toBe(6)
  expect(flattenSuggestions(documentsOnly).length).toBe(8)
})

Deno.test('buildSuggestions puts ask first for an ask field', () => {
  const groups = buildSuggestions(SOURCES, 'orchard yield', { primary: 'ask' })
  expect(groups[0]!.items.map((item) => item.type)).toEqual(['ask', 'search'])
  expect(groups[0]!.items[0]!.text).toBe('orchard yield')
})

Deno.test('buildSuggestions still offers search and ask when nothing matches', () => {
  const groups = buildSuggestions(SOURCES, 'zebra mussels')
  expect(groups.map((group) => group.id)).toEqual(['actions'])
})

Deno.test('highlightRuns splits text into plain and matched runs', () => {
  expect(highlightRuns('Winter colony loss', [[7, 13]])).toEqual([
    { text: 'Winter ', match: false },
    { text: 'colony', match: true },
    { text: ' loss', match: false },
  ])
  expect(highlightRuns('Colony', [[0, 6]])).toEqual([{ text: 'Colony', match: true }])
  expect(highlightRuns('Colony', [])).toEqual([{ text: 'Colony', match: false }])
  // An out-of-range span is skipped rather than drawn in the wrong place.
  expect(highlightRuns('Colony', [[4, 12]])).toEqual([{ text: 'Colony', match: false }])
})
