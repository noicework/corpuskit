import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  isStudyAcronym,
  namedStudies,
  namedStudy,
  removeDependants,
  stripUnheldStudyClaims,
  unheldStudyNote,
} from './ask-grounding.ts'
import { carriesVerbatimRun, textCarriesQuote, verbatimRun } from './generate-sources.ts'

/**
 * Loop 7 (review loop 7): a safety verb binds to its
 * medication (D7-03, tested beside the check in answer-audit.test.ts); a
 * removal takes its dependants with it (D7-07); an answer is never left as
 * an assertion with nothing behind it (D7-08); the absent-study banner
 * fires on a study name, never on a citation-marker fragment (D7-12); and a
 * quiz quote comes from the paper, not from a generated summary (D7-11).
 */

describe('a removal takes its dependants with it (D7-07)', () => {
  const answer = [
    'Yes, medication adherence is associated with mortality in people with epilepsy.[1]',
    'The RANSOM study found that nonadherence was associated with a threefold increase in ' +
    'mortality.[1]',
    'This suggests that adherence to medication regimens is crucial for reducing mortality risk ' +
    'in this population.[1]',
  ].join(' ')

  it('removes the conclusion and the opening assertion the removed sentence carried', () => {
    const out = stripUnheldStudyClaims(answer, ['RANSOM'])
    expect(out.text).toContain('A sentence naming RANSOM was removed')
    expect(out.text).not.toContain('This suggests that adherence')
    expect(out.text).not.toContain('Yes, medication adherence is associated with mortality')
    expect(out.removed.length).toBe(3)
  })

  it('keeps the opening assertion when another sentence still stands behind it', () => {
    const supported = [
      'Yes, medication adherence is associated with mortality in people with epilepsy.[1]',
      'The RANSOM study found that nonadherence tripled mortality.[1]',
      'A cohort of 1,805 patients reported a mortality hazard ratio of 1.41 for non-adherence to ' +
      'antiepileptic medication.[2]',
    ].join(' ')
    const out = stripUnheldStudyClaims(supported, ['RANSOM'])
    expect(out.text).toContain('Yes, medication adherence is associated with mortality')
    expect(out.text).toContain('hazard ratio of 1.41')
  })

  it('strips the connective that tied the next sentence to a removed one', () => {
    const out = removeDependants(
      '*A sentence naming RANSOM was removed.* Additionally, retention at 12 months was 71.1%.[1]',
      ['The RANSOM study found something.'],
      ['*A sentence naming RANSOM was removed.*'],
    )
    expect(out.text).toContain('Retention at 12 months was 71.1%.[1]')
    expect(out.text).not.toContain('Additionally')
  })

  it('leaves an answer with no removals alone', () => {
    expect(removeDependants('One sentence.[1] This suggests something.[1]', [], [])).toEqual({
      text: 'One sentence.[1] This suggests something.[1]',
      removed: [],
    })
  })
})

describe('the absent-study banner fires on a study name only (D7-12)', () => {
  it('rejects a condition abbreviation with a citation marker glued to it', () => {
    // The extraction writes "SUDEP1" and "JME1 2" where the paper had a
    // reference marker; loop 7 told the reader the collection held no
    // SUDEP study while citing one.
    expect(isStudyAcronym('SUDEP1')).toBe(false)
    expect(isStudyAcronym('JME1', '2')).toBe(false)
    expect(isStudyAcronym('IGE2')).toBe(false)
    expect(namedStudies('The SUDEP1 study reports a rate of 1.2 per 1,000.')).toEqual([])
    expect(namedStudies('Withdrawal in JME1 2 was studied in this cohort.')).toEqual([])
  })

  it('still recognises a real study name', () => {
    expect(isStudyAcronym('BREATHS')).toBe(true)
    expect(isStudyAcronym('SANAD', 'II')).toBe(true)
    expect(namedStudy('What does the BREATHS trial test?')).toBe('BREATHS')
    expect(namedStudy('What did SANAD II find?')).toBe('SANAD II')
  })

  it('does not claim second-hand sources when there are none', () => {
    const note = unheldStudyNote(
      'What did the RANSOM study find?',
      [],
      ['Psychiatric comorbidity and mortality in epilepsy'],
      'The RANSOM study found that nonadherence increases mortality.',
      false,
    )
    expect(note).toContain('no source cited above refers to it')
    expect(note).not.toContain('second-hand')
  })

  it('keeps the second-hand wording when cited sources do refer to the study', () => {
    const note = unheldStudyNote(
      'What did the RANSOM study find?',
      ['Adherence in chronic disease: a narrative review'],
      ['Adherence in chronic disease: a narrative review'],
      'The RANSOM study is cited by this review.',
      true,
    )
    expect(note).toContain('second-hand')
  })
})

describe('a quiz quote is the paper’s own words (D7-11)', () => {
  const paper = [
    'Results',
    '',
    'At 12 months, the modified Rankin Scale had improved in 34 of 48 patients with anti-LGI1 ' +
    'encephalitis who received second-line immunotherapy.',
  ].join('\n')

  it('accepts a verbatim run from the paper', () => {
    const quote = 'the modified Rankin Scale had improved in 34 of 48 patients'
    expect(verbatimRun(quote, paper)).toBeGreaterThanOrEqual(8)
    expect(carriesVerbatimRun(quote, paper)).toBe(true)
    expect(textCarriesQuote(quote, paper)).toBe(true)
  })

  it('rejects a sentence assembled from the paper’s vocabulary', () => {
    // The wording of a generated page summary: every content word is in the
    // paper, and no run of it is.
    const summary =
      'anti-LGI1 antibody-mediated encephalitis was associated with better recovery on the ' +
      'modified Rankin Scale after second-line immunotherapy in 34 patients'
    expect(carriesVerbatimRun(summary, paper)).toBe(false)
    expect(textCarriesQuote(summary, paper)).toBe(false)
  })
})
