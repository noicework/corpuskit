import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { tenantCopy } from './tenant-copy.ts'

const neuro = {
  topics: [
    { id: 'forecasting', label: 'Seizure forecasting and cycles' },
    { id: 'genetics', label: 'Genetics and genomics' },
    { id: 'asm', label: 'Antiseizure medications' },
    { id: 'eeg', label: 'EEG and neurophysiology' },
  ],
  suggestedQuestions: [
    {
      id: 'q1',
      text: 'What are the common clinical misconceptions about multiday seizure cycles?',
    },
  ],
}

describe('tenantCopy', () => {
  it('derives every example from the portal itself - no other tenant leaks in', () => {
    const copy = tenantCopy(neuro)
    expect(copy.investigationExample).toBe(
      'e.g. What are the common clinical misconceptions about multiday seizure cycles?',
    )
    expect(copy.generateExample('comparison')).toBe(
      'e.g. Compare seizure forecasting and cycles with genetics and genomics',
    )
    expect(copy.generateExample('faq')).toBe('e.g. Common questions about EEG and neurophysiology')
    for (const kind of ['briefing', 'timeline', 'proscons', 'assessment'] as const) {
      expect(copy.generateExample(kind)).not.toMatch(/farming|tillage|grain|drought|soil/)
    }
  })

  it('reads title-case labels mid-sentence without breaking initialisms', () => {
    const copy = tenantCopy({
      topics: [
        { id: 'a', label: 'Epilepsy Research' },
        { id: 'b', label: 'EEG and Neurophysiology' },
      ],
      suggestedQuestions: [],
    })
    expect(copy.generateExample('briefing')).toBe(
      'e.g. Brief me on the current state of epilepsy research',
    )
    expect(copy.generateExample('timeline')).toBe(
      'e.g. Timeline of EEG and neurophysiology research',
    )
  })

  it('lets the tenant override any of them', () => {
    const copy = tenantCopy({
      ...neuro,
      copy: {
        investigationExample: 'e.g. Is cenobamate worth the wait?',
        generateExamples: { comparison: 'e.g. Compare cenobamate with brivaracetam' },
      },
    })
    expect(copy.investigationExample).toBe('e.g. Is cenobamate worth the wait?')
    expect(copy.generateExample('comparison')).toBe('e.g. Compare cenobamate with brivaracetam')
    expect(copy.generateExample('faq')).toBe('e.g. Common questions about EEG and neurophysiology')
  })

  it('still reads sensibly on a portal with no topics or questions', () => {
    const copy = tenantCopy({ topics: [], suggestedQuestions: [] })
    expect(copy.investigationExample).toBe('e.g. What does the evidence say about ...?')
    expect(copy.generateExample('comparison')).toBe('e.g. Compare two approaches from the research')
    expect(copy.generateExample('briefing')).toBe(
      'e.g. Brief me on the current state of a topic from the research',
    )
  })
})
