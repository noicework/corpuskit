import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { IntentSchema } from '@research-portal/core'
import {
  classifierIntents,
  decideFromClassifier,
  decomposable,
  extractEntities,
  fillPrequeries,
  isResultsQuestion,
  isTerseResultsQuestion,
  lexiconEntities,
  looksLikeGeneSymbol,
  parseAuthorYear,
  parseIdentifier,
  RESULTS_QUESTION_RULE,
  routeByRules,
  wordCount,
} from './intent-router.ts'

const base = {
  description: '',
  retrieval: { features: ['keyword', 'semantic'], topK: 20, reranker: 'predict' },
  answer: { surfaces: ['ask'], strategy: 'neighbours', promptVariant: 'default' },
}
const intents = [
  {
    ...base,
    id: 'lookup',
    label: 'Exact lookup',
    answer: { surfaces: ['search'], strategy: 'none', promptVariant: 'default' },
    rules: ['^\\s*\\S+(?:\\s+\\S+)?\\s*$'],
    requireEntity: true,
    rulesOnly: true,
  },
  {
    ...base,
    id: 'data',
    label: 'Supplementary data',
    rules: ['supplement|data sheet|sample size'],
  },
  {
    ...base,
    id: 'latest',
    label: 'Latest evidence',
    rules: ['\\b(latest|newest|recent|(?:in|from) 202[5-9])\\b'],
  },
  {
    ...base,
    id: 'clinical',
    label: 'Clinical decision',
    rules: ['\\b(dose|dosing|avoid|contraindicat|which asm)'],
    requireEntity: true,
    requireLexiconEntity: true,
  },
  { ...base, id: 'review', label: 'Evidence review', rules: ['\\b(compare|what is known)\\b'] },
  {
    ...base,
    id: 'general',
    label: 'General',
    rules: [RESULTS_QUESTION_RULE],
    ruleRationale: 'a results question, answered from the papers themselves',
  },
].map((i) => IntentSchema.parse(i))
const ctx = {
  intents,
  defaultIntent: 'general',
  lexicon: ['fenfluramine', 'lamotrigine', 'stiripentol', 'Dravet', 'rituximab'],
}

describe('looksLikeGeneSymbol', () => {
  it('accepts human and rodent symbols and rejects acronyms, statistics and strains', () => {
    for (const ok of ['SCN1A', 'KCNQ2', 'DEPDC5', 'SLC2A1', 'STXBP1', 'PTEN', 'Scn1a', 'Kcnt1']) {
      expect(looksLikeGeneSymbol(ok)).toBe(true)
    }
    for (const no of ['EEG', 'AUC', 'URL', 'MRI', 'C57BL', 'fMRI', 'Okafor', 'PMC123', 'H1']) {
      expect(looksLikeGeneSymbol(no)).toBe(false)
    }
  })
})

describe('extractEntities', () => {
  it('finds gene symbols and lexicon drugs, once each, and skips acronyms that are not entities', () => {
    expect(extractEntities('SCN1A and scn1a with fenfluramine and EEG and PMC123', ctx.lexicon))
      .toEqual(['SCN1A', 'fenfluramine'])
  })
  it('reports no entity for a 26-word question full of acronyms (AUC, URL)', () => {
    expect(extractEntities('What AUC did the URL report for the EEG-fMRI model?', ctx.lexicon))
      .toEqual([])
  })
  it('separates lexicon hits from gene shapes', () => {
    expect(lexiconEntities('SCN1A Dravet fenfluramine', ctx.lexicon)).toEqual([
      'fenfluramine',
      'Dravet',
    ])
  })
})

describe('parseIdentifier', () => {
  it('recognises DOIs with and without a prefix, PMC ids and PubMed ids', () => {
    expect(parseIdentifier('10.1111/epi.70015')).toEqual({
      kind: 'doi',
      value: '10.1111/epi.70015',
    })
    expect(parseIdentifier('https://doi.org/10.1016/j.ebiom.2021.103619.')).toEqual({
      kind: 'doi',
      value: '10.1016/j.ebiom.2021.103619',
    })
    expect(parseIdentifier('doi: 10.1111/epi.17440')).toEqual({
      kind: 'doi',
      value: '10.1111/epi.17440',
    })
    expect(parseIdentifier('pmc8517288')).toEqual({ kind: 'pmcid', value: 'PMC8517288' })
    expect(parseIdentifier('PMID: 34567890')).toEqual({ kind: 'pmid', value: '34567890' })
    expect(parseIdentifier('34567890')).toEqual({ kind: 'pmid', value: '34567890' })
  })
  it('is not fooled by ordinary questions, years or short numbers', () => {
    expect(parseIdentifier('Seery 2025 rituximab')).toBeNull()
    expect(parseIdentifier('2025')).toBeNull()
    expect(parseIdentifier('10 mg dose')).toBeNull()
    expect(parseIdentifier('SCN8A')).toBeNull()
  })
})

