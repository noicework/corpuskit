/**
 * Locate first (review loop 5, section 6): every
 * row here is a figure the loop 5 run removed, kept or mis-paired, with the
 * passage as the platform extracted it. A sentence the paper carries word
 * for word is kept (D5-01), the cohort guard never fires against the paper
 * the question describes or names (D5-02), a denominator is never
 * rewritten and only added from the figure's own bracket or cell (D5-03),
 * a wrong quantity under a clean badge is caught by the located sentence's
 * own words, outcomes, threshold and pairing (D5-04), and the loop 4 P0s
 * stay closed.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  bracketSpan,
  claimFeatures,
  denominatorsMissing,
  isRowParagraph,
  isThresholdAt,
  locateFigure,
  normaliseGlyphs,
  prepareSource,
  quantityPhrase,
  spellings,
  studyDesignOf,
  verifyFigures,
} from './answer-audit.ts'
import { quoteCarriesClaim, studyLabel } from './figure-rescue.ts'
import { inTableOrLegend, offsetOfPassage, secondhandFigures, sectionSpans } from './secondhand.ts'
import { carriesDesignator, cohortDesignators } from './study-guard.ts'
import { bindAndAudit, type ExtractionSource } from './ask-grounding.ts'
import type { ResourceSummary, ScoredResource, TenantConfig } from '@research-portal/core'

const verdicts = (
  sentence: string,
  text: string,
  lexicon: string[] = [],
  entities: string[] = [],
) =>
  verifyFigures([{ text: sentence, texts: [text] }], [text], lexicon, entities).map((c) => [
    c.figure,
    c.supported,
  ])

describe('the located sentence places the claim (D5-01)', () => {
  it('keeps "80% of EDs" beside the paper\'s "80% of EDs in Group 1" (Q6)', () => {
    const text =
      'We found F1 = 0.8, suggesting that 80% of EDs in Group \n\n 1 were clustered during the sleep period. In contrast, F2 is 0.37.'
    expect(
      verdicts(
        'Approximately 80% of EDs in this group occur during the sleep period, indicating a strong association with sleep stages, particularly non-rapid eye movement (NREM) sleep, which is known to facilitate EDs.',
        text,
      ),
    ).toEqual([['80%', true]])
  })

  it('reads a table cell by its row label and column headings (N12, E4)', () => {
    const table =
      'Table 1 Patient Demographics by Presence of a Psychiatric Comorbidity (n = 1805)\n\n' +
      'No psychiatric disorder\n\nAny psychiatric disorder\n\nDepressive disorder\n\n' +
      'N (%) 868 (48) 937 (52) 670 (37)\n\nAge at VEM, y, median (IQR)\n\n35 (26-46) 37 (29-47) 38 (30-48)\n\n' +
      'Follow-up duration, y,\n\nmedian (IQR)\n\n9 (4-14) 9 (5-13) 9 (5-13)\n\nNumber deceased 60 87 63\n\n' +
      'Abbreviations: IQR = interquartile range.'
    expect(
      verdicts(
        'In the study "Association Between Psychiatric Comorbidities and Mortality in Epilepsy," 937 patients had a psychiatric diagnosis out of a total of 1,805 patients who had a complete neuropsychiatric evaluation.',
        table,
      ),
    ).toEqual([['937', true], ['1805', true]])
    expect(
      verdicts(
        'Among those with a psychiatric comorbidity, 87 individuals died during follow-up.',
        table,
      ),
    )
      .toEqual([['87', true]])
    // A bare number on a count row is a count of what its label says: 87
    // deceased is not 87 with a psychiatric disorder.
    expect(verdicts('87 patients had a depressive disorder.', table)).toEqual([['87', false]])
  })

  it('finds a duration in a table row whose label names the unit (XA)', () => {
    const table =
      'Table 1 Patient Demographics\n\nNo psychiatric disorder\n\nAny psychiatric disorder\n\n' +
      'Follow-up duration, y,\n\nmedian (IQR)\n\n9 (4-14) 9 (5-13) 9 (5-13)\n\nNumber deceased 60 87 63'
    expect(
      verdicts(
        'The median follow-up duration in the psychiatric comorbidity and mortality cohort was 9 years (interquartile range 4–14 years) for those with no psychiatric disorder and 9 years (interquartile range 5–13 years) for those with any psychiatric disorder.',
        table,
      ).every(([, ok]) => ok),
    ).toBe(true)
  })

  it('keeps the paper\'s own "14.9% (n = 1111)" for brivaracetam, which the paper abbreviates (HE, S3)', () => {
    const text =
      'Effectiveness and Tolerability of 12-Month Brivaracetam (BRV): EXPERIENCE.\n\nResults Analyses included 1644 adults. ' +
      'At 3, 6, and 12 months, respectively, ≥ 50% seizure reduction was achieved by 32.1% (n = 619), 36.7% (n = 867), ' +
      'and 36.9% (n = 822) of patients; seizure freedom rates were 22.4% (n = 923), 17.9% (n = 1165), and 14.9% (n = 1111). ' +
      'During the whole study follow-up, 551/1639 (33.6%) patients discontinued BRV.'
    expect(
      verdicts(
        'In the EXPERIENCE analysis, the seizure freedom rate for brivaracetam at 12 months was 14.9% (n = 1111).',
        text,
        ['brivaracetam'],
        ['brivaracetam'],
      ),
    ).toEqual([['12months', true], ['14.9%', true], ['1111', true]])
  })

  it('reads a statistic inside a bracket with the sentence the bracket belongs to (RB)', () => {
    const text =
      'RFTHC of a language-positive site was associated with subsequent decline on a language measure [χ2 = 6.94, d.f. = 1, P = 0.008, moderate effect size; odds ratio = 10.00, 95% CI (1.68, 59.31); see Table 4].'
    expect(bracketSpan(text, text.indexOf('1.68'))).toEqual({
      open: text.indexOf('['),
      close: text.indexOf(']'),
    })
    expect(
      verdicts(
        'The likelihood of language decline increased by 10-fold when RFTC included a language-positive site [odds ratio = 10.00, 95% CI (1.68, 59.31)].',
        text,
      ).every(([, ok]) => ok),
    ).toBe(true)
  })

  it('matches "414 (IQR 256, 967) days" on a lower-cased text and a median time is no follow-up (K5)', () => {
    const text =
      'A total of 16 (30%) patients experienced at least 1 relapse, at a median of 414 (IQR 256, 967) days from their initial visit.'
    expect(
      verdicts(
        'In the study, 30% of patients experienced at least one relapse, with a median time to first relapse of 414 days (IQR 256–967).',
        text,
      ).every(([, ok]) => ok),
    ).toBe(true)
  })

  it('reads the dot operator as a decimal point (GB)', () => {
    expect(normaliseGlyphs('an AUC of 0⋅70 (95%CI 0⋅67–0⋅72)')).toBe(
      'an AUC of 0.70 (95%CI 0.67–0.72)',
    )
    const text =
      'Internal-external cross-validation of our multivariable model showed an area under the receiver operating characteristic curve of 0⋅70 (95%CI 0⋅68–0⋅72). EEG abnormality before reduction of ASM Yes 67/221 (30.0%) 0.93 (0.65-1.34) 0.70'
    expect(
      verdicts(
        'The model showed an area under the receiver operating characteristic curve (AUC) of 0.70, indicating acceptable predictive performance.',
        text,
      ),
    ).toEqual([['0.70', true]])
  })

  it('keeps "24 completed" and "13 out of 26, or 50%" against the UMPIRE paper (DCB, HC)', () => {
    const text =
      'Results: 26 subjects were implanted between November 2019 and July 2023. The remaining 24 participants completed 6 months of followup.\n\n' +
      'T A B L E 2 Cohort summary (N = 26).\n\nCharacteristic Value\n\nFemale, n (%) 13 (50%)\n\n' +
      'Age at enrollment, years, mean (range) 45 (23-71)\n\nEpilepsy type, n (%)\n\nFocal 23 (88.5%)'
    expect(
      verdicts(
        'Twenty-six participants were implanted with the device, and 24 completed the study.',
        text,
      ),
    )
      .toEqual([['26', true], ['24', true]])
    expect(
      verdicts(
        'Half of the participants were assigned female sex at birth, which is 13 out of 26, or 50%.',
        text,
      )
        .every(([, ok]) => ok),
    ).toBe(true)
    expect(
      verdicts(
        'However, the mean age at enrolment was 45 years, with a range of 23 to 71 years.',
        text,
      )
        .every(([, ok]) => ok),
    ).toBe(true)
    expect(
      verdicts('There were 13 women, which is 50% of the participants (n = 26).', text).every((
        [, ok],
      ) => ok),
    )
      .toBe(true)
    expect(spellings('enrolment')).toBe('enroll?ment')
    expect(new RegExp(spellings('generalised')).test('generalized')).toBe(true)
    expect(new RegExp(spellings('favourable')).test('favorable')).toBe(true)
  })

  it('asks each paper only for the names of the clause its figure sits in (ED)', () => {
    const vem =
      'A total of 1805 patients were identified in whom a record of video-EEG monitoring (VEM) was available.'
    const sudep =
      'Risk of SUDEP with lamotrigine: a nested case-control study of 101 SUDEP cases and 199 living epilepsy controls.'
    const checks = verifyFigures(
      [{
        text:
          'The video-EEG monitoring mortality cohort consisted of 1,805 adults, while the lamotrigine SUDEP case-control study included 101 SUDEP cases and 199 living epilepsy controls, making the latter smaller in size.',
        texts: [vem, sudep],
      }],
      [vem, sudep],
      ['lamotrigine'],
      ['lamotrigine', 'sudep'],
    )
    expect(checks.map((c) => [c.figure, c.supported])).toEqual([['1805', true], ['101', true], [
      '199',
      true,
    ]])
  })

  it('still refuses a figure borrowed from another intervention in the same paper (R3, P1-01)', () => {
    const rftc =
      'A cross-electrode RFTC study of 21 patients with HS reported that 76% had seizure freedom at 12 months. ' +
      'Long-term efficacy has been reported as 64% past 63 months for resection and 68% at 2 years for LITT.'
    expect(verdicts('LITT achieved 76% seizure freedom at 12 months.', rftc)).toEqual([
      ['76%', false],
      ['12months', false],
    ])
  })
})

describe('a wrong quantity under a clean badge is caught by the located sentence (D5-04)', () => {
  it('a responder threshold is not a responder rate (DCC)', () => {
    const text =
      'In the pooled analysis of 1674 participants randomized to placebo, a higher 50% responder rate was associated with shorter duration of epilepsy (p=0.006). Data from 1674 participants was available, of which 395 (23.6%) were 50% responders.'
    expect(isThresholdAt('a higher 50% responder rate', 9, 12)).toBe(true)
    expect(isThresholdAt('the rate was 50% (n = 1674)', 13, 16)).toBe(false)
    expect(isThresholdAt('a 45.7% reduction in seizure frequency', 2, 7)).toBe(false)
    expect(
      verdicts(
        'The pooled placebo responder rate was 50% (n = 1,674 participants randomized to placebo).',
        text,
      ),
    ).toEqual([['50%', false], ['1674', true]])
    expect(
      verdicts(
        'In a pooled analysis of 1,674 participants, the placebo 50% responder rate was 23.6% (395 out of 1,674 participants).',
        text,
      )
        .every(([, ok]) => ok),
    ).toBe(true)
  })

  it('a worsening-frequency rate is not a seizure freedom rate, and an age row is not an outcome (XB)', () => {
    const text = 'Table 1 Baseline characteristics\n\n≥ 65 years 379 (7.6%) 328 (7.1%)\n\n' +
      'The percentage of PWE with focal seizures who had worsening seizure frequency was 7.6% at 12 months and 11.2% at the last visit; in those with generalized seizures, the corresponding values were 2.7% and 5.7%, respectively.'
    expect(
      verdicts(
        'In the PERMIT study, the 12-month seizure freedom rate for patients with generalised seizures was 2.7% (n not stated), while for those with focal seizures, it was 7.6% (n not stated).',
        text,
        [],
        ['permit'],
      ).filter(([f]) => f !== '12months'),
    ).toEqual([['2.7%', false], ['7.6%', false]])
  })

  it('an all-cause discontinuation is not an adverse-event discontinuation (TFA)', () => {
    const text = 'During the whole study follow-up, 551/1639 (33.6%) patients discontinued BRV.'
    expect(
      verdicts(
        'The adverse-event discontinuation rate was 33.6% (n = 1639, full analysis set).',
        text,
      ),
    )
      .toEqual([['33.6%', false], ['1639', true]])
    const permit = 'At 12 months, 17.6% (739/4201) of PWEs had discontinued PER due to AEs.'
    expect(
      verdicts('The adverse-event discontinuation rate at 12 months was 17.6% (739/4201).', permit)
        .every(([, ok]) => ok),
    )
      .toBe(true)
  })

  it("the n the answer pairs in its bracket must be the paper's pairing (TFA, TDE, D4-05)", () => {
    const permit =
      'PERMIT study: a pooled analysis of perampanel (PER).\n\nRetention (Retention Population)\n\nRetention on PER treatment at 12 months was 64.2% (2698/4201).\n\nSeizure freedom rate\n\nThe seizure freedom rate was 23.2% at 12 months and 20.5% at the last visit.'
    expect(
      verdicts(
        'In the PERMIT study, the 12-month seizure freedom rate for perampanel was 23.2% (n = 4201, retention population).',
        permit,
        ['perampanel'],
        ['perampanel', 'permit'],
      )
        .filter(([f]) => f === '23.2%'),
    ).toEqual([['23.2%', false]])
    const claim = claimFeatures(
      'The adverse-event discontinuation rate at 12 months was 17.6% (n = 5193, full analysis set).',
      [],
    )
    expect(quantityPhrase(claim, '17.6%').pairedNs).toEqual(['5193'])
    expect(quantityPhrase(claim, '17.6%').families.sort()).toEqual([
      'adverse events',
      'discontinuation',
    ])
    // A correct pairing stated in prose ("3/28", "n = 121" in the same
    // sentence) is kept as the answer wrote it (Q15, TDB).
    const language =
      'compared with only 11% (3/28) who declined following radiofrequency thermocoagulation of language-negative sites. The lesion involved the frontal lobe in 4/36 (11%) patients.'
    expect(
      verdicts(
        'compared to only 11% (3/28) who declined following RFTHC of language-negative sites.',
        language,
      ).every(([, ok]) => ok),
    )
      .toBe(true)
    const lacosamide =
      'More patients on lacosamide than placebo had ≥50% (68.1%/46.3%) reduction from baseline in PGTCS frequency/28 days (n=119/n=121). Levetiracetam 48 (39.7%) 56 (46.3%)'
    expect(
      verdicts(
        'the 50% responder rate for lacosamide was reported as 68.1% (n = 119), while the placebo responder rate was 46.3% (n = 121).',
        lacosamide,
        ['lacosamide'],
      )
        .every(([, ok]) => ok),
    ).toBe(true)
  })

  it('a quote for a mis-paired share carries the same figure whatever its bracket (D4-05 replacement)', () => {
    expect(
      quoteCarriesClaim(
        'At 12 months, 17.6% (739/4201) of PWEs had discontinued PER due to AEs.',
        'The adverse-event discontinuation rate at 12 months was 17.6% (n = 5193, full analysis set).',
        ['perampanel'],
        [],
        [{ phrase: 'perampanel', abbr: 'PER' }],
      ),
    ).toBe(true)
  })

  it('the loop 4 P0s stay closed', () => {
    const vem =
      'A total of 1805 patients were identified. Of 147 deceased PWE over the study period, 87 had a lifetime history of a psychiatric disorder.'
    expect(
      verdicts(
        'In the video-EEG monitoring cohort, 25 of 205 patients died during follow-up.',
        vem,
      ),
    ).toEqual([
      ['25', false],
      ['205', false],
    ])
  })
})

describe('the denominator helper only adds from the located bracket or cell (D5-03, D5-13)', () => {
  it('says nothing for a share the located sentence gives no n for, and never reads another row', () => {
    expect(
      denominatorsMissing([{
        text:
          '76% of patients with hippocampal sclerosis achieved seizure freedom at 12 months with cross-electrode RFTC.',
        located: [{
          figure: '76%',
          index: 1,
          passage:
            'a crosselectrode RFTC study of 21 patients with HS reported that 76% had seizure freedom at 12 months',
        }],
      }]),
    ).toEqual([{ figure: '76%' }])
    expect(
      denominatorsMissing([{
        text: 'The 12-month seizure freedom rate was 23.2%.',
        located: [{
          figure: '23.2%',
          index: 1,
          passage: 'The seizure freedom rate was 23.2% at 12 months (n = 4392).',
        }],
      }]),
    ).toEqual([{ figure: '23.2%', stated: 'n = 4392', index: 1 }])
  })
})

describe('table rows and figure text', () => {
  it('reads an extracted row, and not a sentence, as a row', () => {
    expect(isRowParagraph('N (%) 868 (48%) 937 (52%) 670 (37%)')).toBe(true)
    expect(isRowParagraph('Number deceased 60 87 63 16 15 19 14')).toBe(true)
    expect(isRowParagraph('9 (4-14) 9 (5-13) 9 (5-13)')).toBe(true)
    expect(isRowParagraph('Female, n (%) 13 (50%)')).toBe(true)
    expect(isRowParagraph('26 subjects were implanted between November 2019 and July 2023.')).toBe(
      false,
    )
    expect(
      isRowParagraph(
        'Of 147 deceased PWE over the study period, 87 had a lifetime history of a psychiatric disorder.',
      ),
    ).toBe(false)
  })

  it('locates a figure with its row block', () => {
    const text = prepareSource(
      'Table 2 Cohort summary (N = 26).\n\nCharacteristic Value\n\nFemale, n (%) 13 (50%)\n\nAge, years 45 (23-71)',
    )
    const [occ] = locateFigure('50%', text)
    expect(occ?.row).toBe(true)
    expect(occ?.label).toContain('female')
    expect(occ?.window).toContain('cohort summary (n = 26)')
  })

  it("a graphical abstract's short lines are the paper's own data (N07)", () => {
    const text =
      'Introduction\n\nLongitudinal study\n\n13 subjects with epilepsy\n\n193 seizures reported per person\n\n312 saliva samples collected\n\nTrough Peak\n\nMorning cortisol (nmol/L)\n\nA chart shows the relationship between stress hormone and morning cortisol.'
    expect(inTableOrLegend(text, text.indexOf('312'))).toBe(true)
    expect(
      secondhandFigures([{
        text:
          'The study involved 13 participants with epilepsy, who provided a total of 312 saliva samples.',
        bound: [1],
      }], new Map([[1, text]])),
    ).toEqual([])
  })

  it('reads Markdown headings, and judges the located passage rather than every occurrence (TFD)', () => {
    const text =
      '## Abstract\n\nWe pooled placebo arms.\n\n## Introduction:\n\nUnfortunately, the placebo 50% responder rate has been increasing over time from 10% in 1990 to over 22% after 2020.[6, 7]\n\n## Results:\n\nThere was a higher 50% responder rate in Bulgaria (42% in the higher group vs 22% in the lower group).'
    expect(sectionSpans(text).map((s) => s.section)).toEqual([
      'abstract',
      'introduction',
      'results',
    ])
    const sentence =
      'the placebo-response paper suggests a placebo responder rate that has been increasing over time, reaching over 22% after 2020.'
    const passage =
      'Unfortunately, the placebo 50% responder rate has been increasing over time from 10% in 1990 to over 22% after 2020.'
    expect(offsetOfPassage(text, passage)).toBe(text.indexOf('Unfortunately'))
    expect(secondhandFigures([{ text: sentence, bound: [1] }], new Map([[1, text]]))).toEqual([])
    expect(
      secondhandFigures([{
        text: sentence,
        bound: [1],
        located: [{ figure: '22%', index: 1, passage }],
      }], new Map([[1, text]])),
    ).toEqual([{ figure: '22%', index: 1 }])
  })

  it('a letter-spaced masthead names a protocol', () => {
    expect(
      studyDesignOf(
        'S T U D Y P R O T O C O L S Prospective multisite cohort study of patient-reported outcomes',
      ),
    ).toBe(
      'a trial protocol',
    )
  })
})

describe('the cohort the question describes or names (D5-02, D5-12)', () => {
  it('a hyphenated designator matches the title that writes it as two words (XF)', () => {
    const [designator] = cohortDesignators(
      'What proportion of the multiday heart-rate cycle cohort had significant cycles?',
    )
    expect(designator?.words).toEqual(['multid', 'heart-', 'cycle'])
    expect(
      carriesDesignator({
        title: 'Multiday cycles of heart rate are associated with seizure likelihood',
      }, designator!.words),
    ).toBe(true)
  })

  it('names a paper by its acronym or its title', () => {
    expect(studyLabel('PERMIT study: a global pooled analysis of perampanel')).toBe('PERMIT')
    expect(
      studyLabel(
        'Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults',
      ),
    ).toBe(
      'Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults',
    )
    expect(studyLabel('Risk of SUDEP with lamotrigine: a nested case-control study')).toBe(
      'Risk of SUDEP with lamotrigine: a nested case-control study',
    )
  })
})

// ---------------------------------------------------------------------------
// bindAndAudit end to end over the loop 5 shapes
// ---------------------------------------------------------------------------

const config = { slug: 'neuro', name: 'Neuro', topics: [] } as unknown as TenantConfig

function management(texts: Record<string, string>): ExtractionSource {
  return { resourceExtraction: (_t, id) => Promise.resolve({ text: texts[id] ?? '' }) }
}

function resource(id: string, title: string, summary: string): ScoredResource {
  return {
    id,
    title,
    summary,
    relevance: 0.9,
    type: 'pdf',
    topicIds: [],
    keyFacts: [],
  } as unknown as ScoredResource
}

const HEALTHY =
  'Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults.\n\nResults\n\n' +
  'Of 525 healthy adults, 70% (369/525) had at least one significant rhythm of ≥4 days, and 36% (187/525) had two or more significant rhythms.'
const EPILEPSY =
  'Multiday cycles of heart rate are associated with seizure likelihood.\n\nResults\n\n' +
  'Participants with epilepsy documented 3619 seizures (mean 117 ± 118 seizures), with 2244 of these reported during the wearable monitoring period.'
const CONSORTIUM =
  'Multimodal prognostication of autoimmune encephalitis: an Australian autoimmune encephalitis consortium study.\n\n' +
  'Results\n\nA total of 231 patients with AE were recruited. At 12 months, a favourable mRS (≤ 2) occurred in 154 (67%) patients.'
const LGI1 =
  'Acute and Long-Term Immune-Treatment Strategies in anti-LGI1 encephalitis.\n\nResults\n\n' +
  'At 12 months, a favourable mRS was recorded in 38 (79%) of 55 patients.'
const PROTOCOL =
  'S T U D Y P R O T O C O L S Prospective multisite cohort study of patient-reported outcomes in adults with new-onset seizures.\n\n' +
  'Methods: Approximately 450 eligible patients will be enrolled in the study over 2 years. Allowing for a 10% loss to follow-up, it is estimated that there will be follow-up data on approximately 405 participants.'
const TRAJECTORIES =
  'Trajectories of quality of life, anxiety and depressive symptomatology after first seizure events.\n\nResults\n\n' +
  'A total of 196 participants met the eligibility criteria and were enrolled in the study. Quality of life improved over 12 months.'

describe('bindAndAudit over the loop 5 shapes', () => {
  it('names each paper when two populations are stitched under one designated cohort (XF)', async () => {
    const result = await bindAndAudit({
      management: management({ healthy: HEALTHY, epilepsy: EPILEPSY }),
      config,
      query:
        'What proportion of the multiday heart-rate cycle cohort had significant cycles, and how many seizures were recorded in total?',
      text:
        'In the multiday heart-rate cycle cohort, 70% (369/525) had at least one significant rhythm of ≥4 days, and 36% (187/525) had two or more significant rhythms.[1] ' +
        'In terms of seizures, participants with epilepsy documented over 3,619 seizures (mean 117 ± 118 seizures) with 2,244 of these reported during the wearable monitoring period.[2]',
      citations: [
        {
          index: 1,
          resourceId: 'healthy',
          title:
            'Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults',
        },
        {
          index: 2,
          resourceId: 'epilepsy',
          title: 'Multiday cycles of heart rate are associated with seizure likelihood',
        },
      ],
      sources: [
        resource(
          'healthy',
          'Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults',
          'Healthy adults.',
        ),
        resource(
          'epilepsy',
          'Multiday cycles of heart rate are associated with seizure likelihood',
          'People with epilepsy.',
        ),
      ],
      lexicon: [],
      variant: undefined,
      floor: 0.3,
      pinScopeIds: ['healthy', 'epilepsy'],
    })
    expect(result.text).toContain(
      'In *Infradian rhythms of human heart rate reveal distinct multiday cycle periods in healthy adults*, 70% (369/525) had at least one significant rhythm',
    )
    expect(result.text).toContain(
      'In *Multiday cycles of heart rate are associated with seizure likelihood*, in terms of seizures, participants with epilepsy documented',
    )
    expect(result.audit.sentencesRemoved).toBe(0)
  })

  it("offers the consortium paper's own figure for the question's outcome after a removal (N06)", async () => {
    const result = await bindAndAudit({
      management: management({ lgi1: LGI1, consortium: CONSORTIUM }),
      config,
      query:
        'Across the Australian autoimmune encephalitis consortium papers, what proportion of patients had a good functional outcome at 12 months?',
      text:
        'Across the Australian Autoimmune Encephalitis Consortium papers, 80% of patients had a favourable modified Rankin Scale (mRS) score at 12 months (n = 231).[1] ' +
        'In a specific study of patients with anti-LGI1 Ab-mediated encephalitis, 79% achieved an mRS of less than 3 at 12 months (n = 55).[1]',
      citations: [{
        index: 1,
        resourceId: 'lgi1',
        title: 'Acute and Long-Term Immune-Treatment Strategies in anti-LGI1 encephalitis',
      }],
      sources: [
        resource(
          'lgi1',
          'Acute and Long-Term Immune-Treatment Strategies in anti-LGI1 encephalitis',
          'LGI1.',
        ),
        resource(
          'consortium',
          'Multimodal prognostication of autoimmune encephalitis: an Australian autoimmune encephalitis consortium study',
          'Consortium.',
        ),
      ],
      lexicon: ['LGI1'],
      variant: undefined,
      floor: 0.3,
    })
    expect(result.text).not.toContain('80% of patients')
    expect(result.text).toContain('79% achieved an mRS of less than 3 at 12 months (n = 55).[1]')
    expect(result.text).toContain(
      'For the outcome asked about, [2] itself reports: "At 12 months, a favourable mRS (≤ 2) occurred in 154 (67%) patients."',
    )
    expect(result.citations.map((c) => c.resourceId)).toEqual(['lgi1', 'consortium'])
  })

  it("says a protocol's sample size is planned recruitment and quotes the results paper's enrolment (GC)", async () => {
    const result = await bindAndAudit({
      management: management({ protocol: PROTOCOL, trajectories: TRAJECTORIES }),
      config,
      query:
        "Which of O'Neill's papers report patient-reported outcomes after a first seizure, and what were the sample sizes?",
      text:
        'Quality of life improved over 12 months for individuals with newly diagnosed epilepsy.[1] ' +
        'The study aimed to recruit approximately 450 patients over two years, with an estimated follow-up data on approximately 405 participants after accounting for a 10% loss to follow-up.[2]',
      citations: [
        {
          index: 1,
          resourceId: 'trajectories',
          title:
            'Trajectories of quality of life, anxiety and depressive symptomatology after first seizure events',
        },
        {
          index: 2,
          resourceId: 'protocol',
          title:
            'Prospective multisite cohort study of patient-reported outcomes in adults with new-onset seizures',
        },
      ],
      sources: [
        resource(
          'trajectories',
          'Trajectories of quality of life, anxiety and depressive symptomatology after first seizure events',
          'PROs.',
        ),
        resource(
          'protocol',
          'Prospective multisite cohort study of patient-reported outcomes in adults with new-onset seizures',
          'Protocol.',
        ),
      ],
      lexicon: [],
      variant: undefined,
      floor: 0.3,
    })
    expect(result.text).toContain('approximately 450 patients')
    expect(result.text).toContain(
      '*[2] is the study protocol: the numbers it gives are the planned recruitment, not the enrolment. The results paper [1] reports: "A total of 196 participants met the eligibility criteria and were enrolled in the study."*',
    )
  })
})

/** Unused type guard so the summary type stays imported for future rows. */
export type _Summary = ResourceSummary
