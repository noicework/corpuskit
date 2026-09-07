import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  ASSESSMENT_INSTRUCTIONS,
  attributeBriefing,
  attributeQuiz,
  cleanQuizProse,
  isReferenceQuote,
  resolveByQuote,
  resolveSource,
  rotateOptions,
  stripCitationLabels,
  traceTakeaway,
} from './generate-sources.ts'

const sources = [
  { id: 'r1', title: 'Seizure forecasting with wearable devices', sourceName: 'PMC1234.pdf' },
  { id: 'r2', title: 'Multiday cycles of seizure risk', sourceName: 'PMC5678.pdf' },
]

describe('resolveSource', () => {
  it('matches a title exactly, case-insensitively', () => {
    expect(resolveSource('seizure forecasting with wearable devices', sources)).toEqual({
      resourceId: 'r1',
      title: 'Seizure forecasting with wearable devices',
    })
  })
  it('matches a truncated or extended title and the raw source name', () => {
    expect(resolveSource('Multiday cycles', sources)?.resourceId).toBe('r2')
    expect(resolveSource('PMC5678.pdf', sources)?.resourceId).toBe('r2')
    expect(
      resolveSource('Seizure forecasting with wearable devices (2021 cohort)', sources)
        ?.resourceId,
    ).toBe('r1')
  })
  it('never resolves an invented or trivially short label', () => {
    expect(resolveSource('Karoly et al. 2018', sources)).toBeNull()
    expect(resolveSource('PMC', sources)).toBeNull()
  })
  it('resolves a paraphrased title by content-word overlap, to the best match', () => {
    const corpus = [
      {
        id: 'a',
        title: 'Retrospective linkage study of autoimmune encephalitis in Australia: protocol',
      },
      {
        id: 'b',
        title: 'Peripheral immune cell ratios and clinical outcomes in autoimmune encephalitis',
      },
    ]
    expect(
      resolveSource('the Retrospective Linkage Study of Autoimmune Encephalitis project', corpus)
        ?.resourceId,
    ).toBe('a')
    expect(resolveSource('immune cell ratios and outcomes', corpus)?.resourceId).toBe('b')
    // Two shared generic words are not an attribution.
    expect(resolveSource('autoimmune encephalitis management guideline review', corpus)).toBeNull()
  })
})

describe('rotateOptions', () => {
  it('moves the correct option off position zero deterministically by question position', () => {
    const q = { options: ['right', 'w1', 'w2', 'w3'], correct_index: 0 }
    expect(rotateOptions(q, 0)).toEqual(q)
    expect(rotateOptions(q, 1)).toEqual({ options: ['w3', 'right', 'w1', 'w2'], correct_index: 1 })
    expect(rotateOptions(q, 3)).toEqual({ options: ['w1', 'w2', 'w3', 'right'], correct_index: 3 })
    expect(rotateOptions(q, 5)).toEqual({ options: ['w3', 'right', 'w1', 'w2'], correct_index: 1 })
  })
  it('leaves a malformed question alone', () => {
    expect(rotateOptions({ options: ['only'], correct_index: 0 }, 2)).toEqual({
      options: ['only'],
      correct_index: 0,
    })
    expect(rotateOptions({ options: ['a', 'b'], correct_index: 7 }, 1).correct_index).toBe(7)
  })
})

describe('attributeBriefing', () => {
  it('resolves per-section sources to resource ids and drops sections with none', () => {
    const out = attributeBriefing({
      title: 'Forecasting',
      sections: [
        {
          heading: 'Performance',
          content: 'AUC 0.72 to 0.92 in six participants.',
          sources: ['Seizure forecasting with wearable devices', 'Nonexistent study'],
        },
        { heading: 'Background', content: 'Generalities.', sources: [] },
        { heading: 'Cycles', content: 'Multiday cycles.', sources: ['Multiday cycles'] },
      ],
    }, sources)
    expect(out.sections).toHaveLength(2)
    expect(out.sections[0]?.sources).toEqual([
      { resourceId: 'r1', title: 'Seizure forecasting with wearable devices' },
    ])
    expect(out.sections[1]?.sources[0]?.resourceId).toBe('r2')
    expect(out.omitted_sections).toEqual(['Background'])
    expect(out.title).toBe('Forecasting')
  })
  it('de-duplicates a source named twice in one section', () => {
    const out = attributeBriefing({
      sections: [{
        heading: 'A',
        content: 'B',
        sources: ['Multiday cycles', 'PMC5678.pdf'],
      }],
    }, sources)
    expect(out.sections[0]?.sources).toHaveLength(1)
  })
})

