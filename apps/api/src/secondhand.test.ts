import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  carriesOwnDenominator,
  figureOffsets,
  hasBodyHeadings,
  markedSentences,
  reportsOwnResults,
  secondhandFigures,
  secondhandNote,
  sectionAt,
  sectionSpans,
} from './secondhand.ts'
import { citesEarlierWork, inTableOrLegend } from './secondhand.ts'

const PAPER = [
  ' Rituximab Use for Relapse Prevention ',
  ' Abstract ',
  ' Background and Objectives: We examined rituximab. ',
  ' Methods: A multicenter cohort of 67 patients. ',
  ' Results: A single course was associated with longer time to relapse (HR 0.11). ',
  ' Introduction ',
  ' Rituximab reduced the odds of relapse by 83% in a meta-analysis.9 ',
  ' 2 | METHODS ',
  ' We identified 67 patients across 10 hospitals. ',
  ' 3 | RESULTS ',
  ' The hazard ratio for first relapse was 0.11 (95% CI 0.02-0.70) with 2,698 person-months. ',
  ' 4 | DISCUSSION ',
  ' Earlier work reported relapse in 12% to 35% of patients. ',
  ' References ',
  ' 9. Some meta-analysis. ',
].join('\n')

describe('sectionSpans', () => {
  it('places each heading and keeps a structured abstract together', () => {
    const spans = sectionSpans(PAPER)
    expect(spans.map((s) => s.section)).toEqual([
      'other',
      'abstract',
      'introduction',
      'methods',
      'results',
      'discussion',
      'references',
    ])
    expect(hasBodyHeadings(spans)).toBe(true)
    expect(sectionAt(spans, PAPER.indexOf('83%'))).toBe('introduction')
    expect(sectionAt(spans, PAPER.indexOf('HR 0.11'))).toBe('abstract')
    expect(sectionAt(spans, PAPER.indexOf('2,698'))).toBe('results')
  })
  it('reports no body headings for a text without them', () => {
    const spans = sectionSpans('Just a paragraph with 12% and no headings at all.')
    expect(hasBodyHeadings(spans)).toBe(false)
  })
})

describe('figureOffsets', () => {
  it('matches a figure with or without a thousands separator, never inside a longer number', () => {
    expect(figureOffsets('2698', 'n = 2,698 and 12698 and 2698.')).toEqual([4, 24])
    expect(figureOffsets('0.11', 'HR 0.11 and 10.11')).toEqual([3])
    expect(figureOffsets('83%', 'by 83% in')).toEqual([3])
    expect(figureOffsets('14%', '14 days and 14 % and 14%')).toEqual([12, 21])
  })
})

describe('secondhandFigures', () => {
  const texts = new Map([[1, PAPER]])
  it('flags a figure that appears only in the introduction or discussion', () => {
    const found = secondhandFigures(
      [
        { text: 'Rituximab reduced the odds of relapse by 83%.', bound: [1] },
        { text: 'Relapse occurred in 35% of patients.', bound: [1] },
      ],
      texts,
    )
    expect(found).toEqual([{ figure: '83%', index: 1 }, { figure: '35%', index: 1 }])
  })
  it('leaves a figure from the abstract, results or methods alone, and an absent one to the audit', () => {
    expect(
      secondhandFigures(
        [{ text: 'The hazard ratio was 0.11 across 67 patients and 99% of nothing.', bound: [1] }],
        texts,
      ),
    ).toEqual([])
  })
  it('never judges a paper without body headings', () => {
    expect(
      secondhandFigures([{ text: 'A 12% rate.', bound: [1] }], new Map([[1, 'Only 12% here.']])),
    ).toEqual([])
  })
})

describe('markedSentences and secondhandNote', () => {
  it('splits marked lines into sentences with their markers and skips addendum lines', () => {
    expect(
      markedSentences(
        'First claim 83%.[1] Second claim.[2][3]\n\n*Denominators: none.*\nUnmarked.',
      ),
    ).toEqual([
      { text: 'First claim 83%.', bound: [1] },
      { text: 'Second claim.', bound: [2, 3] },
    ])
  })
  it('writes one line naming the figures and their markers', () => {
    expect(secondhandNote([])).toBeUndefined()
    expect(secondhandNote([{ figure: '83%', index: 2 }])).toBe(
      '*Second-hand figures: 83% [2] appears in the cited paper only where it cites other ' +
        'studies (its introduction, its discussion or a figure it takes from earlier work), not ' +
        'among its own results.*',
    )
  })
})

