import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { ResourceSummary } from '@research-portal/core'
import {
  appendOmittedPapers,
  authorsNamed,
  authorTopicQuery,
  correctAttributions,
  hasAuthor,
  isPaperListingQuestion,
  namesAnAuthor,
  surnameOf,
} from './ask-author.ts'

const resource = (id: string, authors: string[]): ResourceSummary => ({
  id,
  title: id,
  type: 'pdf',
  authors,
} as ResourceSummary)

const catalogue = [
  resource('cycles', ['Karoly PJ', 'Stirling RE', "O'Neill W", 'Cook MJ']),
  resource('forecast', ['Xiong W', 'Stirling RE', 'Payne DE', 'Karoly PJ']),
  resource('app', ['Reynolds A', 'Stirling RE', 'Peterson A']),
]

describe('author index', () => {
  it('reads surnames from the catalogue author forms', () => {
    expect(surnameOf("O'Neill W")).toBe("O'Neill")
    expect(surnameOf('Vajda FJE')).toBe('Vajda')
    expect(surnameOf('A. B. Surname')).toBe('Surname')
    expect(hasAuthor({ authors: ['O’Neill W'] }, "O'Neill")).toBe(true)
    // Typed without the apostrophe (D3-04).
    expect(hasAuthor({ authors: ['O’Neill W'] }, 'ONeill')).toBe(true)
  })

  it('recognises the possessive form and the apostrophe-less spelling (D3-11)', () => {
    expect(
      authorsNamed("Which of O'Neill's papers report on sub-scalp EEG?", catalogue),
    ).toEqual([{ surname: "O'Neill", resourceIds: ['cycles'] }])
    expect(authorsNamed('What did ONeill find about cycles?', catalogue)).toEqual([
      { surname: 'ONeill', resourceIds: ['cycles'] },
    ])
  })

  it('recognises the surnames a question names and the papers they wrote', () => {
    const named = authorsNamed(
      "What has O'Neill and colleagues published on multiday seizure cycles and Dravet?",
      catalogue,
      ['Dravet'],
    )
    expect(named).toEqual([{ surname: "O'Neill", resourceIds: ['cycles'] }])
    expect(authorsNamed('What is known about multiday seizure cycles?', catalogue)).toEqual([])
  })
})

describe('correctAttributions', () => {
  const authors = [{ surname: "O'Neill", resourceIds: ['cycles'] }]
  const citations = [
    { index: 1, resourceId: 'cycles', title: 'cycles' },
    { index: 2, resourceId: 'forecast', title: 'forecast' },
    { index: 3, resourceId: 'app', title: 'app' },
  ]
  const authorsOf = (id: string) => catalogue.find((r) => r.id === id)?.authors

  it('keeps an attribution the cited paper supports', () => {
    const text = "O'Neill and colleagues found multiday cycles in all participants.[1]"
    expect(correctAttributions(text, authors, citations, authorsOf)).toEqual({ text, fixes: [] })
  })

  it("rewrites to the cited paper's first author when it lacks the named one", () => {
    const text = "O'Neill and colleagues reported a mean AUC of 0.77.[2]"
    const out = correctAttributions(text, authors, citations, authorsOf)
    expect(out.text).toBe('Xiong and colleagues reported a mean AUC of 0.77.[2]')
    expect(out.fixes).toHaveLength(1)
  })

  it('uses a neutral subject when several first authors are cited', () => {
    const text = "O'Neill et al. explored forecasting apps.[2][3] The next sentence stands.[1]"
    const out = correctAttributions(text, authors, citations, authorsOf)
    expect(out.text).toBe(
      'Other authors explored forecasting apps.[2][3] The next sentence stands.[1]',
    )
  })

  it('leaves an unmarked sentence alone', () => {
    const text = "O'Neill and colleagues have contributed to this field."
    expect(correctAttributions(text, authors, citations, authorsOf).text).toBe(text)
  })
})

describe('authorTopicQuery', () => {
  it('keeps the topic and drops the attribution scaffolding', () => {
    expect(
      authorTopicQuery(
        "What has O'Neill and colleagues published on seizure cycles and forecasting?",
        [
          "O'Neill",
        ],
      ),
    ).toBe('seizure cycles and forecasting')
    expect(authorTopicQuery('Summarise the Karoly group work on wearables', ['Karoly'])).toBe(
      'Summarise wearables',
    )
  })
  it('is empty when only scaffolding remains', () => {
    expect(authorTopicQuery("What has O'Neill published?", ["O'Neill"])).toBe('')
  })
  it('keeps the topic of a listing question (D3-11)', () => {
    expect(
      authorTopicQuery(
        "Which of O'Neill's papers report on sub-scalp EEG, and what did each find?",
        ["O'Neill"],
      ),
    ).toBe('sub-scalp EEG')
  })
})

