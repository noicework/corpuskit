/**
 * Loop 8 (review loop 8 D8-09): the lead claim is a
 * dependant too. U9 removed the sentence naming RANSOM and every sentence
 * that rested on it, then left the answer's opening assertion - "non-
 * adherence to antiepileptic drugs is linked to increased mortality" -
 * standing under a paper whose only use of the word is a Discussion
 * sentence about drug response in adherent patients. When nothing left in
 * the answer speaks to the lead claim, the lead goes with the removals and
 * the coverage decline stands in its place.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { leadSentence, removeDependants, stripUnheldStudyClaims } from './ask-grounding.ts'

describe('the lead claim goes when the removal left nothing behind it (D8-09)', () => {
  it('removes an opening assertion the removed sentence no longer supports', () => {
    const answer = [
      'The cited sources indicate that non-adherence to antiepileptic drugs is linked to ' +
      'increased mortality.[1]',
      'The RANSOM study reported a threefold rise in deaths among people who stopped taking ' +
      'their tablets.[1]',
    ].join(' ')
    const out = stripUnheldStudyClaims(answer, ['RANSOM'])
    expect(out.text).toContain('A sentence naming RANSOM was removed')
    expect(out.text).not.toContain('non-adherence to antiepileptic drugs is linked')
    // Nothing but the removal notice is left, which the caller turns into
    // the honest coverage decline rather than an answer.
    expect(leadSentence(out.text)).toBe('')
  })

  it('keeps a lead another sentence still speaks to', () => {
    const answer = [
      'The cited sources indicate that non-adherence to antiepileptic drugs is linked to ' +
      'increased mortality.[1]',
      'The RANSOM study reported a threefold rise in deaths.[1]',
      'A cohort study found a mortality hazard ratio of 1.41 for non-adherence to antiepileptic ' +
      'drugs.[2]',
    ].join(' ')
    const out = stripUnheldStudyClaims(answer, ['RANSOM'])
    expect(out.text).toContain('non-adherence to antiepileptic drugs is linked')
    expect(out.text).toContain('hazard ratio of 1.41')
  })

  it('keeps a lead that states a figure of its own', () => {
    const out = removeDependants(
      'Mortality was 2.3 times higher in people who missed doses.[1] ' +
        '*A sentence naming RANSOM was removed.*',
      ['The RANSOM study reported a threefold rise in deaths.'],
      ['*A sentence naming RANSOM was removed.*'],
    )
    expect(out.text).toContain('Mortality was 2.3 times higher')
    expect(out.removed).toEqual([])
  })

  it('leaves a lead that asserts no finding alone', () => {
    const lead = 'The cited sources do not report an adherence and mortality study for this ' +
      'population.'
    const out = removeDependants(
      `${lead} *A sentence naming RANSOM was removed.*`,
      ['The RANSOM study reported a threefold rise in deaths.'],
      ['*A sentence naming RANSOM was removed.*'],
    )
    expect(out.text).toContain(lead)
    expect(out.removed).toEqual([])
  })
})
