import type { GenerateKind, TenantConfig } from '@research-portal/core'

/**
 * Example copy for the portal's forms and headings. Every string has a
 * default derived from the tenant's own suggested questions and topics, so a
 * portal never shows another portal's examples ("controlled traffic
 * farming" in an epilepsy portal); `config.copy` overrides any of them.
 */
export interface TenantCopy {
  /** Placeholder for a new investigation's name. */
  investigationExample: string
  /** Placeholder for a Generate kind's brief. */
  generateExample: (kind: GenerateKind) => string
}

type CopySource = Pick<TenantConfig, 'suggestedQuestions' | 'topics'> & {
  copy?: TenantConfig['copy']
}

/**
 * A topic label as it reads mid-sentence: "Epilepsy Research" and "Genetics
 * and genomics" both become lower case; an initialism ("EEG", "GABA") keeps
 * its capitals.
 */
function midSentence(label: string): string {
  return label
    .split(' ')
    .map((word) => {
      const second = word.charAt(1)
      return second && second === second.toLowerCase() ? word.toLowerCase() : word
    })
    .join(' ')
}

const GENERIC_TOPIC = 'a topic from the research'

export function tenantCopy(config: CopySource): TenantCopy {
  const custom = config.copy ?? {}
  const topics = config.topics.map((t) => midSentence(t.label))
  const topic = (index: number): string =>
    topics[index % Math.max(1, topics.length)] ?? GENERIC_TOPIC
  const question = config.suggestedQuestions[0]?.text
  const generateDefaults: Record<GenerateKind, string> = {
    comparison: topics.length >= 2
      ? `e.g. Compare ${topic(0)} with ${topic(1)}`
      : 'e.g. Compare two approaches from the research',
    briefing: `e.g. Brief me on the current state of ${topic(0)}`,
    timeline: `e.g. Timeline of ${topic(1)} research`,
    proscons: `e.g. Pros and cons of the main approaches to ${topic(2)}`,
    faq: `e.g. Common questions about ${topic(3)}`,
    assessment: `e.g. Quiz me on the basics of ${topic(0)}`,
  }
  return {
    investigationExample: custom.investigationExample ??
      (question ? `e.g. ${question}` : 'e.g. What does the evidence say about ...?'),
    generateExample: (kind) => custom.generateExamples?.[kind] ?? generateDefaults[kind],
  }
}
