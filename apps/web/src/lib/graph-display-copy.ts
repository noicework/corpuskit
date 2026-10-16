import { englishResearchUi, type ResearchUi } from './research-copy.ts'

/** Display aliases only. Native graph identities, filters and authored values stay unchanged. */
const GROUP_COPY = {
  Entity: 'Entity',
  Topic: 'Topic',
  Kind: 'Kind',
  Experiment: 'Experiment',
  Material: 'Material',
  'Research topic': 'Research topic',
} as const

const RELATION_COPY = {
  examines: 'examines',
  'uses material': 'uses material',
} as const

export function graphGroupLabel(group: string, ui: ResearchUi = englishResearchUi): string {
  if (group === '') return ui('Entity')
  return Object.hasOwn(GROUP_COPY, group) ? ui(GROUP_COPY[group as keyof typeof GROUP_COPY]) : group
}

export function graphRelationLabel(label: string, ui: ResearchUi = englishResearchUi): string {
  if (label === '') return ui('related to')
  return Object.hasOwn(RELATION_COPY, label)
    ? ui(RELATION_COPY[label as keyof typeof RELATION_COPY])
    : label
}
