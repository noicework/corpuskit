import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary } from '@research-portal/core'
import {
  antibodyNames,
  groupNames,
  namePin,
  questionNames,
  resolveNames,
  resolvePin,
} from './name-pin.ts'

const resource = (id: string, title: string, summary = ''): ResourceSummary =>
  ({ id, title, summary, relevance: 0 }) as unknown as ResourceSummary

/** The shapes of the epilepsy catalogue the loop 7 defects were found in. */
const CATALOGUE: ResourceSummary[] = [
  resource(
    'lgi1',
    'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Antibody-Mediated Encephalitis: A Multicenter Cohort Study',
    'A cohort of 55 patients recruited through the Australian Autoimmune Encephalitis Consortium.',
  ),
  resource(
    'nmdar',
    'Rituximab Use for Relapse Prevention in Anti-NMDAR Antibody-Mediated Encephalitis: A Multicenter Cohort Study',
  ),
  resource(
    'consortium',
    'Multimodal prognostication of autoimmune encephalitis: an Australian autoimmune encephalitis consortium study',
  ),
  resource(
    'qol',
    'The relationship between patient-reported quality of life and clinician-rated outcome scores in the Australian Autoimmune Encephalitis Consortium',
  ),
  resource(
    'resilience',
    'RESILIENCE (Retrospective Linkage Study of Autoimmune Encephalitis): protocol for an Australian retrospective cohort',
  ),
  resource(
    'breaths',
    'Breathing control training as a treatment for functional seizures (BREATHS trial): a multicentre randomised controlled trial study protocol',
  ),
  resource(
    'breaths-supp',
    'Supplementary material 1: Breathing control training as a treatment for functional seizures (BREATHS trial)',
  ),
  resource(
    'experience',
    'Effectiveness and Tolerability of 12-Month Brivaracetam in the Real World: EXPERIENCE, an International Pooled Analysis',
  ),
  resource('experience-other', 'User experience of a seizure risk forecasting app'),
  resource(
    'experience-third',
    'Experience of the first adult-focussed undiagnosed disease program',
  ),
  resource('lev-rat', 'Levetiracetam Pharmacokinetics and Brain Uptake in a Lamb Model'),
  resource('lev-febrile', 'Febrile seizure recurrence reduced by intermittent oral levetiracetam'),
  resource(
    'lev-pgx',
    'A pharmacogenomic assessment of psychiatric adverse drug reactions to levetiracetam',
  ),
  resource('sudep-1', 'Risk of sudden unexpected death in epilepsy (SUDEP) with lamotrigine'),
  resource(
    'sudep-2',
    'SUDEP risk is influenced by longevity genomics: a polygenic risk score study',
  ),
  resource('sudep-3', 'Interictal EEG and ECG for SUDEP Risk Assessment'),
  resource(
    'sudep-4',
    'Loss-of-function variants in K(v) 11.1 cardiac channels as a biomarker for SUDEP',
  ),
  resource(
    'sudep-5',
    'MRI and pathology correlations in the medulla in sudden unexpected death in epilepsy (SUDEP)',
  ),
]

const LEXICON = ['levetiracetam', 'brivaracetam', 'rituximab', 'carbamazepine', 'Lennox-Gastaut']

