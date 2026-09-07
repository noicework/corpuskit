/**
 * The matcher's normalisation, checked against every figure the four
 * O'Neill loop reports verified or disputed (
 * review loop 1 to review loop 4): each row is a figure as the answer
 * writes it and the passage as the platform extracted it, with its thousand
 * separators, thin spaces, line breaks, PDF glyphs, proportions and number
 * words. A figure the paper carries must be found; a figure it carries for
 * a different quantity must not.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  denominatorBeside,
  extractNumbers,
  figurePresent,
  normaliseGlyphs,
  normaliseSource,
  prepareSource,
  proportions,
  pValueListClaim,
  pValueListConflict,
  statisticQualifierConflict,
  verifyFigures,
} from './answer-audit.ts'

const present = (token: string, passage: string) => figurePresent(token, normaliseSource(passage))

/** Every figure token the answer states, checked against the extracted passage. */
const CARRIED: [answer: string, passage: string, loop: string][] = [
  // Loop 4: the VEM mortality cohort (D4-01), thousand separators and a line break.
  [
    '2,709 adults admitted between 1995 and 2015',
    'A retrospective medical record audit was conducted on 2,709 adults \n admitted for VEM and diagnosed with epilepsy at 3 Victorian \n comprehensive epilepsy programs from 1995 to 2015.',
    'loop4 EA',
  ],
  ['1,805 patients', 'A total of \n 1,805 patients were identified in whom the record', 'loop4 EA'],
  [
    '147 deaths',
    'Of 147 deceased PWE over the study period, 87 had a lifetime \n history',
    'loop4 EA',
  ],
  // Loop 4: a proportion the answer wrote as a percentage (D4-19).
  [
    'just over a third of discharges (37%) occurred during sleep',
    'In contrast, F2 is 0.37, suggesting that in Group 2 just \n\n over a third of discharges occur during the sleep period',
    'loop4 Q6',
  ],
  [
    '80% of EDs',
    'We found F1 = 0.8, suggesting that 80% of EDs in Group \n\n 1 were clustered',
    'loop4 Q6',
  ],
  // Loop 4: PDF glyphs for the decimal point and plus-minus (D4-10).
  [
    'an increase of 1.66 hours lowered the odds by 27%',
    'an increase in sleep duration, by 1¢66 § 0¢52 h, lowered the odds of seizure by 27% in the following \n 48 h.',
    'loop4 HD',
  ],
  ['p < 0.009', 'when compared to baseline (p < 0¢009; Table 2)', 'loop4 HD'],
  ['1.13 h less', 'which is 1¢13 (§0¢48) h less than their median sleep duration', 'loop4 HD'],
  ['8.29 h', 'sleeping less than the 25th percentile (8·29 ± 0·99 h)', 'loop4 HD'],
  // Loop 4: PERMIT retention and discontinuation (D4-03, D4-05).
  [
    '64.2% (2698/4201) at 12 months',
    'Retention on PER treatment at 3, 6, and 12 months was \n 90.5% (4273/4721), 79.8% (3603/4516), and 64.2% \n (2698/4201), respectively.',
    'loop4 N09',
  ],
  [
    '17.6% (739/4201)',
    'At \n 12 months, 17.6% (739/4201) of PWEs had discontinued \n PER due to AEs.',
    'loop4 TDE',
  ],
  ['5193 patients', 'The Full Analysis Set included 5193 PWE.', 'loop4 TDE'],
  [
    '29.5% (1229/4164)',
    'Over the longer term (> 12 months), retention \n was 29.5% (1229/4164)',
    'loop4 N09',
  ],
  // Loop 4: EXPERIENCE seizure freedom and responders (D4-05, HE).
  [
    '14.9% (n = 1111) and 36.9% (n = 822)',
    '≥ 50% seizure reduction was achieved by 32.1% (n = 619), 36.7% (n = 867), and 36.9% (n = 822) of patients; seizure \n freedom rates were 22.4% (n = 923), 17.9% (n = 1165), and 14.9% (n = 1111)',
    'loop4 HE',
  ],
  // Loop 4: p values per outcome (D4-13).
  [
    'activity impairment (p = 0.002)',
    'significant reductions in absenteeism (p < 0.001), presentee- \n ism (p < 0.001), overall work impairment (p < 0.001), and activity impairment \n (p = 0.002).',
    'loop4 Q12',
  ],
  [
    '196 participants',
    'A total of 196 participants met the eligibility criteria and \n were enrolled in the study.',
    'loop4 EE',
  ],
  // Loop 4: the SUDEP case-control table and text (D4-18).
  [
    'aHR 2.24 (95% CI 1.07-4.68, P = 0.031)',
    '(aHR = 2.24; 95% CI: \n 1.07– 4.68, P = 0.031 and aHR = 2.25',
    'loop4 C3',
  ],
  [
    'HR 3.25, n = 221',
    'Any TCS in 12 months preceding \n admission \n\n 221 3.25 <0.001',
    'loop4 C3',
  ],
  // Loop 4: UMPIRE demographics (D4-09).
  [
    'mean age 45 years (range 23-71)',
    'Half were assigned female sex at birth, with a mean age at implantation of 45 years (range = 23–71)',
    'loop4 HC',
  ],
  ['13 (50%) female', 'Female, n (%) 13 (50)', 'loop4 HC'],
  // Loop 4: second-hand rates the matcher must still find (the section check decides).
  [
    '5.9 per 1000 patient-years',
    'reporting a SUDEP incidence of 5.9/1000 patient-years (Nashef et al., 1995)',
    'loop4 N11',
  ],
  [
    '23.6% (395/1674)',
    'The pooled placebo responder rate was 23.6% (395 out of 1,674 participants)',
    'loop4 TD3',
  ],
  ['up to 40%', 'recent trials have reported placebo responder rates of up to 40%', 'loop4 TDD'],
  // Loop 3: the LGI1 cohort's own figures (D3-01, D3-10).
  [
    '26 (49%) received rituximab',
    'Rituximab was administered in 26 (49%) and cyclophosphamide in 3 (6%) patients.',
    'loop3 C4',
  ],
  [
    'HR 0.10 (95% CI 0.001-0.85; p = 0.03)',
    '(hazard ratio 0.10; 95% CI 0.001–0.85; p = 0.03)',
    'loop3 C4',
  ],
  [
    '16 (30%) relapsed, median 414 days (IQR 256-967)',
    'A total of 16 (30%) patients experienced at least 1 relapse, at a median of 414 (IQR 256, 967) days',
    'loop3 N01',
  ],
  [
    'OR 4.39 (95% CI 1.08-21.5)',
    'first-line immunotherapy within 3 months (OR 4.39; 95% CI 1.08–21.5)',
    'loop2 N01',
  ],
  // Loop 3: the withheld figures with their analysis sets (D3-02).
  [
    '72.7% (n = 605)',
    'retention at 12 months was 72.7% (n = 605) in patients with psychiatric comorbidity',
    'loop3 C1',
  ],
  [
    '71.1% (n = 1644)',
    'BRV reten- \n tion was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 mo (FAS, n = 1644)',
    'loop3 C1',
  ],
  [
    '82,723 with incident epilepsy and 125,223 prevalent',
    'an estimated 82 723 adults with incident epilepsy and 125 223 with prevalent epilepsy',
    'loop3 E2',
  ],
  [
    '23.2% (n = 4392)',
    'seizure freedom was reported in 23.2% (n = 4392) of the Effectiveness Population',
    'loop3 R1',
  ],
  ['58.3%', '≥ 50% responder rate at 12 months was 58.3% (Effectiveness Population)', 'loop3 TD1'],
  [
    '709 (43.8%) switched from LEV',
    'Switched from LEV 709 (43.8)l \n\n Switched from other ASMs 887 (54.8)',
    'loop3 N02',
  ],
  [
    '154 (67%) and 119 (52%)',
    'At 12 months, a favourable mRS (≤ 2) occurred in 154 (67%) patients, and a favourable composite clinical-functional outcome was seen in 119 (52%).',
    'loop3 N06',
  ],
  [
    '15.1 discharges per hour versus 4.6',
    'a median of 15.1/h in sleep versus 4.6 in wakefulness',
    'loop3 T1',
  ],
  ['2518 patients', 'Of the 2,518 patients with JME', 'loop3 E3'],
  [
    '2.49 and 1.62 per 1,000 person-years',
    'SUDEP rates were 2.49 and 1.62 per 1000 person-years',
    'loop3 EC',
  ],
  // Loop 2: the consortium outcome and the anti-NMDAR rituximab schedule (D2-02, Q3).
  [
    '79% achieved an mRS below 3 (n = 55)',
    'Of the 55 patients, 79% achieved an mRS of less than 3 at 12 months',
    'loop2 N06',
  ],
  [
    'HR 0.11 (95% CI 0.02-0.70, p = 0.02, n = 51)',
    'rituximab (HR 0.11, 95% CI 0.02–0.70, p = 0.02, n = 51)',
    'loop2 Q3',
  ],
  [
    'HR 0.05 (95% CI 0.00-0.48, p = 0.005)',
    'six-monthly dosing (HR 0.05; 95% CI 0.00–0.48; p = 0.005; n = 63)',
    'loop2 K4',
  ],
  ['3.9 per 1000 patient-years', 'a SUDEP rate of 3.9/1000 patient-years', 'loop2 N11'],
  // Loop 1: the BREATHS design, the SUDEP aHR and UMPIRE (D1-01, Q2, D1-02).
  [
    '220 participants, 110 per group',
    'a sample size of 220 participants (110 per group)',
    'loop1 Q9',
  ],
  [
    'aHR 0.56 (95% CI 0.31-1.01, p = 0.054)',
    '(aHR = 0.56; 95% CI 0.31-1.01; p = 0.054)',
    'loop1 Q2',
  ],
  [
    '31 enrolled, 26 implanted, 24 completed',
    'Thirty-one subjects were enrolled, twenty-six were implanted and twenty-four completed the study',
    'loop1 N14',
  ],
  ['6.42% at 1400 mg', 'at doses of 1,400 mg/day or less the rate was 6.42%', 'loop1 Q1'],
  ['HR 1.41 (95% CI 1.02-1.97)', 'hazard ratio 1.41 (95% CI 1.02–1.97)', 'loop1 Q11'],
]

