import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { prepareSource } from './answer-audit.ts'
import { auditBriefing, checkStatement } from './briefing-audit.ts'

const EXPERIENCE =
  'Effectiveness and tolerability of 12-month brivaracetam (BRV) in the real world: EXPERIENCE.\n\n' +
  'Results\n\nAt 3, 6, and 12 months, respectively, ≥ 50% seizure reduction was achieved by 32.1%, ' +
  '36.7%, and 36.9% of patients (mFAS; Fig. 1a); seizure freedom was 22.4%, 17.9%, and 14.9% ' +
  '(FAS; n = 1111). BRV retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 months (FAS). ' +
  'During the whole study follow-up, 551/1639 (33.6%) patients discontinued BRV. ' +
  'In the subgroup with psychiatric comorbidity, ≥ 50% seizure reduction was achieved by 31.4%, ' +
  '36.8%, and 38.1% (mFAS; Fig. S4a).'
const PERMIT =
  'PERMIT study: a global pooled analysis of perampanel in routine clinical practice.\n\nResults\n\n' +
  'Retention on PER treatment at 12 months was 64.2% (2698/4201). The 50% responder rate was ' +
  '58.3% at 12 months and the seizure freedom rate was 23.2% (n = 4392). At 12 months, 14.3% ' +
  '(600/4201) had discontinued due to AEs.'

const sources = {
  exp: {
    resourceId: 'exp',
    title: 'Effectiveness and tolerability of 12-month brivaracetam: EXPERIENCE',
  },
  per: { resourceId: 'per', title: 'PERMIT study: a global pooled analysis of perampanel' },
}

describe('briefing statements (D3-03)', () => {
  const text = prepareSource(EXPERIENCE)

  it('accepts a figure at its own outcome for the population the statement names', () => {
    expect(checkStatement({
      figure: '36.9%',
      outcome: '50% responder rate at 12 months',
      population: 'mFAS, all patients',
      study: 'EXPERIENCE',
    }, text)).toEqual({ ok: true })
  })

  it('fails a subgroup figure stated for the whole cohort', () => {
    expect(checkStatement({
      figure: '38.1%',
      outcome: '50% responder rate at 12 months',
      population: 'all patients',
      study: 'EXPERIENCE',
    }, text)).toEqual({ ok: false, reason: 'population' })
  })

  it('fails an all-cause discontinuation given as discontinuation for adverse events', () => {
    expect(checkStatement({
      figure: '33.6%',
      outcome: 'discontinuation due to adverse events',
      population: 'all patients',
      study: 'EXPERIENCE',
    }, text)).toEqual({ ok: false, reason: 'outcome' })
    expect(checkStatement({
      figure: '14.3%',
      outcome: 'discontinuation due to adverse events at 12 months',
      population: 'retention population',
      study: 'PERMIT',
    }, prepareSource(PERMIT))).toEqual({ ok: true })
  })
})

describe('auditBriefing', () => {
  const texts = new Map([['exp', EXPERIENCE], ['per', PERMIT]])
  const generated = new Map<string, string>()
  const lexicon = ['brivaracetam', 'perampanel']

  it('keeps sentences whose figures the section sources carry and removes the rest, counting both', () => {
    const result = auditBriefing({
      sections: [{
        heading: 'Brivaracetam',
        content: 'Brivaracetam retention at 12 months was 71.1% in EXPERIENCE. ' +
          'Seizure freedom at 12 months was 14.9% (n = 1111). ' +
          'Brivaracetam retention at 12 months was 79.3% in EXPERIENCE.',
        sources: [sources.exp],
        refs: [1],
        statements: [],
      }, {
        heading: 'Perampanel',
        content: 'Perampanel retention at 12 months was 64.2% (2698/4201) in PERMIT.',
        sources: [sources.per],
        refs: [2],
        statements: [],
      }],
      key_takeaways: [
        'Brivaracetam retention was 71.1% (EXPERIENCE).',
        'Perampanel retention was 60.2% (PERMIT).',
      ],
      takeaway_refs: [[1], [2]],
    }, { texts, generated, lexicon, query: 'brivaracetam versus perampanel retention' })
    expect(result.sections[0]!.content).toBe(
      'Brivaracetam retention at 12 months was 71.1% in EXPERIENCE. Seizure freedom at 12 months was 14.9% (n = 1111).',
    )
    expect(result.sections[1]!.content).toContain('64.2%')
    expect(result.key_takeaways).toEqual(['Brivaracetam retention was 71.1% (EXPERIENCE).'])
    expect(result.takeaway_refs).toEqual([[1]])
    expect(result.audit.sentencesRemoved).toBe(1)
    expect(result.audit.takeawaysRemoved).toBe(1)
    expect(result.audit.figuresRemoved).toEqual(['79.3%', '60.2%'])
    expect(result.audit.figuresChecked).toBeGreaterThan(5)
  })

  it('removes the sentence a failed statement belongs to even when the figure is in the text', () => {
    const result = auditBriefing({
      sections: [{
        heading: 'Brivaracetam',
        content: 'In EXPERIENCE, 38.1% of patients achieved a 50% reduction at 12 months. ' +
          'Retention at 12 months was 71.1%.',
        sources: [sources.exp],
        refs: [1],
        statements: [{
          figure: '38.1%',
          outcome: '50% responder rate at 12 months',
          population: 'all patients',
          study: 'Effectiveness and tolerability of 12-month brivaracetam: EXPERIENCE',
        }],
      }],
      key_takeaways: ['Brivaracetam achieved a 38.1% responder rate (EXPERIENCE).'],
      takeaway_refs: [[1]],
    }, { texts, generated, lexicon, query: 'brivaracetam responder rate' })
    expect(result.sections[0]!.content).toBe('Retention at 12 months was 71.1%.')
    // The takeaway that repeats the failed figure goes with the sentence.
    expect(result.key_takeaways).toEqual([])
    expect(result.audit.takeawaysRemoved).toBe(1)
    expect(result.audit.statementsFailed).toEqual([{ figure: '38.1%', reason: 'population' }])
    expect(result.audit.figuresRemoved).toContain('38.1%')
  })
})
