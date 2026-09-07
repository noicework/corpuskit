import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  analysisSetIn,
  claimPopulation,
  clauseAround,
  distinguishesModifier,
  outcomeModifiers,
  populationWords,
  rangeInSentence,
  rangeLowerBound,
  rangePartnerOf,
  statesPopulation,
  verifyFigures,
} from './answer-audit.ts'
import { stripReferenceSection } from './citation-binding.ts'
import { endsWithReferenceMarker, secondhandFigures, speaksOfOwnWork } from './secondhand.ts'
import { leadSentence, namedStudies, unheldStudyNote } from './ask-grounding.ts'
import { rowKey, tableCellHeadings } from './answer-gate.ts'

/**
 * Loop 6 (review loop 6): a located figure is bound
 * to the population clause of the sentence it was found in, the outcome
 * test is exact where the paper itself is exact, a bibliography can never
 * ground a sentence, and a paper's own words are never second-hand.
 */

// The EXPERIENCE subgroup paper's two adjacent paragraphs (D6-01): the
// first reports the with/without psychiatric comorbidity contrast, the
// second the LEV-to-BRV switchers.
const EXPERIENCE = [
  'Results',
  '',
  'At 12 months, >= 50% seizure reduction was achieved in 38.7% and 36.1% of patients with and ' +
  'without psychiatric comorbidity, respectively (mFAS) (Fig. 1a); seizure freedom was achieved ' +
  'in 16.0% and 14.4% (FAS) (Fig. 1b); continuous seizure freedom was achieved in 13.7% and ' +
  '10.4% (Fig. 1c); and BRV retention was achieved in 72.7% and 70.3% (Fig. 1d).',
  '',
  'In patients with psychiatric comorbidity who switched from LEV to BRV and who switched from ' +
  'other ASMs to BRV, at 12 months, >= 50% seizure reduction was achieved in 38.3% and 38.7% of ' +
  'patients, respectively (mFAS); seizure freedom was achieved in 13.9% and 16.2% (FAS); ' +
  'continuous seizure freedom was achieved in 10.6% and 15.0%; and BRV retention was achieved ' +
  'in 73.3% and 71.4%.',
].join('\n')

// The EXPERIENCE pooled analysis abstract (D6-03): seizure freedom and
// continuous seizure freedom reported side by side.
const POOLED = [
  'Results Analyses included 1644 adults. At 3, 6, and 12 months, respectively, seizure freedom ' +
  'rates were 22.4% (n = 923), 17.9% (n = 1165), and 14.9% (n = 1111); and continuous seizure ' +
  'freedom rates were 22.4% (n = 923), 15.7% (n = 1165), and 11.7% (n = 1111).',
  '',
  'BRV retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months, respectively (FAS; Fig. 1d).',
].join('\n')

const verdicts = (sentences: readonly string[], text: string, entities: string[] = []) =>
  verifyFigures(
    sentences.map((s) => ({ text: s, texts: [text] })),
    [text],
    [],
    entities,
  ).map((
    c,
  ) => [
    c.sentence === sentences[sentences.length - 1] ? 'last' : 'first',
    c.figure,
    c.supported,
    c.reason ?? '-',
  ])

