import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary, ScoredResource } from '@research-portal/core'
import {
  answerByClause,
  asksForQuantity,
  attributeToResource,
  bestArticle,
  clauseAddendum,
  clauseDecline,
  clausePinningApplies,
  comparedMedications,
  composeClauseAnswers,
  decomposeQuestion,
  groupClauses,
  guidancePin,
  guidanceProbe,
  isOnlyDecline,
  isOpenTreatmentQuestion,
  isSuperlativeComparison,
  markersPerSentence,
  medicationPapers,
  medicationsInResults,
  phraseOverlap,
  resolveClauses,
  stripFraming,
  withoutForeignEntities,
} from './clause-pin.ts'
import { conditionNames, medicationNames, scopeResources } from './name-pin.ts'

const LEXICON = [
  'lamotrigine',
  'levetiracetam',
  'carbamazepine',
  'perampanel',
  'brivaracetam',
  'cannabidiol',
  'rituximab',
  'phenytoin',
]

function resource(
  id: string,
  title: string,
  summary = '',
): ResourceSummary {
  return { id, title, summary } as ResourceSummary
}

function scored(id: string, title: string, relevance: number): ScoredResource {
  return { id, title, relevance, citedCount: 0 } as ScoredResource
}

const CATALOGUE: ResourceSummary[] = [
  resource('jme1', 'Individualised prediction of drug resistance in juvenile myoclonic epilepsy'),
  resource('jme2', 'Valproate and lamotrigine in juvenile myoclonic epilepsy: a cohort'),
  resource('cln2', 'Guidelines for the management of CLN2 disease patients'),
  resource('brv', 'Effectiveness and tolerability of 12-month brivaracetam in the real world'),
  resource('per', 'PERMIT: a pooled analysis of perampanel effectiveness'),
  resource('cbd', 'Long-term cannabidiol in drug-resistant epilepsy'),
  resource('umpire', 'Seizure forecasting using a sub-scalp ultra-long term EEG system'),
  resource('placebo', 'Placebo response in randomised add-on epilepsy trials'),
]

describe('conditionNames', () => {
  it('reads a qualified condition and ignores the bare head noun', () => {
    expect(conditionNames('Is carbamazepine contraindicated in juvenile myoclonic epilepsy?'))
      .toEqual(['juvenile myoclonic epilepsy'])
    expect(conditionNames('How common is epilepsy in people with epilepsy?')).toEqual([])
  })

  it('drops the verbs and adverbs a question puts in front of its subject', () => {
    expect(conditionNames('How often are functional seizures misdiagnosed as epilepsy?'))
      .toEqual(['functional seizures'])
    expect(conditionNames('Does stress increase seizure frequency?')).toEqual([])
    expect(conditionNames('Compare seizure freedom rates between two drugs')).toEqual([])
  })
})

describe('medicationNames', () => {
  it('reads the lexicon medications a question names, in order', () => {
    expect(medicationNames('switching from levetiracetam to brivaracetam', LEXICON))
      .toEqual(['levetiracetam', 'brivaracetam'])
  })

  it('ignores a medication named only as part of a longer word', () => {
    expect(medicationNames('perampanelation is not a word', LEXICON)).toEqual([])
  })
})

describe('scopeResources', () => {
  it('scopes a clause to the papers a condition names, and leaves the rest out', () => {
    expect(scopeResources(['juvenile myoclonic epilepsy'], CATALOGUE)).toEqual(['jme1', 'jme2'])
    expect(scopeResources(['juvenile myoclonic epilepsy'], CATALOGUE)).not.toContain('cln2')
  })

  it('scopes on a medication too', () => {
    expect(scopeResources(['brivaracetam'], CATALOGUE)).toEqual(['brv'])
  })

  it('resolves to nothing when the term reaches no paper', () => {
    expect(scopeResources(['fabricated syndrome'], CATALOGUE)).toEqual([])
  })
})

