import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  bindSentences,
  designTerms,
  looksLikeBibliographyEntry,
  looksLikeReferencePassage,
  namedEntities,
  prepareText,
  rareWords,
  renderBound,
  sentenceFeatures,
  splitSentences,
  stripReferenceSection,
  supportScore,
  tableRowMarkers,
  textStatesDesign,
} from './citation-binding.ts'

const LEXICON = ['vigabatrin', 'lamotrigine', 'levetiracetam', 'phenytoin', 'Dravet']

const CONSENSUS =
  'International consensus on diagnosis and management of Dravet syndrome. Sodium channel ' +
  'blockers should be avoided. Lamotrigine is contraindicated in children with DS (Moderate). ' +
  'First-line treatment is valproate; fenfluramine and stiripentol are second-line options.'

const PROTOCOL =
  'ZYN002 cannabidiol gel in children with developmental and epileptic encephalopathies. ' +
  'Participants must be on stable therapy for at least 6 months; vigabatrin was recorded as a ' +
  'concomitant medication in 14 patients.'

const RECURRENCE =
  'After a first unprovoked seizure the recurrence risk within two years was 21-45% across ' +
  'cohorts. Employment fell by 14% in the year after the first seizure.'

describe('splitSentences', () => {
  it('keeps markers with their sentence and does not split on abbreviations or decimals', () => {
    const text =
      'Rates were 6.42% below 1400 mg [1]. Above it, e.g. at 1500 mg, 33.9% [2]. Verify before acting.[1][2]'
    expect(splitSentences(text)).toEqual([
      'Rates were 6.42% below 1400 mg [1].',
      'Above it, e.g. at 1500 mg, 33.9% [2].',
      'Verify before acting.[1][2]',
    ])
  })
})

describe('supportScore', () => {
  it('rejects a text that lacks every named drug in the sentence', () => {
    const features = sentenceFeatures(
      'Drugs like ethosuximide, valproate and lamotrigine suppress seizures.',
      ['ethosuximide', 'valproate', 'lamotrigine'],
    )
    expect(supportScore(features, prepareText('A multi-omic network analysis of GAERS rats.')))
      .toBe(0)
  })

  it('accepts a paraphrase whose words, entity and figure are in the text', () => {
    const features = sentenceFeatures(
      'Lamotrigine is contraindicated in Dravet syndrome.',
      LEXICON,
    )
    expect(supportScore(features, prepareText(CONSENSUS))).toBeGreaterThan(0)
  })

  it('needs most of a drug list present, not one drug of four', () => {
    const features = sentenceFeatures(
      'Sodium channel blockers include phenytoin, carbamazepine, oxcarbazepine and lamotrigine.',
      ['phenytoin', 'carbamazepine', 'oxcarbazepine', 'lamotrigine'],
    )
    expect(
      supportScore(
        features,
        prepareText('Lamotrigine, a sodium channel blocker, was withdrawn in two patients.'),
      ),
    ).toBe(0)
    expect(
      supportScore(
        features,
        prepareText(
          'Sodium channel blockers such as phenytoin, carbamazepine, oxcarbazepine and lamotrigine worsen seizures.',
        ),
      ),
    ).toBeGreaterThan(0)
  })

  it('rejects a figure the text does not carry even when the words match', () => {
    const features = sentenceFeatures(
      'The recurrence risk after a first unprovoked seizure is 21% to 45% [1].',
      [],
    )
    expect(supportScore(features, prepareText(PROTOCOL))).toBe(0)
    expect(supportScore(features, prepareText(RECURRENCE))).toBeGreaterThan(0)
    // One figure of two is not enough.
    expect(
      supportScore(
        features,
        prepareText('Recurrence after a first unprovoked seizure reached 45% in this cohort.'),
      ),
    ).toBe(0)
  })
})

