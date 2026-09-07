/**
 * What the Assessment page sends to /generate: a retrieval text and a brief.
 *
 * The query is also the retrieval text, so it has to read like the passages
 * the questions should come from - the findings and figures on the topic -
 * not like an instruction ("Quiz me ... generate exactly five questions"),
 * which retrieves reference lists and methodology chatter instead. Count
 * and depth therefore travel separately, as guidance the server appends to
 * the writing instructions (D1-20). Intermediate and advanced checks ask
 * for the figures and comparisons the sources report rather than
 * definitions with throwaway distractors (persona finding P8-11).
 */

export type QuestionCount = 3 | 5 | 10
export type Depth = 'foundational' | 'intermediate' | 'advanced'

export const COUNT_OPTIONS: QuestionCount[] = [3, 5, 10]

export const DEPTH_OPTIONS: { id: Depth; label: string; instruction: string }[] = [
  {
    id: 'foundational',
    label: 'Foundational',
    instruction:
      'Focus on core definitions, terminology and the basic what and why - suitable for someone new to the topic.',
  },
  {
    id: 'intermediate',
    label: 'Intermediate',
    instruction:
      'Focus on how the concepts are applied in practice and how they relate to each other - suitable for someone with working knowledge. ' +
      'Prefer numeric or comparative stems: a reported figure, proportion or effect size, or a comparison between two interventions, groups or study designs.',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    instruction:
      'Focus on nuanced distinctions, edge cases and trade-offs - suitable for a specialist. ' +
      'Every stem must turn on a specific figure, confidence interval, subgroup or head-to-head comparison the sources report, with distractors that are plausible neighbouring values or claims.',
  },
]

const DEPTH_BY_ID = new Map(DEPTH_OPTIONS.map((d) => [d.id, d]))

/** Whether a typed topic is substantial enough to build a quiz on. */
export function isUsableTopic(topic: string): boolean {
  const trimmed = topic.trim()
  return trimmed.length >= 3 && trimmed.length <= 120
}

/** The retrieval text: the topic, phrased as the results a question should turn on. */
export function buildAssessmentQuery(topicLabel: string): string {
  const topic = topicLabel.trim()
  return `${topic}: the findings, figures, outcomes, comparisons and methods reported in the results of the sources on ${topic}.`
}

/** How many spare questions to ask for, so `count` survive the source checks (D7-11). */
export function spareQuestions(count: number): number {
  return Math.max(3, Math.ceil(count / 2))
}

/** The writing brief for the quiz: how many questions, how deep, and how varied. */
export function buildAssessmentBrief(
  topicLabel: string,
  count: QuestionCount,
  depth: Depth,
): string {
  const meta = DEPTH_BY_ID.get(depth) ?? DEPTH_OPTIONS[0]!
  const topic = topicLabel.trim()
  // More than the reader asked for: the portal discards any question whose
  // quote it cannot find verbatim in the paper it is attributed to, and the
  // server trims what survives back to `count` (D6-09). Two spare was not
  // enough - loop 7 asked for six and was shown one (D7-11).
  return `Generate ${
    count + spareQuestions(count)
  } multiple-choice questions at ${meta.label.toLowerCase()} depth, ` +
    `of which at least ${count} must be answerable from a passage you quote verbatim. ` +
    `${meta.instruction} Cover a spread of sub-topics within ${topic} rather than repeating the ` +
    'same idea.'
}
