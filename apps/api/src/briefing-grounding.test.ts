import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ScoredResource } from '@research-portal/core'
import {
  briefingEntities,
  briefingGrounding,
  groundingParagraphs,
  MAX_PARAGRAPHS_PER_SOURCE,
  sourceBlock,
} from './briefing-grounding.ts'

const LEXICON = ['rituximab', 'perampanel', 'brivaracetam', 'Lennox-Gastaut']

const PAPER = [
  'Rituximab Use for Relapse Prevention in Anti-NMDAR Encephalitis',
  '',
  'Abstract',
  '',
  'Results: A single course of rituximab was associated with longer time to first relapse (hazard ratio [HR] 0.11, 95% CI 0.02-0.70, p = 0.02) in 67 patients.',
  '',
  'Introduction',
  '',
  'Rituximab reduced the odds of relapse by 83% at more than 24 months from disease onset in a meta-analysis of earlier cohorts with relapse rates from 12% to 35%.',
  '',
  '3 | RESULTS',
  '',
  'Of 67 patients, 48 did not relapse and 19 relapsed over a median follow-up of 45 months; rituximab within 6 months gave HR 0.05 (95% CI 0.00-0.48).',
  '',
  '4 | DISCUSSION',
  '',
  'Our hazard ratio of 0.11 agrees with the 83% reduction reported by the meta-analysis of relapse prevention in earlier cohorts of patients treated with rituximab.',
  '',
  'References',
  '',
  '1. Someone. A meta-analysis of rituximab. J Neurol. 2020;1:1-10.',
].join('\n')

describe('groundingParagraphs', () => {
  it('keeps abstract and results paragraphs and drops the introduction and discussion', () => {
    const kept = groundingParagraphs(PAPER, 'rituximab relapse hazard ratios cohort sizes')
    expect(kept.map((p) => p.section)).toEqual(['abstract', 'results'])
    expect(kept.every((p) => !p.text.includes('83%'))).toBe(true)
    expect(kept.length).toBeLessThanOrEqual(MAX_PARAGRAPHS_PER_SOURCE)
  })
  it('keeps every prose paragraph of a text without body headings', () => {
    const kept = groundingParagraphs(
      'A cohort of 55 patients relapsed in 30% of cases over two years of follow-up in the study.\n\nNothing numeric or relevant here at all, just words about weather patterns.',
      'relapse cohort',
    )
    expect(kept.map((p) => p.section)).toEqual(['other'])
  })
})

describe('sourceBlock', () => {
  it('heads the block with the exact title, then takeaways, summary and labelled paragraphs', () => {
    const block = sourceBlock(
      { id: 'a', title: 'Rituximab Use', year: '2025', keyTakeaways: ['HR 0.11.'], summary: 'S.' },
      [{ text: 'Of 67 patients, 19 relapsed.', section: 'results', score: 3 }],
    )
    expect(block.split('\n')).toEqual([
      'Source: "Rituximab Use" (2025)',
      'Key takeaways: HR 0.11.',
      'Summary: S.',
      '[results] Of 67 patients, 19 relapsed.',
    ])
  })
})

describe('briefingEntities', () => {
  it('names the drugs, studies and eponyms a briefing request mentions', () => {
    expect(
      briefingEntities(
        'MDT briefing: relapse prevention - rituximab in anti-NMDAR encephalitis and the PERMIT analysis of perampanel; Lennox-Gastaut criteria',
        LEXICON,
      ),
    ).toEqual(['rituximab', 'perampanel', 'PERMIT', 'Lennox-Gastaut'])
  })
})

describe('briefingGrounding', () => {
  const scored = (id: string, title: string): ScoredResource => ({
    id,
    title,
    type: 'pdf',
    summary: '',
    keyFacts: [],
    topicIds: [],
    relevance: 0.9,
    citedCount: 0,
  })
  it('chooses the top paper per entity, then the topic search, and builds one block per paper', async () => {
    const searched: string[] = []
    const grounding = await briefingGrounding(
      'MDT briefing: rituximab in anti-NMDAR encephalitis versus perampanel retention',
      LEXICON,
      {
        search: (text) => {
          searched.push(text)
          if (text.startsWith('rituximab:')) {
            return Promise.resolve([scored('rtx', 'Rituximab Use for Relapse Prevention')])
          }
          if (text.startsWith('perampanel:')) {
            return Promise.resolve([
              scored('supp', 'Supplementary material 1: PERMIT'),
              scored('per', 'PERMIT study: perampanel in routine practice'),
            ])
          }
          return Promise.resolve([
            scored('rtx', 'Rituximab Use for Relapse Prevention'),
            scored('other', 'Language impairments in autoimmune encephalitis'),
          ])
        },
        extraction: (id) =>
          id === 'rtx' ? Promise.resolve(PAPER) : Promise.reject(new Error('no text')),
        record: (id) =>
          id === 'rtx'
            ? { id, title: 'Rituximab Use for Relapse Prevention', keyTakeaways: ['HR 0.11.'] }
            : undefined,
      },
    )
    expect(searched.length).toBe(3)
    expect(grounding.sources.map((s) => s.id)).toEqual(['rtx', 'per', 'other'])
    expect(grounding.context[0]).toContain('Source: "Rituximab Use for Relapse Prevention"')
    expect(grounding.context[0]).toContain('Key takeaways: HR 0.11.')
    expect(grounding.context[0]).toContain('[results]')
    expect(grounding.context[0]).not.toContain('83%')
    // A paper whose text cannot be fetched still contributes its heading.
    expect(grounding.context[1]).toBe('Source: "PERMIT study: perampanel in routine practice"')
  })
})
