import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ScoredResource } from '@research-portal/core'
import {
  comparisonEntities,
  entityQuery,
  isConferenceTitle,
  pickEntityPaper,
  pinnedAddendum,
  questionClauses,
  rankClosest,
} from './ask-entities.ts'

const LEXICON = ['perampanel', 'brivaracetam', 'levetiracetam', 'lamotrigine', 'Lennox-Gastaut']

const scored = (id: string, title: string, passage?: string): ScoredResource => ({
  id,
  title,
  type: 'pdf',
  summary: '',
  keyFacts: [],
  topicIds: [],
  relevance: 0.9,
  citedCount: 0,
  ...(passage ? { matchedPassage: passage } : {}),
})

describe('questionClauses', () => {
  it('splits a two-part question at ", and what"', () => {
    expect(
      questionClauses(
        'What are the ILAE diagnostic criteria for Lennox-Gastaut syndrome, and what proportion of the real-world Australian cohort met all of them?',
      ),
    ).toEqual([
      'What are the ILAE diagnostic criteria for Lennox-Gastaut syndrome',
      'what proportion of the real-world Australian cohort met all of them',
    ])
  })
  it('splits at "and how many" and drops short fragments', () => {
    expect(
      questionClauses(
        'In the EXPERIENCE analysis, what was the seizure freedom rate for brivaracetam, and how many patients were in each group?',
      ),
    ).toEqual([
      'In the EXPERIENCE analysis, what was the seizure freedom rate for brivaracetam',
      'how many patients were in each group',
    ])
  })
  it('yields nothing for a single-clause question', () => {
    expect(questionClauses('What was the retention rate for perampanel at 12 months?')).toEqual([])
  })
})

describe('comparisonEntities', () => {
  it('finds the drugs and study acronyms a question names, in order', () => {
    expect(
      comparisonEntities(
        'What 12-month retention should I assume for adjunctive perampanel versus brivaracetam?',
        LEXICON,
      ),
    ).toEqual(['perampanel', 'brivaracetam'])
    expect(comparisonEntities('Compare PERMIT with the EXPERIENCE analysis', LEXICON)).toEqual([
      'PERMIT',
      'EXPERIENCE',
    ])
  })
  it('does not treat a syndrome or a generic acronym as an entity', () => {
    expect(comparisonEntities('ILAE criteria for Lennox-Gastaut syndrome', LEXICON)).toEqual([])
  })
})

describe('entityQuery', () => {
  it('removes the other entities and leads with the entity', () => {
    expect(
      entityQuery(
        'what 12-month retention rate should I assume for adjunctive perampanel versus brivaracetam in real-world cohorts',
        'perampanel',
        ['perampanel', 'brivaracetam'],
      ),
    ).toBe(
      'perampanel: what 12-month retention rate should I assume for adjunctive perampanel in real-world cohorts',
    )
  })
})

describe('pickEntityPaper', () => {
  const results = [
    scored('supp', 'Supplementary material 1: PERMIT study', 'perampanel retention'),
    scored('brv', 'EXPERIENCE: brivaracetam pooled analysis', 'compared with perampanel'),
    scored('per', 'PERMIT study: perampanel in routine practice', 'retention on PER'),
  ]
  it('prefers an article whose title names the entity over a passage mention or an attachment', () => {
    expect(pickEntityPaper(results, 'perampanel')?.id).toBe('per')
  })
  it('falls back to a passage mention and returns nothing when neither matches', () => {
    expect(pickEntityPaper(results.slice(0, 2), 'perampanel')?.id).toBe('brv')
    expect(pickEntityPaper(results, 'cenobamate')).toBeUndefined()
  })
})

describe('isConferenceTitle', () => {
  it('recognises meeting and proceedings collections and leaves papers alone', () => {
    expect(isConferenceTitle('7th Drug hypersensitivity meeting: part two')).toBe(true)
    expect(isConferenceTitle('25th Annual Computational Neuroscience Meeting: CNS-2016')).toBe(true)
    expect(isConferenceTitle('Ten-year projection of adult epilepsy burden in Australia')).toBe(
      false,
    )
  })
})

describe('pinnedAddendum', () => {
  it('names the pinned papers and asks for a partial answer over a decline', () => {
    const text = pinnedAddendum(['PERMIT study'])
    expect(text).toContain('"PERMIT study"')
    expect(text).toContain('name the figure or table')
    expect(text).not.toContain(' - ')
  })
})