describe('routeByRules', () => {
  it('routes a gene symbol or a lexicon term to lookup', () => {
    expect(routeByRules('SCN8A', ctx)?.intent).toBe('lookup')
    expect(routeByRules('fenfluramine', ctx)?.intent).toBe('lookup')
    expect(routeByRules('Dravet syndrome', ctx)?.configuration).toBe('portal-intent-lookup')
  })
  it('routes an identifier to lookup before any rule, naming the identifier', () => {
    const d = routeByRules('PMC8371239', ctx)
    expect(d?.intent).toBe('lookup')
    expect(d?.rule).toBe('identifier:pmcid')
    expect(d?.entities).toEqual(['PMC8371239'])
    expect(routeByRules('10.1111/epi.70015', ctx)?.rule).toBe('identifier:doi')
  })
  it('treats two clinical entities as a question, not a lookup of the first (D5-17)', () => {
    const lex = { ...ctx, lexicon: [...(ctx.lexicon ?? []), 'lamotrigine', 'SUDEP'] }
    expect(routeByRules('lamotrigine SUDEP', lex)?.intent).not.toBe('lookup')
    expect(routeByRules('lamotrigine', lex)?.intent).toBe('lookup')
    expect(routeByRules('SCN8A epilepsy', lex)?.intent).toBe('lookup')
  })

  it('never treats two arbitrary words or a hyphenated compound as a lookup', () => {
    expect(routeByRules('Okafor recurrence', ctx)).toBeNull()
    expect(routeByRules('EEG-fMRI', ctx)).toBeNull()
    expect(routeByRules('zxqv-nonexistent-term-9931', ctx)).toBeNull()
  })
  it('routes a dosing question with a drug to clinical, and without a medication falls through', () => {
    const askCtx = { ...ctx, surface: 'ask' as const }
    const d = routeByRules('Fenfluramine dose with stiripentol?', askCtx)
    expect(d?.intent).toBe('clinical')
    expect(d?.entities).toEqual(['fenfluramine', 'stiripentol'])
    expect(routeByRules('what dose should I use', askCtx)).toBeNull()
    // A gene symbol or a strain is not a medication: preclinical dosing stays general.
    expect(routeByRules('What selenate dose was given to SCN1A mice?', askCtx)).toBeNull()
    expect(routeByRules('C57BL/6J stereotaxic kainate dose', askCtx)).toBeNull()
  })
  it('settles an author-year citation itself: default on ask, lookup on search', () => {
    const askCtx = { ...ctx, surface: 'ask' as const }
    const onAsk = routeByRules('Seery 2025 rituximab', askCtx)
    expect(onAsk?.intent).toBe('general')
    expect(onAsk?.rule).toBe('author-year')
    expect(routeByRules('Seery 2025 rituximab', { ...ctx, surface: 'search' })?.intent).toBe(
      'lookup',
    )
    expect(routeByRules('Any papers from 2026 on rituximab?', askCtx)?.intent).toBe('latest')
    expect(parseAuthorYear('SCN1A 2020 review')).toBeNull()
  })
  it('returns null when nothing fires and marks the default configuration name', () => {
    expect(routeByRules('How does the ketogenic diet work?', ctx)).toBeNull()
  })
  it("routes a named person's papers to the review intent by rule (D3-11)", () => {
    const askCtx = { ...ctx, surface: 'ask' as const }
    const d = routeByRules(
      "Which of O'Neill's papers report on sub-scalp EEG, and what did each find?",
      askCtx,
    )
    expect(d?.rule).toBe('author-papers')
    expect(d?.intent).toBe('review')
    expect(routeByRules('List the papers by Broadley on encephalitis', askCtx)?.rule).toBe(
      'author-papers',
    )
    expect(routeByRules('What did Kwan et al. report on drug resistance?', askCtx)?.rule).toBe(
      'author-papers',
    )
    expect(routeByRules('Which papers report on sub-scalp EEG?', askCtx)?.rule).not.toBe(
      'author-papers',
    )
  })
})

describe('fillPrequeries', () => {
  it('substitutes entities, falling back to the question', () => {
    expect(fillPrequeries(['safety monitoring for {entities}'], 'q', ['fenfluramine']))
      .toEqual(['safety monitoring for fenfluramine'])
    expect(fillPrequeries(['{query} published 2026'], 'CBD in focal epilepsy', []))
      .toEqual(['CBD in focal epilepsy published 2026'])
  })
})

describe('decideFromClassifier', () => {
  it('never lets the classifier pick a rules-only intent', () => {
    expect(classifierIntents(ctx).map((i) => i.id)).not.toContain('lookup')
    expect(decideFromClassifier({ intent: 'lookup', confidence: 0.9 }, ctx).intent).toBe('general')
  })
  it('accepts a known intent above the threshold and rejects the rest', () => {
    expect(decideFromClassifier({ intent: 'review', confidence: 0.8, rationale: 'r' }, ctx).stage)
      .toBe('classifier')
    expect(decideFromClassifier({ intent: 'review', confidence: 0.4 }, ctx).intent).toBe('general')
    expect(decideFromClassifier({ intent: 'nope', confidence: 0.9 }, ctx).stage).toBe('default')
    expect(decideFromClassifier({ intent: 'general', confidence: 0.9 }, ctx).configuration).toBe(
      'portal-ask',
    )
  })
})

