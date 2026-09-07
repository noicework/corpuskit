import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { outcomeWords, questionNames, topicPin } from './ask-terse.ts'

const LEXICON = ['valproate', 'lamotrigine', 'LGI1', 'rituximab']

const ICV = {
  id: 'icv',
  title:
    'Anti-seizure therapy with a long-term, implanted intra-cerebroventricular delivery system for drug-resistant epilepsy: A first-in-man study',
  relevance: 0.3,
}
const RAT = {
  id: 'rat',
  title:
    'Long-term valproate treatment increases brain neuropeptide Y expression and decreases seizure expression in a genetic rat model of absence epilepsy',
  relevance: 0.85,
  kind: 'preclinical',
}
const CBD = {
  id: 'cbd',
  title: 'Long-term cannabidiol treatment for seizures in patients with tuberous sclerosis complex',
  relevance: 0.76,
}
const texts = [
  {
    resourceId: 'icv',
    title: ICV.title,
    text:
      'Five adult subjects received intracerebroventricular (ICV) valproate through an implanted pump. Four subjects responded with > 50% seizure reduction at the highest tested dose of 160 mg/day. Seizure reduction was sustained.',
  },
  {
    resourceId: 'rat',
    title: RAT.title,
    text:
      'GAERS rats received valproate by ICV infusion for five days; seizure expression decreased and seizure reduction correlated with NPY.',
  },
  {
    resourceId: 'cbd',
    title: CBD.title,
    text: 'Cannabidiol reduced seizures by 48% at 12 months in 34 patients.',
  },
]

describe('topicPin - the paper a terse question is about (D5-09)', () => {
  it('reads the names and outcome words apart', () => {
    expect(questionNames('ICV valproate seizure reduction - number?', LEXICON)).toEqual([
      'valproate',
      'icv',
    ])
    expect(outcomeWords('ICV valproate seizure reduction - number?', ['valproate', 'icv']))
      .toEqual(['seizur', 'reduct'])
    expect(questionNames('LGI1 - proportion relapsed and median time to relapse', LEXICON)).toEqual(
      [
        'lgi1',
      ],
    )
  })

  it('picks the retrieved paper whose own text carries every name, never a preclinical one for a question about people', () => {
    const pin = topicPin(
      'ICV valproate seizure reduction - number?',
      [RAT, CBD, ICV],
      texts,
      LEXICON,
    )
    expect(pin?.id).toBe('icv')
  })

  it('prefers the paper that says most about the outcome when several carry the name', () => {
    const strategies = {
      resourceId: 'lgi1-strategies',
      title: 'Acute and Long-Term Immune-Treatment Strategies in Anti-LGI1 Encephalitis',
      text:
        'Relapse occurred in 16 (30%) patients; median time to relapse 414 days. Relapse was milder. Early treatment reduced relapse.',
    }
    const proteome = {
      resourceId: 'lgi1-proteome',
      title: 'Plasma proteome in LGI-1 autoimmune encephalitis',
      text: 'LGI1 antibodies were measured in plasma; one relapse was recorded.',
    }
    const pin = topicPin(
      'LGI1 - proportion relapsed and median time to relapse',
      [
        { id: 'lgi1-proteome', title: proteome.title, relevance: 0.92 },
        { id: 'lgi1-strategies', title: strategies.title, relevance: 0.85 },
      ],
      [strategies, proteome],
      LEXICON,
    )
    expect(pin?.id).toBe('lgi1-strategies')
  })

  it('pins nothing for a long question, a question with no name, or texts not yet fetched', () => {
    expect(
      topicPin(
        'What seizure reduction and adverse events were reported with the implanted intracerebroventricular valproate delivery system for drug-resistant epilepsy?',
        [ICV],
        texts,
        LEXICON,
      ),
    ).toBeNull()
    expect(topicPin('seizure reduction - number?', [ICV], texts, LEXICON)).toBeNull()
    expect(topicPin('ICV valproate seizure reduction - number?', [ICV], [], LEXICON)).toBeNull()
  })
})
