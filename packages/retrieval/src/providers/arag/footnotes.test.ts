import { expect } from '@std/expect'
import { bindFootnotes, FootnoteStream, parseFootnoteAnswer } from './footnotes.ts'

/**
 * The single reason a citation was dropped. Binding never throws: the answer
 * has already reached the reader by then, so an unusable anchor costs its own
 * marker and nothing else.
 */
function dropReason(drops: readonly { reason: string; count: number }[]) {
  expect(drops.length).toBe(1)
  return drops[0]!.reason
}

const answer =
  '## Heading\n\n😀 A claim [6][7].\n\nAnother claim [6].\n\n[6]: block-AA\n[7]: block-BB\n'
const mapping = {
  type: 'footnote_citations',
  footnote_to_context: {
    'block-AA': 'doc/f/pdf/0-5',
    'block-BB': 'other/f/pdf/5-10',
  },
}

function finish(parts: string[]) {
  const stream = new FootnoteStream()
  let text = ''
  for (const part of parts) text += stream.consume({ type: 'answer', text: part })
  stream.consume(mapping)
  const result = stream.finish()
  expect(text + result.tail).toBe(result.text)
  return result
}

Deno.test('footnotes: append-only streaming and UTF-16 anchors at every split', () => {
  const expected = finish([answer])
  expect(expected.text).toBe('## Heading\n\n😀 A claim.\n\nAnother claim.\n\n')
  expect(expected.anchors.map((a) => a.pos)).toEqual([23, 23, 39])
  for (let i = 0; i <= answer.length; i++) {
    expect(finish([answer.slice(0, i), answer.slice(i)])).toEqual(expected)
  }
  expect(finish(Array.from(answer))).toEqual(expected)
})

Deno.test('footnotes: punctuation and adjacent markers, including inline colon regression', () => {
  for (
    const [prose, expected] of [
      ['Listen [6] .', 'Listen.'],
      ['Listen [6] [7] . Next.', 'Listen. Next.'],
      ['Principles [6] [7]:', 'Principles:'],
      ['“Listen” [6] .', '“Listen”.'],
      ['Listen [6], then act [7].', 'Listen, then act.'],
      ['Listen [6] to carers.', 'Listen to carers.'],
    ]
  ) {
    const raw = prose + '\n\n[6]: block-AA\n[7]: block-BB\n'
    const output = finish([raw])
    expect(output.text).toBe(expected + '\n\n')
    for (let i = 0; i <= raw.length; i++) {
      expect(finish([raw.slice(0, i), raw.slice(i)])).toEqual(output)
    }
    expect(finish(Array.from(raw))).toEqual(output)
  }
})

Deno.test('footnotes: code, escaped brackets and Markdown links remain literal', () => {
  const tick = String.fromCharCode(96)
  const code = tick + '[1]' + tick
  const fence = tick.repeat(3)
  const raw = 'Code ' + code + ' and [2](https://example.test) and \\[3]. Real[^6].\n' +
    fence + 'txt\n[5]: block-ZZ\n' + fence + '\n[^6]: block-AA\n'
  const out = finish(Array.from(raw))
  expect(out.anchors.length).toBe(1)
  expect(out.text).toContain(code)
  expect(out.text).toContain('[2](https://example.test)')
  expect(out.text).toContain('[5]: block-ZZ')
  expect(parseFootnoteAnswer('See [7](https://example.test):').text)
    .toBe('See [7](https://example.test):')
})

Deno.test('footnotes: missing, conflicting and malformed mappings anchor nothing', () => {
  for (
    const raw of [
      'Claim[6].',
      'Claim[6].\n[6]: block-MISSING\n',
      'Claim[6].\n[6]: https://evil.test\n',
    ]
  ) {
    const result = finish([raw])
    expect(result.anchors).toEqual([])
    expect(result.drops.length).toBeGreaterThan(0)
    // The prose survives and the wire syntax never leaks into it.
    expect(result.text).toContain('Claim')
    expect(result.text).not.toContain('block-')
    expect(result.text).not.toContain('evil.test')
  }
  // A redefinition is refused rather than honoured: the first definition of a
  // number stands, so a later line cannot repoint a citation the reader has
  // already seen.
  const redefined = finish(['Claim[6].\n[6]: block-AA\n[6]: block-BB\n'])
  expect(redefined.anchors.map((a) => a.id)).toEqual(['doc/f/pdf/0-5'])
  expect(dropReason(redefined.drops)).toBe('conflicting_definition')
  const stream = new FootnoteStream()
  stream.consume(mapping)
  stream.consume({
    type: 'footnote_citations',
    footnote_to_context: { 'block-AA': 'different/f/pdf/0-5' },
  })
  stream.consume({ type: 'footnote_citations', footnote_to_context: [] })
  stream.consume({ type: 'answer', text: answer })
  const finished = stream.finish()
  // The conflicting remap is refused, so block-AA keeps its first identity.
  expect(finished.anchors[0]!.id).toBe('doc/f/pdf/0-5')
  expect(finished.drops.map((d) => d.reason).sort()).toEqual(
    ['conflicting_mapping', 'invalid_mapping'],
  )
})

