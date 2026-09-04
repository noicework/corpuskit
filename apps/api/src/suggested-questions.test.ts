import { expect } from '@std/expect'
import { describe, it } from '@std/testing/bdd'
import {
  evidenceIsGrounded,
  isAboutTheObject,
  questionContextFor,
  sampleDocument,
  selectQuestions,
} from './suggested-questions.ts'

describe('sampleDocument()', () => {
  it('returns short text untouched', () => {
    expect(sampleDocument('A short abstract.', 6000)).toBe('A short abstract.')
  })

  it('reaches the end of a long document, not just its cover pages', () => {
    // The defect this guards: feeding a model the first N characters of a report
    // feeds it the cover and the contents page, so every question is about the
    // introduction.
    const doc = `COVER ${'front '.repeat(400)}MIDDLEMARKER ${'body '.repeat(400)}ENDMARKER`
    const sampled = sampleDocument(doc, 600)
    expect(sampled.length).toBeLessThan(doc.length)
    expect(sampled).toContain('COVER')
    expect(sampled).toContain('ENDMARKER')
  })

  it('collapses whitespace so windows never open mid-word', () => {
    const sampled = sampleDocument('one\n\n  two\t\tthree', 6000)
    expect(sampled).toBe('one two three')
  })
})

describe('evidenceIsGrounded()', () => {
  const doc = 'The project invested $0.71 million and returned $2.67 million in net benefits.'

  it('accepts an exact quote', () => {
    expect(evidenceIsGrounded(doc, doc)).toBe(true)
  })

  it('accepts a tidied quote sharing six consecutive words', () => {
    // Word-perfect matching tests how good a copyist the model is, not whether
    // the question is answerable - it was discarding true questions.
    expect(
      evidenceIsGrounded('the project invested $0.71 million and returned much more', doc),
    ).toBe(true)
  })

  it('survives curly quotes and en dashes from the PDF extractor', () => {
    const source = 'The fishers’ catch — recorded daily — rose sharply that season.'
    expect(evidenceIsGrounded("The fishers' catch - recorded daily - rose sharply", source)).toBe(
      true,
    )
  })

  it('rejects evidence the document never states', () => {
    expect(evidenceIsGrounded('The study was funded by an anonymous donor abroad', doc)).toBe(false)
  })

  it('trusts the evidence when there is no text to check against', () => {
    expect(evidenceIsGrounded('anything at all', '')).toBe(true)
  })
})

describe('isAboutTheObject()', () => {
  it('rejects questions the page already answers', () => {
    for (
      const q of [
        'Who wrote this report?',
        'When was it published?',
        'What kind of document is this?',
        'What is this document?',
      ]
    ) {
      expect(isAboutTheObject(q)).toBe(true)
    }
  })

  it('keeps questions about the substance', () => {
    expect(isAboutTheObject('What did the trial find about ryegrass?')).toBe(false)
    expect(isAboutTheObject('Who benefits from the stock assessment changes?')).toBe(false)
  })
})

describe('selectQuestions()', () => {
  const doc = 'Genetic techniques improved stock assessments for Southern Bluefin Tuna overall.'
  const ok = {
    question: 'How did genetic techniques change stock assessments?',
    evidence: 'Genetic techniques improved stock assessments for Southern Bluefin Tuna overall.',
  }

  it('keeps a grounded, substantive question', () => {
    expect(selectQuestions([ok], doc)).toEqual([ok.question])
  })

  it('drops a question whose evidence is not in the document', () => {
    const bogus = { question: 'What did the minister say?', evidence: 'The minister said nothing.' }
    expect(selectQuestions([bogus], doc)).toEqual([])
  })

  it('drops questions about the document as an object', () => {
    const meta = { question: 'Who wrote this report?', evidence: ok.evidence }
    expect(selectQuestions([meta], doc)).toEqual([])
  })

  it('drops thin evidence', () => {
    expect(selectQuestions([{ question: 'What?', evidence: 'Yes.' }], doc)).toEqual([])
  })

  it('de-duplicates and caps at the requested count', () => {
    const rows = [ok, { ...ok }, {
      question: 'What species did the assessments cover?',
      evidence: ok.evidence,
    }]
    expect(selectQuestions(rows, doc, 3)).toEqual([
      ok.question,
      'What species did the assessments cover?',
    ])
  })

  it('returns [] for a non-array payload', () => {
    expect(selectQuestions(null, doc)).toEqual([])
  })
})

describe('questionContextFor()', () => {
  it('prefers the full text over the page summary', () => {
    // Questions written from a summary are questions about the summary; the
    // whole text is what makes an opener specific to the document.
    const content = {
      texts: [{
        fieldId: 'f',
        text: 'Trawl selectivity trials ran across four seasons. '.repeat(20),
      }],
      pageSummary: 'A short page summary.',
    } as never
    const context = questionContextFor(content)
    expect(context).toContain('Trawl selectivity trials')
    expect(context).not.toContain('A short page summary')
  })

  it('falls back to the page summary when there is no extractable text', () => {
    const content = { texts: [], pageSummary: 'A scanned poster about carp control.' } as never
    expect(questionContextFor(content)).toBe('A scanned poster about carp control.')
  })

  it('returns empty for missing content', () => {
    expect(questionContextFor(null)).toBe('')
  })
})