/** Figures a passage carries for something else: the matcher must not find them. */
const NOT_CARRIED: [answer: string, passage: string, why: string][] = [
  ['37%', 'the dose was 0.37 mg/kg', 'a dose is not a proportion'],
  ['37%', 'F2 is 0.375', 'a longer decimal is another proportion'],
  ['14%', 'followed for 14 days', 'a duration is not a share'],
  ['2709', 'a cohort of 27,090 adults', 'a longer count'],
  ['12months', '12 patients', 'a count is not a timepoint'],
]

describe('figure normalisation across the four loop reports', () => {
  for (const [answer, passage, loop] of CARRIED) {
    it(`finds every figure of "${answer}" in the ${loop} passage`, () => {
      const tokens = extractNumbers(answer)
      expect(tokens.length).toBeGreaterThan(0)
      for (const token of tokens) {
        expect({ token, found: present(token, passage) }).toEqual({ token, found: true })
      }
    })
  }
  for (const [answer, passage, why] of NOT_CARRIED) {
    it(`does not find ${answer} in "${passage}" (${why})`, () => {
      expect(present(answer, passage)).toBe(false)
    })
  }

  it('reads the PDF glyphs for a decimal point, a plus-minus sign and a thin space', () => {
    expect(normaliseGlyphs('1¢66 § 0¢52 h')).toBe('1.66 ± 0.52 h')
    expect(normaliseGlyphs('8·29 ± 0·99 h')).toBe('8.29 ± 0.99 h')
    expect(normaliseGlyphs('82 723 adults')).toBe('82 723 adults')
    expect(normaliseSource('82 723 adults')).toBe('82723 adults')
    expect(normaliseSource('an increase of 1¢66 § 0¢52 h')).toBe('an increase of 1.66 ± 0.52 h')
  })

  it('reads a thousands separator in the answer and in a raw text', () => {
    expect(extractNumbers('2,709 adults and 1,805 patients')).toEqual(['2709', '1805'])
    expect(figurePresent('2709', 'audit of 2,709 adults')).toBe(true)
    expect(figurePresent('2709', 'audit of 2 709 adults')).toBe(true)
    expect(figurePresent('125223', 'and 125,223 prevalent')).toBe(true)
  })
})

