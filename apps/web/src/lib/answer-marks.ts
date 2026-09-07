/**
 * The per-answer audit as the page shows it: a badge that says what was
 * checked, and the inline marks on figures the cited passages do not carry.
 * The server does the checking (apps/api/src/answer-audit.ts); this only
 * turns its `audit` event into copy and a matcher for the answer text.
 */

export interface AnswerAudit {
  figuresChecked: number
  figuresUnsupported: string[]
  yearsUnsupported: string[]
  contraindicationsUnsupported: string[]
  /** Sentences the binding pass judged, and how many kept a citation. */
  sentencesChecked?: number
  sentencesCited?: number
  /** Proportions stated in a sentence with no denominator. */
  denominatorsMissing?: string[]
  /** Authors whose attribution was corrected because the cited paper lacks them. */
  attributionsCorrected?: string[]
  /** Sentences the figure gate removed because no cited passage carries their figures, and those figures. */
  sentencesRemoved?: number
  figuresRemoved?: string[]
  /** Figures found in a retrieved, prior-turn or generated text after the cited passages failed them. */
  figuresRescued?: string[]
  /** Sentences replaced by the named paper's own figure sentence, quoted and cited. */
  sentencesReplaced?: number
  /** Figures removed because the cited paper carries them only where it cites other studies. */
  figuresSecondhandRemoved?: string[]
  /** Denominators rewritten to the pairing the cited passage gives beside the figure. */
  denominatorsCorrected?: string[]
}

/** "12months" reads as "12 months" in the badge and the tooltip. */
export function figureLabel(token: string): string {
  return token.replace(/(\d)((?:month|week|year|day|hour)s)$/, '$1 $2')
}

export type AuditTone = 'ok' | 'warn'