describe('resolveByQuote', () => {
  const passages = {
    r1: [
      'Seizures were predicted above chance in all participants using an hourly forecast and in 91% using a daily forecast.',
    ],
    r2: [
      'Multiday cycles of seizure risk were detected in 89% of participants with sufficient data.',
    ],
  }
  it('resolves a verbatim or near-verbatim quote to the passage that carries it', () => {
    expect(
      resolveByQuote(
        'predicted above chance in all participants using an hourly forecast',
        passages,
      ),
    ).toBe('r1')
    expect(
      resolveByQuote('Multiday cycles of seizure risk detected in 89% of participants', passages),
    ).toBe('r2')
  })
  it('refuses a quote that no passage carries, or one too short to place', () => {
    expect(resolveByQuote('the hazard ratio for a second seizure was 0.54', passages)).toBeNull()
    expect(resolveByQuote('seizure risk', passages)).toBeNull()
  })
  it('attributeQuiz falls back to the quote when the model wrote a running header instead of a title', () => {
    const out = attributeQuiz(
      {
        questions: [{
          question: 'Q',
          options: ['a', 'b', 'c', 'd'],
          correct_index: 0,
          source: 'Journal of Neurology (2024) 271:310-324',
          source_quote:
            'seizures were predicted above chance in all participants using an hourly forecast',
        }],
      },
      sources,
      passages,
    ) as { questions: Record<string, unknown>[] }
    expect(out.questions[0]?.source_resource_id).toBe('r1')
    expect(out.questions[0]?.source_title).toBe('Seizure forecasting with wearable devices')
  })
})

describe('attributeQuiz', () => {
  it('replaces the model title with a resolved resource id and title, or nulls', () => {
    const out = attributeQuiz({
      questions: [
        { question: 'Q1', source: 'Multiday cycles of seizure risk' },
        { question: 'Q2', source: 'Made-up paper' },
        { question: 'Q3' },
      ],
    }, sources) as { questions: Record<string, unknown>[] }
    expect(out.questions[0]).toEqual({
      question: 'Q1',
      source_resource_id: 'r2',
      source_title: 'Multiday cycles of seizure risk',
      source_label: 'Multiday cycles of seizure risk',
      source_quote: null,
    })
    const rotated = attributeQuiz({
      questions: [
        { options: ['right', 'a', 'b', 'c'], correct_index: 0 },
        { options: ['right', 'a', 'b', 'c'], correct_index: 0 },
      ],
    }, sources) as { questions: { options: string[]; correct_index: number }[] }
    expect(rotated.questions[0]?.correct_index).toBe(0)
    expect(rotated.questions[1]?.correct_index).toBe(1)
    expect(rotated.questions[1]?.options[1]).toBe('right')
    expect(out.questions[1]?.source_resource_id).toBeNull()
    expect(out.questions[1]?.source).toBeUndefined()
    expect(out.questions[2]?.source_title).toBeNull()
  })
})