describe('comparedMedications', () => {
  it('splits a comparison of two drugs', () => {
    expect(
      comparedMedications(
        'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
        LEXICON,
      ),
    ).toEqual(['perampanel', 'brivaracetam'])
  })

  it('does not split a treatment path that merely names two drugs', () => {
    expect(
      comparedMedications(
        'In patients who switched from levetiracetam to brivaracetam, what was the 12-month seizure freedom rate?',
        LEXICON,
      ),
    ).toEqual([])
  })

  it('does not split a question that names a study: the study pins it whole', () => {
    expect(
      comparedMedications(
        'What did the ESETT trial find about levetiracetam versus phenytoin?',
        LEXICON,
      ),
    ).toEqual([])
  })

  it('uses the members retrieval supplied for a category comparison', () => {
    expect(
      comparedMedications('Which anti-seizure medication has the best retention?', LEXICON, [
        'brivaracetam',
        'perampanel',
      ]),
    ).toEqual(['brivaracetam', 'perampanel'])
  })
})

describe('decomposeQuestion', () => {
  it('makes one clause per drug for a comparison, each asking only for its drug', () => {
    const clauses = decomposeQuestion(
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
      LEXICON,
    )
    expect(clauses).toHaveLength(2)
    expect(clauses.map((c) => c.entity)).toEqual(['perampanel', 'brivaracetam'])
    expect(clauses[0]!.ask).toContain('Answer only for perampanel')
    expect(clauses[0]!.ask).toContain('without ranking or comparing')
  })

  it('makes one clause per part of a two-part question', () => {
    expect(
      decomposeQuestion(
        'How old were the participants in the sub-scalp monitoring trial and how many were female?',
        LEXICON,
      ).map((c) => c.text),
    ).toEqual([
      'How old were the participants in the sub-scalp monitoring trial',
      'how many were female',
    ])
  })

  it('makes one clause of a single question', () => {
    const clauses = decomposeQuestion('What proportion relapsed?', LEXICON)
    expect(clauses).toHaveLength(1)
    expect(clauses[0]!.kind).toBe('whole')
  })
})

describe('clausePinningApplies', () => {
  it('applies to a quantity question, a comparison and a drug-in-condition question', () => {
    expect(asksForQuantity('what share of patients reached a good functional outcome?')).toBe(true)
    expect(
      clausePinningApplies(
        'If I am powering an add-on trial, what placebo responder rate should I assume?',
        LEXICON,
      ),
    ).toBe(true)
    expect(
      clausePinningApplies('Compare brivaracetam and perampanel retention.', LEXICON),
    ).toBe(true)
    expect(
      clausePinningApplies(
        'Is carbamazepine contraindicated in juvenile myoclonic epilepsy?',
        LEXICON,
      ),
    ).toBe(true)
  })

  it('does not apply to a multi-paper synthesis question', () => {
    expect(
      clausePinningApplies(
        'What is the evidence that sleep deprivation increases seizure risk?',
        LEXICON,
      ),
    )
      .toBe(false)
    expect(clausePinningApplies('Does stress increase seizure frequency?', LEXICON)).toBe(false)
  })
})

describe('isSuperlativeComparison / medicationsInResults / medicationPapers', () => {
  it('reads a category comparison and its members off the retrieved titles', () => {
    expect(isSuperlativeComparison('Which anti-seizure medication has the best retention?'))
      .toBe(true)
    expect(
      medicationsInResults(
        [scored('brv', CATALOGUE[3]!.title, 0.8), scored('per', CATALOGUE[4]!.title, 0.7)],
        LEXICON,
      ),
    ).toEqual(['brivaracetam', 'perampanel'])
    expect(medicationPapers(CATALOGUE, LEXICON)).toEqual(['jme2', 'brv', 'per', 'cbd'])
  })
})

