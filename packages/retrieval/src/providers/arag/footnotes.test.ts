import { expect } from '@std/expect'
import { bindFootnotes, FootnoteError, FootnoteStream, parseFootnoteAnswer } from './footnotes.ts'

function failureReason(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (!(error instanceof FootnoteError)) throw error
    expect(error.message).toBe(
      'The response citation links could not be verified. Please try again.',
    )
    return error.reason
  }
  throw new Error('Expected footnote validation to fail')
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

Deno.test('footnotes: missing, conflicting and malformed mappings fail closed', () => {
  for (
    const raw of [
      'Claim[6].',
      'Claim[6].\n[6]: block-MISSING\n',
      'Claim[6].\n[6]: block-AA\n[6]: block-BB\n',
      'Claim[6].\n[6]: https://evil.test\n',
    ]
  ) expect(() => finish([raw])).toThrow(FootnoteError)
  const stream = new FootnoteStream()
  stream.consume(mapping)
  expect(() =>
    stream.consume({
      type: 'footnote_citations',
      footnote_to_context: {
        'block-AA': 'different/f/pdf/0-5',
      },
    })
  ).toThrow(FootnoteError)
  expect(() => stream.consume({ type: 'footnote_citations', footnote_to_context: [] }))
    .toThrow(FootnoteError)
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
    expect(() => bindFootnotes(parsed, (rid) => rid !== 'excluded', () => 'Report'))
      .toThrow(FootnoteError)
  }
})

Deno.test('footnotes: mapping can arrive before, after or between answer chunks', () => {
  const stream = new FootnoteStream()
  stream.consume(mapping)
  stream.consume({ type: 'answer', text: answer.slice(0, 15) })
  stream.consume(mapping)
  stream.consume({ type: 'answer', text: answer.slice(15) })
  expect(stream.finish()).toEqual(finish([answer]))
})

Deno.test('footnotes: validation diagnostics distinguish definitions from mappings', () => {
  for (
    const [raw, reason] of [
      ['Claim[6].', 'missing_definition'],
      ['Claim[6].\n[6]: block-MISSING\n', 'missing_mapping'],
      ['Claim[6].\n[6]: block-AA\n[6]: block-BB\n', 'conflicting_definition'],
      ['Claim[6].\n[6]: invalid-private-value\n', 'invalid_definition'],
      ['Claim[6].\n[6]: block-AA another-value\n', 'invalid_definition'],
    ]
  ) expect(failureReason(() => finish([raw!]))).toBe(reason)

  const stream = new FootnoteStream()
  stream.consume(mapping)
  expect(failureReason(() => stream.consume({ type: 'footnote_citations' })))
    .toBe('invalid_mapping')
  expect(failureReason(() =>
    stream.consume({
      type: 'footnote_citations',
      footnote_to_context: { 'block-AA': { secret: 'private-value' } },
    })
  )).toBe('invalid_mapping')
  expect(failureReason(() =>
    stream.consume({
      type: 'footnote_citations',
      footnote_to_context: { 'block-AA': 'private-source/f/pdf/0-5' },
    })
  )).toBe('conflicting_mapping')
})

Deno.test('footnotes: context failure classifications do not loosen citation validation', () => {
  for (
    const [id, reason] of [
      ['USER_CONTEXT_0', 'anonymous_context'],
      ['doc/a/title', 'metadata_context'],
      ['doc/a/summary/0-5', 'metadata_context'],
      ['excluded/f/pdf/0-5', 'out_of_scope'],
      ['private-unsupported-context', 'unsupported_context'],
    ]
  ) {
    const parsed = finish([answer])
    parsed.anchors[0]!.id = id!
    expect(failureReason(() => bindFootnotes(parsed, (rid) => rid !== 'excluded', () => 'Report')))
      .toBe(reason)
    // A generated-summary reference elsewhere in the same answer, bound or
    // dropped, never masks the failure.
    for (const generated of ['other/t/da-summary/0-5', 'excluded/t/da-summary/0-5']) {
      const mixed = finish([answer])
      mixed.anchors[0]!.id = id!
      mixed.anchors[1]!.id = generated
      expect(
        failureReason(() => bindFootnotes(mixed, (rid) => rid !== 'excluded', () => 'Report')),
      ).toBe(reason)
    }
  }
})

// A reference to a data-augmentation field: a generated summary of a
// document, not the document. It binds to that resource or is dropped.
const generatedAnswer = 'First claim [1].\n\nSecond claim [2].\n\nThird claim [3].\n\n' +
  '[1]: block-AA\n[2]: block-BB\n[3]: block-CC\n'

function bindGenerated(contexts: Record<string, string>, citable = (rid: string) => rid !== 'out') {
  const stream = new FootnoteStream()
  stream.consume({ type: 'answer', text: generatedAnswer })
  stream.consume({ type: 'footnote_citations', footnote_to_context: contexts })
  return bindFootnotes(stream.finish(), citable, (id) => `${id} title`)
}

