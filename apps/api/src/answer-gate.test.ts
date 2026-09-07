import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { bindSentences, namedEntities } from './citation-binding.ts'
import { verifyFigures } from './answer-audit.ts'
import {
  asksForEffect,
  blankFailingCells,
  designLead,
  effectSizeNote,
  effectSizesFor,
  effectSubject,
  gateFigures,
  isCovariateList,
  isTableRow,
  nonClinicalDesign,
  removalNote,
  statesEffectSize,
} from './answer-gate.ts'

const LEXICON = ['lamotrigine', 'perampanel', 'brivaracetam', 'fenfluramine']

/** The LGI1 consortium paper and the multimodal prognostication paper, in miniature. */
const LGI1 =
  'Acute and long-term immune-treatment strategies in anti-LGI1 antibody-mediated encephalitis. ' +
  'Relapses occur in approximately 14%-35% of patients. A total of 16 (30%) patients ' +
  'experienced at least one relapse over a median follow-up of 45 months. ' +
  'First-line immunotherapy within 3 months was associated with mRS improvement at 12 months ' +
  '(OR 4.39; 95% CI 1.08-21.5, p = 0.047).'
const PROGNOSIS =
  'Multimodal prognostication of autoimmune encephalitis. At 12 months, a favourable mRS ' +
  '(<= 2) occurred in 154 (67%) patients. Notably, DRE occurred in 31% and contrasts with ' +
  'another study which demonstrated 18 of 23 patients had a favourable mRS at 24 months.'

function gate(text: string, query: string, texts: Record<number, string>) {
  const citations = Object.keys(texts).map((k) => ({
    index: Number(k),
    resourceId: `res-${k}`,
    title: `Paper ${k}`,
  }))
  const questionEntities = namedEntities(query, LEXICON)
  // The same sequence as bindAndAudit: bind keeping the provider's numbers,
  // check against every named text, gate with every citation as a candidate.
  const bound = bindSentences({
    text,
    citations,
    texts: new Map(Object.entries(texts).map(([k, v]) => [Number(k), v])),
    lexicon: LEXICON,
    questionEntities,
    keepNumbering: true,
  })
  const named = new Map(bound.named.map((n) => [n, texts[n]!]))
  const checks = verifyFigures(
    bound.sentences.map((s) => ({
      text: s.text,
      texts: s.bound.map((n) => named.get(n)).filter((t): t is string => t !== undefined),
    })),
    [...named.values()],
    LEXICON,
    questionEntities,
  )
  return { bound, gated: gateFigures(bound, checks, [...named.keys()], citations) }
}