describe('rankClosest', () => {
  const r = (id: string, title: string, relevance: number, kind?: string, summary?: string) => ({
    id,
    title,
    relevance,
    ...(kind ? { kind } : {}),
    ...(summary ? { summary } : {}),
  })
  it('moves on-topic papers up and drops a preclinical paper for a question about people', () => {
    const ranked = rankClosest(
      [
        r('rat', 'Epilepsy phenotype after traumatic brain injury in rats', 0.95, 'preclinical'),
        r('ptr', 'Management of post-traumatic epilepsy: an evidence review', 0.79),
        r(
          'proj',
          'Ten-year projection of adult epilepsy burden in Australia',
          0.73,
          'cohort-study',
          'Incidence and prevalence of epilepsy in Australians to 2033.',
        ),
      ],
      'What is the incidence of epilepsy in Aboriginal and Torres Strait Islander Australians?',
    )
    expect(ranked.map((x) => x.id)).toEqual(['proj', 'ptr'])
  })
  it('ranks by overlap with the question before the semantic score (D3-19)', () => {
    const ranked = rankClosest(
      [
        r(
          'ptr',
          'Management of post-traumatic epilepsy: An evidence review over the last 5 years',
          0.79,
          'narrative-review',
          'This review synthesises evidence on managing post-traumatic epilepsy (PTE) after traumatic brain injury.',
        ),
        r(
          'seeg',
          'Stereoelectroencephalography for Epilepsy Presurgical Assessment: A Nationwide Survey',
          0.76,
          'survey',
          'A survey of SEEG use in Australian adult epilepsy centres, with disparities in Indigenous access.',
        ),
        r(
          'proj',
          'Ten-year projection of adult epilepsy burden in Australia',
          0.73,
          'cohort-study',
          'Projects the burden of epilepsy in Australian adults from 2024 to 2033.',
        ),
      ],
      'What is the incidence of epilepsy in Aboriginal and Torres Strait Islander Australians?',
    )
    expect(ranked.map((x) => x.id)).toEqual(['proj', 'seeg', 'ptr'])
  })
  it('keeps a preclinical paper for a question about a model', () => {
    const ranked = rankClosest(
      [r('rat', 'Epilepsy phenotype after traumatic brain injury in rats', 0.95, 'preclinical')],
      'Which rat model of post-traumatic epilepsy is reproducible?',
    )
    expect(ranked.map((x) => x.id)).toEqual(['rat'])
  })
  it('weights the outcome noun above a place name: a projection with incidence outranks a survey in Australia (D4-23)', () => {
    const ranked = rankClosest(
      [
        r(
          'seeg',
          'Stereoelectroencephalography for Epilepsy Presurgical Assessment: A Nationwide Survey of Evolution of Practice in Australia',
          0.76,
          'survey',
          'A survey of SEEG practice across Australian centres.',
        ),
        r(
          'proj',
          'Ten-year projection of adult epilepsy burden in Australia',
          0.73,
          'cohort-study',
          'Incidence and prevalence of epilepsy in Australian adults projected to 2033.',
        ),
        r(
          'adh',
          "Facilitators and barriers of antiseizure medication adherence from Australian healthcare providers' perspectives: A qualitative study",
          0.56,
          'qualitative-study',
        ),
      ],
      'What is the incidence of epilepsy in Aboriginal and Torres Strait Islander Australians?',
    )
    expect(ranked.map((x) => x.id)).toEqual(['proj', 'seeg', 'adh'])
  })
  it('ranks a review sharing the outcome word below the cohort paper, and reads burden as epidemiology', () => {
    const ranked = rankClosest(
      [
        r(
          'pte',
          'Management of post-traumatic epilepsy: An evidence review over the last 5 years',
          0.79,
          'narrative-review',
          'This review synthesises evidence on the incidence and management of post-traumatic epilepsy.',
        ),
        r(
          'proj',
          'Ten-year projection of adult epilepsy burden in Australia',
          0.73,
          'cohort-study',
          'Projects the burden of epilepsy in Australian adults from 2024 to 2033 using life tables.',
        ),
        r(
          'tas',
          'Epidemiology and etiology of infantile developmental and epileptic encephalopathies in Tasmania',
          0.14,
          undefined,
          'Incidence of 0.44 per 1000 live births.',
        ),
      ],
      'What is the incidence of epilepsy in Aboriginal and Torres Strait Islander Australians?',
    )
    expect(ranked.map((x) => x.id)).toEqual(['proj', 'tas', 'pte'])
  })
})
