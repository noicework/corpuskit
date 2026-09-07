/**
 * Loop 6 D6-10: an author review lists one item per paper - title, year and
 * journal from the catalogue - and answers a per-paper attribute from each
 * paper's own text. X5 named one paper while citing two, and gave no sample
 * size at all (review loop 6).
 */
import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  appendOmittedPapers,
  asksEnrolment,
  authorTopicQuery,
  enrolmentSentence,
} from './ask-author.ts'

const X5 =
  "Which of O'Neill's papers report patient-reported outcomes after a first seizure, and what sample size did they enrol?"

const sources = [
  {
    id: '9cb1d5d7',
    title:
      'Trajectories of quality of life, anxiety and depressive symptomatology, and health-related work productivity after first seizure events',
    year: '2023',
    journal: 'Epilepsia',
    kind: 'cohort-study',
    matchedPassage: 'Patient-reported outcomes were collected after a first seizure.',
  },
  {
    id: 'eddde3fe',
    title: 'First seizure outcomes study: a protocol for a prospective cohort',
    year: '2021',
    journal: 'BMJ Open',
    kind: 'protocol',
  },
]

describe('an author review lists every paper it cites (D6-10)', () => {
  it('keeps the topic and drops the per-paper attribute clause', () => {
    expect(authorTopicQuery(X5, ["O'Neill"])).toBe(
      'patient-reported outcomes after a first seizure',
    )
    expect(asksEnrolment(X5)).toBe(true)
    expect(asksEnrolment("Which of O'Neill's papers report on sub-scalp EEG?")).toBe(false)
  })

  it('lists both cited papers with their year and journal, and the attribute per paper', () => {
    const text =
      'The paper titled "Trajectories of quality of life, anxiety and depressive symptomatology, ' +
      'and health-related work productivity after first seizure events" reports on ' +
      'patient-reported outcomes after a first seizure.[1][2]'
    const out = appendOmittedPapers({
      text,
      query: X5,
      topic: 'patient-reported outcomes after a first seizure',
      surname: "O'Neill",
      sources,
      scopeIds: ['9cb1d5d7', 'eddde3fe'],
      citations: [
        { index: 1, resourceId: '9cb1d5d7', title: sources[0]!.title },
        { index: 2, resourceId: 'eddde3fe', title: sources[1]!.title },
      ],
      kindLabel: (id) => id === 'protocol' ? 'Protocol' : 'Cohort study',
      notes: {
        '9cb1d5d7': '"A total of 196 participants were enrolled."',
        'eddde3fe':
          'planned recruitment, not an enrolment: "Approximately 450 patients will be recruited."',
      },
    })
    expect(out.listed).toEqual(['9cb1d5d7', 'eddde3fe'])
    expect(out.text).toContain("Papers by O'Neill in this collection on patient-reported outcomes")
    expect(out.text).toContain('(2023, Epilepsia, Cohort study) [1] - "A total of 196 participants')
    expect(out.text).toContain(
      '*First seizure outcomes study: a protocol for a prospective cohort* (2021, BMJ Open, Protocol) [2] - planned recruitment, not an enrolment:',
    )
  })
})

describe("a paper's own enrolment sentence (D6-10)", () => {
  it('quotes the enrolment, and marks a protocol plan as a plan', () => {
    const results = [
      'Methods',
      'Participants were recruited from the first seizure clinic between 2016 and 2019.',
      'A total of 196 participants were enrolled, of whom 101 (51.5%) had newly diagnosed epilepsy.',
    ].join('\n\n')
    expect(enrolmentSentence(results)).toEqual({
      sentence:
        'A total of 196 participants were enrolled, of whom 101 (51.5%) had newly diagnosed epilepsy.',
      planned: false,
    })
    const protocol = [
      'This protocol describes a prospective cohort study.',
      'Approximately 450 patients will be recruited over three years.',
    ].join('\n\n')
    expect(enrolmentSentence(protocol)).toEqual({
      sentence: 'Approximately 450 patients will be recruited over three years.',
      planned: true,
    })
    expect(enrolmentSentence('No counts of people here at all, only prose.')).toBeUndefined()
  })
})