describe('gateFigures', () => {
  it('removes a sentence whose figure the cited passage carries for a different outcome (D2-04)', () => {
    const query =
      'For a patient with anti-LGI1 antibody encephalitis, what proportion of patients relapsed?'
    const text = 'Relapses occur in approximately 14%-35% of patients with anti-LGI1 ' +
      'encephalitis.[1] In the specific cohort study mentioned, 31% of patients experienced a ' +
      'relapse.[2]'
    const { gated } = gate(text, query, { 1: LGI1, 2: PROGNOSIS })
    expect(gated.text).toBe(
      'Relapses occur in approximately 14%-35% of patients with anti-LGI1 encephalitis.[1]',
    )
    expect(gated.removed).toEqual([{
      text: 'In the specific cohort study mentioned, 31% of patients experienced a relapse.',
      figures: ['31%'],
      reason: 'terms',
    }])
    // The prognosis paper no longer carries any sentence, so it leaves the citations.
    expect(gated.citations.map((c) => c.resourceId)).toEqual(['res-1'])
    expect(removalNote(gated.removed)).toContain('One sentence was removed from this answer')
    expect(removalNote(gated.removed)).toContain('(31%)')
  })

  it('removes a figure attributed at the wrong time point and one absent from every text (D2-02)', () => {
    const query = 'What proportion of patients had a good functional outcome at 12 months?'
    const text = 'In one study, 80% of patients had a favourable mRS at 12 months, with 231 ' +
      'patients.[1] In a separate analysis, 30% had at least one relapse at 12 months.[2]'
    const { gated } = gate(text, query, { 1: PROGNOSIS, 2: LGI1 })
    expect(gated.text).toBe('')
    expect(gated.removed[0]!.figures).toContain('80%')
    expect(gated.removed[1]!.figures).toContain('30%')
    expect(gated.removed[1]!.reason).toBe('timepoint')
    expect(gated.citations).toEqual([])
    expect(removalNote(gated.removed)).toContain('2 sentences were removed')
    expect(removalNote(gated.removed)).toContain('different outcome or follow-up')
  })

  it('keeps a figure sentence with no marker when the binding can place it (D2-12)', () => {
    const query = 'Does early immunotherapy improve outcome in anti-LGI1 encephalitis?'
    const text = 'Early immunotherapy is associated with a better outcome.[1] ' +
      'Treatment within 3 months improved mRS at 12 months (OR 4.39; 95% CI 1.08-21.5).'
    const { gated } = gate(text, query, { 1: LGI1, 2: PROGNOSIS })
    expect(gated.removed).toEqual([])
    expect(gated.text).toContain('(OR 4.39; 95% CI 1.08-21.5).[1]')
  })

  it('lets a figure sentence the binding could not place inherit the one text that carries all its figures', () => {
    const PERMIT = 'PERMIT: perampanel retention at 12 months was 64.2% (2698/4201).'
    const query = 'What was the perampanel retention rate?'
    // Too little word overlap for the binding, but every figure sits beside
    // the drug in one text: the gate lends that text's marker.
    const text = 'Retention was reported.[1] Perampanel retention was 64.2% (2698/4201) at 12 ' +
      'months according to the pooled registry analysis across many European and Australian ' +
      'centres.'
    const { gated } = gate(text, query, { 1: PERMIT, 2: LGI1 })
    expect(gated.removed).toEqual([])
    expect(gated.inherited).toBe(1)
    expect(gated.text.endsWith('Australian centres.[1]')).toBe(true)
  })

  it('keeps a list item whose sentences pass and drops the item that fails', () => {
    const query = 'What did the consortium report?'
    const text = '1. At 12 months a favourable mRS occurred in 154 (67%) patients.[1]\n' +
      '2. In one study 80% had a favourable mRS at 12 months.[1]'
    const { gated } = gate(text, query, { 1: PROGNOSIS })
    expect(gated.text).toBe('1. At 12 months a favourable mRS occurred in 154 (67%) patients.[1]')
    expect(gated.removed.length).toBe(1)
  })

  it('renumbers the surviving citations by first appearance', () => {
    const bound = {
      text: 'Some 80% had a favourable mRS at 12 months.[1] Relapse occurred in 16 (30%).[2]',
      citations: [{ index: 1, resourceId: 'res-1', title: 'Paper 1' }, {
        index: 2,
        resourceId: 'res-2',
        title: 'Paper 2',
      }],
      sentences: [
        { text: 'Some 80% had a favourable mRS at 12 months.', bound: [1], line: 0 },
        { text: 'Relapse occurred in 16 (30%).', bound: [2], line: 0 },
      ],
      layout: [{ kind: 'sentences' as const, prefix: '', sentences: [0, 1] }],
      usable: [1, 2],
      named: [1, 2],
      dropped: 0,
      rebound: 0,
    }
    const check = (figure: string, sentence: string, supported: boolean) => ({
      figure,
      sentence,
      supported,
      supportedBy: supported ? [0] : [],
    })
    const gated = gateFigures(bound, [
      check('80%', bound.sentences[0]!.text, false),
      check('12months', bound.sentences[0]!.text, true),
      check('30%', bound.sentences[1]!.text, true),
    ], [1, 2])
    expect(gated.text).toBe('Relapse occurred in 16 (30%).[1]')
    expect(gated.citations.map((c) => [c.index, c.resourceId])).toEqual([[1, 'res-2']])
    expect(gated.renumber.get(2)).toBe(1)
    expect(gated.removed).toEqual([{
      text: 'Some 80% had a favourable mRS at 12 months.',
      figures: ['80%'],
      reason: 'absent',
    }])
  })
})

