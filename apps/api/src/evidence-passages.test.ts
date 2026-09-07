import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { choosePassage, paragraphsOf, stripRunningHead } from './evidence-passages.ts'

describe('choosePassage', () => {
  const masthead =
    'Vol.:(0123456789)1 3 Journal of Neurology (2022) 269:1957-1977 https://doi.org/10.1007/s00415-021-10801-2 ORIGINAL COMMUNICATION'
  const results =
    'Retention, effectiveness and safety/tolerability were assessed in 4721, 4392 and 4617, respectively. Retention on PER treatment at 3, 6, and 12 months was 90.5%, 79.8%, and 64.2%, respectively.'
  const discussion =
    'An increasing number of previous ASMs is associated with lower retention, as other real-world studies of perampanel have reported.'

  it('picks the retrieved paragraph that carries the cited figure, with its page', () => {
    const choice = choosePassage(
      ['The retention rate on perampanel at 12 months was 64.2%.'],
      [{ text: masthead, page: 1 }, { text: discussion, page: 13 }, { text: results, page: 5 }],
      [],
      ['perampanel'],
    )
    expect(choice?.page).toBe(5)
    expect(choice?.passage).toContain('64.2%')
  })

  it('falls back to a paragraph of the extracted text when retrieval has none with the figure', () => {
    const choice = choosePassage(
      ['The retention rate on perampanel at 12 months was 64.2%.'],
      [{ text: masthead, page: 1 }, { text: discussion, page: 13 }],
      paragraphsOf(
        `${discussion}\n\n${results}\n\nReferences\n\n1. Smith AB, Jones C. A paper. J Neurol. 2019;45:1-9.`,
      ),
      ['perampanel'],
    )
    expect(choice?.page).toBeUndefined()
    expect(choice?.passage).toContain('64.2%')
  })

  it('returns null when no candidate carries the claim', () => {
    expect(
      choosePassage(['Seizure freedom was 23.2%.'], [{ text: masthead, page: 1 }], [], []),
    ).toBeNull()
  })

  it('focuses a long paragraph on the sentence with the figure', () => {
    const long = `${'Background sentence about epilepsy care. '.repeat(20)}${results} ${
      'Trailing sentence about limitations. '.repeat(10)
    }`
    const choice = choosePassage(
      ['Retention at 12 months was 64.2%.'],
      [{ text: long, page: 5 }],
      [],
    )
    expect(choice?.passage.length).toBeLessThan(700)
    expect(choice?.passage).toContain('64.2%')
  })
})

describe('paragraphsOf', () => {
  it('splits on blank lines and drops bibliography entries and fragments', () => {
    const paragraphs = paragraphsOf(
      'A paragraph of prose that is long enough to be worth quoting in an evidence card.\n\nShort.\n\n12. Smith AB, Jones C. Title. J Neurol. 2019;45:1-9.',
    )
    expect(paragraphs).toHaveLength(1)
  })
})

describe('stripRunningHead', () => {
  it('drops a pipe-delimited running head from the start of a chunk', () => {
    expect(
      stripRunningHead('| 343NIGHTSCALES et al. 3.2 | Implications This study provides evidence.'),
    ).toBe('Implications This study provides evidence.')
    expect(stripRunningHead('Retention on PER treatment was 64.2%.')).toBe(
      'Retention on PER treatment was 64.2%.',
    )
  })
})
