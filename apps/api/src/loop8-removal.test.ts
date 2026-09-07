/**
 * Loop 8 (review loop 8 D8-02): removal is real.
 * A figure the answer reports as removed is not printed anywhere in the
 * answer body, in a briefing section or in a briefing takeaway - the
 * invariant this file asserts, over the grounding pass end to end and over
 * the gate and the briefing audit on their own.
 *
 * Beside it, the loop 8 figure-check regressions: the denominator a paper
 * writes as a numerator ("19 patients (28%)") against a claim that gives
 * the cohort n (D8-05), an n that must come from the figure's own sentence
 * rather than from anywhere in its paragraph, and an analysis set the
 * claim names that the located sentence does not (D8-01).
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ScoredResource, TenantConfig } from '@research-portal/core'
import { bindAndAudit, type ExtractionSource } from './ask-grounding.ts'
import { answerBody, figuresStillPrinted, gateFigures, uncitedNote } from './answer-gate.ts'
import { attributedElsewhere, attributedNote } from './secondhand.ts'
import { auditBriefing } from './briefing-audit.ts'
import { claimFeatures, figureSupportedBy, prepareSource } from './answer-audit.ts'

const config = { slug: `test-${crypto.randomUUID()}` } as unknown as TenantConfig

function management(texts: Record<string, string>): ExtractionSource {
  return {
    resourceExtraction: (_tenant, id) => Promise.resolve({ text: texts[id] ?? '' }),
  }
}

function resource(id: string, title: string, summary: string, relevance = 0.9): ScoredResource {
  return {
    id,
    title,
    summary,
    type: 'pdf',
    topicIds: [],
    keyFacts: [],
    relevance,
    citedCount: 1,
  } as unknown as ScoredResource
}

const EXPERIENCE =
  'Effectiveness and Tolerability of 12-Month Brivaracetam in the Real World: EXPERIENCE.\n\n' +
  'Abstract\n\nBRV retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months (n = 1644).\n\n' +
  'Introduction\n\nBrivaracetam is a SV2A ligand.\n\nResults\n\nAt 12 months, seizure freedom ' +
  'was 14.9% (n = 1111) and continuous seizure freedom was 11.7% (n = 1111).\n\nDiscussion\n\n' +
  'Retention was high.'

const PERAMPANEL =
  'Long-term open-label perampanel: generalized tonic-clonic seizures in idiopathic generalized ' +
  'epilepsy.\n\nAbstract\n\nPatients entered an open-label extension (OLEx) phase.\n\n' +
  'Introduction\n\nPerampanel is an AMPA antagonist.\n\nResults\n\nFor all seizure types, ' +
  '39.7% and 22.1% of patients who received perampanel during the Core Study and 35.7% and ' +
  '17.1% of patients who received placebo during the Core Study were seizure free for at ' +
  'least 6 and 12 months, respectively.\n\nDiscussion\n\nPerampanel was well tolerated.'

const RITUXIMAB = 'Rituximab Use for Relapse Prevention in Anti-NMDAR Antibody-Mediated ' +
  'Encephalitis: A Multicenter Cohort Study.\n\nAbstract\n\nMethods We recruited 67 patients ' +
  'with anti-NMDAR Ab-mediated encephalitis from 10 Australian hospitals.\n\nIntroduction\n\n' +
  'Rituximab is an anti-CD20 monoclonal antibody.\n\nResults\n\nA total of 19 patients (28%) ' +
  'had at least 1 relapse, which occurred at a median of 764 (IQR 355, 1193) days from the ' +
  'initial admission.\n\nDiscussion\n\nRelapse was common.'

const PLACEBO = 'Factors associated with placebo response rate in randomized controlled trials ' +
  'of antiseizure medications.\n\nAbstract\n\nIn the pooled analysis of 1674 participants ' +
  'randomized to placebo, a higher 50% responder rate was associated with shorter duration of ' +
  'epilepsy. Data from 1674 participants were analysed, of which 395 (23.6%) were 50% ' +
  'responders.\n\nIntroduction\n\nPlacebo response complicates trial design.\n\nResults\n\n' +
  'We addressed the challenge of multiple testing using mixture modeling, which suggested that ' +
  'there were 2 groups of 50% responder rate: high (42%, 95% CI: 33-50%) and not high (22%, ' +
  '95% CI: 19-24%).\n\nDiscussion\n\nPlacebo response is rising.'

describe('removal is real: a removed figure is not printed in the answer (D8-02)', () => {
  it('never names a figure the body still carries, and never carries one the note names', async () => {
    const result = await bindAndAudit({
      management: management({ experience: EXPERIENCE, perampanel: PERAMPANEL }),
      config,
      query:
        'Compare seizure freedom rates between brivaracetam and perampanel at 12 months in real-world cohorts.',
      text: [
        'The cited sources provide data on seizure freedom rates for both brivaracetam and ' +
        'perampanel at 12 months in real-world cohorts.[1]',
        '',
        '**Brivaracetam:**',
        '- In the EXPERIENCE study, seizure freedom at 12 months was achieved by 14.9% of ' +
        'patients (n = 1111).[1]',
        '',
        '**Perampanel:**',
        '- In the OLEx Phase of Study 332, seizure freedom rates for all seizures at 12 months ' +
        'were 22.1% for patients who received placebo during the Core Study before converting ' +
        'to perampanel (n = 70).[2]',
        '',
        'In summary, perampanel showed higher seizure freedom rates at 12 months compared to ' +
        'brivaracetam in these real-world cohorts, with rates of 22.1% and 33.8% for perampanel ' +
        'versus 14.9% for brivaracetam.[2]',
      ].join('\n'),
      citations: [
        { index: 1, resourceId: 'experience', title: 'EXPERIENCE' },
        { index: 2, resourceId: 'perampanel', title: 'Long-term open-label perampanel' },
      ],
      sources: [
        resource('experience', 'EXPERIENCE', 'Brivaracetam in the real world.'),
        resource('perampanel', 'Long-term open-label perampanel', 'Perampanel extension study.'),
      ],
      lexicon: ['brivaracetam', 'perampanel'],
      variant: undefined,
      floor: 0.3,
    })
    // The invariant: nothing the note calls removed is still on the page.
    expect(figuresStillPrinted(result.audit.figuresRemoved ?? [], answerBody(result.text)))
      .toEqual([])
    // And the figure that did leave is named, once.
    expect(answerBody(result.text)).not.toContain('33.8%')
    expect(result.audit.figuresRemoved).toContain('33.8%')
    // The verified bullet stands, and is no longer contradicted.
    expect(answerBody(result.text)).toContain('14.9%')
    expect(result.audit.figuresRemoved).not.toContain('14.9%')
  })

  it('removes a kept sentence that repeats a removed figure with no check of its own', () => {
    const bound = {
      text: 'Retention was 75% at 12 months.[1] Retention was 75%.',
      layout: [{ kind: 'sentences' as const, prefix: '', sentences: [0, 1] }],
      sentences: [
        { text: 'Retention was 75% at 12 months.', bound: [1], line: 0, original: [1], block: [] },
        { text: 'Retention was 75%.', bound: [], line: 0, original: [], block: [] },
      ],
      citations: [{ index: 1, resourceId: 'a', title: 'A' }],
      usable: [1],
      named: [1],
      dropped: 0,
      rebound: 0,
    }
    const gated = gateFigures(
      bound,
      [{
        sentence: 'Retention was 75% at 12 months.',
        figure: '75%',
        supported: false,
        reason: 'outcome' as const,
        supportedBy: [],
      }],
      [1],
    )
    expect(gated.text).not.toContain('75%')
    expect(gated.removed).toHaveLength(2)
  })
})

const VEM = 'Association Between Psychiatric Comorbidities and Mortality in Epilepsy.\n\n' +
  'Abstract\n\nMethods: A retrospective medical record audit was conducted on 2,709 adults ' +
  'admitted for video-EEG monitoring and diagnosed with epilepsy.\n\nIntroduction\n\nPeople ' +
  'with epilepsy die earlier.\n\nResults\n\nThe standardised mortality ratio was 3.6 (95% CI ' +
  '2.9-4.4) in those with a lifetime psychiatric disorder and 2.5 (95% CI 1.9-3.2) in those ' +
  'without.\n\nDiscussion\n\nThe cohort is large.'

describe('a heading whose every sentence was removed goes with them', () => {
  it('leaves no bold label standing over nothing', () => {
    const bound = {
      text: '**Perampanel:**\n- Retention at 12 months was 75%.',
      layout: [
        { kind: 'raw' as const, text: '**Perampanel:**' },
        { kind: 'sentences' as const, prefix: '- ', sentences: [0] },
      ],
      sentences: [
        { text: 'Retention at 12 months was 75%.', bound: [1], line: 1, original: [1], block: [] },
      ],
      citations: [{ index: 1, resourceId: 'a', title: 'A' }],
      usable: [1],
      named: [1],
      dropped: 0,
      rebound: 0,
    }
    const gated = gateFigures(bound, [{
      sentence: 'Retention at 12 months was 75%.',
      figure: '75%',
      supported: false,
      reason: 'entity' as const,
      supportedBy: [],
    }], [1])
    expect(gated.text.trim()).toBe('')
  })
})

describe('the paper the decline would name is read first (D8-11, D3-02)', () => {
  it("quotes the paper's own sentence rather than refusing a question it answers", async () => {
    const result = await bindAndAudit({
      management: management({ vem: VEM }),
      config,
      query: 'What is the standardised mortality ratio in people with epilepsy and a ' +
        'psychiatric comorbidity?',
      text: 'The standardised mortality ratio (SMR) for people with epilepsy and a psychiatric ' +
        'comorbidity is 3.6 (95% confidence interval 2.9-4.4).',
      citations: [{
        index: 1,
        resourceId: 'vem',
        title: 'Association Between Psychiatric ' +
          'Comorbidities and Mortality in Epilepsy',
      }],
      sources: [
        resource(
          'vem',
          'Association Between Psychiatric Comorbidities and Mortality in Epilepsy',
          'Mortality in adults admitted for video-EEG monitoring.',
        ),
      ],
      lexicon: [],
      variant: undefined,
      floor: 0.3,
    })
    expect(result.emptied).toBe(false)
    expect(result.text).toContain('3.6')
    expect(result.text).toContain('lifetime psychiatric disorder')
    expect(result.citations).toHaveLength(1)
  })
})

describe('what the answer credits to other authors, and what it cites nobody for', () => {
  it('names a finding the answer credits to authors who did not write the cited paper', () => {
    const found = attributedElsewhere(
      [{
        text: 'Rajna and Veres showed that sleep deprivation increased seizure risk six-fold.',
        bound: [1],
      }],
      () => ['Dell KL', 'Payne DE', 'Kremen V'],
    )
    expect(found.map((f) => f.surname)).toEqual(['Rajna'])
    expect(attributedNote(found)).toContain('Rajna [1]')
  })

  it("says nothing when the paper's own authors are the ones credited", () => {
    expect(
      attributedElsewhere(
        [{ text: 'Dell et al. found no effect on seizure risk.', bound: [1] }],
        () => ['Dell KL', 'Payne DE'],
      ),
    ).toEqual([])
  })

  it('names the sentence an answer states with no citation behind it', () => {
    const note = uncitedNote([
      { text: 'Seizure freedom at 12 months was 14.9% of patients.', bound: [1] },
      {
        text: 'Wearable devices are more acceptable to people with epilepsy than invasive ' +
          'devices, and many people may still find forecasting devices useful.',
        bound: [],
      },
    ])
    expect(note).toContain('One sentence in this answer carries no citation')
    expect(note).toContain('Wearable devices are more acceptable')
  })

  it('says nothing about a sentence describing what the sources do not say', () => {
    expect(
      uncitedNote([
        {
          text: 'The BREATHS trial compares breathing control training to befriending.',
          bound: [1],
        },
        {
          text: 'The cited sources do not provide specific data on how often functional ' +
            'seizures are misdiagnosed as epilepsy.',
          bound: [],
        },
      ]),
    ).toBe('')
  })

  it('says nothing when every sentence carries one', () => {
    expect(uncitedNote([{ text: 'Retention at 12 months was 71.1%.', bound: [1] }])).toBe('')
  })
})

describe('a briefing never prints a figure its audit reports as removed (D8-02)', () => {
  it('reconciles the removed list with the sections it kept', () => {
    const result = auditBriefing({
      sections: [
        {
          heading: 'Perampanel Effectiveness',
          content: 'The PERMIT study found retention rates for perampanel at 3, 6, and 12 ' +
            'months were 90.5%, 79.8%, and 64.2%, respectively.',
          sources: [{ resourceId: 'permit', title: 'PERMIT study' }],
          refs: [1],
        },
        {
          heading: 'Dosing',
          content: 'Perampanel was titrated to 100mg/day in the extension.',
          sources: [{ resourceId: 'permit', title: 'PERMIT study' }],
          refs: [1],
        },
      ],
      key_takeaways: ['Perampanel retention was 90.5% at 3 months in a Melbourne clinic cohort.'],
      takeaway_refs: [[1]],
    }, {
      texts: new Map([[
        'permit',
        'PERMIT study: a global pooled analysis of perampanel.\n\nResults\n\nRetention on PER ' +
        'treatment at 3, 6, and 12 months was 90.5% (4273/4721), 79.8% (3603/4516), and 64.2% ' +
        '(2698/4201), respectively.',
      ]]),
      generated: new Map(),
      lexicon: ['perampanel'],
      query: 'How effective is perampanel?',
    })
    const printed = [...result.sections.map((s) => s.content), ...result.key_takeaways].join('\n')
    expect(figuresStillPrinted(result.audit.figuresRemoved, printed)).toEqual([])
    // The dosing sentence had nothing behind it and went.
    expect(result.audit.figuresRemoved).toContain('100mg/day')
    expect(printed).not.toContain('100mg/day')
    // The retention rates stand where the paper carries them.
    expect(printed).toContain('90.5%')
  })
})

describe('a figure belongs to the arm its own phrase names (D8-02)', () => {
  const prepared = prepareSource(PERAMPANEL)
  const check = (claim: string, figure: string) =>
    figureSupportedBy(
      figure,
      claimFeatures(claim, ['perampanel', 'placebo'], ['perampanel']),
      prepared,
    )

  it("refuses the other arm's number", () => {
    const verdict = check(
      'Seizure freedom at 12 months was 22.1% for patients who received placebo during the ' +
        'Core Study before converting to perampanel.',
      '22.1%',
    )
    expect(verdict.supported).toBe(false)
    expect(verdict.reason).toBe('population')
  })

  it('reads no arm out of a phrase that allocates nothing', () => {
    const placebo = prepareSource(PLACEBO)
    const claim = 'In the pooled analysis of placebo arms in randomised add-on epilepsy trials, ' +
      'the 50% responder rate was 23.6% among 1,674 participants, with 395 participants ' +
      'achieving this response.'
    expect(
      figureSupportedBy('23.6%', claimFeatures(claim, ['placebo'], ['placebo']), placebo).supported,
    ).toBe(true)
  })

  it("accepts the arm's own number from the same sentence", () => {
    expect(
      check(
        'Seizure freedom at 12 months was 17.1% for patients who received placebo during the ' +
          'Core Study.',
        '17.1%',
      ).supported,
    ).toBe(true)
    expect(
      check(
        'Seizure freedom at 12 months was 22.1% for patients who received perampanel during ' +
          'the Core Study.',
        '22.1%',
      ).supported,
    ).toBe(true)
  })
})

describe('the figure check reads the figure own sentence (D8-05, D8-01)', () => {
  const prepared = prepareSource(RITUXIMAB)

  it("accepts the cohort n against the paper's own numerator pairing (D8-05)", () => {
    const claim = 'In the anti-NMDAR receptor encephalitis rituximab study, 28% of patients ' +
      'relapsed (n = 67).'
    const features = claimFeatures(claim, ['rituximab', 'anti-NMDAR'], ['anti-NMDAR'])
    expect(figureSupportedBy('28%', features, prepared).supported).toBe(true)
  })

  it('keeps rejecting a share the paper pairs with a different n', () => {
    const claim = 'In the anti-NMDAR receptor encephalitis rituximab study, 28% of patients ' +
      'relapsed (n = 205).'
    const features = claimFeatures(claim, ['rituximab', 'anti-NMDAR'], ['anti-NMDAR'])
    expect(figureSupportedBy('28%', features, prepared).supported).toBe(false)
  })

  it('refuses an n the paragraph gives but the figure own sentence does not (D8-01)', () => {
    const claim = 'For powering an add-on trial, you should assume a placebo responder rate of ' +
      '22% (n = 1,674, full analysis set).'
    const features = claimFeatures(claim, ['placebo'], ['placebo'])
    expect(figureSupportedBy('22%', features, prepareSource(PLACEBO)).supported).toBe(false)
  })

  it("accepts the paper's own pairing for the same claim", () => {
    const claim = 'The placebo 50% responder rate was 23.6% (395 of 1,674).'
    const features = claimFeatures(claim, ['placebo'], ['placebo'])
    expect(figureSupportedBy('23.6%', features, prepareSource(PLACEBO)).supported).toBe(true)
  })
})