/** The badge copy for an audit, or null when there was nothing to check. */
export function auditBadge(audit: AnswerAudit | undefined): {
  label: string
  tone: AuditTone
  title: string
} | null {
  if (!audit) return null
  const unsupported = audit.figuresUnsupported.length + audit.yearsUnsupported.length
  const stripped = audit.contraindicationsUnsupported.length
  const removed = audit.sentencesRemoved ?? 0
  if (audit.figuresChecked === 0 && unsupported === 0 && stripped === 0 && removed === 0) {
    return null
  }
  const checked = audit.figuresChecked === 1
    ? '1 figure checked'
    : `${audit.figuresChecked} figures checked`
  const cited = typeof audit.sentencesChecked === 'number' && audit.sentencesChecked > 0 &&
      typeof audit.sentencesCited === 'number'
    ? ` ${audit.sentencesCited} of ${audit.sentencesChecked} sentences carry a citation.`
    : ''
  const denominators = (audit.denominatorsMissing ?? []).length > 0
    ? ` Stated without a denominator: ${
      (audit.denominatorsMissing ?? []).map(figureLabel).join(', ')
    }.`
    : ''
  const replaced = audit.sentencesReplaced ?? 0
  const rescued = (audit.figuresRescued ?? []).map(figureLabel)
  const found = rescued.length > 0
    ? ` ${rescued.length === 1 ? 'One figure' : `${rescued.length} figures`} (${
      rescued.join(', ')
    }) ${
      rescued.length === 1 ? 'was' : 'were'
    } found in a retrieved paper the platform had not cited, which now carries the marker.`
    : ''
  const quoted = replaced > 0
    ? ` ${
      replaced === 1 ? 'One sentence' : `${replaced} sentences`
    } whose figures could not be verified ${
      replaced === 1 ? 'was' : 'were'
    } replaced by the named paper's own words, quoted and cited.`
    : ''
  const replacedLabel = replaced > 0
    ? ` · ${replaced === 1 ? '1 sentence' : `${replaced} sentences`} replaced`
    : ''
  const secondhand = (audit.figuresSecondhandRemoved ?? []).map(figureLabel)
  const corrected = audit.denominatorsCorrected ?? []
  const secondhandNote = secondhand.length > 0
    ? ` ${secondhand.length === 1 ? 'One figure' : `${secondhand.length} figures`} (${
      secondhand.join(', ')
    }) ${secondhand.length === 1 ? 'was' : 'were'} removed because the cited paper carries ${
      secondhand.length === 1 ? 'it' : 'them'
    } only where it cites other studies.`
    : ''
  const correctedNote = corrected.length > 0
    ? ` ${
      corrected.length === 1 ? 'One denominator was' : `${corrected.length} denominators were`
    } corrected to the cited passage's own pairing: ${corrected.join('; ')}.`
    : ''
  if (unsupported === 0 && stripped === 0 && removed === 0) {
    return {
      label: `${checked}${replacedLabel}`,
      tone: replaced > 0 ? 'warn' : 'ok',
      title:
        `Every figure in this answer was found beside its claim in a cited passage.${found}${quoted}${correctedNote}${cited}${denominators}`,
    }
  }
  if (unsupported === 0 && stripped === 0) {
    // The gate removed what failed: what remains has passed, and the badge
    // says both so the reader knows the answer is shorter than it was.
    const figures = (audit.figuresRemoved ?? []).map(figureLabel).join(', ')
    return {
      label: `${checked} · ${
        removed === 1 ? '1 sentence' : `${removed} sentences`
      } removed${replacedLabel}`,
      tone: 'warn',
      title: `${
        removed === 1 ? 'One sentence was' : `${removed} sentences were`
      } removed because no retrieved passage carries ${
        removed === 1 ? 'its' : 'their'
      } figures beside the claim${
        figures ? ` (${figures})` : ''
      }. Every figure still in the answer was found beside its claim.${secondhandNote}${found}${quoted}${correctedNote}${cited}${denominators}`,
    }
  }
  const parts: string[] = []
  if (unsupported > 0) {
    parts.push(
      `${unsupported} of ${audit.figuresChecked + audit.yearsUnsupported.length} unverified`,
    )
  }
  if (stripped > 0) {
    parts.push(
      stripped === 1
        ? '1 unsupported contraindication removed'
        : `${stripped} unsupported contraindications removed`,
    )
  }
  const detail: string[] = []
  if (audit.figuresUnsupported.length > 0) {
    detail.push(
      `Figures not found beside their claim: ${
        audit.figuresUnsupported.map(figureLabel).join(', ')
      }.`,
    )
  }
  if (audit.yearsUnsupported.length > 0) {
    detail.push(`Years the cited resources do not carry: ${audit.yearsUnsupported.join(', ')}.`)
  }
  if (stripped > 0) {
    detail.push(
      `Contraindication claims no cited passage states: ${
        audit.contraindicationsUnsupported.join(', ')
      }.`,
    )
  }
  return {
    label: parts.join(' · '),
    tone: 'warn',
    title: `${detail.join(' ')}${cited}${denominators}`,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A matcher for the unsupported figures and years as they appear in the
 * answer text: "1400mg" matches "1,400 mg" and "1400 mg/day", "45%"
 * matches "45 %", "2025" matches only the bare year. Null when nothing is
 * unsupported. Used with `String.split` so the match is captured.
 */
export function unsupportedFigurePattern(audit: AnswerAudit | undefined): RegExp | null {
  if (!audit) return null
  const alternatives: string[] = []
  for (const figure of audit.figuresUnsupported) {
    const m = /^(\d+(?:\.\d+)?)(%|mg(?:\/kg)?(?:\/day)?|(?:month|week|year|day|hour)s)?$/.exec(
      figure,
    )
    if (!m) continue
    const [, value, unit] = m
    const digits = value!.includes('.')
      ? escapeRegExp(value!)
      : value!.split('').join(',?').replace(/^(\d),\?/, '$1,?')
    const time = unit ? /^(month|week|year|day|hour)s$/.exec(unit) : null
    const unitPattern = unit === '%'
      ? '\\s?%'
      : time
      ? `[\\s-]?${time[1]}s?\\b`
      : unit
      ? `\\s?${escapeRegExp(unit)}`
      : ''
    alternatives.push(`(?<![\\d.])${digits}${unitPattern}(?![\\d])`)
  }
  for (const year of audit.yearsUnsupported) {
    if (/^\d{4}$/.test(year)) alternatives.push(`(?<![\\d.\\-/])${year}(?![\\d.\\-/%])`)
  }
  if (alternatives.length === 0) return null
  // Non-capturing: callers wrap it in their own splitter group, and a
  // nested capture would make `String.split` emit each match twice.
  return new RegExp(`(?:${alternatives.join('|')})`, 'g')
}

/** Whether a split segment is one of the unsupported figures (the pattern is global; test a fresh copy). */
export function isUnsupportedFigure(segment: string, pattern: RegExp | null): boolean {
  if (!pattern) return false
  return new RegExp(`^${pattern.source}$`).test(segment)
}