describe('"all p < x" over each listed outcome (D4-13)', () => {
  const sentence =
    'Over 12 months there was a significant reduction in absenteeism, presenteeism, overall work impairment, and activity impairment (all p < 0.001).'
  const passage = prepareSource(
    'The newly diagnosed epilepsy group showed significant reductions in absenteeism (p < 0.001), presentee- \n ism (p < 0.001), overall work impairment (p < 0.001), and activity impairment \n (p = 0.002).',
  )

  it('reads the listed outcomes and the bound', () => {
    const claim = pValueListClaim(sentence)
    expect(claim?.bound).toBe('0.001')
    expect(claim?.items).toEqual([
      'absenteeism',
      'presenteeism',
      'overall work impairment',
      'activity impairment',
    ])
    expect(pValueListClaim('The rate was 14.9% (p < 0.001).')).toBeUndefined()
  })

  it('names the outcome whose own p value breaks the bound, and none when all satisfy it', () => {
    expect(pValueListConflict(pValueListClaim(sentence)!, passage)).toBe('activity impairment')
    const tight = prepareSource(
      'absenteeism (p < 0.001), presenteeism (p < 0.001), overall work impairment (p < 0.001), and activity impairment (p < 0.001).',
    )
    expect(pValueListConflict(pValueListClaim(sentence)!, tight)).toBeUndefined()
  })

  it('fails the bound figure in the sentence check, with its own reason', () => {
    const checks = verifyFigures([{ text: sentence, texts: [passage.original] }], [
      passage.original,
    ])
    const bound = checks.find((c) => c.figure === '0.001')
    expect(bound?.supported).toBe(false)
    expect(bound?.reason).toBe('pvalue')
  })
})