describe('bindSentences', () => {
  it('binds each sentence to the passage that carries it and drops the paragraph spray', () => {
    const text = 'Lamotrigine is contraindicated in Dravet syndrome. ' +
      'Vigabatrin was recorded as a concomitant medication in 14 patients. ' +
      'Verify against current prescribing information before acting.[1][2][3]'
    const result = bindSentences({
      text,
      citations: [
        { index: 1, resourceId: 'protocol', title: 'ZYN002 protocol' },
        { index: 2, resourceId: 'consensus', title: 'Dravet consensus' },
        { index: 3, resourceId: 'recurrence', title: 'First seizure' },
      ],
      texts: new Map([[1, PROTOCOL], [2, CONSENSUS], [3, RECURRENCE]]),
      lexicon: LEXICON,
    })
    expect(result.text).toBe(
      'Lamotrigine is contraindicated in Dravet syndrome.[1] ' +
        'Vigabatrin was recorded as a concomitant medication in 14 patients.[2] ' +
        'Verify against current prescribing information before acting.',
    )
    expect(result.citations.map((c) => [c.index, c.resourceId])).toEqual([
      [1, 'consensus'],
      [2, 'protocol'],
    ])
    expect(result.sentences.map((s) => s.bound)).toEqual([[1], [2], []])
    expect(result.dropped).toBeGreaterThan(0)
  })

  it('drops a marker whose cited text does not contain the claim and rebinds to one that does', () => {
    const text =
      'Approximately 10% of children with an apparently de novo SCN1A variant had a parent with mosaicism [1].'
    const result = bindSentences({
      text,
      citations: [
        { index: 1, resourceId: 'gnao1', title: 'GNAO1 spectrum' },
        { index: 2, resourceId: 'mosaic', title: 'Parental mosaicism' },
      ],
      texts: new Map([
        [1, 'Phenotypic spectrum of GNAO1 variants in neurodevelopmental disorders.'],
        [
          2,
          'These findings show that approximately 10% of children with an apparently de novo SCN1A variant had a parent with low-level mosaicism.',
        ],
      ]),
      lexicon: [],
    })
    expect(result.text).toContain('mosaicism.[1]')
    expect(result.citations).toEqual([{
      index: 1,
      resourceId: 'mosaic',
      title: 'Parental mosaicism',
    }])
    expect(result.rebound).toBe(1)
  })

  it('keeps markers off headings and leaves list structure intact', () => {
    const result = bindSentences({
      text:
        '### Contraindications [1]\n- Lamotrigine is contraindicated in Dravet syndrome. [1]\n- Unsupported claim about nothing at all. [1]',
      citations: [{ index: 1, resourceId: 'consensus', title: 'Consensus' }],
      texts: new Map([[1, CONSENSUS]]),
      lexicon: LEXICON,
    })
    expect(result.text).toBe(
      '### Contraindications\n- Lamotrigine is contraindicated in Dravet syndrome.[1]\n- Unsupported claim about nothing at all.',
    )
  })

  it('renumbers by first appearance and orders every run of markers ascending', () => {
    const result = bindSentences({
      text: 'Lamotrigine is contraindicated in Dravet syndrome. [3] ' +
        'Sodium channel blockers should be avoided in Dravet syndrome. [3][1]',
      citations: [
        { index: 1, resourceId: 'consensus-copy', title: 'Consensus (copy)' },
        { index: 3, resourceId: 'consensus', title: 'Consensus' },
      ],
      texts: new Map([[1, CONSENSUS], [3, CONSENSUS]]),
      lexicon: LEXICON,
    })
    // Both texts carry both sentences, and the paragraph's trailing markers
    // are candidates for every sentence in it, so each sentence binds to both.
    expect(result.text).toBe(
      'Lamotrigine is contraindicated in Dravet syndrome.[1][2] ' +
        'Sodium channel blockers should be avoided in Dravet syndrome.[1][2]',
    )
    expect(result.citations.map((c) => c.resourceId)).toEqual(['consensus-copy', 'consensus'])
  })

  it('drops markers to citations under the display floor', () => {
    const result = bindSentences({
      text: 'Lamotrigine is contraindicated in Dravet syndrome. [1]',
      citations: [{ index: 1, resourceId: 'consensus', title: 'Consensus' }],
      texts: new Map([[1, CONSENSUS]]),
      lexicon: LEXICON,
      belowFloor: new Set([1]),
    })
    expect(result.text).toBe('Lamotrigine is contraindicated in Dravet syndrome.')
    expect(result.citations).toEqual([])
  })

  it('keeps a marker to a citation whose text could not be fetched', () => {
    const result = bindSentences({
      text: 'Lamotrigine is contraindicated in Dravet syndrome. [1]',
      citations: [{ index: 1, resourceId: 'consensus', title: 'Consensus' }],
      texts: new Map(),
      lexicon: LEXICON,
    })
    expect(result.text).toBe('Lamotrigine is contraindicated in Dravet syndrome.[1]')
  })
})