describe('resolveClauses', () => {
  const deps = (
    find: (text: string, ids?: readonly string[]) => Promise<readonly ScoredResource[]>,
  ) => ({
    catalogue: CATALOGUE,
    lexicon: LEXICON,
    find,
    pin: () => null,
    floor: 0.3,
    margin: 0.2,
  })

  it('resolves a clause inside the scope its condition gives it', async () => {
    const seen: (readonly string[] | undefined)[] = []
    const resolved = await resolveClauses(
      decomposeQuestion(
        'Is carbamazepine contraindicated in juvenile myoclonic epilepsy?',
        LEXICON,
      ),
      deps((_text, ids) => {
        seen.push(ids)
        return Promise.resolve([scored('jme2', CATALOGUE[1]!.title, 0.7)])
      }),
    )
    expect(seen[0]).toEqual(['jme1', 'jme2'])
    expect(resolved[0]!.via).toBe('scope')
    expect(resolved[0]!.resourceId).toBe('jme2')
  })

  it('never lets a clause with no subject of its own leave the clause before it', async () => {
    const resolved = await resolveClauses(
      decomposeQuestion(
        'What proportion of people report depressive symptoms after a first seizure, and how many participants were enrolled?',
        LEXICON,
      ),
      deps((text, ids) => {
        if (ids) return Promise.resolve([scored(ids[0]!, 'scoped', 0.2)])
        // A vagus-nerve-stimulation registry scores far higher for "how many
        // participants were enrolled" than the first-seizure paper does.
        if (/enrolled/i.test(text)) return Promise.resolve([scored('cbd', 'VNS registry', 0.95)])
        return Promise.resolve([scored('umpire', CATALOGUE[6]!.title, 0.6)])
      }),
    )
    expect(resolved.map((r) => r.resourceId)).toEqual(['umpire', 'umpire'])
    expect(resolved[1]!.via).toBe('inherited')
  })

  it('keeps a continuation clause with the paper the clause before it resolved to', async () => {
    const resolved = await resolveClauses(
      decomposeQuestion(
        'How old were the participants in the sub-scalp monitoring trial and how many were female?',
        LEXICON,
      ),
      deps((text, ids) => {
        // The corpus offers a neonatal cohort for "how many were female"; the
        // sub-scalp paper answers it about as well, so it keeps it (D8-03).
        if (ids?.length === 1 && ids[0] === 'umpire') {
          return Promise.resolve([scored('umpire', CATALOGUE[6]!.title, 0.55)])
        }
        if (ids) return Promise.resolve([])
        if (/female/i.test(text)) {
          return Promise.resolve([scored('cbd', CATALOGUE[5]!.title, 0.65)])
        }
        return Promise.resolve([scored('umpire', CATALOGUE[6]!.title, 0.6)])
      }),
    )
    expect(resolved.map((r) => r.resourceId)).toEqual(['umpire', 'umpire'])
    expect(resolved[1]!.via).toBe('inherited')
  })

  it('declines a clause nothing answers rather than borrowing a neighbour', async () => {
    const resolved = await resolveClauses(
      [{ text: 'what does the BREATHS trial test', kind: 'part', label: 'BREATHS' }],
      deps(() => Promise.resolve([scored('cbd', CATALOGUE[5]!.title, 0.1)])),
    )
    expect(resolved[0]!.via).toBe('none')
    expect(resolved[0]!.resourceId).toBeUndefined()
  })

  it('never returns an attachment or a reference-list hit as a clause paper', () => {
    expect(
      bestArticle([
        { ...scored('a', 'Supplementary material 1', 0.9) },
        { ...scored('b', 'A real paper', 0.6), referenceChunk: true } as ScoredResource,
        scored('c', 'Another real paper', 0.4),
      ], 0.3)?.id,
    ).toBe('c')
  })
})

