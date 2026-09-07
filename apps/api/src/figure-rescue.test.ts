import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { prepareSource } from './answer-audit.ts'
import {
  carriesQualifier,
  cohortTerms,
  exposureOutcomePair,
  figuresFoundIn,
  isDeclineSentence,
  isTableRow,
  isWholeDecline,
  namesOtherStudy,
  ownFigureSentence,
  pairCarried,
  quoteSentence,
  replacementCue,
  rescueSentence,
  splitOwnSentences,
  statesResultFigure,
  tableRowText,
  withQualifier,
} from './figure-rescue.ts'

const LEXICON = ['brivaracetam', 'levetiracetam', 'perampanel', 'lamotrigine']

/** The EXPERIENCE main paper and the LGI1 and anti-NMDAR consortium papers, in miniature. */
const EXPERIENCE =
  'Effectiveness and tolerability of 12-month brivaracetam (BRV) in the real world: EXPERIENCE.\n\n' +
  'Results\n\nAnalyses included 1644 adults (FAS). BRV retention was 89.4%, 79.8%, and 71.1% at 3, 6, ' +
  'and 12 months, respectively (FAS; Fig. 1d). Seizure freedom rates were 22.4% (n = 923), ' +
  '17.9% (n = 1165), and 14.9% (n = 1111).\n\nSwitched from LEV or other ASMs to BRV at index, n (%)\n\n' +
  'Switched from LEV 709 (43.8)l\n\nSwitched from other ASMs 887 (54.8)l\n\nNo switch 23 (1.4)l\n\n' +
  'Discussion\n\nThe 12-month retention on BRV in EXPERIENCE (71.1%) was similar to BRIVAFIRST (74.2%).'
const LGI1 =
  'Acute and long-term immune-treatment strategies in anti-LGI1 antibody-mediated encephalitis.\n\n' +
  'Results\n\nRituximab was administered in 26 (49%) and cyclophosphamide in 3 (6%) patients. ' +
  'Rituximab, adjusted for concomitant use of other immunotherapies, was associated with increased ' +
  'time to first relapse (hazard ratio 0.10; 95% CI 0.001-0.85; p = 0.03). A total of 16 (30%) ' +
  'patients experienced at least 1 relapse.'

describe('the cohort the question names (D3-01)', () => {
  it('reads a designator from the question and keeps the symbol inside it', () => {
    expect(cohortTerms('In the LGI1 encephalitis cohort, how many patients received rituximab?'))
      .toEqual(['lgi1'])
    expect(cohortTerms('What did the BREATHS trial find?')).toEqual(['breaths'])
    expect(cohortTerms('In the PERMIT pooled analysis, what was retention?')).toEqual(['permit'])
    expect(cohortTerms('Across the whole cohort, what was retention?')).toEqual([])
    expect(cohortTerms('In the real-world Australian cohort, how many met the criteria?')).toEqual(
      [],
    )
  })

  it('designates nothing for a comparison of two studies, or for a topic acronym', () => {
    expect(cohortTerms(
      'Compare the SUDEP case-control study with the psychiatric comorbidity and mortality study - cohort, design, effect size and n for each.',
    )).toEqual([])
    expect(cohortTerms('In the SUDEP case-control study, what was the hazard ratio?')).toEqual([])
    expect(cohortTerms('Compare the PERMIT study with the EXPERIENCE analysis.', ['PERMIT']))
      .toEqual(['permit'])
  })

  it('adds the terms that pinned a paper', () => {
    expect(cohortTerms('What did UMPIRE report?', ['UMPIRE'])).toEqual(['umpire'])
  })

  it('lets a sentence that names another study keep it', () => {
    expect(namesOtherStudy('In the anti-NMDAR study, the hazard ratio was 0.11.', ['lgi1'])).toBe(
      true,
    )
    expect(namesOtherStudy('In the LGI1 cohort, the hazard ratio was 0.10.', ['lgi1'])).toBe(false)
    expect(namesOtherStudy('The hazard ratio was 0.11.', ['lgi1'])).toBe(false)
  })

  it('tells a result figure from a sample size or a timepoint', () => {
    expect(statesResultFigure('The hazard ratio was 0.11 (n = 51).')).toBe(true)
    expect(statesResultFigure('The analysis included 1644 patients at 12 months.')).toBe(false)
  })
})