describe('results questions', () => {
  it('reads a figure question on the default configuration by rule, with its own rationale', () => {
    const decision = routeByRules(
      'What seizure freedom and retention rates did the PERMIT pooled analysis report?',
      ctx,
    )
    expect(decision?.intent).toBe('general')
    expect(decision?.stage).toBe('rule')
    expect(decision?.rationale).toBe(
      'General: a results question, answered from the papers themselves',
    )
    expect(isResultsQuestion('How many participants were implanted in UMPIRE?')).toBe(true)
    expect(isResultsQuestion('How does the ketogenic diet work?')).toBe(false)
  })
  it('lets a narrower intent win first: a supplement word still routes to data', () => {
    expect(routeByRules('sample size in the supplement of PERMIT', ctx)?.intent).toBe('data')
    expect(routeByRules('compare retention rates across studies', ctx)?.intent).toBe('review')
  })
})

describe('classifier gate', () => {
  const gated = {
    ...ctx,
    intents: ctx.intents.map((i) =>
      i.id === 'data'
        ? { ...i, classifierGate: ['\\b(tables?|supplement\\w*|peer[- ]review\\w*)\\b'] }
        : i
    ),
  }
  it('offers a gated intent to the classifier only when the question matches the gate', () => {
    expect(classifierIntents(gated, 'How many were implanted in UMPIRE?').map((i) => i.id))
      .toEqual(['latest', 'clinical', 'review', 'general'])
    expect(classifierIntents(gated, 'Which table lists the variants?').map((i) => i.id))
      .toContain('data')
    // Without a question, a gated intent is left out, never guessed.
    expect(classifierIntents(gated).map((i) => i.id)).not.toContain('data')
  })
  it('turns a classifier answer naming a gated intent into the default when the gate fails', () => {
    const decision = decideFromClassifier(
      { intent: 'data', confidence: 0.9, rationale: 'numbers' },
      gated,
      [],
      undefined,
      'How many were implanted in UMPIRE?',
    )
    expect(decision.intent).toBe('general')
    expect(decision.stage).toBe('default')
    const allowed = decideFromClassifier(
      { intent: 'data', confidence: 0.9, rationale: 'a table' },
      gated,
      [],
      undefined,
      'Which supplementary table lists the variants?',
    )
    expect(allowed.intent).toBe('data')
    expect(allowed.stage).toBe('classifier')
  })
})

describe('terse clinic questions (D4-08)', () => {
  const lexicon = ['lamotrigine', 'rituximab', 'brivaracetam', 'LGI1']
  it('counts words without their punctuation', () => {
    expect(wordCount('lamotrigine SUDEP risk - adjusted HR?')).toBe(5)
    expect(wordCount('rituximab anti-NMDAR relapse - HR and dose schedule')).toBe(7)
  })
  it('recognises a short question with an entity and an outcome word', () => {
    expect(isTerseResultsQuestion('lamotrigine SUDEP risk - adjusted HR?', lexicon)).toBe(true)
    expect(isTerseResultsQuestion('rituximab anti-NMDAR relapse - HR and dose schedule', lexicon))
      .toBe(true)
    expect(isTerseResultsQuestion('brivaracetam 12 month retention EXPERIENCE - number?', lexicon))
      .toBe(true)
    // No entity, or no outcome word, or too long: not terse.
    expect(isTerseResultsQuestion('short sleep next day seizure risk - how much', lexicon)).toBe(
      false,
    )
    expect(isTerseResultsQuestion('lamotrigine mechanism of action', lexicon)).toBe(false)
    expect(
      isTerseResultsQuestion(
        'What is the adjusted hazard ratio for SUDEP with lamotrigine at EMU admission in the case-control study?',
        lexicon,
      ),
    ).toBe(false)
  })
  it('routes a terse question to the default configuration by rule, ahead of the classifier', () => {
    const decision = routeByRules('lamotrigine SUDEP risk - adjusted HR?', {
      ...ctx,
      lexicon,
    })
    expect(decision).toMatchObject({ intent: 'general', stage: 'rule', rule: 'terse-results' })
    expect(decision?.rationale).toContain('short results question')
  })
  it('decomposes only a long question with a question word', () => {
    expect(decomposable('lamotrigine SUDEP risk - adjusted HR?')).toBe(false)
    expect(decomposable('brivaracetam perampanel lacosamide retention comparison table now')).toBe(
      false,
    )
    expect(
      decomposable(
        'What is the evidence that timing antiseizure medication to seizure cycles improves efficacy?',
      ),
    ).toBe(true)
  })
})
