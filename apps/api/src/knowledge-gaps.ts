import { type AskInsight, WEAK_GROUNDEDNESS } from './stores.ts'
import type { UsagePeriod } from './usage-report.ts'

// ---------------------------------------------------------------------------
// This month's knowledge gaps for Insights: the questions the collection could not answer, or
// answered on weak grounding, most asked first. Question text can hold personal data, so these
// are shown to the portal's curators and administrators in Insights only, cut short, and never
// exported (the usage report carries counts alone).
// ---------------------------------------------------------------------------

/** The longest question shown, in characters; a longer one is cut short. */
export const GAP_QUESTION_MAX = 160
/** Most questions listed. */
export const TOP_GAPS = 10

/** One question this month's asks could not answer well, with how often it was asked. */
export interface TopGap {
  /** The latest phrasing, at most `GAP_QUESTION_MAX` characters. */
  question: string
  asks: number
  unanswered: number
  weaklyGrounded: number
  lastAsked: string
}

/** The month's knowledge gaps, and why there is no per-topic view. */
export interface KnowledgeGaps {
  month: string
  questions: TopGap[]
  /**
   * Evidence coverage by topic needs each question's topic. The ask log keeps the question text
   * alone, and an unanswered question has no cited source to take a topic from.
   */
  topics: null
}

/** Questions that differ only in case, spacing or closing punctuation are one question. */
function normalised(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '')
}

function shortened(question: string): string {
  // Counted and cut by code point, so a character outside the basic plane is never split.
  const characters = Array.from(question.trim().replace(/\s+/g, ' '))
  return characters.length > GAP_QUESTION_MAX
    ? `${characters.slice(0, GAP_QUESTION_MAX - 1).join('')}…`
    : characters.join('')
}

/** The period's gaps: unanswered or weakly grounded asks on its days, most asked first. */
export function knowledgeGaps(
  asks: readonly AskInsight[],
  period: UsagePeriod,
  limit = TOP_GAPS,
): KnowledgeGaps {
  const days = new Set(period.days)
  const groups = new Map<string, TopGap>()
  for (const ask of asks) {
    const at = Date.parse(ask.ts)
    if (!Number.isFinite(at) || !days.has(period.localDate(at))) continue
    const weak = ask.answered && ask.groundedness !== null &&
      ask.groundedness <= WEAK_GROUNDEDNESS
    if (ask.answered && !weak) continue
    const key = normalised(ask.question)
    if (!key) continue
    const gap = groups.get(key) ??
      { question: '', asks: 0, unanswered: 0, weaklyGrounded: 0, lastAsked: ask.ts }
    gap.asks++
    if (weak) gap.weaklyGrounded++
    else gap.unanswered++
    if (!gap.question || at >= Date.parse(gap.lastAsked)) {
      gap.question = shortened(ask.question)
      gap.lastAsked = ask.ts
    }
    groups.set(key, gap)
  }
  const questions = [...groups.values()].sort((a, b) =>
    b.asks - a.asks || Date.parse(b.lastAsked) - Date.parse(a.lastAsked)
  ).slice(0, limit)
  return { month: period.month, questions, topics: null }
}