Deno.test('footnotes: canonical numbering follows claims, not wire numbers or headings', () => {
  const bound = bindFootnotes(finish([answer]), () => true, (id) => id + ' title')
  expect(bound.text).toBe('## Heading\n\n😀 A claim.[1][2]\n\nAnother claim.[1]\n\n')
  expect(bound.citations).toEqual([
    { index: 1, resourceId: 'doc', title: 'doc title' },
    { index: 2, resourceId: 'other', title: 'other title' },
  ])
})

Deno.test('footnotes: resource numbering stays compatible with CorpusKit evidence cards', () => {
  const parsed = finish([answer])
  parsed.anchors[1]!.id = 'doc/f/pdf/5-10'
  const bound = bindFootnotes(parsed, () => true, () => 'Report')
  expect(bound.citations.length).toBe(1)
  expect(bound.text).toContain('claim.[1]\n')
  expect(bound.text).not.toContain('[1][1]')
})

Deno.test('footnotes: excluded and anonymous extra-context references cannot bind', () => {
  for (
    const id of [
      'excluded/f/pdf/0-5',
      'USER_CONTEXT_0',
      'javascript:alert(1)',
    ]
  ) {
    const parsed = finish([answer])
    parsed.anchors[0]!.id = id
    const bound = bindFootnotes(parsed, (rid) => rid !== 'excluded', () => 'Report')
    // The unusable anchor is gone; the answer and its good citations stand.
    // `doc` still binds through the third anchor, which was never touched.
    expect(bound.drops.length).toBe(1)
    expect(bound.citations.map((c) => c.resourceId)).toEqual(['other', 'doc'])
    expect(bound.text).toContain('A claim.')
  }
})

Deno.test('footnotes: a data-augmentation anchor cites the resource that owns it', () => {
  const parsed = finish([answer])
  parsed.anchors[0]!.id = 'doc/t/da-summary/0-5'
  const bound = bindFootnotes(parsed, () => true, (id) => id + ' title')
  // `doc` is a real resource: the generated field belongs to it, so the reader
  // is sent to the document rather than losing the answer.
  expect(bound.citations).toEqual([
    { index: 1, resourceId: 'doc', title: 'doc title' },
    { index: 2, resourceId: 'other', title: 'other title' },
  ])
  expect(dropReason(bound.drops)).toBe('generated_context')
})

Deno.test('footnotes: a generated anchor outside scope is still refused', () => {
  const parsed = finish([answer])
  parsed.anchors[0]!.id = 'excluded/t/da-summary/0-5'
  const bound = bindFootnotes(parsed, (rid) => rid !== 'excluded', () => 'Report')
  // `excluded` never appears, generated field or not. `doc` binds through the
  // untouched third anchor.
  expect(bound.citations.map((c) => c.resourceId)).toEqual(['other', 'doc'])
  expect(bound.drops.map((d) => d.reason).sort()).toEqual(['generated_context', 'out_of_scope'])
})

Deno.test('footnotes: mapping can arrive before, after or between answer chunks', () => {
  const stream = new FootnoteStream()
  stream.consume(mapping)
  stream.consume({ type: 'answer', text: answer.slice(0, 15) })
  stream.consume(mapping)
  stream.consume({ type: 'answer', text: answer.slice(15) })
  expect(stream.finish()).toEqual(finish([answer]))
})

Deno.test('footnotes: degradation diagnostics distinguish definitions from mappings', () => {
  for (
    const [raw, reason] of [
      ['Claim[6].', 'missing_definition'],
      ['Claim[6].\n[6]: block-MISSING\n', 'missing_mapping'],
      ['Claim[6].\n[6]: block-AA\n[6]: block-BB\n', 'conflicting_definition'],
      ['Claim[6].\n[6]: invalid-private-value\n', 'invalid_definition'],
      ['Claim[6].\n[6]: block-AA another-value\n', 'invalid_definition'],
    ]
  ) {
    const drops = finish([raw!]).drops
    expect(drops.map((d) => d.reason)).toContain(reason)
  }

  const stream = new FootnoteStream()
  stream.consume(mapping)
  stream.consume({ type: 'footnote_citations' })
  stream.consume({
    type: 'footnote_citations',
    footnote_to_context: { 'block-AA': { secret: 'private-value' } },
  })
  stream.consume({
    type: 'footnote_citations',
    footnote_to_context: { 'block-AA': 'private-source/f/pdf/0-5' },
  })
  const drops = stream.finish().drops
  expect(drops.find((d) => d.reason === 'invalid_mapping')?.count).toBe(2)
  expect(drops.find((d) => d.reason === 'conflicting_mapping')?.count).toBe(1)
})

Deno.test('footnotes: context classifications stay distinct when a citation is dropped', () => {
  for (
    const [id, reason] of [
      ['USER_CONTEXT_0', 'anonymous_context'],
      ['doc/t/da-private-summary/0-5', 'generated_context'],
      ['doc/a/title', 'metadata_context'],
      ['doc/a/summary/0-5', 'metadata_context'],
      ['excluded/f/pdf/0-5', 'out_of_scope'],
      ['private-unsupported-context', 'unsupported_context'],
    ]
  ) {
    const parsed = finish([answer])
    parsed.anchors[0]!.id = id!
    const bound = bindFootnotes(parsed, (rid) => rid !== 'excluded', () => 'Report')
    expect(dropReason(bound.drops)).toBe(reason)
    // A classification never carries the id, the block or the answer text.
    expect(JSON.stringify(bound.drops)).not.toContain(id!)
  }
})
