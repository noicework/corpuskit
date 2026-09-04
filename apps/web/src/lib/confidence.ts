import type { QualityScores } from '../components/QualityGauge.tsx'

/**
 * Overall, plain-language confidence state for a single AI answer, derived
 * from the REMi trust signals (see docs/ARAG-DEV.md). `unscored` covers an
 * answer with no REMi at all (e.g. a stub retrieval provider in local dev,
 * or a scoring call that failed) - it is deliberately its own state rather
 * than defaulting to "moderate" or "high", because staying silent about
 * unscored confidence would look like an endorsement it never earned.
 */
export type ConfidenceState = 'unscored' | 'low' | 'moderate' | 'high'

export interface Confidence {
  state: ConfidenceState
  /** Plain-language headline, e.g. "High confidence". */
  label: string
}

const LABELS: Record<ConfidenceState, string> = {
  unscored: 'Confidence not scored',
  low: 'Low confidence',
  moderate: 'Moderate confidence',
  high: 'High confidence',
}

type Band = 'ok' | 'warn' | 'bad'

/**
 * ok/warn/bad band for a single 0-5 REMi score. Matches `QualityGauge.tsx`'s
 * own `bandColour` thresholds exactly (>=4 ok, >=2.5 warn, else bad), so the
 * mini-meters and this headline confidence state always agree about where a
 * score sits - the gauge and the banner are reading the same ruler.
 */
function bandOf(score: number): Band {
  if (score >= 4) return 'ok'
  if (score >= 2.5) return 'warn'
  return 'bad'
}

/**
 * Maps the REMi signals to one overall confidence state.
 *
 * Groundedness is the primary signal - it is the one that says whether the
 * words in the answer are actually backed by the retrieved passages, which
 * is the thing a reader most needs to know before acting on an answer. So:
 *
 *  - Missing groundedness (REMi absent, e.g. a stub provider or a failed
 *    scoring call) => `unscored`. Never guess.
 *  - Groundedness < 2.5 ("bad" band) => `low`, full stop. A well-worded,
 *    on-topic answer (high answer-relevance) built on weak grounding is
 *    still not trustworthy - this is the one hard floor in the model, so an
 *    answer never reads as more credible than its evidence supports.
 *  - Groundedness in [2.5, 4) ("warn" band) => `moderate`, UNLESS
 *    answer-relevance is also in the "bad" band, in which case the answer is
 *    both weakly grounded and off-target, so it drops to `low`.
 *  - Groundedness >= 4 ("ok" band) => `high`, UNLESS answer-relevance or
 *    context-relevance sits in the "warn" or "bad" band, in which case it is
 *    capped at `moderate` - a well-grounded answer to a weakly-matched
 *    question, or one that wanders off the question, should not read as
 *    fully trustworthy either.
 *
 * Context-relevance is the softest signal (it describes retrieval, not the
 * generated answer itself) so on its own it can only pull `high` down to
 * `moderate`, never force `low`.
 */
/**
 * The confidence state at which the assistant proactively offers a deep
 * re-answer - re-running the question against the full text of the matching
 * documents. Anchored to the `low` state (groundedness in the "bad" band, or a
 * moderately-grounded answer that is also off-target) so the offer appears on
 * exactly the answers that already carry the red "Low confidence" banner:
 * never on a healthy moderate/high answer, and never on an unscored one. One
 * ruler for both, so the banner and the offer can never disagree.
 */
export const DEEP_REANSWER_CONFIDENCE: ConfidenceState = 'low'

/**
 * Whether an answer is thinly grounded enough to proactively offer a deep
 * re-answer. Deliberately delegates to `assessConfidence` rather than
 * re-deriving its own groundedness cut-off, so this predicate and the red
 * confidence banner stay perfectly in step: a low-confidence answer always
 * carries the offer, a moderate/high one never does, and an unscored one never
 * does. Pure and side-effect free, so it is unit-tested directly.
 */
export function isThinlyGrounded(quality: QualityScores | null | undefined): boolean {
  return assessConfidence(quality).state === DEEP_REANSWER_CONFIDENCE
}

export function assessConfidence(quality: QualityScores | null | undefined): Confidence {
  const groundedness = quality?.groundedness
  if (groundedness === null || groundedness === undefined) {
    return { state: 'unscored', label: LABELS.unscored }
  }

  const groundednessBand = bandOf(groundedness)
  const answerRelevance = quality?.answerRelevance
  const contextRelevance = quality?.contextRelevance
  const answerBand = answerRelevance === null || answerRelevance === undefined
    ? null
    : bandOf(answerRelevance)
  const contextBand = contextRelevance === null || contextRelevance === undefined
    ? null
    : bandOf(contextRelevance)

  if (groundednessBand === 'bad') {
    return { state: 'low', label: LABELS.low }
  }

  if (groundednessBand === 'warn') {
    const state: ConfidenceState = answerBand === 'bad' ? 'low' : 'moderate'
    return { state, label: LABELS[state] }
  }

  // groundednessBand === 'ok'
  const secondaryWeak = answerBand === 'warn' || answerBand === 'bad' ||
    contextBand === 'warn' || contextBand === 'bad'
  const state: ConfidenceState = secondaryWeak ? 'moderate' : 'high'
  return { state, label: LABELS[state] }
}