describe('briefing references (D1-10)', () => {
  const records = [
    {
      id: 'r1',
      title: 'Rituximab use for relapse prevention in anti-NMDAR encephalitis',
      journal: 'Neurol Neuroimmunol Neuroinflamm',
      published: '2025-05-30',
      authors: ['Broadley J', "O'Neill W"],
    },
    { id: 'r2', title: 'Immune treatment in anti-LGI1 encephalitis', year: '2024' },
  ]

  it('strips the free-text labels the model writes and leaves figures alone', () => {
    expect(stripCitationLabels(
      'Rituximab reduces relapse risk (Journal of Neurology, 2024). Relapse rates range from 14% to 35% (Broadley et al.).',
    )).toBe('Rituximab reduces relapse risk. Relapse rates range from 14% to 35%.')
    expect(
      stripCitationLabels('HR 0.11 (95% CI 0.03 to 0.41) in the EXPERIENCE cohort (n = 1644).'),
    )
      .toBe('HR 0.11 (95% CI 0.03 to 0.41) in the EXPERIENCE cohort (n = 1644).')
    expect(stripCitationLabels('Smith and Jones (2021) reported 28% (Smith and Jones, 2021).'))
      .toBe('Smith and Jones reported 28%.')
  })

  it('numbers references from the resource record, in order of first citation', () => {
    const out = attributeBriefing({
      title: 'Autoimmune encephalitis',
      executive_summary: 'Rituximab prevents relapse (Journal of Neurology, 2024).',
      sections: [
        {
          heading: 'Relapse prevention',
          content: 'Rituximab gave HR 0.11 for relapse (Broadley et al., 2025).',
          sources: ['Rituximab use for relapse prevention in anti-NMDAR encephalitis'],
        },
        {
          heading: 'LGI1',
          content: 'Early immunotherapy improved outcomes in anti-LGI1 encephalitis.',
          sources: [
            'Immune treatment in anti-LGI1 encephalitis',
            'Rituximab use for relapse prevention in anti-NMDAR encephalitis',
          ],
        },
      ],
      key_takeaways: [
        'Rituximab reduces relapse risk, HR 0.11 (Journal of Neurology, 2024).',
        'Corticosteroids improve outcomes in FBDS but carry long-term risks.',
      ],
    }, records)
    expect(out.references).toEqual([
      {
        index: 1,
        resourceId: 'r1',
        title: 'Rituximab use for relapse prevention in anti-NMDAR encephalitis',
        journal: 'Neurol Neuroimmunol Neuroinflamm',
        year: '2025',
        authors: ['Broadley J', "O'Neill W"],
      },
      {
        index: 2,
        resourceId: 'r2',
        title: 'Immune treatment in anti-LGI1 encephalitis',
        year: '2024',
      },
    ])
    expect(out.sections.map((s) => s.refs)).toEqual([[1], [2, 1]])
    expect(out.sections[0]?.content).toBe('Rituximab gave HR 0.11 for relapse.')
    expect(out.executive_summary).toBe('Rituximab prevents relapse.')
    expect(out.key_takeaways).toEqual([
      'Rituximab reduces relapse risk, HR 0.11.',
      'Corticosteroids improve outcomes in FBDS but carry long-term risks.',
    ])
    // The first takeaway restates section 1; the second is stated nowhere.
    expect(out.takeaway_refs).toEqual([[1], []])
  })

  it('traceTakeaway needs a real share of the takeaway in one section', () => {
    const sections = [{
      heading: 'A',
      content: 'Retention at 12 months was 71.1% in 1644 patients.',
      refs: [3],
    }]
    expect(traceTakeaway('Twelve-month retention was 71.1% (1644 patients).', sections)).toEqual([
      3,
    ])
    expect(traceTakeaway('Perampanel seizure freedom was 23.2%.', sections)).toEqual([])
  })
})

