import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  type ContextTurn,
  isReformatFollowUp,
  priorAnswerContext,
  priorPassageContext,
  priorQuestions,
  priorResourceIds,
  refersToPriorTurns,
  reformatAddendum,
  reformatBudget,
  staysWithinPriorTurns,
} from './ask-session.ts'

const context: ContextTurn[] = [
  { author: 'USER', text: 'Give me the 12-month responder rate for brivaracetam (EXPERIENCE).' },
  {
    author: 'AGENT',
    text:
      'The 12-month 50% responder rate was 36.9% (n = 822).[1]\n\n*Denominators: none missing.*',
    resourceIds: ['exp'],
    passages: [
      'At 12 months the 50% responder rate was 36.9% (n = 822) in the modified full analysis set of the EXPERIENCE pooled analysis.',
    ],
  },
  {
    author: 'USER',
    text: 'Now add lacosamide: what responder rate did the randomised trial report?',
  },
  {
    author: 'AGENT',
    text: 'Lacosamide: 68.1% (n = 119) versus placebo 46.3% (n = 121).[1]',
    resourceIds: ['lcm', 'exp'],
    passages: [
      'The 50% responder rate was 68.1% for lacosamide (n = 119) and 46.3% for placebo (n = 121) over the treatment period.',
      'short',
    ],
  },
]

describe('prior turns', () => {
  it('lists the cited papers most recent first without repeats', () => {
    expect(priorResourceIds(context)).toEqual(['lcm', 'exp'])
  })
  it('lists the earlier questions most recent first', () => {
    expect(priorQuestions(context)).toEqual([
      'Now add lacosamide: what responder rate did the randomised trial report?',
      'Give me the 12-month responder rate for brivaracetam (EXPERIENCE).',
    ])
  })
  it('labels each cited passage and drops fragments and repeats', () => {
    const blocks = priorPassageContext(context)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('Passage cited by an earlier answer')
    expect(blocks[0]).toContain('68.1%')
    expect(blocks[1]).toContain('36.9%')
  })
  it('gives a reformatting turn the earlier answers without markers or audit notes', () => {
    const blocks = priorAnswerContext(context)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('Earlier question: Give me the 12-month responder rate')
    expect(blocks[0]).toContain('36.9% (n = 822).')
    expect(blocks[0]).not.toContain('[1]')
    expect(blocks[0]).not.toContain('Denominators')
  })
})

describe('reformatting follow-ups (D4-06)', () => {
  it('recognises a table, bullets or a summary of the earlier answers', () => {
    expect(
      isReformatFollowUp(
        'Put the three drugs in a table: drug, study, design, responder rate, denominator, retention where reported.',
      ),
    ).toBe(true)
    expect(isReformatFollowUp('Summarise the above as bullet points')).toBe(true)
    expect(isReformatFollowUp('Can you tabulate these?')).toBe(true)
    expect(isReformatFollowUp('Give me those figures as a one-liner for a slide')).toBe(true)
  })
  it('does not mistake a new question for a reformat', () => {
    expect(
      isReformatFollowUp(
        'Now add lacosamide: what 50% responder rate and sample size did the randomised trial report?',
      ),
    ).toBe(false)
    expect(isReformatFollowUp('What placebo responder rate should I plan for?')).toBe(false)
    expect(isReformatFollowUp('Which trial reported the list of adverse events?')).toBe(false)
    expect(
      isReformatFollowUp(
        'How does that cohort compare with the lamotrigine SUDEP case-control study in size, design and main effect size?',
      ),
    ).toBe(false)
  })
  it('asks for a table with every cell filled, and never a new claim', () => {
    const addendum = reformatAddendum('Put the three drugs in a table')
    expect(addendum).toContain('Markdown table')
    expect(addendum).toContain('add nothing')
    expect(reformatAddendum('as bullet points please')).toContain('bulleted list')
  })
})

describe('follow-ups that lean on the earlier turns (D4-07)', () => {
  it('pins the earlier papers for "that cohort" and a comparison, not for a new drug', () => {
    expect(
      refersToPriorTurns(
        'How does that cohort compare with the lamotrigine SUDEP case-control study in size, design and main effect size?',
      ),
    ).toBe(true)
    expect(refersToPriorTurns('And the SUDEP rate per 1000 person-years in each group?')).toBe(true)
    expect(
      refersToPriorTurns(
        'Now add lacosamide: what 50% responder rate did the randomised adjunctive lacosamide trial report?',
      ),
    ).toBe(false)
  })
})

describe('follow-ups that stay within the earlier papers (D5-06)', () => {
  const jme: ContextTurn[] = [
    {
      author: 'USER',
      text:
        'In the JME drug-resistance prediction study, how many patients were included, what proportion were drug resistant, and over what period were they recruited?',
    },
    {
      author: 'AGENT',
      text: 'In the JME drug-resistance prediction study, 2,518 patients were included.[1]',
      resourceIds: ['jme'],
    },
  ]
  const lexicon = ['lacosamide', 'lamotrigine', 'brivaracetam']
  it('scopes "that study" and "back to the JME cohort" to the earlier papers', () => {
    expect(
      staysWithinPriorTurns(
        'What was the strongest predictor in that study, with its odds ratio and confidence interval?',
        jme,
        lexicon,
      ),
    ).toBe(true)
    expect(
      staysWithinPriorTurns(
        'Back to the JME cohort: what proportion had a psychiatric comorbidity, if the paper reports it?',
        jme,
        lexicon,
      ),
    ).toBe(true)
  })
  it('does not confine a follow-up that names a new drug or study, a reformat, or a first turn', () => {
    expect(
      staysWithinPriorTurns(
        'How does that compare with the lamotrigine SUDEP case-control study?',
        jme,
        lexicon,
      ),
    ).toBe(false)
    expect(
      staysWithinPriorTurns('Now add lacosamide: what responder rate did it report?', jme, lexicon),
    )
      .toBe(false)
    expect(staysWithinPriorTurns('Put the two in a table', jme, lexicon)).toBe(false)
    expect(staysWithinPriorTurns('What was the strongest predictor in that study?', [], lexicon))
      .toBe(false)
  })
  it('sizes the reformatting budget to the answers a table has to hold (D5-05)', () => {
    expect(reformatBudget(jme)).toBe(1800)
    const five = [...jme, ...jme, ...jme, ...jme, ...jme]
    expect(reformatBudget(five)).toBe(3150)
    expect(reformatBudget([...five, ...five])).toBe(4096)
  })
  it('asks a table turn to write Markdown directly and to name a study by its paper', () => {
    const addendum = reformatAddendum('Summarise the three in a table')
    expect(addendum).toContain('never inside a code fence')
    expect(addendum).toContain('never "not named"')
  })
})