describe('the retrieval pin (D7-01, D7-02, D7-09)', () => {
  it('antibody names - an antigen is read where a gene symbol reader refuses it', () => {
    expect(antibodyNames('In anti-LGI1 antibody encephalitis, what proportion relapsed?')).toEqual([
      'LGI1',
    ])
    expect(antibodyNames('Relapse rate in LGI1 antibody encephalitis?')).toEqual(['LGI1'])
    expect(antibodyNames('rituximab in anti-NMDAR encephalitis')).toEqual(['NMDAR'])
    expect(antibodyNames('CASPR2 autoantibody encephalitis')).toEqual(['CASPR2'])
  })

  it('antibody names - a drug class prefixed anti- is never an antigen', () => {
    expect(antibodyNames('Which antiseizure medications are contraindicated?')).toEqual([])
    expect(antibodyNames('anti-epileptic drugs in pregnancy')).toEqual([])
    expect(antibodyNames('autoimmune encephalitis outcomes at 12 months')).toEqual([])
  })

  it('group names - a consortium, registry or network is a name', () => {
    expect(
      groupNames('What proportion of the Australian autoimmune encephalitis consortium cohort ...'),
    ).toEqual(['Australian autoimmune encephalitis consortium'])
    expect(groupNames('the Danish epilepsy registry')).toEqual(['Danish epilepsy registry'])
    expect(groupNames('a consortium')).toEqual([])
  })

  it('an antibody resolves to the one paper whose title carries it', () => {
    const pin = resolvePin(
      'In anti-LGI1 antibody encephalitis, what proportion of patients relapsed, and at what median time to first relapse?',
      CATALOGUE,
      LEXICON,
    )
    expect(pin?.resourceIds).toEqual(['lgi1'])
  })

  it('a named consortium resolves to its own papers, not to a sub-study that mentions it', () => {
    const pin = resolvePin(
      'What proportion of the Australian autoimmune encephalitis consortium cohort had a favourable modified Rankin score at 12 months?',
      CATALOGUE,
      LEXICON,
    )
    if (pin === null) throw new Error('expected a pin')
    // The LGI1 paper names the consortium only in its summary: a title match
    // wins outright, so the sub-study is not one of the consortium's papers.
    expect(pin.resourceIds.includes('lgi1')).toBe(false)
    expect(pin.resourceIds.includes('consortium')).toBe(true)
    expect(pin.resourceIds.includes('qol')).toBe(true)
    // "Australian retrospective" is not "Australian autoimmune encephalitis".
    expect(pin.resourceIds.includes('resilience')).toBe(false)
  })

  it('a described cohort resolves through its contiguous words, geography included', () => {
    const pin = resolvePin(
      'What proportion of the Australian autoimmune encephalitis cohort had an mRS of 2 or less one year on?',
      CATALOGUE,
      LEXICON,
    )
    if (pin === null) throw new Error('expected a pin')
    expect(pin.resourceIds.includes('consortium')).toBe(true)
    expect(pin.resourceIds.includes('lgi1')).toBe(false)
  })

  it('a trial acronym resolves in the case the question wrote it, and never to an attachment', () => {
    const pin = resolvePin(
      'For a registrar teaching session: what does the collection say about how often functional seizures are misdiagnosed as epilepsy, and what does the BREATHS trial test?',
      CATALOGUE,
      LEXICON,
    )
    expect(pin?.resourceIds).toEqual(['breaths'])
    const experience = resolvePin(
      'In the EXPERIENCE study, what was the 12-month retention rate and its denominator?',
      CATALOGUE,
      LEXICON,
    )
    // "User experience" and "Experience of the first ..." are the English word.
    expect(experience?.resourceIds).toEqual(['experience'])
  })

  it('a drug alone is a topic and pins nothing', () => {
    expect(resolvePin(
      'In patients with psychiatric comorbidity who switched from levetiracetam to brivaracetam, what was the 12-month seizure freedom rate?',
      CATALOGUE,
      LEXICON,
    )).toEqual(null)
    expect(
      resolvePin(
        'Is carbamazepine contraindicated in juvenile myoclonic epilepsy?',
        CATALOGUE,
        LEXICON,
      ),
    ).toEqual(null)
  })

  it('a drug joins a pin a stronger name has already made', () => {
    const pin = resolvePin(
      "Grant background: what does the group's work show about rituximab in anti-NMDAR encephalitis and early immunotherapy in LGI1 encephalitis?",
      CATALOGUE,
      LEXICON,
    )
    if (pin === null) throw new Error('expected a pin')
    expect(pin.resourceIds.includes('lgi1')).toBe(true)
    expect(pin.resourceIds.includes('nmdar')).toBe(true)
  })

  it('a name that titles many papers is a topic and pins nothing', () => {
    expect(resolvePin(
      'What is the adjusted hazard ratio for SUDEP in people who had generalised tonic-clonic seizures in the year before admission?',
      CATALOGUE,
      LEXICON,
    )).toEqual(null)
    expect(resolvePin(
      'What is the placebo 50% responder rate pooled across antiseizure medication randomised trials?',
      CATALOGUE,
      LEXICON,
    )).toEqual(null)
  })

  it('questionNames puts the names that identify a cohort before the ones that narrow it', () => {
    const names = questionNames(
      'rituximab in anti-NMDAR antibody encephalitis',
      LEXICON,
    )
    expect(names.map((n) => n.kind)).toEqual(['antibody', 'term'])
  })

  it('resolveNames prefers a title to a generated summary', () => {
    const resolved = resolveNames(
      'the Australian autoimmune encephalitis consortium',
      questionNames('the Australian autoimmune encephalitis consortium', []),
      CATALOGUE,
    )
    expect(resolved.length).toEqual(1)
    expect(resolved[0]?.via).toEqual('title')
  })

  it('namePin caps the pin and keeps the strong names first', () => {
    const many = Array.from({ length: 10 }, (_, i) => resource(`r${i}`, `Paper ${i}`))
    const pin = namePin([
      {
        name: { text: 'A', kind: 'term', words: ['a'] },
        via: 'title',
        resourceIds: many.slice(0, 5).map((r) => r.id),
        titles: many.slice(0, 5).map((r) => r.title),
      },
      {
        name: { text: 'B', kind: 'acronym', words: ['b'] },
        via: 'title',
        resourceIds: ['strong'],
        titles: ['Strong'],
      },
    ])
    expect(pin?.resourceIds[0]).toEqual('strong')
    expect(pin?.resourceIds.length).toEqual(6)
  })
})
