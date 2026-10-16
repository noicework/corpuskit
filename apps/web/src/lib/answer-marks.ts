import { englishResearchUi, type ResearchUi } from './research-copy.ts'
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
  /** Figures found in a retrieved or prior-turn paper's own text after the cited passages failed them. */
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
export function auditBadge(audit: AnswerAudit | undefined, ui: ResearchUi = englishResearchUi): {
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
  const checked = ui(audit.figuresChecked === 1 ? '1 figure checked' : '{count} figures checked', {
    count: audit.figuresChecked,
  })
  const cited = typeof audit.sentencesChecked === 'number' && audit.sentencesChecked > 0 &&
      typeof audit.sentencesCited === 'number'
    ? ' ' +
      ui('{cited} of {total} sentences carry a citation.', {
        cited: audit.sentencesCited,
        total: audit.sentencesChecked,
      })
    : ''
  const denominators = (audit.denominatorsMissing ?? []).length > 0
    ? ' ' +
      ui('Stated without a denominator: {figures}.', {
        figures: (audit.denominatorsMissing ?? []).map(figureLabel).join(', '),
      })
    : ''
  const replaced = audit.sentencesReplaced ?? 0
  const rescued = (audit.figuresRescued ?? []).map(figureLabel)
  const found = rescued.length > 0
    ? ' ' +
      ui(
        rescued.length === 1
          ? 'One figure ({figures}) was found in a retrieved paper the platform had not cited, which now carries the marker.'
          : '{count} figures ({figures}) were found in a retrieved paper the platform had not cited, which now carries the marker.',
        { count: rescued.length, figures: rescued.join(', ') },
      )
    : ''
  const quoted = replaced > 0
    ? ' ' +
      ui(
        replaced === 1
          ? "One sentence whose figures could not be verified was replaced by the named paper's own words, quoted and cited."
          : "{count} sentences whose figures could not be verified were replaced by the named paper's own words, quoted and cited.",
        { count: replaced },
      )
    : ''
  const replacedLabel = replaced > 0
    ? ui(replaced === 1 ? ' · 1 sentence replaced' : ' · {count} sentences replaced', {
      count: replaced,
    })
    : ''
  const secondhand = (audit.figuresSecondhandRemoved ?? []).map(figureLabel)
  const corrected = audit.denominatorsCorrected ?? []
  const secondhandNote = secondhand.length > 0
    ? ' ' +
      ui(
        secondhand.length === 1
          ? 'One figure ({figures}) was removed because the cited paper carries it only where it cites other studies.'
          : '{count} figures ({figures}) were removed because the cited paper carries them only where it cites other studies.',
        { count: secondhand.length, figures: secondhand.join(', ') },
      )
    : ''
  const correctedNote = corrected.length > 0
    ? ' ' +
      ui(
        corrected.length === 1
          ? "One denominator was corrected to the cited passage's own pairing: {figures}."
          : "{count} denominators were corrected to the cited passage's own pairing: {figures}.",
        { count: corrected.length, figures: corrected.join('; ') },
      )
    : ''
  if (unsupported === 0 && stripped === 0 && removed === 0) {
    return {
      label: `${checked}${replacedLabel}`,
      tone: replaced > 0 ? 'warn' : 'ok',
      title: ui('Every figure in this answer was found beside its claim in a cited passage.') +
        found + quoted + correctedNote + cited + denominators,
    }
  }
  if (unsupported === 0 && stripped === 0) {
    const figures = (audit.figuresRemoved ?? []).map(figureLabel).join(', ')
    return {
      label: ui(
        removed === 1
          ? '{checked} · 1 sentence removed{replaced}'
          : '{checked} · {count} sentences removed{replaced}',
        { checked, count: removed, replaced: replacedLabel },
      ),
      tone: 'warn',
      title: ui(
        removed === 1
          ? 'One sentence was removed because no retrieved passage carries its figures beside the claim{figures}. Every figure still in the answer was found beside its claim.'
          : '{count} sentences were removed because no retrieved passage carries their figures beside the claim{figures}. Every figure still in the answer was found beside its claim.',
        { count: removed, figures: figures ? ` (${figures})` : '' },
      ) + secondhandNote + found + quoted + correctedNote + cited + denominators,
    }
  }
  const parts: string[] = []
  if (unsupported > 0) {
    parts.push(
      ui('{unsupported} of {total} unverified', {
        unsupported,
        total: audit.figuresChecked + audit.yearsUnsupported.length,
      }),
    )
  }
  if (stripped > 0) {
    parts.push(ui(
      stripped === 1
        ? '1 unsupported contraindication removed'
        : '{count} unsupported contraindications removed',
      { count: stripped },
    ))
  }
  const detail: string[] = []
  if (audit.figuresUnsupported.length > 0) {
    detail.push(
      ui('Figures not found beside their claim: {figures}.', {
        figures: audit.figuresUnsupported.map(figureLabel).join(', '),
      }),
    )
  }
  if (audit.yearsUnsupported.length > 0) {
    detail.push(
      ui('Years the cited resources do not carry: {years}.', {
        years: audit.yearsUnsupported.join(', '),
      }),
    )
  }
  if (stripped > 0) {
    detail.push(
      ui('Contraindication claims no cited passage states: {claims}.', {
        claims: audit.contraindicationsUnsupported.join(', '),
      }),
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