describe('composition', () => {
  it('gives every sentence exactly one marker, and never two', () => {
    const attributed = attributeToResource(
      'The rate was 23.6% [4]. It was drawn from 1,674 participants [2][7].',
      1,
    )
    expect(attributed).toBe('The rate was 23.6%.[1] It was drawn from 1,674 participants.[1]')
    expect(markersPerSentence(attributed).every((n) => n === 1)).toBe(true)
  })

  it("leaves headings, list prefixes and the portal's own notes alone", () => {
    const attributed = attributeToResource(
      '## Retention\n\n- The rate was 71.1%.\n\n*One sentence was removed.*',
      2,
    )
    expect(attributed).toContain('## Retention')
    expect(attributed).toContain('- The rate was 71.1%.[2]')
    expect(attributed).toContain('*One sentence was removed.*')
    expect(attributed).not.toContain('removed.*[2]')
    expect(markersPerSentence(attributed).filter((n) => n > 0)).toEqual([1])
  })

  it('composes one block per paper, with one citation each', () => {
    const { groups } = groupClauses(
      [
        {
          clause: {
            text: 'brivaracetam retention',
            kind: 'entity',
            label: 'brivaracetam',
            entity: 'brivaracetam',
          },
          via: 'scope',
          resourceId: 'brv',
          title: CATALOGUE[3]!.title,
          relevance: 0.8,
        },
        {
          clause: {
            text: 'perampanel retention',
            kind: 'entity',
            label: 'perampanel',
            entity: 'perampanel',
          },
          via: 'scope',
          resourceId: 'per',
          title: CATALOGUE[4]!.title,
          relevance: 0.7,
        },
      ],
    )
    expect(groups.map((g) => g.heading)).toEqual(['brivaracetam', 'perampanel'])
    const composed = composeClauseAnswers(
      [
        { group: groups[0]!, text: 'Retention was 71.1%.' },
        { group: groups[1]!, text: 'Retention was 64.2%.' },
      ],
      [],
    )
    expect(composed.citations).toEqual([
      { index: 1, resourceId: 'brv', title: CATALOGUE[3]!.title },
      { index: 2, resourceId: 'per', title: CATALOGUE[4]!.title },
    ])
    expect(composed.text).toContain('**brivaracetam**')
    expect(composed.text).toContain('Retention was 71.1%.[1]')
    expect(composed.text).toContain('Retention was 64.2%.[2]')
    // The defect this closes: one drug's figure under the other's heading.
    expect(composed.text.indexOf('71.1%.[1]')).toBeLessThan(composed.text.indexOf('**perampanel**'))
  })

  it('asks one paper both of its clauses, in the words the decomposition left them in', () => {
    const { groups, declined } = groupClauses(
      [
        {
          clause: { text: 'a', kind: 'part', label: 'a' },
          via: 'topic',
          resourceId: 'placebo',
          title: CATALOGUE[7]!.title,
          relevance: 0.8,
        },
        {
          clause: { text: 'b', kind: 'part', label: 'b' },
          via: 'inherited',
          resourceId: 'placebo',
          title: CATALOGUE[7]!.title,
          relevance: 0.6,
        },
      ],
      'What was the responder rate, and in how many participants?',
    )
    expect(declined).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.query).toBe('What was the responder rate, and in how many participants?')
    expect(groups[0]!.heading).toBeUndefined()
  })

  it('declines an unresolved clause by name and keeps the rest of the answer', () => {
    const composed = composeClauseAnswers(
      [
        {
          group: {
            resourceId: 'brv',
            title: CATALOGUE[3]!.title,
            clauses: [{ text: 'x', kind: 'part', label: 'x' }],
            query: 'x',
          },
          text: 'Retention was 71.1%.',
        },
      ],
      [{
        text: 'what does the BREATHS trial test',
        kind: 'part',
        label: 'what does the BREATHS trial test',
      }],
    )
    expect(composed.text).toContain('Retention was 71.1%.[1]')
    expect(composed.text).toContain(
      '*This collection holds no paper answering "what does the BREATHS trial test".*',
    )
  })

  it('drops the block-local remark about the drug the block beside it answers for', () => {
    expect(
      withoutForeignEntities(
        'Retention was 71.1%. The cited sources do not provide data on perampanel. This ' +
          'document does not state which medication has the best retention.',
        ['perampanel'],
      ),
    ).toBe('Retention was 71.1%.')
  })

  it('reads a block that only declines as a declined clause', () => {
    expect(isOnlyDecline('This document does not state the 12-month retention for perampanel.'))
      .toBe(true)
    expect(isOnlyDecline('Retention was 71.1%. The paper does not state the overall rate.'))
      .toBe(false)
  })

  it('strips the framing a question carries for the portal, not for the corpus', () => {
    expect(
      stripFraming(
        'For a registrar teaching session: what does the collection say about how often ' +
          'functional seizures are misdiagnosed as epilepsy',
      ),
    ).toBe('how often functional seizures are misdiagnosed as epilepsy')
    expect(stripFraming('What proportion relapsed?')).toBe('What proportion relapsed?')
  })

  it("prefers the paper that shares the question's phrase, not merely its words", () => {
    const candidates = [
      scored(
        'lac',
        'Efficacy and tolerability of adjunctive lacosamide in pediatric patients',
        0.94,
      ),
      scored(
        'placebo',
        'Factors associated with placebo response rate in randomized controlled trials',
        0.93,
      ),
    ]
    expect(
      bestArticle(
        candidates,
        0.3,
        'what placebo responder rate should I assume, and from how many patients',
      )?.id,
    ).toBe('placebo')
    expect(phraseOverlap('placebo responder rate', 'placebo response rate in trials'))
      .toBeGreaterThan(0)
  })

  it('names the entity in a declined comparison clause', () => {
    expect(
      clauseDecline({ text: 'x', kind: 'entity', label: 'perampanel', entity: 'perampanel' }),
    ).toBe('*This collection holds no paper answering this question for perampanel.*')
  })

  it('constrains the one-paper prompt to that paper and that entity', () => {
    const addendum = clauseAddendum({
      resourceId: 'brv',
      title: 'Brivaracetam in the real world',
      clauses: [{ text: 'x', kind: 'entity', label: 'brivaracetam', entity: 'brivaracetam' }],
      query: 'x',
    })
    expect(addendum).toContain('"Brivaracetam in the real world"')
    expect(addendum).toContain('only what it states about brivaracetam')
    expect(addendum).toContain('Never pair a figure with a denominator from a different sentence')
  })
})

