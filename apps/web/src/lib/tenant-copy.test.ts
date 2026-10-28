import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { portalStarterQuestions, tenantCopy } from './tenant-copy.ts'
import { localisePortalConfig } from './portal-locale.tsx'
import { TenantConfigSchema } from '@research-portal/core'

it('uses authored starter translations only for portals with custom interface copy', () => {
  const config = TenantConfigSchema.parse({
    slug: 'example',
    branding: {
      productName: 'Example',
      organisation: 'Example',
      tagline: 'Example records',
      colours: { primary: '#123456', accent: '#123456', heroFrom: '#123456', heroTo: '#123456' },
    },
    searchPlaceholder: 'Search',
    topics: [],
    entityTypes: [],
    relationTypes: [],
    suggestedQuestions: [{ id: 'q1', text: '架空の記録では何が報告されていますか。' }],
    languagePolicy: {
      defaultLanguage: 'ja',
      availableLanguages: ['ja', 'en'],
      translations: {
        en: { '架空の記録では何が報告されていますか。': 'What do the fictional records report?' },
      },
    },
    copy: { interfaceMessages: { en: { Graph: 'Knowledge map' } } },
  })
  const suggestions = [...config.suggestedQuestions, {
    id: 'generated',
    text: 'An additional question',
  }]
  expect(portalStarterQuestions(localisePortalConfig(config, 'en'), suggestions)).toEqual([
    { id: 'q1', text: 'What do the fictional records report?' },
    suggestions[1],
  ])
  expect(portalStarterQuestions(localisePortalConfig(config, 'ja'), suggestions)).toEqual(
    suggestions,
  )
  expect(
    portalStarterQuestions({ ...localisePortalConfig(config, 'en'), copy: undefined }, suggestions),
  )
    .toBe(suggestions)
})

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