describe("the statistic's own qualifier (D4-18, D4-09)", () => {
  it('rejects an adjusted ratio placed by a univariable table row, and a median placed by a mean', () => {
    const claim = (s: string) => ({
      anchors: [],
      words: [],
      content: [],
      mandatory: [],
      outcomes: [],
      timepoints: [],
      figures: [],
      normalised: s.toLowerCase(),
    })
    expect(
      statisticQualifierConflict(
        claim('the adjusted hazard ratio was 3.25'),
        'any tcs 221 3.25 <0.001',
      ),
    ).toBe(true)
    expect(
      statisticQualifierConflict(
        claim('the adjusted hazard ratio was 2.24'),
        'irrespective of lamotrigine (ahr = 2.24; 95% ci 1.07-4.68)',
      ),
    ).toBe(false)
    expect(
      statisticQualifierConflict(
        claim('the median age was 45 years'),
        'with a mean age at implantation of 45 years (range = 23-71)',
      ),
    ).toBe(true)
    expect(
      statisticQualifierConflict(claim('the mean age was 45 years'), 'a mean age of 45 years'),
    ).toBe(false)
  })

  it('fails the figure in the sentence check', () => {
    const table =
      'Table 2 Univariable analysis \n\n Any TCS in 12 months preceding \n admission \n\n 221 3.25 <0.001 \n\n History of Anxiety 283 0.39 0.042'
    const checks = verifyFigures(
      [{
        text: 'The adjusted hazard ratio (aHR) for tonic-clonic seizures was 3.25 (n = 221).',
        texts: [table],
      }],
      [table],
    )
    expect(checks.find((c) => c.figure === '3.25')?.supported).toBe(false)
  })
})

describe('denominators from the same parenthesis only (D4-05, D4-11)', () => {
  const experience =
    '≥ 50% seizure reduction was achieved by 32.1% (n = 619), 36.7% (n = 867), and 36.9% (n = 822) of patients; seizure freedom rates were 22.4% (n = 923), 17.9% (n = 1165), and 14.9% (n = 1111).'

  it('pairs each share with the n in its own bracket', () => {
    expect(denominatorBeside('14.9%', [experience])).toBe('n = 1111')
    expect(denominatorBeside('36.9%', [experience])).toBe('n = 822')
    expect(denominatorBeside('17.6%', ['At 12 months, 17.6% (739/4201) of PWEs had discontinued']))
      .toBe(
        '739/4201',
      )
    expect(denominatorBeside('64.2%', ['and 64.2% \n (2698/4201), respectively'])).toBe('2698/4201')
  })

  it('takes no n from elsewhere in the sentence, and none for a threshold', () => {
    expect(
      denominatorBeside('14.9%', [
        'seizure freedom was 22.4%, 17.9%, and 14.9% (FAS) in 1165 patients',
      ]),
    ).toBeUndefined()
    expect(proportions('the 50% responder rate was 36.9% at the same 12-month mark')).toEqual([
      '36.9%',
    ])
    expect(proportions('a ≥ 50% seizure reduction was achieved by 36.9%')).toEqual(['36.9%'])
    expect(proportions('the SMR was 2.5 (95% CI 1.9-3.2)')).toEqual([])
  })

  it("fails a share whose bracket n the located passage pairs differently, and passes the paper's own pairing (D4-05, loop 5 D5-03)", () => {
    const permit =
      'At 12 months, 17.6% (739/4201) of PWEs had discontinued PER due to AEs. The Full Analysis Set included 5193 PWE.'
    const wrong = verifyFigures(
      [{
        text:
          'The adverse-event discontinuation rate at 12 months was 17.6% (n = 5193, full analysis set).',
        texts: [permit],
      }],
      [permit],
    )
    expect(wrong.map((c) => [c.figure, c.supported])).toEqual([
      ['12months', true],
      ['17.6%', false],
      ['5193', true],
    ])
    const right = verifyFigures(
      [{
        text: 'Retention was 64.2% (n = 4201, Retention Population).',
        texts: ['Retention on PER at 12 months was 64.2% (2698/4201), respectively'],
      }],
      ['Retention on PER at 12 months was 64.2% (2698/4201), respectively'],
    )
    expect(right.every((c) => c.supported)).toBe(true)
    // An n the passage gives in the window of a bracket-less figure is its n.
    const abstract =
      'Retention, effectiveness and safety were assessed in 4721, 4392 and 4617, respectively. Retention on PER treatment at 3, 6, and 12 months was 90.5% (4273/4721), 79.8%, and 64.2%, respectively.'
    expect(
      verifyFigures([{
        text: 'The 12-month retention rate was 64.2% (n = 4721).',
        texts: [abstract],
      }], [abstract])
        .every((c) => c.supported),
    ).toBe(true)
  })
})
