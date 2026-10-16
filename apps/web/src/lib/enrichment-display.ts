import { DEFAULT_RESEARCH_ENRICHMENT, type EnrichmentAgent } from '@research-portal/core'
import type { Locale } from './portal-locale.tsx'

/** Display projection only. Never pass this value into agent schemas, generation or storage. */
export function enrichmentDisplay(agent: EnrichmentAgent, ui: Locale['ui']): EnrichmentAgent {
  const builtIn = DEFAULT_RESEARCH_ENRICHMENT
  if (agent.id !== builtIn.id || !agent.isDefault) return agent
  return {
    ...agent,
    title: agent.title === builtIn.title ? ui(builtIn.title) : agent.title,
    description: agent.description === builtIn.description
      ? ui(builtIn.description)
      : agent.description,
    fields: agent.fields.map((field) => {
      const original = builtIn.fields.find((item) => item.key === field.key)
      return original
        ? {
          ...field,
          label: field.label === original.label ? ui(original.label) : field.label,
          description: field.description === original.description
            ? ui(original.description)
            : field.description,
        }
        : field
    }),
  }
}