describe('reference-list exclusion', () => {
  it('recognises bibliography entries', () => {
    expect(
      looksLikeBibliographyEntry(
        '41. Temkin NR, Dikmen SS. More harm than good: antiseizure prophylaxis after traumatic brain injury. Neurology. 2001;56(4):32-38.',
      ),
    ).toBe(true)
    expect(
      looksLikeBibliographyEntry(
        'Karoly PJ, Stirling RE, Freestone DR, et al. Multiday cycles of heart rate. Nat Commun. 2021;12:1-10. doi:10.1038/s41467-021-22452-5',
      ),
    ).toBe(true)
    expect(
      looksLikeBibliographyEntry(
        'Phenytoin within 7 days reduced early seizures in the 1990 trial of 404 patients.',
      ),
    ).toBe(false)
  })

  it('recognises a mid-list slice of a bibliography as a reference passage', () => {
    expect(
      looksLikeReferencePassage(
        '2018;90(1):e67-e72. 58. Devinsky O, Cross JH, Wright S. Trial of Cannabidiol for Drug-Resistant Seizures in the Dravet Syndrome. N Engl J Med. 2017;377(7):699-700. 59. Lux AL, Edwards SW, Hancock E. The United Kingdom Infantile Spasms Study.',
      ),
    ).toBe(true)
    expect(
      looksLikeReferencePassage(
        'Lamotrigine is contraindicated in children with DS; sodium channel blockers should be avoided.',
      ),
    ).toBe(false)
  })

  it('cuts the reference section and stray entries from a text', () => {
    const text = [
      'Levetiracetam was non-inferior to phenytoin for early seizure prophylaxis.',
      '',
      'References',
      '1. Temkin NR, Dikmen SS. A randomized double-blind study of phenytoin. N Engl J Med. 1990;323:497-502.',
      '2. Jones KE, Puccio AM. Levetiracetam versus phenytoin. Neurosurg Focus. 2008;25(4):E3.',
      '41. Temkin NR. More harm than good: antiseizure prophylaxis. Neurology. 2001;56:32-38.',
    ].join('\n')
    const stripped = stripReferenceSection(text)
    expect(stripped).toContain('non-inferior')
    expect(stripped).not.toContain('More harm than good')
    expect(stripped).not.toContain('References')
  })
})

describe('rare words', () => {
  const sanad =
    'Levetiracetam did not meet criteria for non-inferiority for efficacy and cost benefit in the 2021 SANAD trial.'
  const lev =
    'Levetiracetam efficacy and cost were assessed against the criteria for benefit in focal epilepsy.'
  const tau =
    'Levetiracetam reduced tau pathology in a mouse model; efficacy criteria and cost benefit were secondary.'

  it('names the words few cited texts carry', () => {
    const texts = [sanad, lev, tau].map(prepareText)
    const features = sentenceFeatures(
      'Levetiracetam did not meet the criteria for non-inferiority in terms of efficacy and cost benefit.',
      ['levetiracetam'],
    )
    expect(rareWords(features.words, texts)).toEqual(['meet', 'noninf'])
    expect(rareWords(features.words, texts.slice(0, 1))).toEqual([])
  })

  it('drops a supporter that carries none of the rare words', () => {
    const features = sentenceFeatures(
      'Levetiracetam did not meet the criteria for non-inferiority in terms of efficacy and cost benefit.',
      ['levetiracetam'],
    )
    const rare = ['meet', 'noninf']
    expect(supportScore(features, prepareText(sanad), rare)).toBeGreaterThan(0)
    expect(supportScore(features, prepareText(lev), rare)).toBe(0)
    expect(supportScore(features, prepareText(tau), rare)).toBe(0)
  })

  it('binds the sentence to the one paper that carries the claim', () => {
    const text =
      'Levetiracetam did not meet the criteria for non-inferiority in terms of efficacy and cost benefit.[1][2][3]'
    const result = bindSentences({
      text,
      citations: [
        { index: 1, resourceId: 'a', title: 'a' },
        { index: 2, resourceId: 'b', title: 'b' },
        { index: 3, resourceId: 'c', title: 'c' },
      ],
      texts: new Map([[1, sanad], [2, lev], [3, tau]]),
      lexicon: ['levetiracetam'],
    })
    expect(result.text).toBe(
      'Levetiracetam did not meet the criteria for non-inferiority in terms of efficacy and cost benefit.[1]',
    )
    expect(result.dropped).toBe(2)
  })
})

