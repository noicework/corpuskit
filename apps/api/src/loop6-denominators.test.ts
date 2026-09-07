/**
 * Loop 6 D6-08 and the carried-over D5-13: the denominator addendum asks
 * only where a denominator exists to be asked for. A fitted statistic, a
 * range, a confidence interval and a table row take none; a share whose n
 * the paper writes one clause further on gets that n rather than a
 * complaint (review loop 6).
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  auditAddendum,
  denominatorBeside,
  denominatorsMissing,
  isFittedStatistic,
  proportions,
} from './answer-audit.ts'

describe('the denominator addendum exempts figures that take no denominator (D6-08)', () => {
  it('reads a fitted statistic as the share itself', () => {
    expect(
      isFittedStatistic('80%', [
        'We found F1 = 0.8, suggesting that 80% of EDs in Group 1 were clustered during the sleep period.',
      ]),
    ).toBe(true)
    expect(isFittedStatistic('70%', ['The model reached an AUC of 0.70 (95% CI 0.68-0.72).'])).toBe(
      true,
    )
    // A different value, and a share stated as a share, are not fitted.
    expect(isFittedStatistic('80%', ['The AUC was 0.62 and 80% of patients responded.'])).toBe(
      false,
    )
    expect(isFittedStatistic('14.9%', ['seizure freedom was 14.9% (n = 1111)'])).toBe(false)
    expect(
      denominatorsMissing([{
        text: '80% of epileptiform discharges in Group 1 occurred during the sleep period.',
        located: [{
          figure: '80%',
          index: 1,
          passage:
            'We found F1 = 0.8, suggesting that 80% of EDs in Group 1 were clustered during the sleep period.',
        }],
      }]),
    ).toEqual([])
  })

  it('reads a range or an interquartile range as a spread, not as three shares', () => {
    // R15 of the persona's loop 6: "17.1% (range 13-28%)" is one prevalence.
    expect(proportions('The prevalence was reported as 17.1% (range 13-28%).')).toEqual([])
    expect(proportions('The prevalence was reported as 17.1% (range 13–28%).')).toEqual([])
    expect(proportions('The median age was 45 years (IQR 23-71) and 30% were women.')).toEqual([
      '30%',
    ])
    expect(
      denominatorsMissing([{
        text: 'The prevalence of depressive symptoms was reported as 17.1% (range 13-28%).',
        located: [{
          figure: '17.1%',
          index: 1,
          passage: 'pooled prevalence of depressive symptoms was 17.1% (range 13-28%)',
        }],
      }]),
    ).toEqual([])
  })

  it('says nothing inside a table, whose n column is the denominator', () => {
    expect(
      denominatorsMissing([{
        text: '| Brivaracetam | EXPERIENCE | 1111 | 71.1% | 14.9% |',
        located: [
          { figure: '71.1%', index: 1, passage: 'BRV retention was 71.1% at 12 months' },
          { figure: '14.9%', index: 1, passage: 'seizure freedom rates were 14.9%' },
        ],
      }]),
    ).toEqual([])
  })

  it('takes the count and the n the sentence gives one clause further on', () => {
    const passage =
      'Among patients with data on the reasons for switching from LEV to BRV (n = 583), the ' +
      'most common reasons were lack of effectiveness (232 [39.8%]), tolerability unrelated to ' +
      'behavioural AEs (BAEs) (223 [38.3%]), and BAEs (103 [17.7%]).'
    expect(denominatorBeside('39.8%', [passage])).toBe('232 of 583')
    expect(denominatorBeside('38.3%', [passage])).toBe('223 of 583')
    expect(
      denominatorsMissing([{
        text:
          'The most common reasons for switching were lack of effectiveness (39.8%) and tolerability (38.3%).',
        located: [
          { figure: '39.8%', index: 1, passage },
          { figure: '38.3%', index: 1, passage },
        ],
      }]),
    ).toEqual([
      { figure: '39.8%', stated: '232 of 583', index: 1 },
      { figure: '38.3%', stated: '223 of 583', index: 1 },
    ])
    expect(
      auditAddendum({
        missingDrugs: [],
        missingNumbers: [],
        denominators: [{ figure: '39.8%', stated: '232 of 583', index: 1 }],
      }),
    ).toContain('the cited passage gives 232 of 583 for 39.8% [1]')
  })

  it('still asks when the passage genuinely states a bare share', () => {
    expect(
      denominatorsMissing([{
        text: 'The 12-month seizure freedom rate was 4% in a refractory cohort.',
        located: [{
          figure: '4%',
          index: 1,
          passage: 'seizure freedom at 12 months was achieved by 4% of this refractory cohort',
        }],
      }]),
    ).toEqual([{ figure: '4%' }])
  })
})