/** Every marker resolves to a citation, and the citations are numbered 1..n with no gaps. */
function expectConsistentNumbering(bound: ReturnType<typeof bindFootnotes>) {
  const markers = [...bound.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
  const indices = bound.citations.map((c) => c.index)
  expect(indices).toEqual(indices.map((_, i) => i + 1))
  expect(markers.every((m) => indices.includes(m))).toBe(true)
  expect(indices.every((i) => markers.includes(i))).toBe(true)
}

Deno.test('footnotes: a generated-summary reference binds to its citable resource, never as a quote', () => {
  const bound = bindGenerated({
    'block-AA': 'doc/f/pdf/0-5',
    'block-BB': 'summarised/t/da-summary/0-40',
    'block-CC': 'doc/f/pdf/9-14',
  })
  expect(bound.text).toBe('First claim.[1]\n\nSecond claim.[2]\n\nThird claim.[1]\n\n')
  // Resource level only: no passage, so the generated text is never shown as the source's words.
  expect(bound.citations).toEqual([
    { index: 1, resourceId: 'doc', title: 'doc title' },
    { index: 2, resourceId: 'summarised', title: 'summarised title' },
  ])
  expect(bound.generated).toEqual({ remapped: 1, dropped: 0 })
  expectConsistentNumbering(bound)
})

Deno.test('footnotes: a generated-summary reference reuses the number its resource already has', () => {
  for (
    const contexts of [
      // The document's own text is cited first, its summary later.
      { 'block-AA': 'doc/f/pdf/0-5', 'block-BB': 'doc/t/da-summary/0-40' },
      // The summary is cited first: the document's later text shares its number.
      { 'block-AA': 'doc/t/da-summary/0-40', 'block-BB': 'doc/f/pdf/0-5' },
    ]
  ) {
    const bound = bindGenerated({ ...contexts, 'block-CC': 'other/f/pdf/0-5' })
    expect(bound.text).toBe('First claim.[1]\n\nSecond claim.[1]\n\nThird claim.[2]\n\n')
    expect(bound.citations.map((c) => c.resourceId)).toEqual(['doc', 'other'])
    expect(bound.generated).toEqual({ remapped: 1, dropped: 0 })
    expectConsistentNumbering(bound)
  }
})

Deno.test('footnotes: a generated-summary reference to a resource that is not citable is dropped', () => {
  const bound = bindGenerated({
    'block-AA': 'doc/f/pdf/0-5',
    'block-BB': 'out/t/da-summary/0-40',
    'block-CC': 'other/f/pdf/0-5',
  })
  // No marker where the dropped reference stood, and no gap in the numbering.
  expect(bound.text).toBe('First claim.[1]\n\nSecond claim.\n\nThird claim.[2]\n\n')
  expect(bound.citations.map((c) => c.resourceId)).toEqual(['doc', 'other'])
  expect(bound.generated).toEqual({ remapped: 0, dropped: 1 })
  expectConsistentNumbering(bound)

  const only = bindGenerated({
    'block-AA': 'out/t/da-summary/0-40',
    'block-BB': 'out/t/da-takeaways/0-12',
    'block-CC': 'out/t/da-summary/41-90',
  })
  expect(only.text).toBe('First claim.\n\nSecond claim.\n\nThird claim.\n\n')
  expect(only.citations).toEqual([])
  expect(only.generated).toEqual({ remapped: 0, dropped: 3 })
})

Deno.test('footnotes: a mixed answer keeps one number per resource and no dead markers', () => {
  const stream = new FootnoteStream()
  stream.consume({
    type: 'answer',
    text: 'Stocks fell [1][2]. Closures followed [3]. Recovery took years [4][5].\n\n' +
      'Monitoring continues [2][6].\n\n' +
      '[1]: block-A1\n[2]: block-A2\n[3]: block-A3\n[4]: block-A4\n[5]: block-A5\n[6]: block-A6\n',
  })
  stream.consume({
    type: 'footnote_citations',
    footnote_to_context: {
      'block-A1': 'out/t/da-summary/0-10',
      'block-A2': 'survey/t/da-summary/0-10',
      'block-A3': 'closure/f/pdf/0-10',
      'block-A4': 'survey/f/pdf/20-40',
      'block-A5': 'out/t/da-takeaways/0-10',
      'block-A6': 'closure/t/da-summary/0-10',
    },
  })
  const bound = bindFootnotes(stream.finish(), (rid) => rid !== 'out', (id) => `${id} title`)
  expect(bound.text).toBe(
    'Stocks fell.[1] Closures followed.[2] Recovery took years.[1]\n\nMonitoring continues.[1][2]\n\n',
  )
  expect(bound.citations).toEqual([
    { index: 1, resourceId: 'survey', title: 'survey title' },
    { index: 2, resourceId: 'closure', title: 'closure title' },
  ])
  // Counted per reference: [2] is used twice.
  expect(bound.generated).toEqual({ remapped: 3, dropped: 2 })
  expectConsistentNumbering(bound)
})
