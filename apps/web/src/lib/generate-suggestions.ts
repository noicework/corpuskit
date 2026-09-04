import type { GenerateKind, Topic } from '@research-portal/core'

/** A single suggested-topic chip: a stable React key and the exact prompt text it fills in. */
export interface SuggestionChip {
  key: string
  text: string
}

/** Chips shown at once - enough to feel generous without crowding the input. */
const MAX_CHIPS = 6

/**
 * An even spread across `items` rather than always the first N, so a tenant
 * with a long topic list still shows variety instead of the same handful
 * every time.
 */
function spreadPick<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return []
  if (items.length <= count) return items
  const step = items.length / count
  const picked: T[] = []
  for (let i = 0; i < count; i++) {
    const item = items[Math.floor(i * step)]
    if (item !== undefined) picked.push(item)
  }
  return picked
}

/**
 * Up to `MAX_CHIPS` distinct topic pairs for the comparison kind, drawn from
 * a spread of the tenant's topics. Fewer than two topics configured means no
 * pair can be formed, so it yields nothing rather than comparing a topic
 * with itself.
 */
function comparisonPairs(topics: Topic[]): [Topic, Topic][] {
  if (topics.length < 2) return []
  const pool = spreadPick(topics, Math.min(topics.length, MAX_CHIPS * 2))
  const pairs: [Topic, Topic][] = []
  for (let i = 0; i < pool.length && pairs.length < MAX_CHIPS; i += 2) {
    const a = pool[i]
    const b = pool[i + 1] ?? pool[0]
    if (a && b && a.id !== b.id) pairs.push([a, b])
  }
  return pairs
}

/**
 * Suggested-topic chips for the Generate page's prompt input, one per
 * artefact kind's natural phrasing, grounded in the tenant's real topics
 * rather than generic placeholders. Empty when the tenant has no topics
 * configured (or, for comparison, fewer than the two needed to form a
 * pair) - the caller hides the chip row in that case rather than rendering
 * nothing useful.
 */
export function suggestedTopicChips(kind: GenerateKind, topics: Topic[]): SuggestionChip[] {
  if (kind === 'comparison') {
    return comparisonPairs(topics).map(([a, b]) => ({
      key: `${a.id}::${b.id}`,
      text: `Compare ${a.label} and ${b.label}`,
    }))
  }

  const picked = spreadPick(topics, Math.min(topics.length, MAX_CHIPS))

  switch (kind) {
    case 'briefing':
      return picked.map((t) => ({ key: t.id, text: `Brief me on ${t.label}` }))
    case 'timeline':
      return picked.map((t) => ({ key: t.id, text: `Timeline of ${t.label}` }))
    case 'proscons':
      return picked.map((t) => ({ key: t.id, text: `Pros and cons of ${t.label}` }))
    case 'faq':
      return picked.map((t) => ({ key: t.id, text: `FAQ about ${t.label}` }))
    case 'assessment':
      return picked.map((t) => ({ key: t.id, text: `Test my knowledge of ${t.label}` }))
    default:
      return []
  }
}
