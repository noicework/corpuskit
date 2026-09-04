import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { GenerateKind, Topic } from '@research-portal/core'
import { suggestedTopicChips } from './generate-suggestions.ts'

const TOPICS: Topic[] = [
  { id: 'carp-control', label: 'Carp control' },
  { id: 'governance-reporting', label: 'Governance and reporting' },
  { id: 'research-development', label: 'Research and development' },
  { id: 'water-quality', label: 'Water quality' },
  { id: 'community-engagement', label: 'Community engagement' },
]

const SINGLE_TOPIC_KINDS: { kind: GenerateKind; template: (label: string) => string }[] = [
  { kind: 'briefing', template: (l) => `Brief me on ${l}` },
  { kind: 'timeline', template: (l) => `Timeline of ${l}` },
  { kind: 'proscons', template: (l) => `Pros and cons of ${l}` },
  { kind: 'faq', template: (l) => `FAQ about ${l}` },
  { kind: 'assessment', template: (l) => `Test my knowledge of ${l}` },
]

describe('suggestedTopicChips', () => {
  for (const { kind, template } of SINGLE_TOPIC_KINDS) {
    it(`builds correctly-phrased, non-empty suggestions for ${kind}`, () => {
      const chips = suggestedTopicChips(kind, TOPICS)
      expect(chips.length).toBeGreaterThan(0)
      expect(chips.length).toBeLessThanOrEqual(6)
      for (const chip of chips) {
        const matchesATopic = TOPICS.some((t) => chip.text === template(t.label))
        expect(matchesATopic).toBe(true)
        expect(chip.key.length).toBeGreaterThan(0)
      }
      // Every chip key is unique - React list rendering needs it, and it
      // rules out silently duplicating the same topic.
      expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length)
    })
  }

  it('builds "Compare A and B" pairs of two distinct topics for comparison', () => {
    // Built from the topic list itself (not a regex split on the rendered
    // text) so a topic label that happens to contain the word "and" - e.g.
    // "Governance and reporting" - can't produce a false negative.
    const validTexts = new Set(
      TOPICS.flatMap((a) =>
        TOPICS.filter((b) => b.id !== a.id).map((b) => `Compare ${a.label} and ${b.label}`)
      ),
    )

    const chips = suggestedTopicChips('comparison', TOPICS)
    expect(chips.length).toBeGreaterThan(0)
    expect(chips.length).toBeLessThanOrEqual(6)
    for (const chip of chips) {
      expect(validTexts.has(chip.text)).toBe(true)
    }
  })

  it('comparison yields nothing with fewer than two topics', () => {
    expect(suggestedTopicChips('comparison', [])).toEqual([])
    expect(suggestedTopicChips('comparison', [TOPICS[0]!])).toEqual([])
  })

  it('an empty topic list yields no suggestions for any kind', () => {
    const kinds: GenerateKind[] = [
      'comparison',
      'briefing',
      'timeline',
      'proscons',
      'faq',
      'assessment',
    ]
    for (const kind of kinds) {
      expect(suggestedTopicChips(kind, [])).toEqual([])
    }
  })

  it('never shows more than six chips even with a long topic list', () => {
    const many: Topic[] = Array.from({ length: 40 }, (_, i) => ({
      id: `topic-${i}`,
      label: `Topic ${i}`,
    }))
    for (const kind of ['comparison', 'briefing', 'assessment'] as GenerateKind[]) {
      expect(suggestedTopicChips(kind, many).length).toBeLessThanOrEqual(6)
    }
  })
})
