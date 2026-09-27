/**
 * How a cited answer reads on the page, shared by Ask and Search so the two
 * surfaces can never mark an answer differently: linked `[n]` markers, the
 * amber marks on figures the audit could not find beside their claim, the
 * model's "(inference)" hedge, the audit badge and the truncation notice.
 * Block structure comes from `AnswerMarkdown`; the inline pass here runs on
 * its plain-text runs.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Citation, ScoredResource } from '@research-portal/core'
import {
  type AnswerAudit,
  auditBadge,
  isUnsupportedFigure,
  unsupportedFigurePattern,
} from '../lib/answer-marks.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { citationHref, InferenceMark } from './AnswerStream.tsx'

export interface InlineOptions {
  /** Matches the figures the audit could not find beside their claim (`unsupportedFigurePattern`). */
  unsupported: RegExp | null
  /**
   * The answer is still streaming. A marker with no citation to bind to is
   * then the model's own provisional numbering, never shown as if it were a
   * source (D2-14); the server's bound text replaces it on `done`.
   */
  streaming: boolean
  /** Added to a marker's tooltip, to say where else the reader finds the source. */
  citationHint?: string
}

/**
 * Replaces `[n]` markers in a plain-text run with superscript links to the
 * citation's deep link, marks the figures the audit could not find beside
 * their claim, and renders the model's "(inference)" hedge quietly. Runs
 * after bold and italic parsing, so it only ever sees plain text.
 */
export function renderCitationMarkers(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
  keyPrefix: string,
  options: InlineOptions,
): ReactNode[] {
  const { unsupported, streaming, citationHint } = options
  // Bracketed runs are either the answer's own citation markers (bound to a
  // source below) or a paper's citation numbers copied verbatim ("[16,17]"),
  // which mean nothing here and are dropped.
  const splitter = new RegExp(
    `(\\[\\d+(?:\\s*,\\s*\\d+)*\\]|\\[inference\\]|\\(inference\\)${
      unsupported ? `|${unsupported.source}` : ''
    })`,
    'gi',
  )
  const segments = text.split(splitter).filter((segment) => segment !== undefined)
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`
    if (/^[[(]inference[\])]$/i.test(segment)) return <InferenceMark key={key} />
    if (isUnsupportedFigure(segment, unsupported)) {
      return (
        <mark
          key={key}
          className='rounded-[var(--rp-radius-chip)] px-0.5 underline decoration-dotted decoration-[var(--rp-warn-ink)] underline-offset-2'
          style={{ backgroundColor: 'var(--rp-warn-bg)', color: 'var(--rp-warn-ink)' }}
          title='Not found beside this claim in the cited passages - verify against the source'
        >
          {segment}
        </mark>
      )
    }
    const match = /^\[(\d+)\]$/.exec(segment)
    const citationIndex = match?.[1] ? Number(match[1]) : null
    const citation = citationIndex === null
      ? undefined
      : citations.find((item) => item.index === citationIndex)
    if (citation) {
      const source = sources.find((s) => s.id === citation.resourceId)
      const matchedPassage = source?.matchedField === 'summary' ? undefined : source?.matchedPassage
      return (
        <sup key={key}>
          <Link
            to={citationHref(slug, citation.resourceId, matchedPassage, source?.matchedPage)}
            className='rp-focus rounded-[var(--rp-radius-chip)] px-0.5 font-semibold no-underline'
            style={{ color: 'var(--rp-accent-fg)' }}
            aria-label={`Source ${citationIndex}, ${citation.title}`}
            title={`Source ${citationIndex} - ${citation.title}${
              citationHint ? `; ${citationHint}` : ''
            }`}
          >
            [{citationIndex}]
          </Link>
        </sup>
      )
    }
    if (/^\[[\d,\s]+\]$/.test(segment) && (streaming || citations.length > 0)) return null
    return <span key={key}>{segment}</span>
  })
}

/** Bold and italic spans, with the citation pass inside each. */
export function renderInline(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
  keyPrefix: string,
  options: InlineOptions,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g)
  return parts.flatMap((part, index): ReactNode[] =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? [
        <strong key={`${keyPrefix}-${index}`}>
          {renderCitationMarkers(
            part.slice(2, -2),
            citations,
            sources,
            slug,
            `${keyPrefix}-${index}`,
            options,
          )}
        </strong>,
      ]
      : part.startsWith('*') && part.endsWith('*') && part.length > 2
      ? [
        <em key={`${keyPrefix}-${index}`} className='text-ink-2'>
          {renderCitationMarkers(
            part.slice(1, -1),
            citations,
            sources,
            slug,
            `${keyPrefix}-${index}`,
            options,
          )}
        </em>,
      ]
      : renderCitationMarkers(part, citations, sources, slug, `${keyPrefix}-${index}`, options)
  )
}

/** A cited answer's text, with its audit's marks. */
export function AnswerText({
  text,
  citations,
  sources,
  slug,
  audit,
  streaming,
  citationHint,
  bodyClassName,
}: {
  text: string
  citations: Citation[]
  sources: ScoredResource[]
  slug: string
  audit?: AnswerAudit
  streaming: boolean
  citationHint?: string
  bodyClassName?: string
}) {
  const options: InlineOptions = {
    unsupported: unsupportedFigurePattern(audit),
    streaming,
    ...(citationHint ? { citationHint } : {}),
  }
  return (
    <AnswerMarkdown
      text={text}
      renderInline={(run, keyPrefix) =>
        renderInline(run, citations, sources, slug, keyPrefix, options)}
      {...(bodyClassName ? { bodyClassName } : {})}
    />
  )
}

/** What the audit checked, as a badge whose tooltip names what it found and removed. */
export function AuditBadge({ audit, className = '' }: { audit?: AnswerAudit; className?: string }) {
  const badge = auditBadge(audit)
  if (!badge) return null
  return (
    <span
      className={`rp-badge ${badge.tone === 'ok' ? 'rp-badge-ok' : 'rp-badge-warn'} ${className}`}
      title={badge.title}
      data-audit-badge=''
    >
      {badge.label}
    </span>
  )
}

/** The generation stopped mid-sentence and was cut back; says so and offers the rest. */
export function TruncatedNotice(
  { onAskAgain, className = '', style }: {
    onAskAgain: () => void
    className?: string
    style?: CSSProperties
  },
) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-[var(--rp-radius)] border p-3 ${className}`}
      role='status'
      data-answer-truncated=''
      style={{ ...style, borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
    >
      <p className='text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
        The answer stopped mid-sentence. The incomplete sentence was removed; what remains is
        complete and cited. Ask again for the rest.
      </p>
      <button
        type='button'
        onClick={onAskAgain}
        className='rp-btn rp-btn-outline h-8 shrink-0 px-2 text-xs'
      >
        Ask again
      </button>
    </div>
  )
}
