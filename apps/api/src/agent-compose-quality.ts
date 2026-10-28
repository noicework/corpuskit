import type { AgentChunk, AgentSource } from '@research-portal/core'

/** Keep the existing decline, with one nearest retrieved title per collection for a next step. */
export function closestComposeSources(
  decline: string,
  gathered: readonly { source: AgentSource; chunk: AgentChunk }[],
): string {
  const closest = new Map<string, string>()
  // Labels and titles are untrusted plain text, never links or Markdown instructions.
  const plain = (value: string) =>
    value.replace(/\s+/g, ' ').replace(/[\\`*_{}[\]()<>!|#]/g, '\\$&')
  for (const { source, chunk } of gathered) {
    if (!closest.has(source.id)) {
      closest.set(source.id, `- ${plain(source.label)}: ${plain(chunk.title)}`)
    }
  }
  return closest.size
    ? `${decline}\n\nClosest sources:\n${[...closest.values()].join('\n')}`
    : decline
}
