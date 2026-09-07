/**
 * The loop 4 helpers (review loop 4): cohort
 * designators the study guard pins, the cohort terms a question yields,
 * the strict quote check, the planning and demographic question forms, the
 * scaffolding strip, list items inheriting their paragraph's marker and a
 * table row of bare statistics.
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary } from '@research-portal/core'
import { carriesDesignator, cohortDesignators, matchStudies } from './study-guard.ts'
import {
  cohortTerms,
  isPlanningQuestion,
  quoteCarriesClaim,
  stripTemplateLeaks,
} from './figure-rescue.ts'
import { isDemographicQuestion } from './ask-entities.ts'
import { bindSentences } from './citation-binding.ts'
import { inTableOrLegend } from './secondhand.ts'
import { extractNumbers, timepointsInMonths, verifyFigures } from './answer-audit.ts'

const paper = (id: string, title: string, summary: string): ResourceSummary => ({
  id,
  title,
  summary,
  type: 'pdf',
  topicIds: [],
  keyFacts: [],
})

describe('cohort designators (D4-01, D4-02)', () => {
  const catalogue = [
    paper(
      'vem',
      'Association Between Psychiatric Comorbidities and Mortality in Epilepsy',
      'Using data from 2,709 patients admitted for video-EEG monitoring in Melbourne, higher mortality was found.',
    ),
    paper(
      'dravet',
      'Defining Dravet syndrome',
      'A cohort of 205 patients with SCN1A Dravet syndrome.',
    ),
    paper(
      'trauma',
      'Childhood trauma in patients with epileptic vs non-epileptic seizures',
      'Patients admitted for video-EEG monitoring in Melbourne were surveyed.',
    ),
    paper(
      'lgi1',
      'Acute and Long-Term Immune-Treatment Strategies in anti-LGI1 encephalitis',
      'The LGI1 encephalitis cohort of the consortium.',
    ),
  ]

  it('reads a designator by description and its content words', () => {
    expect(cohortDesignators('How many adults were in the video-EEG monitoring mortality cohort?'))
      .toEqual([
        { phrase: 'video-EEG monitoring mortality cohort', words: ['video-', 'monito', 'mortal'] },
      ])
    expect(
      cohortDesignators('In the LGI1 encephalitis cohort, how many received rituximab?')[0]?.words,
    )
      .toEqual(['lgi1', 'enceph'])
    // One content word is an acronym's business, not a designator's.
    expect(cohortDesignators('What did the PERMIT pooled analysis report?')).toEqual([])
  })

  it('pins the papers whose title or summary carries every word, as cohort pins', () => {
    const pins = matchStudies(
      'How many adults were in the video-EEG monitoring mortality cohort, and how many died?',
      catalogue,
    )
    expect(pins.map((p) => [p.id, p.kind])).toEqual([['vem', 'cohort']])
    expect(
      matchStudies(
        'What was the SUDEP incidence in the Melbourne video-EEG monitoring cohort?',
        catalogue,
      )
        .map((p) => p.id).sort(),
    ).toEqual(['trauma', 'vem'])
    expect(carriesDesignator(catalogue[1]!, ['video-', 'monito'])).toBe(false)
  })
})

describe('cohort terms (D4-01, D4-03)', () => {
  it('keeps a lower-case token that carries an acronym, and every drug the question names', () => {
    expect(cohortTerms('How many adults were in the video-EEG monitoring mortality cohort?'))
      .toEqual([
        'video-eeg',
      ])
    expect(
      cohortTerms(
        'What 12-month retention should I assume for adjunctive perampanel versus brivaracetam?',
        ['brivaracetam'],
        ['perampanel', 'brivaracetam', 'lamotrigine'],
      ),
    ).toEqual(['brivaracetam', 'perampanel'])
    expect(cohortTerms('In the Melbourne video-EEG monitoring cohort, what was the rate?')).toEqual(
      ['video-eeg'],
    )
  })
})

describe('the strict quote check (D4-03)', () => {
  const sentence = 'For adjunctive perampanel, the 12-month retention rate is 64.2% (n = 4201).'
  it('accepts the sentence that carries the same figure at the same time point, and nothing else', () => {
    expect(
      quoteCarriesClaim(
        'Retention on PER treatment at 3, 6, and 12 months was 90.5% (4273/4721), 79.8% (3603/4516), and 64.2% (2698/4201), respectively.',
        sentence,
        ['perampanel'],
        ['perampanel'],
        [{ phrase: 'perampanel', abbr: 'PER' }],
      ),
    ).toBe(true)
    expect(
      quoteCarriesClaim(
        'Over the longer term (> 12 months), retention was 29.5% (1229/4164) and the mean retention time on PER treatment was 18.7 months.',
        sentence,
        ['perampanel'],
        ['perampanel'],
        [{ phrase: 'perampanel', abbr: 'PER' }],
      ),
    ).toBe(false)
    expect(
      quoteCarriesClaim(
        'Retention on PER treatment at 6 months was 64.2%.',
        sentence,
        [
          'perampanel',
        ],
        [],
        [{ phrase: 'perampanel', abbr: 'PER' }],
      ),
    ).toBe(false)
  })
})

describe('planning and demographic questions (D4-12, D4-09)', () => {
  it('recognises what should I assume, plan for or expect', () => {
    expect(
      isPlanningQuestion(
        'What placebo responder rate should I plan for in the sample size calculation?',
      ),
    ).toBe(true)
    expect(isPlanningQuestion('what 12-month retention rate should I assume for perampanel?')).toBe(
      true,
    )
    expect(isPlanningQuestion('What did PERMIT report for retention?')).toBe(false)
  })
  it('recognises a question about who was in a study', () => {
    expect(
      isDemographicQuestion(
        'What was the median age of the UMPIRE participants, and how many were women?',
      ),
    ).toBe(true)
    expect(isDemographicQuestion('How many adults were enrolled in the first-seizure study?')).toBe(
      true,
    )
    expect(isDemographicQuestion('What was the primary outcome of UMPIRE?')).toBe(false)
  })
})

describe('the scaffolding strip (D4-14, D4-11)', () => {
  it('removes the trailing sources line and the no-denominator clause, keeps the inference mark', () => {
    expect(
      stripTemplateLeaks(
        'The SMR was 2.5 (95% CI 1.9-3.2; no denominator stated).[1] Cited sources from the provided context.',
      ),
    ).toBe('The SMR was 2.5 (95% CI 1.9-3.2).[1]')
    expect(stripTemplateLeaks('This limits the evidence (inference).')).toBe(
      'This limits the evidence (inference).',
    )
  })
})

describe('list items inherit the paragraph marker (D4-20)', () => {
  it("binds a short item to the paragraph's text when the text carries its words", () => {
    const text =
      'The BREATHS protocol specifies these assessment time points:[1]\n- Baseline\n- Week 4\n- Week 12 (primary outcome time point)\n- Optional follow-up at Weeks 52, 78 and 104.'
    const protocol =
      'Assessments are at baseline, week 4, week 12 (the primary outcome time point) and week 24, with optional follow-up at weeks 52, 78 and 104.'
    const bound = bindSentences({
      text,
      citations: [{ index: 1, resourceId: 'breaths', title: 'BREATHS protocol' }],
      texts: new Map([[1, protocol]]),
    })
    const items = bound.sentences.filter((s) => s.text.startsWith('Week') || s.text === 'Baseline')
    expect(items.length).toBe(3)
    for (const item of items) expect(item.bound).toEqual([1])
    expect(bound.text).toContain('- Week 4[1]')
  })

  it('inherits from the nearest marked list item when the lead line has no marker (TD2 replay)', () => {
    const bound = bindSentences({
      text:
        'The protocol specifies:\n1. **Primary**:\n- Seizure remission measured at Week 12.[1]\n2. **Time points**:\n- Baseline\n- Week 24',
      citations: [{ index: 1, resourceId: 'breaths', title: 'BREATHS protocol' }],
      texts: new Map([[
        1,
        'Seizure remission is measured at week 12; assessments are at baseline, week 4, week 12 and week 24.',
      ]]),
    })
    expect(bound.sentences.find((s) => s.text === 'Baseline')?.bound).toEqual([1])
    expect(bound.sentences.find((s) => s.text === 'Week 24')?.bound).toEqual([1])
  })

  it('leaves an item the text does not carry uncited', () => {
    const bound = bindSentences({
      text: 'The protocol specifies:[1]\n- Week 4\n- Quarterly MRI',
      citations: [{ index: 1, resourceId: 'breaths', title: 'BREATHS protocol' }],
      texts: new Map([[1, 'Assessments are at week 4 and week 12.']]),
    })
    expect(bound.sentences.find((s) => s.text === 'Week 4')?.bound).toEqual([1])
    expect(bound.sentences.find((s) => s.text === 'Quarterly MRI')?.bound).toEqual([])
  })
})

describe('a designated cohort outranks a drug pin (D3-01 replay)', () => {
  it('pins the cohort papers before the rituximab paper', () => {
    const catalogue = [
      paper(
        'nmdar',
        'Rituximab Use for Relapse Prevention in Anti-NMDAR Antibody-Mediated Encephalitis',
        'Rituximab in anti-NMDAR encephalitis.',
      ),
      paper(
        'lgi1',
        'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Antibody-Mediated Encephalitis',
        'The LGI1 encephalitis cohort; rituximab reduced relapse.',
      ),
    ]
    const pins = matchStudies(
      'In the LGI1 encephalitis cohort, how many patients received rituximab, and what was the hazard ratio for time to first relapse with rituximab?',
      catalogue,
      ['rituximab'],
    )
    expect(pins.map((p) => [p.id, p.kind])).toEqual([['lgi1', 'cohort'], ['nmdar', 'term']])
  })
})

describe('durations, number words and demographic words (K5, HC replays)', () => {
  it('does not read a median time to relapse as a follow-up time point', () => {
    expect(timepointsInMonths('16 (30%) relapsed at a median of 414 (IQR 256, 967) days')).toEqual(
      [],
    )
    expect(timepointsInMonths('the mean retention time was 18.7 months; retention at 12 months'))
      .toEqual([12])
  })
  it('finds "Thirteen participants were women" in a table row "Female, n (%) 13 (50%)"', () => {
    const row =
      'T A B L E 2 Cohort summary (N = 26).\n\nCharacteristic Value\n\nFemale, n (%) 13 (50%)\n\nAge at enrollment, years, mean (range) 45 (23–71)'
    const checks = verifyFigures(
      [{ text: 'Thirteen participants were women, which is 50% of the cohort.', texts: [row] }],
      [row],
    )
    expect(checks.map((c) => [c.figure, c.supported])).toEqual([['13', true], ['50%', true]])
  })
  it('reads an age range with its unit as two bare figures (HC replay)', () => {
    expect(extractNumbers('a mean age of 45 years (range 23-71 years)')).toEqual([
      '45',
      '23',
      '71',
    ])
    const row = 'Age at enrollment, years, mean (range) 45 (23–71)'
    const checks = verifyFigures(
      [{ text: 'The mean age at enrolment was 45 years (range 23-71 years).', texts: [row] }],
      [row],
    )
    expect(checks.every((c) => c.supported)).toBe(true)
  })
  it('places "147 patients died" by the paper\'s "147 deceased PWE" (EA replay)', () => {
    const text =
      'Cause of Death\n\nOf 147 deceased PWE over the study period, 87 had a lifetime history of a psychiatric disorder.'
    const checks = verifyFigures(
      [{ text: 'During follow-up, 147 patients died.', texts: [text] }],
      [text],
    )
    expect(checks.map((c) => [c.figure, c.supported])).toEqual([['147', true]])
    const deaths = verifyFigures(
      [{ text: 'There were 147 deaths during follow-up.', texts: [text] }],
      [text],
    )
    expect(deaths.map((c) => [c.figure, c.supported])).toEqual([['147', true]])
  })
  it('reads a blank line before a lower-case continuation as one sentence (Q6 replay)', () => {
    const text =
      'In contrast, F2 is 0.37, suggesting that in Group 2 just \n\n over a third of discharges occur during the sleep period.'
    const checks = verifyFigures(
      [{
        text:
          'This group displayed greater variation, with about 37% of discharges occurring during sleep.',
        texts: [text],
      }],
      [text],
    )
    expect(checks.map((c) => [c.figure, c.supported])).toEqual([['37%', true]])
  })
})

describe('a table row of bare statistics is first-hand (D4-18)', () => {
  it('reads a line of numbers under its label as a table row', () => {
    const text =
      'Any TCS in 12 months preceding \n admission \n\n 221 3.25 <0.001 \n\n History of Anxiety 283 0.39 0.042'
    expect(inTableOrLegend(text, text.indexOf('3.25'))).toBe(true)
    expect(inTableOrLegend('The aHR was 2.24 in the model.', 12)).toBe(false)
  })
})