describe('the rescue (D3-02)', () => {
  it('finds every figure of a withheld sentence in a retrieved text and lends its marker', () => {
    const found = rescueSentence({
      sentence: {
        text: 'For the whole cohort, the retention was 71.1% (n = 1644, full analysis set).',
        bound: [],
        line: 0,
      },
      pool: [{ index: 7, text: prepareSource(EXPERIENCE), resourceId: 'exp' }],
      lexicon: LEXICON,
      questionEntities: ['brivaracetam'],
    })
    expect(found?.index).toBe(7)
    expect(found?.checks.map((c) => c.figure)).toEqual(['71.1%', '1644'])
    expect(found?.checks.every((c) => c.supported)).toBe(true)
  })

  it('does not lend a marker when one figure is missing', () => {
    const found = rescueSentence({
      sentence: {
        text: 'For the whole cohort, the retention was 71.1% (n = 1700).',
        bound: [],
        line: 0,
      },
      pool: [{ index: 7, text: prepareSource(EXPERIENCE), resourceId: 'exp' }],
      lexicon: LEXICON,
      questionEntities: [],
    })
    expect(found).toBeUndefined()
  })

  it('names the papers that carry a removed figure somewhere', () => {
    expect(
      figuresFoundIn(['71.1%'], [{ title: 'EXPERIENCE', text: prepareSource(EXPERIENCE) }, {
        title: 'LGI1',
        text: prepareSource(LGI1),
      }]),
    ).toEqual(['EXPERIENCE'])
  })
})

describe("the paper's own figure sentence (D3-10)", () => {
  it('quotes the results sentence that carries the claim, preferring the kind of figure the sentence stated', () => {
    const cue = replacementCue(
      'In the LGI1 encephalitis cohort, 38 patients received rituximab as second-line therapy.',
      LEXICON,
      ['lgi1'],
      ['relapse'],
    )
    const own = ownFigureSentence(LGI1, cue)
    expect(own?.sentence).toBe(
      'Rituximab was administered in 26 (49%) and cyclophosphamide in 3 (6%) patients.',
    )
    const ratio = replacementCue(
      'The hazard ratio for time to first relapse with rituximab was 0.11 (95% CI 0.02-0.70).',
      LEXICON,
      ['lgi1'],
      ['relapse'],
    )
    expect(ownFigureSentence(LGI1, ratio)?.sentence).toContain('hazard ratio 0.10')
  })

  it('never quotes the discussion, and adds nothing the answer already states', () => {
    const cue = replacementCue(
      'Retention at 12 months was 74.2% in the whole cohort.',
      LEXICON,
      [],
      ['retention'],
    )
    expect(ownFigureSentence(EXPERIENCE, cue)?.sentence).toContain('71.1%')
    expect(ownFigureSentence(EXPERIENCE, { ...cue, exclude: ['71.1%', '89.4%', '79.8%'] }))
      .toBeUndefined()
  })

  it('reads a table row with its share, and its sibling rows, for a count', () => {
    expect(isTableRow('Switched from LEV 709 (43.8)l')).toBe(true)
    expect(tableRowText('Switched from LEV 709 (43.8)l')).toBe('Switched from LEV 709 (43.8%)')
    const cue = replacementCue(
      'Patients who switched from levetiracetam (LEV) to brivaracetam (BRV) were compared. ' +
        'The number of patients in each group was not specified.',
      LEXICON,
      ['levetiracetam', 'brivaracetam'],
      [],
    )
    const own = ownFigureSentence(
      `Levetiracetam (LEV) was the prior drug.\n\n${EXPERIENCE}`,
      { ...cue, outcomes: [], wantCount: true },
    )
    expect(own?.sentence).toContain(
      'Switched from LEV 709 (43.8%); Switched from other ASMs 887 (54.8%)',
    )
  })

  it('renders the quote without a glued heading or a figure reference', () => {
    expect(quoteSentence('Results Rituximab was given in 26 (49%) (Fig. 2).')).toBe(
      'The paper itself reports: "Rituximab was given in 26 (49%)."',
    )
  })

  it('splits sentences without breaking at Fig. or et al.', () => {
    expect(splitOwnSentences('A favourable mRS occurred in 154 (67%) patients (Fig. 2). Next one.'))
      .toEqual(['A favourable mRS occurred in 154 (67%) patients (Fig. 2).', ' Next one.'])
  })
})

