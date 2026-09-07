import type { QualityScores } from '../components/QualityGauge.tsx'
import type { AnswerAudit } from './answer-marks.ts'

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
  /**
   * What decided the state: the portal's own audit of the answer against
   * the cited texts (figures beside their claims, sentences bound to a
   * passage) or, when there was nothing to audit, the platform's REMi
   * groundedness score. Named so the two signals never read as one.
   */
  basis: 'audit' | 'remi' | 'none'
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
export function isThinlyGrounded(
  quality: QualityScores | null | undefined,
  audit?: AnswerAudit,
): boolean {
  return assessConfidence(quality, audit).state === DEEP_REANSWER_CONFIDENCE
}

/**
 * The audit's verdict, when it checked anything: figures that the cited
 * passages do not carry beside their claim, or contraindications no source
 * states, make the answer `low`; sentences the gate removed cap it at
 * `moderate` (what remains has passed, but the answer is not whole); every
 * figure found and most sentences bound to a passage make it `high`;
 * figures found but half the sentences uncited is `moderate`. Null when
 * the audit had nothing to judge by (no figures, no sentences), so the
 * platform score decides instead.
 */
export function auditConfidence(audit: AnswerAudit | undefined): ConfidenceState | null {
  if (!audit) return null
  const unsupported = audit.figuresUnsupported.length + audit.yearsUnsupported.length +
    audit.contraindicationsUnsupported.length
  if (unsupported > 0) return 'low'
  const checked = audit.sentencesChecked ?? 0
  const cited = audit.sentencesCited ?? 0
  const removed = audit.sentencesRemoved ?? 0
  if (audit.figuresChecked === 0 && checked === 0 && removed === 0) return null
  const citedRate = checked > 0 ? cited / checked : 1
  if (removed > 0) return citedRate >= 0.5 ? 'moderate' : 'low'
  if (audit.figuresChecked > 0 && citedRate >= 0.5) return 'high'
  if (audit.figuresChecked > 0 || citedRate >= 0.5) return 'moderate'
  return 'low'
}

/** The order the states rank in, for "never higher than". */
const RANK: Record<ConfidenceState, number> = { unscored: 0, low: 1, moderate: 2, high: 3 }

function lowerOf(a: ConfidenceState, b: ConfidenceState): ConfidenceState {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * The overall state: the portal's own audit leads whenever it judged
 * anything, and the platform's REMi scores may only lower it - a
 * groundedness in the bad band takes an audited `high` down to `moderate`,
 * never up. Without an audit verdict the REMi scores decide, capped at
 * `moderate`: "High confidence" is earned only by checking the answer
 * against the cited texts, never by a score alone (D2-15).
 */
export function assessConfidence(
  quality: QualityScores | null | undefined,
  audit?: AnswerAudit,
): Confidence {
  const audited = auditConfidence(audit)
  const groundedness = quality?.groundedness
  if (audited) {
    const state = groundedness !== null && groundedness !== undefined &&
        bandOf(groundedness) === 'bad'
      ? lowerOf(audited, 'moderate')
      : audited
    return { state, label: LABELS[state], basis: 'audit' }
  }
  if (groundedness === null || groundedness === undefined) {
    return { state: 'unscored', label: LABELS.unscored, basis: 'none' }
  }

  const groundednessBand = bandOf(groundedness)
  const answerRelevance = quality?.answerRelevance
  const answerBand = answerRelevance === null || answerRelevance === undefined
    ? null
    : bandOf(answerRelevance)

  if (groundednessBand === 'bad') {
    return { state: 'low', label: LABELS.low, basis: 'remi' }
  }

  if (groundednessBand === 'warn') {
    const state: ConfidenceState = answerBand === 'bad' ? 'low' : 'moderate'
    return { state, label: LABELS[state], basis: 'remi' }
  }

  // groundednessBand === 'ok': never `high` on the platform score alone.
  return { state: 'moderate', label: LABELS.moderate, basis: 'remi' }
}
