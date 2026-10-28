import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Citation, ScoredResource } from '@research-portal/core'
import { citationLink, citationTarget, EvidenceDisclosure } from './AnswerStream.tsx'

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

const source: ScoredResource = {
  id: 'r1',
  title: 'Survey report',
  summary: 'A winter survey.',
  type: 'pdf',
  topicIds: [],
  keyFacts: [],
  relevance: 0.8,
  citedCount: 1,
  matchedPassage: 'The opening summary of the survey.',
  matchedPage: 1,
}

Deno.test('a citation opens at the paragraph it cited and that paragraph’s page', () => {
  const citation: Citation = {
    index: 1,
    resourceId: 'r1',
    title: 'Survey report',
    passage: 'Losses rose 12% over winter.',
    page: 7,
  }
  expect(citationTarget(citation, source)).toEqual({
    passage: 'Losses rose 12% over winter.',
    page: 7,
  })
  expect(citationLink('marine', citation, source)).toBe(
    `/t/marine/library/r1?passage=${encodeURIComponent('Losses rose 12% over winter.')}&page=7`,
  )
  // A cited passage with no page never borrows the source's page: it would
  // open on a page that does not carry the highlight.
  const { page: _page, ...unpaged } = citation
  expect(citationTarget(unpaged, source)).toEqual({ passage: 'Losses rose 12% over winter.' })
})

Deno.test('a citation without its own paragraph falls back to the source passage and page', () => {
  const citation: Citation = { index: 1, resourceId: 'r1', title: 'Survey report' }
  expect(citationTarget(citation, source)).toEqual({
    passage: 'The opening summary of the survey.',
    page: 1,
  })
  // A match on the generated summary has no place in the document.
  expect(citationTarget(citation, { ...source, matchedField: 'summary' })).toEqual({})
  expect(citationLink('marine', citation, { ...source, matchedField: 'summary' })).toBe(
    '/t/marine/library/r1',
  )
  expect(citationTarget(citation, undefined)).toEqual({})
})