describe('the claim population (D6-01)', () => {
  it('reads the qualifier that follows the figure and the one that opens the clause', () => {
    expect(
      claimPopulation(
        'seizure freedom was achieved in 16.0% of patients with psychiatric comorbidity who switched from lev to brv (fas)',
      )?.words,
    )
      .toEqual(['psychiatric', 'comorbidity', 'switched', 'lev', 'brv'])
    expect(
      claimPopulation(
        'in patients with psychiatric comorbidity who switched from lev to brv, seizure freedom was 13.9%',
      )?.words,
    )
      .toEqual(['psychiatric', 'comorbidity', 'switched', 'lev', 'brv'])
  })

  it('names neither population in a with-and-without contrast, and marks a pointer back', () => {
    expect(
      claimPopulation('in patients with and without psychiatric comorbidity, retention was 72.7%'),
    )
      .toBeUndefined()
    expect(
      claimPopulation('continuous seizure freedom was achieved in 13.7% of these patients')
        ?.anaphoric,
    )
      .toBe(true)
  })

  it('drops the stop words a qualifier never narrows on', () => {
    expect(populationWords('with a complete neuropsychiatric evaluation over 12 months'))
      .toEqual(['complete', 'neuropsychiatric', 'evaluation'])
  })

  it('says whether a passage frames a population of its own', () => {
    expect(
      statesPopulation(
        'seizure freedom was achieved in 16.0% and 14.4% of patients with and without psychiatric comorbidity',
      ),
    ).toBe(true)
    expect(statesPopulation('BRV retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months'))
      .toBe(false)
  })

  it("refuses the broader subgroup's figure for the narrower group the question named", () => {
    const rows = verdicts(
      [
        'In the EXPERIENCE study, at 12 months, seizure freedom was achieved in 16.0% of patients with psychiatric comorbidity who switched from LEV to BRV (FAS).',
      ],
      EXPERIENCE,
      ['brivaracetam'],
    ).filter((r) => r[1] === '16.0%')
    expect(rows).toEqual([['last', '16.0%', false, 'population']])
  })

  it("keeps the narrower paragraph's own figures for that group", () => {
    expect(
      verdicts(
        [
          'In patients with psychiatric comorbidity who switched from LEV to BRV, at 12 months, seizure freedom was achieved in 13.9% (FAS).',
        ],
        EXPERIENCE,
        ['brivaracetam'],
      ).filter((r) => r[1] === '13.9%'),
    ).toEqual([['last', '13.9%', true, '-']])
    expect(
      verdicts(
        [
          'In patients with psychiatric comorbidity who switched from LEV to BRV, continuous seizure freedom was achieved in 10.6% at 12 months.',
        ],
        EXPERIENCE,
        ['brivaracetam'],
      ).filter((r) => r[1] === '10.6%'),
    ).toEqual([['last', '10.6%', true, '-']])
  })

  it('keeps a figure the claim states for the population the passage frames', () => {
    expect(
      verdicts(
        ['At 12 months, seizure freedom was achieved in 16.0% of patients with psychiatric comorbidity.'],
        EXPERIENCE,
        ['brivaracetam'],
      ).filter((r) => r[1] === '16.0%'),
    ).toEqual([['last', '16.0%', true, '-']])
  })

  it('carries the population into a sentence that only points back at it', () => {
    const checks = verifyFigures(
      [
        {
          text:
            'At 12 months, seizure freedom was achieved in 16.0% of patients with psychiatric comorbidity who switched from LEV to BRV (FAS).',
          texts: [EXPERIENCE],
        },
        {
          text: 'Continuous seizure freedom was achieved in 13.7% of these patients.',
          texts: [EXPERIENCE],
        },
      ],
      [EXPERIENCE],
      [],
      ['brivaracetam'],
    )
    expect(checks.filter((c) => c.figure === '13.7%').map((c) => [c.supported, c.reason]))
      .toEqual([[false, 'population']])
  })
})

describe('exact outcomes (D6-03)', () => {
  it('reads the modifiers a phrase names and the clause a figure sits in', () => {
    expect(outcomeModifiers('continuous seizure freedom rates were 11.7%')).toEqual(['continuous'])
    expect(clauseAround('seizure freedom was 14.9%; and continuous seizure freedom was 11.7%', 55))
      .toContain('continuous')
  })

  it('only counts a modifier the paper itself uses to tell two figures apart', () => {
    expect(distinguishesModifier(POOLED.toLowerCase(), ['seizure freedom'], 'continuous')).toBe(
      true,
    )
    expect(
      distinguishesModifier('all-cause mortality was 3.6 per 1000.', ['mortality'], 'all-cause'),
    )
      .toBe(false)
  })

  it('refuses a continuous seizure freedom rate under a seizure freedom heading', () => {
    expect(
      verdicts(
        ['| Drug | Study | 71.1% | 12-month seizure freedom 11.7% (FAS) |'],
        POOLED,
      ).filter((r) => r[1] === '11.7%'),
    ).toEqual([['last', '11.7%', false, 'outcome']])
  })

  it('keeps each rate under its own outcome', () => {
    expect(
      verdicts(
        ['The 12-month seizure freedom rate was 14.9% (n = 1111, full analysis set).'],
        POOLED,
      )
        .filter((r) => r[1] === '14.9%'),
    ).toEqual([['last', '14.9%', true, '-']])
    expect(
      verdicts(['Continuous seizure freedom at 12 months was 11.7% (n = 1111).'], POOLED)
        .filter((r) => r[1] === '11.7%'),
    ).toEqual([['last', '11.7%', true, '-']])
  })
})

