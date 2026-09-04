import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { normaliseAnswerBullets } from './answer-text.ts'

describe('normaliseAnswerBullets', () => {
  it('moves an inline bullet after a bold heading onto its own line', () => {
    expect(
      normaliseAnswerBullets('**8. Tier Systems** * The SESSF uses a Tier system.'),
    ).toBe('**8. Tier Systems**\n* The SESSF uses a Tier system.')
  })

  it('splits a run of inline bullets after sentence ends and citation markers', () => {
    const input =
      'Methods include: * **Catch-MSY**: Needs a catch series.[3] * **SPM**: Pools growth and mortality. * Risk assessments may be the only option.'
    expect(normaliseAnswerBullets(input)).toBe(
      [
        'Methods include:',
        '* **Catch-MSY**: Needs a catch series.[3]',
        '* **SPM**: Pools growth and mortality.',
        '* Risk assessments may be the only option.',
      ].join('\n'),
    )
  })

  it('leaves well-formed newline bullets untouched', () => {
    const input = 'More specifically:\n*   **First**: one thing.\n*   **Second**: another.'
    expect(normaliseAnswerBullets(input)).toBe(input)
  })

  it('does not break emphasis or arithmetic', () => {
    expect(normaliseAnswerBullets('a growth rate of 0.2 * 3 per year')).toBe(
      'a growth rate of 0.2 * 3 per year',
    )
    expect(normaliseAnswerBullets('this is *important* to note')).toBe(
      'this is *important* to note',
    )
  })
})
