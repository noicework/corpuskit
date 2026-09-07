import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  chooseSnippet,
  extractDoi,
  isCitationNoise,
  isExactTermMatch,
  looksLikeBibliographicSnippet,
  looksLikeFrontMatter,
  looksLikeIdentifierFragment,
  matchesDoi,
  REFERENCE_DISCOUNT,
} from './snippet.ts'
import { looksLikeDeclarationsChunk } from './index.ts'

// Verbatim shapes from the persona reports (P1-16, P5-14, P6-21, P8-17,
// P9-10, P10-22, P3-18).
const REF_NUMBERED =
  '33. Steinhoff BJ, Christensen J, Doherty CP, Majoie M, Schulz A-L, Brock F, et al. Cognitive performance of patients with epilepsy. Epilepsia. 2018;59:186-94.'
const REF_TAIL =
  '2018;138:186–94. 18. Brandt C, Dimova S, Elmoufti S, Laloyaux C, Nondonfaz X, Klein P. Retention, efficacy and safety of brivaracetam.'
const REF_FENFLURAMINE =
  '2024;65(8):2186-99. 49. Tupal S, Faingold CL. Fenfluramine, a serotonin-releasing drug, prevents seizure-induced respiratory arrest.'
const DOI_COLUMN =
  'https://doi.org/10.1111/epi.17217 https://doi.org/10.1111/epi.17217 https://doi.org/10.1111/epi.17588'
const FRONT_MATTER =
  'RESEARCH ARTICLE OPEN ACCESS Rituximab Use for Relapse Prevention in Autoimmune Encephalitis Nabil Seery,1,2 Robb Wesselingh,1,2 Paul Beech,3,4 Correspondence: N. Seery'
const BODY =
  'Upon admission, the patient was started on brivaracetam (50 mg/day); complete seizure control was achieved within two weeks and retention at twelve months was 78%.'
const BODY_WITH_ONE_CITE =
  'Retention rates in the open-label extension were consistent with earlier cohorts (Toledo et al., 2016), and no new safety signals emerged over 24 months of follow-up.'

describe('looksLikeBibliographicSnippet', () => {
  it('flags numbered reference entries and citation tails', () => {
    expect(looksLikeBibliographicSnippet(REF_NUMBERED)).toBe(true)
    expect(looksLikeBibliographicSnippet(REF_TAIL)).toBe(true)
    expect(looksLikeBibliographicSnippet(REF_FENFLURAMINE)).toBe(true)
  })

  it('flags a passage that is mostly DOIs', () => {
    expect(looksLikeBibliographicSnippet(DOI_COLUMN)).toBe(true)
  })

  it('leaves body prose alone, even with an in-text citation', () => {
    expect(looksLikeBibliographicSnippet(BODY)).toBe(false)
    expect(looksLikeBibliographicSnippet(BODY_WITH_ONE_CITE)).toBe(false)
  })
})

describe('looksLikeFrontMatter', () => {
  it('flags the masthead and affiliation block of a first page', () => {
    expect(looksLikeFrontMatter(FRONT_MATTER)).toBe(true)
    expect(looksLikeFrontMatter('Received: 3 March 2021 Accepted: 9 June 2021')).toBe(true)
  })

  it('does not flag a results paragraph', () => {
    expect(looksLikeFrontMatter(BODY)).toBe(false)
  })
})

describe('looksLikeIdentifierFragment', () => {
  it('flags a bare DOI or URL and near-empty fragments', () => {
    expect(looksLikeIdentifierFragment('doi: 10.1038/s41582-018-0055-2')).toBe(true)
    expect(looksLikeIdentifierFragment('https://doi.org/10.1111/epi.17440')).toBe(true)
    expect(looksLikeIdentifierFragment('p. 12')).toBe(true)
  })

  it('flags a shredded table column, including one that opens a longer passage', () => {
    expect(
      looksLikeIdentifierFragment('Pa tie nt s (% ) d n Patients with post-stroke epilepsy 12 4 n'),
    ).toBe(true)
    expect(
      looksLikeIdentifierFragment(
        'Pa tie nt s (% ) d n Patients with post-stroke epilepsy Patients without post-stroke epilepsy Patients with BTRE Patients without BTRE Etiologies Fig. 2 Analyses of effectiveness by etiology',
      ),
    ).toBe(true)
  })

  it('does not flag prose that merely mentions a DOI', () => {
    expect(looksLikeIdentifierFragment(BODY_WITH_ONE_CITE)).toBe(false)
    expect(looksLikeIdentifierFragment(BODY)).toBe(false)
  })
})

