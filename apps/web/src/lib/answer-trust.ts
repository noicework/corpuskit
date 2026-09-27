/**
 * The answer both research surfaces show - Ask's conversation and Search's AI
 * answer panel - folded from one `/ask` event stream. Both pages apply every
 * event through `applyAnswerEvent`, so the same stream always leaves them with
 * the same text, citations, audit and quality: the inputs to the confidence
 * label and the amber marks on unverified figures (docs/TRUST-LAYER.md,
 * section 8). Surface-specific state (stages, the route chip, the composer)
 * stays with each page.
 */
import type { AskEvent, Citation, ScoredResource } from '@research-portal/core'
import type { QualityScores } from '../components/QualityGauge.tsx'
import type { AnswerAudit } from './answer-marks.ts'

type AuditEvent = Extract<AskEvent, { type: 'audit' }>

/** Every field of the server's `audit` event, as the page keeps it. */
export function auditFromEvent(event: AuditEvent): AnswerAudit {
  return {
    figuresChecked: event.figuresChecked,
    figuresUnsupported: event.figuresUnsupported,
    yearsUnsupported: event.yearsUnsupported,
    contraindicationsUnsupported: event.contraindicationsUnsupported,
    sentencesChecked: event.sentencesChecked,
    sentencesCited: event.sentencesCited,
    denominatorsMissing: event.denominatorsMissing ?? [],
    attributionsCorrected: event.attributionsCorrected ?? [],
    sentencesRemoved: event.sentencesRemoved ?? 0,
    figuresRemoved: event.figuresRemoved ?? [],
    figuresRescued: event.figuresRescued ?? [],
    sentencesReplaced: event.sentencesReplaced ?? 0,
    figuresSecondhandRemoved: event.figuresSecondhandRemoved ?? [],
    denominatorsCorrected: event.denominatorsCorrected ?? [],
  }
}

/** The part of an answer that one stream decides, whichever surface shows it. */
export interface StreamedAnswer {
  text: string
  citations: Citation[]
  sources: ScoredResource[]
  quality?: QualityScores
  audit?: AnswerAudit
  refused?: boolean
  /** The generation stopped mid-sentence and was cut back to its last complete sentence. */
  truncated?: boolean
}

export const EMPTY_ANSWER: StreamedAnswer = { text: '', citations: [], sources: [] }

/**
 * One stream event applied to the answer. Events that say nothing about the
 * answer itself (stages, routing, usage) return it unchanged, so a surface can
 * pass every event through and handle its own extras beside it.
 */
export function applyAnswerEvent<T extends StreamedAnswer>(answer: T, event: AskEvent): T {
  switch (event.type) {
    case 'sources':
      return { ...answer, sources: event.resources }
    case 'delta':
      return { ...answer, text: answer.text + event.text }
    case 'citation':
      return answer.citations.some((citation) => citation.index === event.citation.index)
        ? answer
        : { ...answer, citations: [...answer.citations, event.citation] }
    case 'quality':
      return {
        ...answer,
        quality: {
          answerRelevance: event.answerRelevance,
          groundedness: event.groundedness,
          contextRelevance: event.contextRelevance,
        },
      }
    case 'audit':
      return { ...answer, audit: auditFromEvent(event) }
    case 'fallback':
      // A fresh answer follows on another configuration: whatever the first
      // attempt streamed is discarded so the two never read as one answer.
      return { ...answer, text: '', sources: [], citations: [], audit: undefined }
    case 'done':
      return {
        ...answer,
        // The citation-bound, gated text replaces the streamed accumulation;
        // a refusal may carry none, and the streamed text then stands.
        text: event.text ?? answer.text,
        refused: event.refused ?? false,
        truncated: event.truncated === true,
      }
    default:
      return answer
  }
}