describe('answerByClause', () => {
  const deps = (
    asked: string[],
    answers: Record<string, string>,
  ) => ({
    catalogue: CATALOGUE,
    lexicon: LEXICON,
    floor: 0.3,
    margin: 0.2,
    pin: () => null,
    find: (_text: string, ids?: readonly string[]) => {
      if (ids?.includes('brv')) return Promise.resolve([scored('brv', CATALOGUE[3]!.title, 0.8)])
      if (ids?.includes('per')) return Promise.resolve([scored('per', CATALOGUE[4]!.title, 0.7)])
      return Promise.resolve([scored('brv', CATALOGUE[3]!.title, 0.5)])
    },
    askOne: (group: { resourceId: string; query: string }) => {
      asked.push(`${group.resourceId}:${group.query}`)
      return Promise.resolve({
        text: answers[group.resourceId] ?? '',
        sources: [] as readonly ScoredResource[],
      })
    },
  })

  it('asks each drug its own paper and composes with one paper per sentence', async () => {
    const asked: string[] = []
    const answer = await answerByClause(
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
      deps(asked, {
        brv: 'Retention at 12 months was 71.1% (n = 1644).',
        per: 'Retention at 12 months was 64.2% (2698/4201).',
      }),
    )
    expect(asked).toHaveLength(2)
    expect(answer?.text).toContain('71.1% (n = 1644).[')
    expect(markersPerSentence(answer!.text).every((n) => n <= 1)).toBe(true)
    // Each figure is under, and cited to, its own drug's paper.
    const brv = answer!.citations.find((c) => c.resourceId === 'brv')!
    expect(answer!.text).toContain(`71.1% (n = 1644).[${brv.index}]`)
  })

  it('declines the clause whose paper answered nothing and keeps the other', async () => {
    const answer = await answerByClause(
      'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
      deps([], { brv: 'Retention at 12 months was 71.1%.' }),
    )
    expect(answer?.text).toContain('71.1%.[1]')
    expect(answer?.text).toContain(
      '*This collection holds no paper answering this question for perampanel.*',
    )
  })

  it('returns null when no one-paper ask produced an answer, so the ordinary path runs', async () => {
    expect(
      await answerByClause(
        'Compare the 12-month retention rates of brivaracetam and perampanel in real-world studies.',
        deps([], {}),
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// An open "which medications" question (PR: the Dravet clause regression)
// ---------------------------------------------------------------------------

const CONDITION_LEXICON = [...LEXICON, 'Dravet']

const GUIDANCE_CATALOGUE: ResourceSummary[] = [
  ...CATALOGUE,
  resource('consensus', 'International consensus on diagnosis and management of Dravet syndrome'),
  resource('phen', 'Does long-term phenytoin have a place in Dravet syndrome?'),
]

const DRAVET = 'Which anti-seizure medications are contraindicated in SCN1A Dravet syndrome?'

describe('an open "which medications" question is never decomposed by drug', () => {
  it('is not a ranking, so clause pinning does not apply to it', () => {
    expect(isOpenTreatmentQuestion(DRAVET, CONDITION_LEXICON)).toBe(true)
    expect(isSuperlativeComparison(DRAVET)).toBe(false)
    expect(clausePinningApplies(DRAVET, CONDITION_LEXICON)).toBe(false)
    expect(isOpenTreatmentQuestion('Which ASMs should be avoided in SCN1A Dravet?', LEXICON))
      .toBe(true)
    expect(isOpenTreatmentQuestion('What drugs should I avoid in Dravet syndrome?', LEXICON))
      .toBe(true)
  })

  it('stays one clause even when retrieval offers the drugs it found', () => {
    // The drugs come off the retrieved titles, not off the question: this is
    // what produced a "phenytoin" heading and clause declines for
    // cannabidiol and fenfluramine on a question that named none of them.
    expect(comparedMedications(DRAVET, CONDITION_LEXICON, ['phenytoin', 'cannabidiol'])).toEqual([])
    expect(
      decomposeQuestion(DRAVET, CONDITION_LEXICON, ['phenytoin', 'cannabidiol']).map((c) => c.kind),
    ).toEqual(['whole'])
  })

  it('leaves a ranking question and a named comparison decomposed', () => {
    const ranking = 'Which anti-seizure medication has the best real-world 12-month retention?'
    expect(isOpenTreatmentQuestion(ranking, LEXICON)).toBe(false)
    expect(isSuperlativeComparison(ranking)).toBe(true)
    expect(clausePinningApplies(ranking, LEXICON)).toBe(true)
    expect(decomposeQuestion(ranking, LEXICON, ['brivaracetam', 'perampanel']).map((c) => c.entity))
      .toEqual(['brivaracetam', 'perampanel'])
    expect(clausePinningApplies('Compare brivaracetam and perampanel retention.', LEXICON))
      .toBe(true)
    // A question that names one drug is a drug-in-condition question, not an
    // enumeration, and keeps its clause pin.
    expect(
      isOpenTreatmentQuestion('Which of lamotrigine and carbamazepine is safer in JME?', LEXICON),
    ).toBe(false)
  })
})

describe('guidancePin', () => {
  it("pins the syndrome's consensus statement, by phrase and by lexicon term", () => {
    const byPhrase = guidancePin(DRAVET, GUIDANCE_CATALOGUE, CONDITION_LEXICON)
    expect(byPhrase?.resourceIds).toEqual(['consensus'])
    expect(byPhrase?.names).toEqual(['scn1a dravet syndrome'])
    // "Which ASMs should be avoided in SCN1A Dravet?" carries no head noun,
    // so it names no condition by phrase and resolves on the lexicon term.
    expect(
      guidancePin('Which ASMs should be avoided in SCN1A Dravet?', GUIDANCE_CATALOGUE, [
        'Dravet',
      ])?.resourceIds,
    ).toEqual(['consensus'])
    expect(guidanceProbe(byPhrase!)).toContain('scn1a dravet syndrome')
  })

  it('pins nothing for a question that names a drug, a ranking, or a condition with no guidance', () => {
    expect(
      guidancePin(
        'Is carbamazepine contraindicated in juvenile myoclonic epilepsy?',
        GUIDANCE_CATALOGUE,
        CONDITION_LEXICON,
      ),
    ).toBeNull()
    expect(
      guidancePin(
        'Which anti-seizure medication has the best retention?',
        GUIDANCE_CATALOGUE,
        CONDITION_LEXICON,
      ),
    ).toBeNull()
    expect(
      guidancePin(
        'Which drugs are contraindicated in juvenile myoclonic epilepsy?',
        GUIDANCE_CATALOGUE,
        CONDITION_LEXICON,
      ),
    ).toBeNull()
  })
})