describe('ranges and analysis sets (D6-05, D6-06)', () => {
  it("reads a range's lower bound and its partner", () => {
    const interval = '95% ci: 1.07- 4.68, p = 0.031'
    expect(rangeLowerBound(interval, interval.indexOf('4.68'))).toBe(interval.indexOf('1.07'))
    expect(rangePartnerOf('the range was 23 to 71 years', '71')).toBe('23')
    expect(rangeInSentence('mean age at implantation of 45 years (range = 23-71).', '71', '23'))
      .toBe(true)
  })

  it("places a confidence interval's upper bound by the quantity of its lower bound", () => {
    const text =
      'Patients with a history of tonic-clonic seizures in the 12 months leading up to admission ' +
      'had a >2 times increased SUDEP risk than those without, irrespective of lamotrigine or ' +
      'NaM-ASM use (aHR = 2.24; 95% CI: 1.07- 4.68, P = 0.031).'
    expect(
      verdicts(
        ['The adjusted hazard ratio for active tonic-clonic seizures at EMU admission is 2.24 (95% CI: 1.07-4.68, P = 0.031).'],
        text,
        ['sudep'],
      ).filter((r) => r[1] === '4.68'),
    ).toEqual([['last', '4.68', true, '-']])
  })

  it('places a stated range by the same range in the paper, and reads "mean" from the figure\'s own clause', () => {
    const text =
      'Half were assigned female sex at birth, with a mean age at implantation of 45 years (range = 23-71).'
    expect(
      verdicts(
        ['The median age of the UMPIRE participants was not explicitly stated, but the mean age at enrolment was 45 years, with a range of 23 to 71 years.'],
        text,
        ['umpire'],
      ).filter((r) => r[1] === '71'),
    ).toEqual([['last', '71', true, '-']])
  })

  it('names an analysis set, and accepts its size as the n a figure pairs', () => {
    expect(analysisSetIn('(n = 1644, full analysis set)')).toBe('fas')
    expect(analysisSetIn('(mFAS)')).toBe('mfas')
    expect(
      verdicts([
        'For brivaracetam, the 12-month retention rate was 71.1% (n = 1644, full analysis set).',
      ], POOLED)
        .filter((r) => r[1] === '71.1%'),
    ).toEqual([['last', '71.1%', true, '-']])
  })
})

describe('bibliographies never ground a sentence (D6-02)', () => {
  const PAPER = [
    'Introduction',
    '',
    'Adherence matters.',
    '',
    'REFERENCES',
    '',
    '7. Faught RE, Weiner JR, Guerin A, Cunnington MC, Duh MS.',
    'Impact of nonadherence to antiepileptic drugs on health',
    'care utilization and costs: findings from the RANSOM study.',
    'Epilepsia. 2009;50(3):501-9.',
    '',
    "8. Kerr MP. The impact of epilepsy on patients' lives. Acta Neurol",
    'Scand. 2012;126(s194):1-9.',
  ].join('\n')

  it('cuts a reference list the extraction wrapped over several lines per entry', () => {
    const stripped = stripReferenceSection(PAPER)
    expect(stripped).toContain('Adherence matters.')
    expect(/RANSOM/i.test(stripped)).toBe(false)
  })

  it('bounds a study the answer itself introduces, not only one the question names', () => {
    expect(
      namedStudies(
        'For instance, the RANSOM Study found that nonadherence is associated with mortality.',
      ),
    )
      .toEqual(['RANSOM'])
    expect(
      unheldStudyNote(
        'Is adherence associated with mortality?',
        ['Barriers to medication adherence'],
        ['Barriers to medication adherence'],
        'The RANSOM Study found increased mortality.',
      ),
    )
      .toContain('does not hold RANSOM itself')
    expect(
      unheldStudyNote(
        'Is adherence associated with mortality?',
        ['The EXPERIENCE pooled analysis'],
        ['The EXPERIENCE pooled analysis'],
        'The EXPERIENCE study reported retention.',
      ),
    )
      .toBeUndefined()
  })
})

