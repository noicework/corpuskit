import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceDisclosure } from './AnswerStream.tsx'

Deno.test('evidence disclosure keeps its labelled target while mounting content only when open', () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(
      <EvidenceDisclosure
        regionId='answer-sources'
        open={open}
        onToggle={() => {}}
        label='sources and evidence'
        summary='7 sources · 3 cited'
        heading
      >
        <p>Retrieved source passages</p>
      </EvidenceDisclosure>,
    )
    expect(html).toContain('aria-controls="answer-sources"')
    expect(html).toContain('id="answer-sources"')
    expect(html).toContain(`aria-expanded="${open}"`)
    expect(html).toContain(`${open ? 'Hide' : 'Show'} sources and evidence`)
    expect(html).toContain('7 sources · 3 cited')
    expect(html).toContain('<h3 ')
    if (open) {
      expect(html).toContain('Retrieved source passages')
      expect(html).not.toContain('hidden=""')
    } else {
      expect(html).not.toContain('Retrieved source passages')
      expect(html).toContain('hidden=""')
    }
  }
})