describe('boilerplate', () => {
  it('never lets the prescribing-information line carry a marker', () => {
    const text =
      'Retention at 12 months was 64.2%.[1] Verify against current prescribing information before acting.[1][2]'
    const result = bindSentences({
      text,
      citations: [{ index: 1, resourceId: 'a', title: 'a' }, {
        index: 2,
        resourceId: 'b',
        title: 'b',
      }],
      texts: new Map([
        [
          1,
          'Retention at 12 months was 64.2%. Verify against current prescribing information before acting.',
        ],
        [2, 'Prescribing information: verify current dosing before acting.'],
      ]),
    })
    expect(result.text).toBe(
      'Retention at 12 months was 64.2%.[1] Verify against current prescribing information before acting.',
    )
  })
})

describe('bindSentences - names the question uses', () => {
  const FENFLURAMINE =
    'Long-term safety of fenfluramine in Dravet syndrome. The SUDEP rate was 3.9 per 1000 ' +
    'patient-years, judged unrelated to FFA.'
  const SUDEP_MELBOURNE =
    'Risk of SUDEP with lamotrigine: a nested case-control study of the Melbourne video-EEG ' +
    'monitoring cohort. SUDEP occurred at 3.9 per 1000 patient-years in the cohort.'

  it("binds a sentence naming the question's cohort only to a text that names it (D2-01)", () => {
    const query = 'What was the SUDEP incidence in the Melbourne video-EEG monitoring cohort?'
    const text =
      'The SUDEP incidence in the Melbourne video-EEG cohort was 3.9 per 1000 patient-years.[1]'
    const citations = [
      { index: 1, resourceId: 'ffa', title: 'Fenfluramine' },
      { index: 2, resourceId: 'sudep', title: 'SUDEP with lamotrigine' },
    ]
    const wrong = bindSentences({
      text,
      citations: citations.slice(0, 1),
      texts: new Map([[1, FENFLURAMINE]]),
      lexicon: ['fenfluramine', 'lamotrigine'],
      questionEntities: namedEntities(query, []),
    })
    expect(wrong.citations).toEqual([])
    expect(wrong.sentences[0]!.bound).toEqual([])
    const right = bindSentences({
      text,
      citations,
      texts: new Map([[1, FENFLURAMINE], [2, SUDEP_MELBOURNE]]),
      lexicon: ['fenfluramine', 'lamotrigine'],
      questionEntities: namedEntities(query, []),
    })
    expect(right.citations.map((c) => c.resourceId)).toEqual(['sudep'])
  })

  it('binds a sentence only to a text that carries its figure beside its drug (D2-13)', () => {
    const EXPERIENCE = 'Brivaracetam retention was 89.4%, 79.8%, and 71.1% at 3, 6, and 12 ' +
      'months. Perampanel and PERMIT are discussed elsewhere.'
    const PERMIT = 'PERMIT pooled analysis: perampanel retention was 79.8% at 6 months.'
    const bound = bindSentences({
      text: 'At 6 months, the PERMIT pooled analysis reported a retention rate of 79.8% for ' +
        'perampanel treatment.[1][2]',
      citations: [{ index: 1, resourceId: 'permit', title: 'PERMIT' }, {
        index: 2,
        resourceId: 'experience',
        title: 'EXPERIENCE',
      }],
      texts: new Map([[1, PERMIT], [2, EXPERIENCE]]),
      lexicon: ['perampanel', 'brivaracetam'],
    })
    expect(bound.citations.map((c) => c.resourceId)).toEqual(['permit'])
    expect(bound.text).toBe(
      'At 6 months, the PERMIT pooled analysis reported a retention rate of 79.8% for perampanel treatment.[1]',
    )
  })

  it('drops every marker to a text that never mentions the study the question names (D1-16)', () => {
    const REVIEW = 'Prognosis of focal epilepsy: SANAD II recruited 990 patients; levetiracetam ' +
      'was less likely to achieve remission than lamotrigine.'
    const TAU = 'Tau pathology in epilepsy. Levetiracetam and lamotrigine are common ' +
      'antiseizure medications; remission is rarely discussed.'
    const bound = bindSentences({
      text: 'Levetiracetam was less likely to achieve remission than lamotrigine.[1][2]',
      citations: [{ index: 1, resourceId: 'review', title: 'Prognosis of focal epilepsy' }, {
        index: 2,
        resourceId: 'tau',
        title: 'Tau pathology in epilepsy',
      }],
      texts: new Map([[1, REVIEW], [2, TAU]]),
      lexicon: ['levetiracetam', 'lamotrigine'],
      requiredName: 'SANAD',
    })
    expect(bound.citations.map((c) => c.resourceId)).toEqual(['review'])
    expect(bound.text.endsWith('lamotrigine.[1]')).toBe(true)
  })

  it('renders the layout again without the removed sentences and empty list items', () => {
    const bound = bindSentences({
      text: 'Intro line.\n\n- First 45% here.[1] Second.\n- Third 21% there.[1]',
      citations: [{ index: 1, resourceId: 'a', title: 'A' }],
      texts: new Map([[1, 'The rate was 45% here and 21% there.']]),
    })
    expect(bound.layout.length).toBe(4)
    expect(renderBound(bound.layout, bound.sentences, new Set([3]))).toBe(
      'Intro line.\n\n- First 45% here.[1] Second.',
    )
    expect(renderBound(bound.layout, bound.sentences)).toBe(bound.text)
  })
})

