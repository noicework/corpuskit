import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import { passageIsInformative } from './passage.ts'

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
