/**
 * The one extra ask a research question may cost (D3-05). A refusal used to
 * walk a chain - the general configuration, then the default without
 * prequeries, then the pinned paper - and the provider retried once more
 * inside each, so a question the corpus does not answer took four platform
 * asks and up to 37 seconds to say so. Now a refusal buys at most one more
 * retrieval, chosen for the reason the first pass failed, and the refusal
 * is accepted when none applies.
 */
export type RetryKind = 'supplements' | 'pinned' | 'prequeries' | 'unpinned'

export interface RetryContext {
  /** Document chat never retries: the document either answers or it does not. */
  documentScope: boolean
  /** The extra ask has been spent. */
  extraAttemptUsed: boolean
  /** Papers the question names, pinned into the grounding set. */
  pinnedIds: readonly string[]
  /** Resources the failed pass cited before binding - a pinned paper among them was read already. */
  citedIds: readonly string[]
  /** The current attempt ran on a supplements-only configuration. */
  supplementsOnly: boolean
  /** The current attempt's intent, and the tenant's default intent. */
  currentIntent: string | undefined
  defaultIntent: string | undefined
  /** How many prequeries the current attempt carried. */
  prequeries: number
  /** The strongest retrieval relevance seen on the current attempt, and the cut that reads as "the generator, not the corpus, said no". */
  bestRelevance: number
  strongMatch: number
  /** The current attempt pinned the session's earlier papers into a follow-up's grounding set. */
  priorPinned?: boolean
  /** The current attempt scoped retrieval to the earlier papers alone (a follow-up that stays within them, D5-06). */
  priorScoped?: boolean
  /** A retrieved paper that carries the terse question's own terms, when nothing was pinned (D5-09). */
  topicPinId?: string
  /**
   * Retrieval was pinned to the papers the question names (name-pin.ts).
   * The first pass then read the pinned paper through a paragraph budget;
   * the retry reads it whole (`rag_strategies: full_resource`), so it sees
   * what the first pass did not and is worth making even though the pinned
   * paper was already cited (D7-04: the same SUDEP question answers under
   * one wording and withholds under a synonym).
   */
  pinScoped?: boolean
}

/**
 * Which extra ask to make, or null to accept the refusal. `refused` is the
 * generator declining outright; `uncited` is an answer whose every marker
 * the binding stripped, where only a document-scoped read of the named
 * paper can help. The pinned retry is skipped when the first pass already
 * cited the pinned paper: reading it again produces the same figures the
 * gate just rejected.
 */
export function nextRetry(ctx: RetryContext, reason: 'refused' | 'uncited'): RetryKind | null {
  if (ctx.documentScope || ctx.extraAttemptUsed) return null
  const pinnable = ctx.pinnedIds.length > 0 &&
    (ctx.pinScoped || !ctx.pinnedIds.some((id) => ctx.citedIds.includes(id)))
  // A terse question the generator refused, or answered with another
  // paper's figures, while a retrieved paper carries the question's own
  // terms: read that paper directly before declining (D5-09).
  const topicPinnable = !pinnable && ctx.pinnedIds.length === 0 && Boolean(ctx.topicPinId) &&
    !ctx.citedIds.includes(ctx.topicPinId!)
  if (reason === 'uncited') return pinnable || topicPinnable ? 'pinned' : null
  // The data sheets matched on words but held no answer: the general
  // configuration is the right place to ask, whatever else applies.
  if (ctx.currentIntent && ctx.supplementsOnly) return 'supplements'
  if (pinnable || topicPinnable) return 'pinned'
  // A follow-up scoped to the earlier turns' papers that refused: when
  // the scoped retrieval matched strongly, the paper is the one and the
  // generator, not the corpus, said no, so it is read alone with its own
  // sections and the firmer directive; otherwise the question reaches
  // beyond the earlier papers after all and the whole collection is asked
  // once (D5-06). A follow-up that merely pinned them and refused over a
  // strong match has the latter remedy: their paragraphs crowded out the
  // paper it asks about ("now add lacosamide").
  if (ctx.priorScoped) return ctx.bestRelevance >= ctx.strongMatch ? 'pinned' : 'unpinned'
  if (ctx.priorPinned && ctx.bestRelevance >= ctx.strongMatch) return 'unpinned'
  // A strong match was retrieved and the generator still declined: the
  // prequeries or a narrower configuration crowded the grounding set.
  // Dropping the default intent with no prequeries changes nothing, so
  // that case is a refusal to accept rather than an ask to repeat.
  const narrowed = ctx.prequeries > 0 ||
    (ctx.currentIntent !== undefined && ctx.currentIntent !== ctx.defaultIntent)
  if (ctx.bestRelevance >= ctx.strongMatch && narrowed) return 'prequeries'
  return null
}

/**
 * The directive the one retry adds to the prompt: the platform's own
 * guardrail refuses over a relevant grounding set, and a firmer instruction
 * is the retry the provider used to make on its own (now folded into the
 * application's single extra ask, so the two never stack).
 */
export const RETRY_DIRECTIVE =
  'Relevant sources were retrieved for this exact question: answer directly from them, ' +
  'reporting what they state, rather than declining.'
