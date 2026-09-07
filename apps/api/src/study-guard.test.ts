import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary } from '@research-portal/core'
import {
  distinctiveTerms,
  isAttachmentTitle,
  matchStudies,
  quotedTitles,
  studyAcronyms,
} from './study-guard.ts'

const resource = (id: string, title: string, year = '2024'): ResourceSummary => ({
  id,
  title,
  type: 'pdf',
  summary: '',
  keyFacts: [],
  topicIds: [],
  year,
})

const catalogue: ResourceSummary[] = [
  resource(
    'breaths',
    'Breathing control training as a treatment for functional seizures (BREATHS trial): a multicentre, assessor-blinded randomised controlled trial protocol',
    '2025',
  ),
  resource(
    'breaths-pr',
    'Peer review history (2): Breathing control training as a treatment for functional seizures (BREATHS trial)',
    '2025',
  ),
  resource(
    'breaths-supp',
    'Supplementary material 1: Breathing control training as a treatment for functional seizures (BREATHS trial)',
    '2025',
  ),
  resource(
    'umpire',
    'The UMPIRE study: A first-in-human multicenter trial of bilateral subscalp monitoring for epileptic seizure detection',
  ),
  resource('permit', 'PERMIT study: a global pooled analysis study of perampanel', '2022'),
  resource(
    'exp',
    'Effectiveness of brivaracetam: EXPERIENCE, an international pooled analysis',
    '2023',
  ),
  resource('exp-user', 'User experience of a seizure risk forecasting app'),
  resource('resilience-neural', 'Loss of neuronal network resilience precedes seizures', '2018'),
  resource(
    'resilience',
    'RESILIENCE (Retrospective Linkage Study of Autoimmune Encephalitis): protocol',
  ),
  ...['a', 'b', 'c', 'd'].map((n) => resource(`ilae-${n}`, `ILAE classification paper ${n}`)),
  ...['a', 'b', 'c', 'd', 'e'].map((n) => resource(`sudep-${n}`, `SUDEP risk paper ${n}`)),
  resource('scn1a', 'SCN1A variants in Dravet syndrome'),
  resource(
    'lgs',
    'Applying the ILAE diagnostic criteria for Lennox-Gastaut syndrome in the real-world setting',
  ),
  resource('lgs-supp', 'Supplementary material 1: ILAE criteria for Lennox-Gastaut syndrome'),
  resource(
    'lgs-fen-a',
    'Efficacy and Safety of Fenfluramine for Seizures Associated With Lennox-Gastaut Syndrome',
  ),
  resource(
    'lgs-fen-b',
    'Fenfluramine reduces drop seizures in patients with Lennox-Gastaut syndrome',
  ),
  resource(
    'lgs-fen-c',
    'Practical considerations for fenfluramine in Dravet or Lennox-Gastaut syndrome',
  ),
  resource('lgs-fen-d', 'Transitioning from fenfluramine in Lennox-Gastaut syndrome'),
  resource(
    'ltg',
    'Risk of SUDEP with lamotrigine and other sodium channel-modulating ASMs',
    '2023',
  ),
  ...['a', 'b', 'c', 'd'].map((n) => resource(`lev-${n}`, `Levetiracetam in pregnancy ${n}`)),
]

const LEXICON = ['lamotrigine', 'levetiracetam', 'Lennox-Gastaut', 'Dravet']

describe('studyAcronyms', () => {
  it('keeps upper-case tokens that could name a study and drops generic acronyms, genes and ids', () => {
    // ILAE is a generic acronym, SCN1A a gene, PMC123 an identifier, EEG too short.
    expect(studyAcronyms('In the UMPIRE sub-scalp trial, how many EEG channels? SCN1A PMC123 ILAE'))
      .toEqual(['UMPIRE'])
    expect(studyAcronyms('What did the BREATHS trial protocol say about SUDEP?')).toEqual([
      'BREATHS',
    ])
    expect(studyAcronyms('a lower-case question about seizures')).toEqual([])
  })
})

describe('quotedTitles', () => {
  it('takes straight and curly quoted fragments long enough to be a title', () => {
    expect(
      quotedTitles('Summarise "Multiday cycles of heart rate" and “Six common misconceptions”'),
    )
      .toEqual(['Multiday cycles of heart rate', 'Six common misconceptions'])
    expect(quotedTitles('the "n" of the "small" study')).toEqual([])
  })
})