describe('effect sizes the answer left out (D2-09)', () => {
  const SUDEP = 'Risk of SUDEP with lamotrigine. After controlling for tonic-clonic seizure ' +
    'frequency, lamotrigine was not associated with SUDEP (adjusted hazard ratio [aHR] = 0.56; ' +
    '95% CI: 0.31-1.01, P = 0.054). The cohort held 101 cases and 199 controls.'

  it('recognises an effect question and an answer that already states a ratio', () => {
    expect(asksForEffect('Does lamotrigine increase the risk of SUDEP?')).toBe(true)
    expect(asksForEffect('What are the EEG features of JME?')).toBe(false)
    expect(
      asksForEffect(
        'What 12-month retention rate should I assume for perampanel versus brivaracetam?',
      ),
    )
      .toBe(false)
    expect(statesEffectSize('The aHR was 0.56 (95% CI 0.31-1.01).')).toBe(true)
    expect(
      statesEffectSize(
        'The hazard ratio for mortality in people with epilepsy (PWE) with psychiatric ' +
          'comorbidities compared to those without is 1.41, with a 95% confidence interval.',
      ),
    ).toBe(true)
    expect(statesEffectSize('Lamotrigine does not increase the risk of SUDEP.')).toBe(false)
  })

  it("quotes the passage's own effect size for the question's drug when the answer has none", () => {
    const sizes = effectSizesFor(
      'Does lamotrigine increase the risk of SUDEP compared with other antiseizure medications?',
      'Lamotrigine does not increase the risk of SUDEP.[1]',
      [{ index: 1, text: SUDEP }],
      LEXICON,
    )
    expect(sizes).toEqual([{
      index: 1,
      statement: 'adjusted hazard ratio [aHR] = 0.56; 95% CI: 0.31-1.01, P = 0.054',
      subject: 'lamotrigine was not associated with SUDEP',
    }])
    expect(effectSizeNote(sizes)).toBe(
      '*Effect size in the cited passage: for "lamotrigine was not associated with SUDEP", ' +
        'adjusted hazard ratio [aHR] = 0.56; 95% CI: 0.31-1.01, P = 0.054 [1].*',
    )
  })

  it('adds nothing when the answer states the ratio, or the passage carries none for the question', () => {
    expect(
      effectSizesFor(
        'Does lamotrigine increase the risk of SUDEP?',
        'No: aHR 0.56 (95% CI 0.31-1.01).[1]',
        [{ index: 1, text: SUDEP }],
        LEXICON,
      ),
    ).toEqual([])
    expect(
      effectSizesFor(
        'Does perampanel increase the risk of SUDEP?',
        'The sources do not say.[1]',
        [{ index: 1, text: 'Perampanel retention was 64.2% at 12 months.' }],
        LEXICON,
      ),
    ).toEqual([])
  })
})

describe('study design first (D2-11)', () => {
  it('names a modelling paper as such from its title or its own text, and a preclinical kind', () => {
    expect(
      nonClinicalDesign({
        title: 'Optimising anti-seizure medication timing using a dynamic network model',
      })?.label,
    ).toBe('a modelling study')
    expect(
      nonClinicalDesign({
        title: 'Timing matters',
        text: 'We built a dynamic network model of seizure rhythms and pharmacokinetics.',
      })?.label,
    ).toBe('a modelling study')
    // A recording study that interpreted its data with a model is not a simulation.
    expect(
      nonClinicalDesign({
        title: 'Circadian distribution of epileptiform discharges in epilepsy',
        text: 'We recorded EEG in 107 people. Using a mathematical model, the study suggests ' +
          'that sleep stages drive the two patterns.',
      }),
    ).toBe(undefined)
    expect(nonClinicalDesign({ title: 'SCN1A in mice', kind: 'preclinical' })?.label).toBe(
      'a preclinical study',
    )
    expect(nonClinicalDesign({ title: 'A pooled analysis of perampanel retention' })).toBe(
      undefined,
    )
    // A case study that used a personalised model is a patient's story, not a simulation.
    expect(
      nonClinicalDesign({
        title: 'Early detection of medication inefficacy using a personalized model: a case study',
        text: 'We report a case study of one patient with an implanted EEG system.',
      }),
    ).toBe(undefined)
  })

  it('leads the answer with the design when the first citing sentence did not name it', () => {
    const lead = designLead(
      [{
        index: 1,
        title: 'Optimising anti-seizure medication timing using a dynamic network model',
      }, { index: 2, title: 'PERMIT pooled analysis' }],
      [
        { text: 'Yes, timing doses to seizure cycles can improve efficacy.', bound: [1], line: 0 },
        { text: 'Retention was 64.2%.', bound: [2], line: 0 },
      ],
    )
    expect(lead).toBe(
      '*Study design: [1] is a modelling study - its results are simulated, not demonstrated in patients.*',
    )
    expect(
      designLead(
        [{ index: 1, title: 'A dynamic network model of seizure rhythms' }],
        [{ text: 'A dynamic network model suggests better timing helps.', bound: [1], line: 0 }],
      ),
    ).toBe(undefined)
    expect(
      designLead(
        [{ index: 1, title: 'A dynamic network model of seizure rhythms' }, {
          index: 2,
          title: 'In silico dosing',
        }],
        [{ text: 'Timing helps.', bound: [1, 2], line: 0 }],
      ),
    ).toBe(
      '*Study design: [1] and [2] are modelling studies - their results are simulated, not demonstrated in patients.*',
    )
  })
})

