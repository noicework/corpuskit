import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import {
  passageIsInformative,
  passageIsQuotable,
  passageRepeatsSummary,
  scrubSnippetBoilerplate,
} from './passage.ts'

const QUERY = 'What research has been done in Western Australia?'

describe('passageIsInformative', () => {
  it('drops a passage that is only the query echoed back', () => {
    expect(passageIsInformative(' Western Australia ', QUERY)).toBe(false)
  })

  it('drops a list of place names that adds almost nothing', () => {
    expect(passageIsInformative('Western Australia South Australia Victoria', QUERY)).toBe(false)
  })

  it('drops punctuation noise around the query terms', () => {
    expect(passageIsInformative("—- I 'Western Australia.", QUERY)).toBe(false)
  })

  it('drops an empty or whitespace-only passage', () => {
    expect(passageIsInformative('', QUERY)).toBe(false)
    expect(passageIsInformative('   \n  ', QUERY)).toBe(false)
  })

  it('keeps a real sentence that happens to contain the query terms', () => {
    expect(passageIsInformative(
      'Abalone stocks in Western Australia declined sharply after the 2011 marine heatwave.',
      QUERY,
    )).toBe(true)
  })

  it('keeps a passage for a short query, where most words are new', () => {
    expect(passageIsInformative(
      'Rock lobster are held in aerated seawater immediately after capture.',
      'lobster',
    )).toBe(true)
  })
})

describe('passageRepeatsSummary', () => {
  it('spots a snippet that is the summary again', () => {
    const summary =
      'Multi-day cycles in epilepsy refer to recurrent patterns in seizure occurrence over extended periods.'
    expect(passageRepeatsSummary(summary, summary)).toBe(true)
    expect(passageRepeatsSummary(`${summary} Understanding these patterns is crucial.`, summary))
      .toBe(true)
  })
  it('keeps a snippet that adds something', () => {
    expect(
      passageRepeatsSummary(
        'The hazard ratio was 0.54 for a second seizure.',
        'A trial of lacosamide in generalised epilepsy.',
      ),
    ).toBe(false)
  })
})

describe('scrubSnippetBoilerplate', () => {
  it('drops correspondence emails and funding boilerplate', () => {
    const snippet = 'Email: dgvossler@msn.com Funding information UCB Pharma funded the study'
    expect(scrubSnippetBoilerplate(snippet)).toBe('')
    expect(
      scrubSnippetBoilerplate('Lacosamide was effective. Correspondence: J Smith, smith@uni.edu'),
    ).toBe('Lacosamide was effective.')
  })
})

describe('passageIsQuotable', () => {
  it('quotes a passage matched in the document body', () => {
    expect(passageIsQuotable({ matchedField: 'body' })).toBe(true)
    expect(passageIsQuotable({})).toBe(true)
  })

  it('never quotes the byline an author or identifier lookup matched (D2-20)', () => {
    expect(passageIsQuotable({ matchedField: 'metadata' })).toBe(false)
    // In a lookup even a body hit is only where the surname appears.
    expect(passageIsQuotable({ matchedField: 'body' }, true)).toBe(false)
  })

  it('never quotes a reference-list or front-matter hit', () => {
    expect(passageIsQuotable({ matchedField: 'body', referenceChunk: true })).toBe(false)
  })
})
