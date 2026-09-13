import { expect } from '@std/expect'
import { DOC_PAGES } from '../../../packages/core/src/docs.ts'
import { headingIds, renderInline, renderMarkdown } from './docs-markdown.ts'

Deno.test('every authored documentation section uses recognised, renderable syntax', async (t) => {
  for (const page of DOC_PAGES) {
    for (const section of page.sections) {
      await t.step(`${page.id}: ${section.heading}`, () => {
        expect(renderMarkdown(section.body).length).toBeGreaterThan(0)
      })
    }
  }
})

Deno.test('documentation renders headings, paragraphs, emphasis, code, lists and safe links', () => {
  expect(renderInline('**Bold** and *italic*, __bold__ and _italic_, `a < b`.')).toBe(
    '<strong>Bold</strong> and <em>italic</em>, <strong>bold</strong> and <em>italic</em>, <code>a &lt; b</code>.',
  )
  expect(renderInline('[A & B](https://demo.corpuskit.org?q=1&x=2) [1]')).toBe(
    '<a href="https://demo.corpuskit.org?q=1&amp;x=2">A &amp; B</a> [1]',
  )
  expect(renderMarkdown('### Heading\n\nA paragraph.\n\n- One\n  - Child\n- Two')).toBe(
    '<h3 id="heading">Heading</h3>\n<p>A paragraph.</p>\n<ul><li>One<ul><li>Child</li></ul></li><li>Two</li></ul>',
  )
  expect(renderMarkdown('1. First\n2. Second')).toBe('<ol><li>First</li><li>Second</li></ol>')
  expect(renderMarkdown('```json\n{"key": "<secret>"}\n```')).toBe(
    '<pre><code>{&quot;key&quot;: &quot;&lt;secret&gt;&quot;}</code></pre>',
  )
  expect(renderMarkdown('First paragraph.\n\nSecond paragraph.')).toBe(
    '<p>First paragraph.</p>\n<p>Second paragraph.</p>',
  )
})

Deno.test('new or malformed Markdown fails loudly rather than shipping raw or lost syntax', () => {
  for (
    const source of [
      'A setext heading\n===',
      '**Unclosed',
      '`unclosed',
      '~~strike~~',
      '[reference][id]',
      '![image](/image.png)',
      '<script>alert(1)</script>',
      '> quote',
      '| A | B |\n| - | - |',
      '---',
      '~~~\ncode\n~~~',
      '```\nunclosed',
      '- [x] task',
      '    indented code',
      '- parent\n  - child\n    - grandchild',
      '- first\n1. mixed',
      '4. Starts at four',
    ]
  ) expect(() => renderMarkdown(source)).toThrow()
  for (
    const href of ['javascript:alert', 'data:text/html,test', '//example.org', '/\\example.org']
  ) {
    expect(() => renderInline(`[link](${href})`)).toThrow()
  }
})

Deno.test('heading anchors are stable and unique, including colliding numeric suffixes', () => {
  const id = headingIds()
  expect(['A heading!', 'A heading', 'A heading 2', 'A heading'].map(id)).toEqual([
    'a-heading',
    'a-heading-2',
    'a-heading-2-2',
    'a-heading-3',
  ])
})