describe('isAttachmentTitle', () => {
  it('recognises supplements, peer review files and media', () => {
    expect(isAttachmentTitle('Supplementary material 1: tables')).toBe(true)
    expect(isAttachmentTitle('Peer review history (2): the trial')).toBe(true)
    expect(isAttachmentTitle('The UMPIRE study')).toBe(false)
  })
})

describe('matchStudies', () => {
  it('pins the article a study acronym names, not its supplements', () => {
    const matches = matchStudies(
      'What is the primary outcome, sample size and control arm in the BREATHS trial protocol?',
      catalogue,
    )
    expect(matches.map((m) => m.id)).toEqual(['breaths'])
    expect(matches[0]).toMatchObject({ term: 'BREATHS', kind: 'acronym' })
  })

  it('matches the acronym as a whole upper-case word, so EXPERIENCE is the pooled analysis alone', () => {
    expect(matchStudies('12-month retention in EXPERIENCE and PERMIT', catalogue).map((m) => m.id))
      .toEqual(['exp', 'permit'])
    expect(matchStudies('the RESILIENCE protocol', catalogue).map((m) => m.id)).toEqual([
      'resilience',
    ])
  })

  it('treats a name that titles many papers as a topic and a gene as a gene', () => {
    expect(matchStudies('ILAE classification of SUDEP in SCN1A', catalogue)).toEqual([])
  })

  it('pins the article an eponym or a lexicon term titles, never a term that titles many', () => {
    // Five Lennox-Gastaut papers: the question's other words single out the criteria paper.
    const lgs = matchStudies(
      'What are the ILAE diagnostic criteria for Lennox-Gastaut syndrome in the real-world setting, and what proportion met them?',
      catalogue,
      LEXICON,
    )
    expect(lgs.map((m) => m.id)).toEqual(['lgs'])
    expect(lgs[0]).toMatchObject({ term: 'Lennox-Gastaut', kind: 'term' })
    // A question about the topic pins nothing.
    expect(matchStudies('Which drugs help in Lennox-Gastaut syndrome?', catalogue, LEXICON))
      .toEqual([])
    expect(
      matchStudies('Does lamotrigine increase SUDEP risk?', catalogue, LEXICON).map((m) => m.id),
    )
      .toEqual(['ltg'])
    // Four levetiracetam papers make the drug a topic, not a study.
    expect(matchStudies('levetiracetam in pregnancy', catalogue, LEXICON).map((m) => m.id))
      .toEqual([])
  })

  it('keeps acronym pins ahead of term pins', () => {
    expect(
      matchStudies('In EXPERIENCE, did lamotrigine co-medication matter?', catalogue, LEXICON).map(
        (m) => m.id,
      ),
    ).toEqual(['exp', 'ltg'])
  })

  it('pins the resources a quoted title fragment names, article before attachment, capped', () => {
    const matches = matchStudies(
      'What does "Breathing control training as a treatment for functional seizures" conclude?',
      catalogue,
    )
    expect(matches.map((m) => m.id)).toEqual(['breaths', 'breaths-pr', 'breaths-supp'])
    expect(matches[0]?.kind).toBe('title')
  })

  it('never pins the same resource twice and caps the set', () => {
    const matches = matchStudies(
      'BREATHS "Breathing control training" UMPIRE PERMIT EXPERIENCE',
      catalogue,
    )
    expect(matches.length).toBe(3)
    expect(new Set(matches.map((m) => m.id)).size).toBe(3)
  })
})

describe('distinctiveTerms', () => {
  it('finds capitalised eponyms and whole-word lexicon terms, not generic acronyms', () => {
    expect(distinctiveTerms('ILAE criteria for Lennox-Gastaut syndrome on lamotrigine', LEXICON))
      .toEqual(['Lennox-Gastaut', 'lamotrigine'])
    expect(distinctiveTerms('EEG-fMRI and anti-NMDAR', LEXICON)).toEqual([])
    expect(distinctiveTerms('lamotrigines are not lamotrigine', LEXICON)).toEqual(['lamotrigine'])
  })
})