describe('first-hand sections and table rows (D3-08)', () => {
  it('reads a protocol\'s "Methods and analysis" as methods, so its sample size is first-hand', () => {
    const protocol = 'Abstract\n\nA trial.\n\nIntroduction\n\nEarlier work found 30%.\n\n' +
      'Methods and analysis\n\nSample size calculation\n\nA total of 220 participants (110 per group) are required.\n\n' +
      'Discussion\n\nWe discuss.'
    expect(secondhandFigures(
      [{ text: 'The sample size is 220 participants, with 110 per group.', bound: [1] }],
      new Map([[1, protocol]]),
    )).toEqual([])
  })

  it("treats a table row and a figure legend as the paper's own data wherever the extraction put them", () => {
    const paper =
      'Abstract\n\nA study.\n\nIntroduction\n\nBackground.\n\nResults\n\nAEs were common.\n\n' +
      'Discussion\n\nOthers found 12%.\n\nTable 3 Adverse events\n\nDizziness/vertigo, n (%) 701 (15.2)\n\n' +
      'Somnolence, n (%) 491 (10.6)\n\n'
    expect(secondhandFigures(
      [{
        text: 'Dizziness was reported in 15.2% (n = 701) and somnolence in 10.6% (n = 491).',
        bound: [1],
      }],
      new Map([[1, paper]]),
    )).toEqual([])
    expect(inTableOrLegend(paper, paper.indexOf('701'))).toBe(true)
  })

  it('never judges a clock time, a follow-up week or a bare small integer', () => {
    const paper =
      'Abstract\n\nA.\n\nIntroduction\n\nPeaks at 11 p.m.; follow-up at weeks 52, 78 and 104; 16 Hz.\n\nResults\n\nB.'
    expect(secondhandFigures(
      [{
        text: 'Discharges peak at 11 p.m.; outcomes at weeks 52, 78 and 104; 10-16 Hz.',
        bound: [1],
      }],
      new Map([[1, paper]]),
    )).toEqual([])
  })
})