describe('chooseSnippet', () => {
  const ref = { score: 0.97, text: REF_NUMBERED, page: 16 }
  const body = { score: 0.62, text: BODY, page: 3 }

  it('prefers a body paragraph over a higher-scoring reference line', () => {
    const choice = chooseSnippet([ref, body], 0.1)
    expect(choice.passage).toBe(body)
    expect(choice.score).toBe(0.62)
    expect(choice.reference).toBe(false)
  })

  it('keeps a reference-only match, flagged and discounted', () => {
    const choice = chooseSnippet([ref], 0.1)
    expect(choice.passage).toBe(ref)
    expect(choice.reference).toBe(true)
    expect(choice.score).toBeCloseTo(0.97 * REFERENCE_DISCOUNT)
  })

  it('ignores a body paragraph under the relevance floor', () => {
    const choice = chooseSnippet([ref, { score: 0.05, text: BODY }], 0.1)
    expect(choice.reference).toBe(true)
  })

  it('never quotes front matter or a DOI fragment when the body matched', () => {
    const front = { score: 0.9, text: FRONT_MATTER }
    const doi = { score: 0.8, text: 'https://doi.org/10.1111/epi.17440' }
    expect(chooseSnippet([front, doi, body], 0.1).passage).toBe(body)
  })

  it('returns nothing for a resource with no paragraphs', () => {
    expect(chooseSnippet([], 0.1)).toEqual({ score: 0, reference: false })
  })

  it('accepts a caller-supplied noise detector', () => {
    const choice = chooseSnippet([ref, body], 0.1, () => false)
    expect(choice.passage).toBe(ref)
  })

  it('exposes one combined detector', () => {
    expect(isCitationNoise(REF_TAIL)).toBe(true)
    expect(isCitationNoise(BODY)).toBe(false)
  })
})

describe('extractDoi', () => {
  it('recognises a bare DOI, a resolver URL and a doi: prefix', () => {
    expect(extractDoi('10.1111/epi.17708')).toBe('10.1111/epi.17708')
    expect(extractDoi('https://doi.org/10.1111/EPI.17440')).toBe('10.1111/epi.17440')
    expect(extractDoi('doi: 10.1002/acn3.34.')).toBe('10.1002/acn3.34')
  })

  it('is not fooled by ordinary queries', () => {
    expect(extractDoi('brivaracetam retention')).toBeUndefined()
    expect(extractDoi('10 mg lamotrigine')).toBeUndefined()
  })
})

describe('matchesDoi', () => {
  it('matches the resource that records the DOI, or whose text carries it exactly', () => {
    expect(matchesDoi('10.1111/epi.17440', { doi: '10.1111/EPI.17440', texts: [] })).toBe(true)
    expect(
      matchesDoi('10.1111/epi.17440', { texts: ['see https://doi.org/10.1111/epi. 17440'] }),
    ).toBe(true)
  })

  it('does not match another DOI from the same journal in a reference list', () => {
    expect(matchesDoi('10.1111/epi.17708', { doi: '10.1111/epi.17588', texts: [DOI_COLUMN] }))
      .toBe(false)
  })
})

describe('isExactTermMatch', () => {
  it('requires every term of an exact lookup to be present', () => {
    const paper = { title: 'Febrile seizure recurrence reduced by levetiracetam', texts: [BODY] }
    expect(isExactTermMatch('Okafor recurrence', paper)).toBe(false)
    expect(isExactTermMatch('seizure recurrence', paper)).toBe(true)
    expect(isExactTermMatch('brivaracetam', paper)).toBe(true)
  })

  it('treats a query with no usable term as matching', () => {
    expect(isExactTermMatch('a', { texts: [] })).toBe(true)
  })
})

describe('looksLikeDeclarationsChunk (D3-04)', () => {
  it('recognises a declarations block and leaves results and methods alone', () => {
    expect(
      looksLikeDeclarationsChunk(
        "Code availability Not applicable. Declarations Conflicts of interest Vicente Villanueva has received honoraria and/ or research funds from UCB Pharma, Eisai and Novartis. Wilma O'Neill has received honoraria from UCB.",
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        'Funding This work was supported by the NHMRC. Competing interests The authors declare no competing interests.',
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        "study concept or design; analysis or interpretation of data. W.J. O'Neill: drafting/revision of the manuscript for content, including medical writing for content; major role in the acquisition of data.",
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        "We acknowledge the doctors who referred some of the patients - Dr Simon Harvey (Royal Children's Hospital Melbourne) and A/Prof Wilma O'Neill (St Vincent's Hospital Melbourne).",
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        'Benjamin H. Brinkmann: Writing - review & editing, Funding acquisition, Conceptualization. Philippa J. Karoly: Writing - original draft, Methodology, Formal analysis.',
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        'Journal of Neurology (2025) 272:665 Page 13 of 15. Roche, Janssen, Genzyme, Novartis, Biogen and UCB, outside the submitted work.',
      ),
    ).toBe(true)
    expect(
      looksLikeDeclarationsChunk(
        'Results Rituximab, adjusted for concomitant use of other immunotherapies, was associated with increased time to first relapse (hazard ratio 0.10; 95% CI 0.001-0.85; p = 0.03).',
      ),
    ).toBe(false)
    expect(
      looksLikeDeclarationsChunk(
        'Methods The study was approved by the ethics committee and funding for the registry came from the hospital foundation; 1,805 adults were followed.',
      ),
    ).toBe(false)
  })
})