describe('conclusions and connectives after a removal (D3-06, D3-15)', () => {
  it('removes a conclusion that rested on removed sentences, and names it in the note', () => {
    const { gated } = gate(
      'Perampanel retention was 64.2%.[2] Brivaracetam retention was 79.9%.[1]\n\n' +
        'Thus, perampanel had a lower retention rate than brivaracetam.[1]',
      'How does perampanel retention compare with brivaracetam?',
      {
        1: 'Brivaracetam retention at 12 months was 71.1% (FAS).',
        2: 'Retention on perampanel at 12 months was 64.2% (2698/4201).',
      },
    )
    expect(gated.text).toBe('Perampanel retention was 64.2%.[1]')
    expect(gated.removed.map((r) => r.reason)).toEqual(['entity', 'conclusion'])
    expect(removalNote(gated.removed)).toContain(
      'One sentence was removed from this answer, and a conclusion that rested on it: its figures (79.9%)',
    )
  })

  it('strips a dangling connective from the sentence after a removal', () => {
    const { gated } = gate(
      'Across the consortium, 80% had a good outcome (n = 231).[1] ' +
        'Additionally, in the LGI1 study, 79% achieved an mRS below 3 at 12 months (n = 55).[2]',
      'What proportion had a good functional outcome at 12 months?',
      { 1: PROGNOSIS, 2: 'In the LGI1 study, 79% achieved an mRS below 3 at 12 months (n = 55).' },
    )
    expect(gated.text).toBe(
      'In the LGI1 study, 79% achieved an mRS below 3 at 12 months (n = 55).[1]',
    )
  })

  it('says where removed figures were found and what was replaced', () => {
    expect(
      removalNote([{ text: 'x', figures: ['71.1%'], reason: 'absent' }], {
        foundIn: ['EXPERIENCE'],
        replaced: 1,
      }),
    ).toBe(
      '*One sentence was removed from this answer: its figures (71.1%) could not be verified - ' +
        'the figures were found in *EXPERIENCE* but could not be tied to the claim as the answer ' +
        'stated it. One sentence cited to the wrong paper was replaced by the sentence of the ' +
        'paper that carries the same figure at the same time point, quoted and cited. Ask about ' +
        'one paper to see the figures it reports.*',
    )
  })

  it('names the effect and skips a covariate list', () => {
    expect(
      isCovariateList(
        'Age (OR 1.02), sex (OR 0.9) and anti-LGI1 diagnosis; OR 1.64; 95% CI 0.72-3.75.',
      ),
    )
      .toBe(true)
    expect(
      isCovariateList(
        'Rituximab was associated with time to first relapse (HR 0.10; 95% CI 0.001-0.85).',
      ),
    )
      .toBe(false)
    expect(
      effectSubject(
        'Results Rituximab, adjusted for concomitant use of other immunotherapies, was associated with increased time to first relapse (',
      ),
    )
      .toBe('rituximab was associated with increased time to first relapse')
  })
})

describe('table rows keep their place with failing cells blanked (D5-05)', () => {
  it('blanks the cells that carry the failing figures and nothing else', () => {
    const row =
      '| Brivaracetam | EXPERIENCE | Non-interventional | 1111 | 14.9% (full analysis set) | 33.6% (n = 1639) |'
    expect(blankFailingCells(row, ['33.6%', '1639'])).toBe(
      '| Brivaracetam | EXPERIENCE | Non-interventional | 1111 | 14.9% (full analysis set) | not verified |',
    )
    expect(blankFailingCells('| Perampanel | 4,201 | 17.6% |', ['4201'])).toBe(
      '| Perampanel | not verified | 17.6% |',
    )
    expect(isTableRow('| A | B |')).toBe(false)
    expect(isTableRow('|---|---|')).toBe(false)
    expect(isTableRow('| Perampanel | 4201 |')).toBe(true)
  })

  it('keeps a table row whose figure fails, blanked, rather than dropping the row', () => {
    const text =
      '| Cohort | Relapse |\n|---|---|\n| LGI1 relapse | 16 (30%) [1] |\n| Other relapse | 55 (99%) [1] |'
    const { gated } = gate(text, 'What proportion relapsed in the LGI1 cohort?', { 1: LGI1 })
    expect(gated.text).toContain('| LGI1 relapse | 16 (30%) [1] |')
    expect(gated.text).toContain('| Other relapse | not verified |')
    expect(gated.removed).toEqual([])
    expect(gated.blanked.map((b) => b.figures)).toEqual([['55', '99%']])
  })
})