describe('quiz prose (D1-20)', () => {
  it('removes prompt-speak from stems and explanations', () => {
    expect(cleanQuizProse(
      'What is a significant challenge in the diagnosis of epilepsy according to the context?',
    )).toBe('What is a significant challenge in the diagnosis of epilepsy?')
    expect(cleanQuizProse(
      'What is a critical aspect of machine learning in epilepsy management as discussed in the context?',
    )).toBe('What is a critical aspect of machine learning in epilepsy management?')
    expect(cleanQuizProse('Based on the provided text, what was the 12-month retention rate?'))
      .toBe('What was the 12-month retention rate?')
    expect(cleanQuizProse('The context states that retention was 71.1%.')).toBe(
      'Retention was 71.1%.',
    )
    expect(cleanQuizProse('In the EXPERIENCE analysis, what was the retention rate?')).toBe(
      'In the EXPERIENCE analysis, what was the retention rate?',
    )
  })

  it('attributeQuiz cleans every question it returns', () => {
    const out = attributeQuiz({
      questions: [{
        question: 'According to the context, which drug was studied?',
        options: ['A', 'B', 'C', 'D'],
        correct_index: 0,
        explanation: 'The passage mentions brivaracetam, as stated in the context.',
        topic: 'x',
      }],
    }, sources)
    const question = out.questions as { question: string; explanation: string }[]
    expect(question[0]?.question).toBe('Which drug was studied?')
    expect(question[0]?.explanation).toBe('The passage mentions brivaracetam.')
  })

  it('the instruction reaches the model whole and forbids referring to the context', () => {
    expect(ASSESSMENT_INSTRUCTIONS).toContain('what the sources actually report')
    expect(ASSESSMENT_INSTRUCTIONS).toContain('never refer to "the context"')
    expect(ASSESSMENT_INSTRUCTIONS.endsWith('Australian English.')).toBe(true)
  })
})

describe('questions from reference lists (D1-20)', () => {
  it('recognises a bibliography entry', () => {
    expect(isReferenceQuote(
      'Kurowski BG, Hugentobler J, Quatman-Yates C, et al. Aerobic exercise for adolescents. J Head Trauma Rehabil. 2017;32(2):79-89.',
    )).toBe(true)
    expect(isReferenceQuote('Hutcheson JD, Setola V, Roth BL, et al. (2011) Serotonin receptors'))
      .toBe(
        true,
      )
    expect(isReferenceQuote('doi:10.1111/epi.17263')).toBe(true)
    expect(isReferenceQuote(
      'In the study by Kurowski et al. on aerobic exercise for adolescents, what design was used?',
    )).toBe(true)
    expect(isReferenceQuote('In the EXPERIENCE study, what was 12-month retention?')).toBe(false)
    expect(
      isReferenceQuote(
        'Retention on PER treatment at 3, 6, and 12 months was 90.5%, 79.8%, and 64.2%',
      ),
    )
      .toBe(false)
  })

  it('attributeQuiz drops such questions and counts them', () => {
    const out = attributeQuiz({
      questions: [
        {
          question: 'What design did Kurowski et al. use?',
          options: ['A', 'B', 'C', 'D'],
          correct_index: 0,
          explanation: 'x',
          topic: 't',
          source_quote: 'Kurowski BG, et al. J Head Trauma Rehabil. 2017;32(2):79-89.',
        },
        {
          question: 'What was 12-month retention on perampanel?',
          options: ['64.2%', '71.1%', '79.8%', '90.5%'],
          correct_index: 0,
          explanation: 'x',
          topic: 't',
          source_quote: 'Retention on PER treatment at 12 months was 64.2%',
        },
      ],
    }, sources)
    expect((out.questions as unknown[]).length).toBe(1)
    expect(out.omitted_questions).toBe(1)
  })

  it('drops a question whose quote came from a passage the retrieval layer calls a reference list', () => {
    const out = attributeQuiz(
      {
        questions: [{
          question: 'Which trial design did the sepsis fluid trial use?',
          options: ['A', 'B', 'C', 'D'],
          correct_index: 0,
          explanation: 'x',
          topic: 't',
          source_quote:
            'Design of clinical trials in acute kidney injury: report from an NIDDK workshop',
        }],
      },
      sources,
      {
        r1: [
          '12. Palevsky PM, et al. Design of clinical trials in acute kidney injury: report from an NIDDK workshop on trial methodology. Clin J Am Soc Nephrol. 2012;7(5):844-850.',
        ],
      },
      () => true,
    )
    expect((out.questions as unknown[]).length).toBe(0)
    expect(out.omitted_questions).toBe(1)
  })
})
