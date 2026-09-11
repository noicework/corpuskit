import { expect } from '@std/expect'
import type { Citation, TenantConfig } from '@research-portal/core'
import { captureAuthoredGroups, compactAuthoredGroups } from './authored-citation-groups.ts'
import { bindSentences, renderBound } from './citation-binding.ts'
import { gateFigures } from './answer-gate.ts'
import { bindAndAudit } from './ask-grounding.ts'

const statements = [
  'The portal helps readers explore the research collection.',
  'Readers can open sources to check the supporting evidence.',
  'The library provides searchable documents for further reading.',
]
const source = statements.join(' ')
const citations: Citation[] = [{ index: 7, resourceId: 'manual', title: 'Portal guide' }]
const texts = new Map([[7, source]])

function fixture(text = `${source}[7]`, sourceTexts = texts) {
  const bound = bindSentences({ text, citations, texts: sourceTexts, keepNumbering: true })
  const groups = captureAuthoredGroups(bound, sourceTexts, [])
  return { bound, groups }
}

Deno.test('authored paragraph group survives gate renumbering without changing sentence audit bindings', () => {
  const { bound, groups } = fixture()
  expect(groups.length).toBe(1)
  expect(bound.sentences.map((s) => s.bound)).toEqual([[7], [7], [7]])
  const gated = gateFigures(bound, [], [])
  expect(gated.sentences.map((s) => s.bound)).toEqual([[1], [1], [1]])
  expect(compactAuthoredGroups(gated.text, groups, gated.sentences, gated.citations))
    .toBe(`${source}[1]`)
})

Deno.test('multi-source authored groups compare support sets independent of sentence ranking order', () => {
  const allCitations = [...citations, { index: 8, resourceId: 'second', title: 'Second guide' }]
  const allTexts = new Map([[7, source], [8, source]])
  const bound = bindSentences({
    text: `${source}[7][8]`,
    citations: allCitations,
    texts: allTexts,
    keepNumbering: true,
  })
  // Sentence relevance can rank the same supporting resources differently.
  bound.sentences[1]!.bound = [8, 7]
  const groups = captureAuthoredGroups(bound, allTexts, [])
  expect(groups.length).toBe(1)
  const rendered = renderBound(bound.layout, bound.sentences, new Set())
  expect(compactAuthoredGroups(rendered, groups, bound.sentences, bound.citations))
    .toBe(`${source}[7][8]`)
  expect(bound.sentences[1]!.bound).toEqual([8, 7])
})

Deno.test('explicit repeated inline markers and separate paragraph/bullet groups are not merged', () => {
  expect(fixture(statements.map((s) => `${s}[7]`).join(' ')).groups).toEqual([])
  expect(fixture([...statements, ...statements.slice(0, 2)].join(' ') + '[7]').groups).toEqual([])
  const bullets = `- ${statements.slice(0, 2).join(' ')}[7]\n- ${statements.slice(1).join(' ')}[7]`
  const separate = fixture(bullets)
  expect(separate.groups.length).toBe(2)
  expect(compactAuthoredGroups(
    separate.bound.text,
    separate.groups,
    separate.bound.sentences,
    separate.bound.citations,
  )).toBe(bullets)
  for (const separator of ['\n\n', '\n- ']) {
    const first = statements.slice(0, 2).join(' ')
    const authored = `${separator.includes('-') ? '- ' : ''}${first}[7]${separator}${first}[7]`
    const { bound, groups } = fixture(authored)
    // Identical rendered lines are deliberately ambiguous; no accidental cross-block removal.
    expect(compactAuthoredGroups(bound.text, groups, bound.sentences, bound.citations))
      .toBe(bound.text)
  }
})

Deno.test('an unrelated preceding removal and renumbering leave a verified later group intact', () => {
  const allCitations = [{ index: 1, resourceId: 'other', title: 'Other' }, ...citations]
  const first = 'The collection has 99 documents.'
  const allTexts = new Map([[1, first], ...texts])
  const bound = bindSentences({
    text: `${first}[1]\n\n${source}[7]`,
    citations: allCitations,
    texts: allTexts,
    keepNumbering: true,
  })
  const groups = captureAuthoredGroups(bound, allTexts, [])
  expect(groups.length).toBe(1)
  const gated = gateFigures(bound, [{
    sentence: first,
    figure: '99',
    supported: false,
    supportedBy: [],
    reason: 'absent',
  }], [])
  expect(gated.removed.length).toBe(1)
  expect(compactAuthoredGroups(gated.text, groups, gated.sentences, gated.citations).trim())
    .toBe(`${source}[1]`)
})

Deno.test('quotes statistics findings absent source text and different supporting passages prevent grouping', () => {
  for (
    const special of [
      'The guide says "readers can check the supporting evidence".',
      'The library provides 25 searchable documents for further reading.',
      'The study found readers could check the supporting evidence.',
    ]
  ) {
    const prose = `${statements[0]} ${special}`
    expect(fixture(`${prose}[7]`, new Map([[7, prose]])).groups).toEqual([])
  }
  expect(fixture(undefined, new Map()).groups).toEqual([])
  const separatePassages = statements.map((s) => `${s} This source paragraph contains guidance.`)
    .join('\n\n')
  expect(fixture(undefined, new Map([[7, separatePassages]])).groups).toEqual([])
})

Deno.test('changed removed unsupported or rebound members invalidate the complete authored group', () => {
  for (const change of ['changed', 'removed', 'unsupported', 'rebound']) {
    const { bound, groups } = fixture()
    const current = bound.sentences.map((s) => ({ ...s, bound: [...s.bound] }))
    const removed = new Set<number>()
    const finalCitations = [...bound.citations]
    if (change === 'changed') current[0]!.text = 'A changed claim has different implications.'
    if (change === 'removed') removed.add(0)
    if (change === 'unsupported') current[0]!.bound = []
    if (change === 'rebound') {
      current[0]!.bound = [8]
      finalCitations.push({ index: 8, resourceId: 'another', title: 'Other source' })
    }
    const rendered = renderBound(bound.layout, current, removed)
    expect(compactAuthoredGroups(
      rendered,
      groups,
      current.filter((_, i) => !removed.has(i)),
      finalCitations,
    )).toBe(rendered)
    // A rewrite of the final text alone cannot be compacted using stale sentence metadata either.
    expect(
      compactAuthoredGroups('Completely rewritten answer.[7]', groups, bound.sentences, citations),
    )
      .toBe('Completely rewritten answer.[7]')
  }
})

Deno.test('full bindAndAudit keeps one authored group and all three audited sentence bindings only when opted in', async () => {
  for (const enabled of [false, true]) {
    const result = await bindAndAudit({
      ...(enabled ? { citationPresentation: 'authored_blocks' as const } : {}),
      management: { resourceExtraction: () => Promise.resolve({ text: source }) },
      config: { slug: `citation-group-${crypto.randomUUID()}` } as TenantConfig,
      query: 'How does the research portal help readers?',
      text: `${source}[7]`,
      citations,
      sources: [],
      lexicon: [],
      variant: undefined,
      floor: 0.35,
    })
    expect(result.audit.sentencesChecked).toBe(3)
    expect(result.audit.sentencesCited).toBe(3)
    expect(result.text).toBe(enabled ? `${source}[1]` : statements.map((s) => `${s}[1]`).join(' '))
    expect(result.citations).toEqual([{ ...citations[0]!, index: 1 }])
  }
})