describe('appendOmittedPapers (D3-11)', () => {
  const sources = [
    {
      id: 'umpire',
      title: 'The UMPIRE study: a first-in-human trial of bilateral subscalp monitoring',
      summary: 'Sub-scalp EEG was recorded for a year.',
      year: '2025',
      kind: 'clinical-trial',
      matchedPassage: 'Subscalp EEG was recorded.',
    },
    {
      id: 'minder',
      title: 'Feasibility and signal quality of the Minder implantable EEG system',
      summary: 'A sub-scalp EEG device.',
      year: '2024',
    },
    {
      id: 'cycles',
      title: 'Multiday cycles of heart rate',
      summary: 'Wearables and sub-scalp EEG.',
      matchedPassage: 'Sub-scalp EEG devices now record for months.',
      year: '2020',
    },
    { id: 'outside', title: 'Sub-scalp EEG in dogs', summary: 'sub-scalp EEG', year: '2019' },
  ]
  const citations = [{ index: 1, resourceId: 'minder', title: sources[1]!.title }]
  const text = 'Two papers report on it: **Feasibility and signal quality of the Minder ' +
    'implantable EEG system** found good signal quality.[1]'
  it('lists the on-topic scoped sources the answer left out, with new markers', () => {
    const out = appendOmittedPapers({
      text,
      query: "Which of O'Neill's papers report on sub-scalp EEG, and what did each find?",
      topic: 'sub-scalp EEG',
      surname: "O'Neill",
      sources,
      scopeIds: ['umpire', 'minder', 'cycles'],
      citations,
      kindLabel: (id) => id === 'clinical-trial' ? 'Clinical trial (non-randomised)' : id,
    })
    expect(out.added).toBe(1)
    expect(out.text).toContain("Papers by O'Neill in this collection on sub-scalp EEG:")
    expect(out.text).toContain(
      '- *The UMPIRE study: a first-in-human trial of bilateral subscalp monitoring* (2025, Clinical trial (non-randomised)) [2]',
    )
    const listing = out.text.split('Papers by')[1] ?? ''
    // Loop 6 D6-10: a paper the answer cited is listed too, so a reader
    // never sees a marker for a paper the answer never names.
    expect(listing).toContain('Minder')
    expect(listing).not.toContain('dogs')
    expect(out.citations.map((c) => [c.index, c.resourceId])).toEqual([[1, 'minder'], [
      2,
      'umpire',
    ]])
    expect(out.citations[1]?.passage).toBe('Subscalp EEG was recorded.')
  })
  it('changes nothing for a finding question or when every paper is named', () => {
    const finding = appendOmittedPapers({
      text,
      query: 'What did the sub-scalp EEG studies find?',
      topic: 'sub-scalp EEG',
      surname: "O'Neill",
      sources,
      scopeIds: ['umpire', 'minder'],
      citations,
      kindLabel: (id) => id,
    })
    expect(finding.added).toBe(0)
    expect(finding.text).toBe(text)
    expect(isPaperListingQuestion("Which of O'Neill's papers report on EEG?")).toBe(true)
    expect(isPaperListingQuestion('What papers has Kwan published on resistance?')).toBe(true)
    expect(isPaperListingQuestion('List the papers by Broadley on encephalitis')).toBe(true)
    expect(isPaperListingQuestion('What did the trial find?')).toBe(false)
    expect(isPaperListingQuestion('What did the sub-scalp EEG studies find?')).toBe(false)
  })
})

describe('author constructions (D5-07)', () => {
  const withGrant = [...catalogue, resource('exome', ['Grant R', 'Other A'])]
  it('never scopes to a surname that is not used as an author', () => {
    expect(
      authorsNamed(
        'Grant background: what did the group find on time to first relapse with rituximab?',
        withGrant,
      ),
    ).toEqual([])
    expect(namesAnAuthor('Grant background: what did the group find', 'Grant')).toBe(false)
  })
  it('recognises the author shapes the portal answers', () => {
    expect(namesAnAuthor("Which of O'Neill's papers report on EEG?", "O'Neill")).toBe(true)
    expect(namesAnAuthor('List the papers by Grant on exome sequencing', 'Grant')).toBe(true)
    expect(namesAnAuthor('What did Grant et al. report?', 'Grant')).toBe(true)
    expect(namesAnAuthor("What has O'Neill and colleagues published on cycles?", "O'Neill")).toBe(
      true,
    )
    expect(namesAnAuthor('What did ONeill find about cycles?', 'ONeill')).toBe(true)
    expect(authorsNamed('What did Grant et al. report on exome sequencing?', withGrant)).toEqual([
      { surname: 'Grant', resourceIds: ['exome'] },
    ])
  })
})
