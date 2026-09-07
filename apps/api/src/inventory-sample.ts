/**
 * A corpus inventory that fits inside one design prompt.
 *
 * The platform's /ask query is capped at 20,000 characters, and a prompt that
 * lists every resource overflows it on any real corpus (a 981-resource box
 * 422'd with string_too_long). The design calls - taxonomy, knowledge-graph
 * strategy - only need a representative picture of the corpus, so they get an
 * even-stride sample trimmed to a character budget, and the whole corpus is
 * handled separately by the labelling agents.
 */
export interface InventorySample<T> {
  sample: T[]
  /** True when the sample is smaller than the corpus. */
  sampled: boolean
  /** The numbered inventory lines, joined for the prompt. */
  inventory: string
}

export function sampleInventory<T>(
  resources: readonly T[],
  line: (resource: T, index: number) => string,
  budget: number,
): InventorySample<T> {
  const size = (items: readonly T[]) => items.reduce((n, r, i) => n + line(r, i).length + 1, 0)
  let sample = [...resources]
  if (size(sample) > budget) {
    // An even stride across the whole corpus keeps the sample representative
    // (newest-first catalogues would otherwise sample only the newest slice).
    const average = size(sample) / Math.max(1, sample.length)
    const stride = Math.max(1, Math.ceil(average * resources.length / budget))
    sample = resources.filter((_, i) => i % stride === 0)
    while (sample.length > 0 && size(sample) > budget) sample.pop()
  }
  return {
    sample,
    sampled: sample.length < resources.length,
    inventory: sample.map(line).join('\n'),
  }
}