describe('design sentences (D4-07)', () => {
  it('reads the designs a sentence states', () => {
    expect(
      designTerms(
        'This study was a retrospective, nested case-control design conducted across multiple Epilepsy Monitoring Units over an 18-year period.',
      ),
    ).toEqual(['retrospective', 'nested case-control'])
    expect(designTerms('A randomized, double-blind, placebo-controlled trial of lacosamide.'))
      .toEqual(['randomised', 'double-blind', 'placebo-controlled'])
    expect(designTerms('Retention was 64.2% at 12 months.')).toEqual([])
  })
  it('matches a design in a text under either spelling and either dash', () => {
    expect(textStatesDesign('a nested case control study of sudep', 'nested case-control')).toBe(
      true,
    )
    expect(textStatesDesign('this randomized trial enrolled 240 adults', 'randomised')).toBe(true)
    expect(textStatesDesign('a retrospective cohort applying the ilae criteria', 'case-control'))
      .toBe(false)
  })
  it('never binds a design sentence to a paper that does not mention the design', () => {
    const sentence =
      'This study was a retrospective, nested case-control design conducted across Epilepsy Monitoring Units in Australia and the USA over an 18-year period.'
    const lgs = prepareText(
      'We applied the ILAE diagnostic criteria for Lennox-Gastaut syndrome to a retrospective cohort of adults ' +
        'attending Epilepsy Monitoring Units in Australia and the USA over an 18-year period; 29 patients met all criteria.',
    )
    const sudep = prepareText(
      'We conducted a retrospective, nested case-control study of SUDEP across four Epilepsy Monitoring Units in Australia ' +
        'and the USA over an 18-year period, comparing lamotrigine use between cases and living controls.',
    )
    const features = sentenceFeatures(sentence, [])
    expect(supportScore(features, lgs)).toBe(0)
    expect(supportScore(features, sudep)).toBeGreaterThan(0)
  })
})

describe('table rows (D4-06)', () => {
  it("moves a row's markers into its last cell and drops them from a header row", () => {
    expect(tableRowMarkers('| Brivaracetam | EXPERIENCE | 36.9% | n = 822 |[2]')).toBe(
      '| Brivaracetam | EXPERIENCE | 36.9% | n = 822 [2] |',
    )
    expect(tableRowMarkers('| Drug | Study | Responder rate |[1]')).toBe(
      '| Drug | Study | Responder rate |',
    )
    expect(tableRowMarkers('|---|---|---|[1]')).toBe('|---|---|---|')
    expect(tableRowMarkers('Retention was 64.2%.[1]')).toBe('Retention was 64.2%.[1]')
  })
})
