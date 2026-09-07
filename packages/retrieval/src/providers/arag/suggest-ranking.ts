/**
 * Query-aware ranking for the ask box's suggested questions.
 *
 * Order the tenant's suggested questions by how much they share with what the
 * reader typed. `/suggest?q=SCN1A` used to ignore its query and hand back the
 * same six canned questions for every prefix; now the ones that name the
 * typed term come first, and a query that matches nothing leaves the list in
 * its configured order rather than returning nothing.
 * Serves: R14 (PR #3).
 */

import type { Question } from '@research-portal/core'
export function rankSuggestedQuestions(questions: readonly Question[], query?: string): Question[] {
  const terms = (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
  if (terms.length === 0) return [...questions]
  const score = (q: Question): number => {
    const text = q.text.toLowerCase()
    let hits = 0
    for (const term of terms) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) hits++
    }
    return hits
  }
  const scored = questions.map((q, index) => ({ q, index, score: score(q) }))
  if (!scored.some((s) => s.score > 0)) return [...questions]
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.q)
}