describe('a figure the paper attributes to earlier work', () => {
  it('is second-hand even in the methods', () => {
    const paper =
      'Abstract\n\nA.\n\nIntroduction\n\nB.\n\nMethods\n\nThe expected SUDEP incidence of 5.9 per 1000 ' +
      'patient-years was based on previous incidence data from a comparable group.\n\nResults\n\nC.'
    expect(secondhandFigures(
      [{ text: 'The SUDEP incidence was 5.9 per 1000 patient-years.', bound: [1] }],
      new Map([[1, paper]]),
    )).toEqual([{ figure: '5.9', index: 1 }, { figure: '1000', index: 1 }])
    expect(citesEarlierWork(paper, paper.indexOf('5.9'))).toBe(true)
    expect(citesEarlierWork('We found 5.9 per 1000 in our cohort.', 9)).toBe(false)
    // Elsevier-style numbered headings, and a text with none at all.
    const numbered =
      '1. Introduction\n\nA.\n\n2. Methods\n\nWe applied previous incidence data, reporting a SUDEP ' +
      'incidence of 5.9/1000 patient-years (Nashef et al., 1995).\n\n3. Results\n\nB.'
    expect(sectionSpans(numbered).map((s) => s.section)).toContain('results')
    expect(
      secondhandFigures(
        [{ text: 'The SUDEP incidence was 5.9 per 1000 patient-years.', bound: [1] }],
        new Map([[1, numbered]]),
      ).map((f) => f.figure),
    ).toEqual(['5.9', '1000'])
    expect(secondhandFigures(
      [{ text: 'The rate was 5.9 per 1000.', bound: [1] }],
      new Map([[1, 'No headings here. We found 5.9 per 1000 in our cohort.']]),
    )).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Papers that are not IMRaD articles (PR: the fenfluramine second-hand note)
// ---------------------------------------------------------------------------

/** A review: an abstract, one long body under numbered headings, a conclusion. */
const REVIEW = [
  ' Ameliorating Seizures in Dravet Syndrome: A Review ',
  ' Abstract ',
  ' We review newly approved and investigational drugs. ',
  ' 1 Introduction ',
  ' Dravet syndrome is a developmental and epileptic encephalopathy. ',
  ' 3 Newly Approved Drugs ',
  ' When fenfluramine is combined with stiripentol, a reduction in the maximum dose is',
  ' recommended, from 0.7 mg/kg/day (maximum 26 mg/day) without stiripentol to 0.4 mg/kg/day',
  ' (maximum 17 mg/day) on stiripentol. ',
  ' 5 Conclusion ',
  ' Several disease-modifying therapies are in trials. ',
].join('\n')

/** A consensus statement: its recommendations carry the panel vote behind them. */
const CONSENSUS = [
  ' International consensus on diagnosis and management of Dravet syndrome ',
  ' Abstract ',
  ' We gathered consensus from physicians and caregivers. ',
  ' 1 | INTRODUCTION ',
  ' Earlier surveys reported avoidance in 45% of centres.11 ',
  ' 3 | RESULTS ',
  ' All physicians (n = 20) and nine of 11 caregivers participated in both rounds. ',
  ' 4 | DISCUSSION ',
  ' Lamotrigine ',
  ' Lamotrigine should be considered contraindicated in children with DS (physicians: n = 19, 79%). ',
  ' Lamotrigine may have a very limited role in adults with refractory seizures due to DS, but',
  ' should not be used until all appropriate agents have been trialed',
  ' (PHYSICIANS: n = 19, 100%). ',
].join('\n')

describe('a paper with no Results section of its own', () => {
  it('is not judged on its sections, so a review reports its own dosing', () => {
    const spans = sectionSpans(REVIEW)
    expect(hasBodyHeadings(spans)).toBe(true)
    expect(reportsOwnResults(spans)).toBe(false)
    // Without the rule every figure in the review's body sits in what the
    // splitter calls its introduction, so all four were called second-hand.
    expect(sectionAt(spans, REVIEW.indexOf('0.7'))).toBe('introduction')
    expect(
      secondhandFigures(
        [{
          text:
            'The recommended dose is 0.7 mg/kg/day (maximum 26 mg/day), reduced to 0.4 mg/kg/day (maximum 17 mg/day) on stiripentol.',
          bound: [1],
        }],
        new Map([[1, REVIEW]]),
      ),
    ).toEqual([])
  })

  it('still flags a figure the text itself attributes to earlier work', () => {
    const quoting = REVIEW.replace(
      ' recommended, from 0.7 mg/kg/day',
      ' recommended, as reported by an earlier trial, from 0.7 mg/kg/day',
    )
    expect(
      secondhandFigures(
        [{ text: 'The dose is reduced to 0.7 mg/kg/day.', bound: [1] }],
        new Map([[1, quoting]]),
      ),
    ).toEqual([{ figure: '0.7', index: 1 }])
  })
})

describe('carriesOwnDenominator', () => {
  it('reads a proportion printed beside the group the paper counted', () => {
    expect(carriesOwnDenominator(CONSENSUS, CONSENSUS.indexOf('100%'))).toBe(true)
    expect(carriesOwnDenominator(CONSENSUS, CONSENSUS.indexOf('79%'))).toBe(true)
    // No parenthesis of its own, and a quotation of earlier work, are not.
    expect(carriesOwnDenominator(CONSENSUS, CONSENSUS.indexOf('45%'))).toBe(false)
    expect(
      carriesOwnDenominator(
        'the rate rose to (n = 40) 22% after 2020.[6]',
        'the rate rose to (n = 40) '.length,
      ),
    ).toBe(false)
  })

  it("keeps a consensus recommendation's own vote out of the second-hand note", () => {
    const spans = sectionSpans(CONSENSUS)
    expect(reportsOwnResults(spans)).toBe(true)
    expect(sectionAt(spans, CONSENSUS.indexOf('100%'))).toBe('discussion')
    const passage =
      'Lamotrigine may have a very limited role in adults with refractory seizures due to DS, but should not be used until all appropriate agents have been trialed (PHYSICIANS: n = 19, 100%).'
    expect(
      secondhandFigures(
        [{
          text:
            'It may have a very limited role in adults with refractory seizures (physicians: n = 19, 100%).',
          bound: [1],
          located: [{ figure: '100%', index: 1, passage }],
        }],
        new Map([[1, CONSENSUS]]),
      ),
    ).toEqual([])
  })
})
