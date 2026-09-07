import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  applicablePrequeries,
  isMedicationTerm,
  isTreatmentDecisionQuestion,
  isTreatmentSelectionQuestion,
  medicationEntities,
} from './ask-prequeries.ts'

const TEMPLATES = [
  'contraindications, drugs to avoid and safety monitoring for {entities}',
  'dose limits, starting dose and interactions for {entities}',
]

describe('medication entities', () => {
  it('keeps drugs and drops genes, antigens, journals, syndromes and diets', () => {
    expect(isMedicationTerm('vigabatrin')).toBe(true)
    expect(isMedicationTerm('sodium valproate')).toBe(true)
    expect(isMedicationTerm('cannabidiol')).toBe(true)
    expect(isMedicationTerm('NMDAR')).toBe(false)
    expect(isMedicationTerm('LGI1')).toBe(false)
    expect(isMedicationTerm('JAMA')).toBe(false)
    expect(isMedicationTerm('Dravet')).toBe(false)
    expect(isMedicationTerm('ketogenic diet')).toBe(false)
    expect(medicationEntities(['JAMA', 'valproate', 'lamotrigine', 'SCN1A'])).toEqual([
      'valproate',
      'lamotrigine',
    ])
  })
})

describe('question gates', () => {
  it('fires the safety probe on selection and safety questions only', () => {
    expect(isTreatmentDecisionQuestion('Is vigabatrin contraindicated in Dravet syndrome?'))
      .toBe(true)
    expect(
      isTreatmentDecisionQuestion('Should levetiracetam or phenytoin be given after severe TBI?'),
    ).toBe(true)
    expect(
      isTreatmentDecisionQuestion('What were the retention rates for lacosamide at 12 months?'),
    )
      .toBe(false)
    expect(isTreatmentDecisionQuestion('What is the mechanism of action of cenobamate?'))
      .toBe(false)
  })

  it('reserves the omitted-drug pointer for which-drug questions', () => {
    expect(
      isTreatmentSelectionQuestion('Which anti-seizure medications are contraindicated in Dravet?'),
    ).toBe(true)
    expect(isTreatmentSelectionQuestion('What is the cardiac safety of fenfluramine?')).toBe(false)
  })
})

describe('applicablePrequeries', () => {
  it('fills the templates with medication entities on a treatment question', () => {
    expect(
      applicablePrequeries(TEMPLATES, 'Which ASMs should be avoided in SCN1A Dravet?', [
        'SCN1A',
        'Dravet',
        'lamotrigine',
      ]),
    ).toEqual([
      'contraindications, drugs to avoid and safety monitoring for lamotrigine',
      'dose limits, starting dose and interactions for lamotrigine',
    ])
  })

  it('fires nothing for an antigen or a retention question', () => {
    expect(applicablePrequeries(TEMPLATES, 'What rituximab dose was used for NMDAR?', ['NMDAR']))
      .toEqual([])
    expect(
      applicablePrequeries(TEMPLATES, 'Retention rates for lacosamide over 12 months', [
        'lacosamide',
      ]),
    ).toEqual([])
  })

  it('falls back to the gene or syndrome on a which-drug question that names no drug', () => {
    expect(
      applicablePrequeries(
        TEMPLATES,
        'Which anti-seizure medications are contraindicated in SCN1A Dravet syndrome?',
        ['SCN1A', 'Dravet'],
      ),
    ).toEqual([
      'contraindications, drugs to avoid and safety monitoring for SCN1A, Dravet',
      'dose limits, starting dose and interactions for SCN1A, Dravet',
    ])
    expect(
      applicablePrequeries(TEMPLATES, 'Which ASMs did the JAMA study compare?', ['JAMA']),
    ).toEqual([])
  })

  it('always fires a template with no entity placeholder', () => {
    expect(applicablePrequeries(['{query} published 2025 or 2026'], 'Latest on RNS', [])).toEqual([
      'Latest on RNS published 2025 or 2026',
    ])
  })
})
