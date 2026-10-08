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

Deno.test('developer guides render tables, resumed numbering, wrapped spans and indented fences', () => {
  expect(renderMarkdown('| Setting | Meaning |\n|---|---|\n| `A` | `{ "x": true \\| false }` |'))
    .toBe(
      '<div class="docs-table" role="region" aria-label="Table: Setting, Meaning" tabindex="0">' +
        '<table><thead><tr><th scope="col">Setting</th><th scope="col">Meaning</th></tr></thead>' +
        '<tbody><tr><td><code>A</code></td><td><code>{ &quot;x&quot;: true | false }</code></td>' +
        '</tr></tbody></table></div>',
    )
  // A list resumed after a code block keeps its numbering.
  expect(renderMarkdown('1. One\n\n   ```http\n   GET /\n   ```\n\n2. Two')).toBe(
    '<ol><li>One</li></ol>\n<pre><code>GET /</code></pre>\n<ol start="2"><li>Two</li></ol>',
  )
  // An item wraps onto indented lines, and a code span or bold run may wrap with it.
  expect(renderMarkdown('1. Run\n   `deno task\n   check`, **then\n   commit**.\n2. Push')).toBe(
    '<ol><li>Run <code>deno task check</code>, <strong>then commit</strong>.</li><li>Push</li></ol>',
  )
  // Three spaces nest under a numbered item; an arrow may end a line.
  expect(renderMarkdown('1. Call it:\n   - 200: done\n2. Read ->\n   the answer')).toBe(
    '<ol><li>Call it:<ul><li>200: done</li></ul></li><li>Read -&gt; the answer</li></ol>',
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
      '| A | B |',
      '---',
      '~~~\ncode\n~~~',
      '```\nunclosed',
      '- [x] task',
      '    indented code',
      '- parent\n  - child\n    - grandchild',
      '- first\n1. mixed',
      '- parent\n    - four spaces is deeper than one level',
      '| A | B |\n| - | - |\n| `unclosed | cell |',
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