describe("a paper's own words are never second-hand (D6-04, D6-07)", () => {
  const TRIAL = [
    'Abstract',
    '',
    'More patients on lacosamide than placebo had >=50% (68.1%/46.3%) reduction from baseline.',
    '',
    'Discussion',
    '',
    'The placebo responses seen in this trial were relatively high (median percent reduction',
    'in PGTCS frequency: -43.24%; 50% responder rate: 46.3%).',
  ].join('\n')

  it('keeps a Discussion figure the abstract also reports', () => {
    expect(
      secondhandFigures(
        [{
          text: 'The placebo 50% responder rate was 46.3%.',
          bound: [1],
          located: [{
            figure: '46.3%',
            index: 1,
            passage:
              'The placebo responses seen in this trial were relatively high (median percent reduction in PGTCS frequency: -43.24%; 50% responder rate: 46.3%).',
          }],
        }],
        new Map([[1, TRIAL]]),
      ),
    ).toEqual([])
  })

  it('reads a self-referential subject across a wrapped line, and stops at a heading', () => {
    const wrapped =
      'Discussion\n\nConsistent with this observation, our cohort had\nan 80% favorable mRS score at 12 months.'
    expect(speaksOfOwnWork(wrapped, wrapped.indexOf('80%'))).toBe(true)
    const heading =
      'Introduction\nRituximab reduced the odds of relapse by 83% in a meta-analysis.\n2 | METHODS\nWe identified 67 patients.'
    expect(speaksOfOwnWork(heading, heading.indexOf('83%'))).toBe(false)
  })
})

describe('a flagged sentence never leads (D6-07)', () => {
  it("reads the answer's lead sentence past headings and italic notes", () => {
    expect(
      leadSentence('## Findings\n\nIn the cohort, 80% had a favourable score.[1] More follows.'),
    )
      .toBe('In the cohort, 80% had a favourable score.')
    expect(leadSentence('*One sentence was removed.*\n\nRetention was 71.1%.[1]'))
      .toBe('Retention was 71.1%.')
  })
})

describe('a table cell is checked under its column heading (D6-03)', () => {
  // The generator puts a row's markers after its closing pipe.
  const TABLE = [
    '| Drug | n | 12-month retention | 12-month seizure freedom |[1]',
    '|---|---|---|---|',
    '| Brivaracetam | 1644 | 71.1% | 14.9% |[1]',
  ].join('\n')

  it('maps each figure to the heading above it', () => {
    const headings = tableCellHeadings(TABLE)
    const row = headings.get(rowKey('| Brivaracetam | 1644 | 71.1% | 14.9% |[1]'))
    expect(row?.get('14.9%')).toBe('12-month seizure freedom')
    expect(row?.get('71.1%')).toBe('12-month retention')
  })

  it('keeps the cell whose outcome the heading names and refuses the one it does not', () => {
    const row = '| Brivaracetam | 1644 | 71.1% | 11.7% [1] |'
    const headings = new Map([['11.7%', '12-month seizure freedom'], [
      '71.1%',
      '12-month retention',
    ]])
    expect(
      verifyFigures([{ text: row, texts: [POOLED], headings }], [POOLED])
        .filter((c) => c.figure === '11.7%').map((c) => [c.supported, c.reason]),
    ).toEqual([[false, 'outcome']])
    const good = '| Brivaracetam | 1644 | 71.1% | 14.9% [1] |'
    expect(
      verifyFigures([{
        text: good,
        texts: [POOLED],
        headings: new Map([['14.9%', '12-month seizure freedom'], ['71.1%', '12-month retention']]),
      }], [POOLED]).filter((c) => c.figure === '14.9%').map((c) => c.supported),
    ).toEqual([true])
  })
})

describe('a sentence that quotes other work is second-hand whatever the abstract says (D5-15)', () => {
  it('reads a trailing numbered citation', () => {
    expect(
      endsWithReferenceMarker('the rate has risen from 10% in 1990 to over 22% after 2020.[6, 7]'),
    )
      .toBe(true)
    expect(endsWithReferenceMarker('our cohort had an 80% favorable mRS score at 12 months.')).toBe(
      false,
    )
  })

  it("does not let a paper's own abstract clear a figure its introduction quotes", () => {
    const text = [
      '## Abstract',
      '',
      'Mixture modeling indicated a higher 50% responder rate (42% in the higher group vs 22% in the lower group).',
      '',
      '## Introduction:',
      '',
      'The placebo 50% responder rate has been increasing over time from 10% in 1990 to over 22% after 2020.[6, 7]',
      '',
      '## Results:',
      '',
      'There was a higher 50% responder rate in Bulgaria (42% in the higher group vs 22% in the lower group).',
    ].join('\n')
    const passage =
      'The placebo 50% responder rate has been increasing over time from 10% in 1990 to over 22% after 2020.'
    expect(
      secondhandFigures([{
        text: 'the placebo responder rate has been increasing, reaching over 22% after 2020.',
        bound: [1],
        located: [{ figure: '22%', index: 1, passage }],
      }], new Map([[1, text]])),
    ).toEqual([{ figure: '22%', index: 1 }])
  })
})