describe('the population the passage states (D3-07)', () => {
  it('carries the qualifier into a sentence that lacks it, keeping an acronym opener', () => {
    expect(
      carriesQualifier(
        'In patients with psychiatric comorbidity, 13.9%',
        'with psychiatric comorbidity',
      ),
    )
      .toBe(true)
    expect(carriesQualifier('In the EXPERIENCE analysis, 13.9%', 'with psychiatric comorbidity'))
      .toBe(false)
    expect(
      withQualifier(
        'In the EXPERIENCE analysis, the rate was 13.9%.',
        'with psychiatric comorbidity',
      ),
    )
      .toBe(
        'Among patients with psychiatric comorbidity, in the EXPERIENCE analysis, the rate was 13.9%.',
      )
    expect(withQualifier('BRV retention was 72.7%.', 'with psychiatric comorbidity'))
      .toBe('Among patients with psychiatric comorbidity, BRV retention was 72.7%.')
  })
})

describe('decline sentences (D3-15)', () => {
  it('recognises the decline forms and a wholly declining answer', () => {
    expect(isDeclineSentence('The cited sources do not provide specific data on SUDEP incidence.'))
      .toBe(true)
    expect(
      isDeclineSentence(
        'The number of patients in each group was not specified in the cited sources.',
      ),
    )
      .toBe(true)
    expect(isDeclineSentence('The retention rate was 71.1%.')).toBe(false)
    expect(isWholeDecline('The cited sources do not provide the rate per 1000 patient-years.[1]'))
      .toBe(true)
    expect(isWholeDecline('The rate was 2.5 per 1000.[1] The cited sources do not provide more.'))
      .toBe(false)
  })
})

describe('the relationship a question pairs (D3-12)', () => {
  it('reads "the relationship between X and Y" and checks a record pairs both in one field', () => {
    const pair = exposureOutcomePair(
      'For a grant application: what did the group find about the relationship between antiseizure medication adherence and death, with the cohort size?',
    )
    expect(pair?.exposure).toBe('antiseizure medication adherence')
    expect(pair?.outcome).toBe('death')
    expect(pairCarried({
      title: 'Facilitators and barriers of antiseizure medication adherence',
      keyTakeaways: ['Five patients died during follow-up.'],
    }, pair!)).toBe(false)
    expect(pairCarried({
      title: 'Adherence and mortality in epilepsy: a linkage study',
    }, pair!)).toBe(true)
    expect(exposureOutcomePair('What was the 12-month retention rate?')).toBeUndefined()
  })
})

describe('a claim about a named drug (D3-06)', () => {
  it('is never answered from a paper about another drug', () => {
    const PERMIT =
      'PERMIT study of perampanel.\n\nResults\n\nRetention on PER treatment at 12 months was 64.2% (2698/4201). ' +
      'The seizure freedom rate was 23.2% at 12 months.'
    const cue = replacementCue(
      'In the EXPERIENCE pooled analysis for brivaracetam, the 12-month retention rate was 71.1% (n = 1644).',
      LEXICON,
      ['brivaracetam'],
      ['retention'],
    )
    expect(cue.drugs).toEqual(['brivaracetam'])
    expect(ownFigureSentence(PERMIT, cue)).toBeUndefined()
    expect(ownFigureSentence(EXPERIENCE, cue)?.sentence).toContain('71.1%')
  })
})
