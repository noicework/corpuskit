import { englishResearchUi, type ResearchUi } from '../lib/research-copy.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { assessConfidence, type Confidence, type ConfidenceState } from '../lib/confidence.ts'
import { type AnswerAudit, figureLabel } from '../lib/answer-marks.ts'
import { useCompactViewport } from './useViewMode.ts'
import { AlertTriangle, Info, ShieldCheck, X } from './icons.tsx'
import { Button, IconButton } from './ui.tsx'

const SEGMENTS = 5

export interface QualityScores {
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}

const METRICS: { key: keyof QualityScores; label: string; description: string }[] = [
  {
    key: 'answerRelevance',
    label: 'Relevance',
    description:
      "Answer relevance: the platform's own self-assessment of how directly the answer addresses the question asked. Not the portal's check of the figures.",
  },
  {
    key: 'groundedness',
    label: 'Groundedness',
    description:
      "Groundedness: the platform's own self-assessment of how firmly the answer is supported by the retrieved material. It is not the portal's check of the figures against the cited texts, and the two can disagree.",
  },
  {
    key: 'contextRelevance',
    label: 'Context',
    description:
      "Context relevance: the platform's own self-assessment of how well the retrieved passages match the question asked.",
  },
]

/** ok/warn/bad status band for a 0-5 REMi score. */
function bandColour(score: number): string {
  if (score >= 4) return 'var(--rp-ok-ink)'
  if (score >= 2.5) return 'var(--rp-warn-ink)'
  return 'var(--rp-bad-ink)'
}

function MiniMeter(
  { label, description, score }: { label: string; description: string; score: number },
) {
  const colour = bandColour(score)
  const filled = Math.round(Math.max(0, Math.min(SEGMENTS, score)))

  return (
    <span className='inline-flex items-center gap-1.5' title={description}>
      <span className='text-2xs font-medium text-ink-3'>{label}</span>
      <span className='inline-flex items-center gap-[2px]' aria-hidden='true'>
        {Array.from({ length: SEGMENTS }).map((_, index) => (
          <span
            key={index}
            className='h-2 w-1 rounded-[var(--rp-radius)]'
            style={{ backgroundColor: index < filled ? colour : 'var(--rp-surface-3)' }}
          />
        ))}
      </span>
      <span className='text-2xs font-semibold tabular-nums' style={{ color: colour }}>
        {score.toFixed(1)}/5
      </span>
    </span>
  )
}

export interface TrustSignalsProps {
  quality: QualityScores
  /**
   * Set false where the surrounding panel already says "Answer quality" - the
   * assistant's disclosure heads its own popup, and two identical labels one
   * above the other read as a rendering bug. Defaults true, so every existing
   * caller keeps the labelled row it has.
   */
  showLabel?: boolean
}

type PresentMetric = { key: keyof QualityScores; label: string; description: string; score: number }

/**
 * Compact inline row of REMi trust signals: a shield-check icon labelled
 * "Answer quality" followed by up to three five-segment mini-meters (answer
 * relevance, groundedness, context relevance). Each metric is coloured by its
 * own ok/warn/bad band and carries a one-sentence explanation in its title
 * attribute. A null metric is skipped; if every metric is null nothing renders.
 */
export function TrustSignals({ quality, showLabel = true }: TrustSignalsProps) {
  const { ui } = usePortalLocale()
  const present: PresentMetric[] = []
  for (const metric of METRICS) {
    const score = quality[metric.key]
    if (score !== null) present.push({ ...metric, score })
  }

  if (present.length === 0) return null

  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
      {showLabel
        ? (
          <span
            className={'inline-flex items-center gap-1 text-2xs font-semibold uppercase ' +
              'tracking-wide text-ink-3'}
          >
            <ShieldCheck size='sm' />
            {ui('Platform self-assessment')}
          </span>
        )
        : null}
      {present.map((metric) => (
        <MiniMeter
          key={metric.key}
          label={ui(metric.label)}
          description={ui(metric.description)}
          score={metric.score}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Confidence indicator - the plain-language headline `TrustSignals` above
// supports. One component, four looks, all driven by `assessConfidence` (see
// apps/web/src/lib/confidence.ts) so this and the mini-meters never disagree.
// ---------------------------------------------------------------------------

/**
 * The sentence that elaborates each confidence level. Held in one place so the
 * inline pill (`ConfidenceIndicator`, still used by search and the docs
 * assistant) and the assistant's popup (`AnswerQualityDisclosure`) can never
 * tell a reader two different things about the same score.
 */
const CONFIDENCE_DETAIL: Record<ConfidenceState, string> = {
  unscored:
    'The automatic quality checks did not run for this answer, so there is no score to report. Judge it on its citations.',
  high: 'The retrieved sources support this answer well.',
  moderate:
    'The platform scores this answer as well grounded, but the portal could not check its figures against the cited texts - read the citations before relying on it.',
  low:
    'The retrieved sources only weakly support this answer. Treat it as a lead and verify against the cited sources below.',
}

export interface ConfidenceIndicatorProps {
  quality: QualityScores | null | undefined
  /**
   * The portal's own audit of the answer against the cited texts. It leads
   * the verdict whenever it checked anything, exactly as it does in
   * `AnswerQualityDisclosure`, so the same answer reads the same confidence
   * on every surface - and only an audit can earn "High confidence".
   */
  audit?: AnswerAudit
}

/**
 * The sentence behind a confidence level: what the audit found when it led
 * the verdict, otherwise the platform-score explanation. Shared by the pill
 * and the disclosure so the two never explain the same level differently.
 */
function confidenceDetail(
  confidence: Confidence,
  audit: AnswerAudit | undefined,
  ui: ResearchUi = englishResearchUi,
): string {
  const audited = auditSummary(audit, ui)
  return confidence.basis === 'audit' && audited
    ? ui('Checked against the cited texts: {detail}', {
      detail: audited.charAt(0).toLowerCase() + audited.slice(1),
    })
    : ui(CONFIDENCE_DETAIL[confidence.state])
}

/**
 * The single, unmissable, plain-language answer-confidence signal - the
 * headline `TrustSignals`' detailed mini-meters support. Renders differently
 * per state so the visual weight matches how much a reader should worry:
 *
 *  - `unscored`: a quiet inline chip - honest about missing REMi rather than
 *    defaulting to a confident look.
 *  - `high`: a quiet positive chip - confirms without shouting.
 *  - `moderate`: a lighter caution callout.
 *  - `low`: THE key piece - a bold, bordered warning banner with
 *    `role="alert"` so assistive tech announces it immediately, an icon (not
 *    colour alone), and copy that explicitly points at the evidence below.
 */
export function ConfidenceIndicator({ quality, audit }: ConfidenceIndicatorProps) {
  const { ui } = usePortalLocale()
  const confidence = assessConfidence(quality, audit)

  if (confidence.state === 'unscored') {
    return (
      <span
        className='rp-badge rp-badge-quiet inline-flex items-center gap-1'
        data-confidence={confidence.state}
      >
        <Info size='sm' />
        {ui('Confidence not scored for this answer')}
      </span>
    )
  }

  if (confidence.state === 'high') {
    return (
      <span
        className='rp-badge rp-badge-ok inline-flex items-center gap-1'
        title={confidenceDetail(confidence, audit, ui)}
        data-confidence={confidence.state}
      >
        <ShieldCheck size='sm' />
        {ui('High confidence')}
      </span>
    )
  }

  return (
    <ConfidencePill
      tone={confidence.state === 'moderate' ? 'warn' : 'bad'}
      label={ui(confidence.label)}
      detail={confidenceDetail(confidence, audit, ui)}
      state={confidence.state}
    />
  )
}

/**
 * The confidence level as a pill, with the elaboration behind a disclosure.
 *
 * The LEVEL itself stays visible - burying "low confidence" entirely would
 * weaken the one signal this product exists to give. Only the sentence
 * explaining it is tucked away, and the pill keeps `role="status"` plus an
 * icon so the warning is not carried by colour alone.
 */
function ConfidencePill(
  { tone, label, detail, state }: {
    tone: 'warn' | 'bad'
    label: string
    detail: string
    state: ConfidenceState
  },
) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={wrapRef} className='relative inline-flex' data-confidence={state}>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        aria-label={`${label}. ${detail}`}
        title={`${label}. ${detail}`}
        className={`rp-btn rp-btn-ghost rp-btn-sm rp-badge inline-flex items-center gap-1 ${
          tone === 'bad' ? 'rp-badge-bad' : 'rp-badge-warn'
        }`}
      >
        <AlertTriangle size='sm' />
        {label}
      </button>
      {open
        ? (
          <span
            role='status'
            className='rp-shadow-lg absolute left-0 top-full z-30 mt-1.5 w-72 rounded-[var(--rp-radius)] border border-line bg-surface p-3 text-xs leading-relaxed text-ink-2'
          >
            {detail}
          </span>
        )
        : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Answer quality disclosure - one control on the answer's actions row that
// opens the confidence headline, the REMi meters and the grounding advice
// together.
//
// Those three used to stack as full-width blocks between the answer and the
// actions row. On a phone that is most of a screen of chrome after every
// answer, and it is chrome a reader mostly scrolls past.
//
// Confidence always leads with its full label. When space is tight, the action
// group wraps below it so the reader can still see the answer's trust level.
// Opening the badge restores the explanation and quality scores.
// ---------------------------------------------------------------------------

/** The focusable descendants of a panel, in tab order. */
function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return [
    ...panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ]
}

/** Confidence stays visible in the toolbar through the badge's state and name. */
const TRIGGER_TONE: Record<ConfidenceState, 'quiet' | 'ok' | 'warn' | 'bad'> = {
  high: 'ok',
  unscored: 'quiet',
  moderate: 'warn',
  low: 'bad',
}

export interface AnswerQualityDisclosureProps {
  quality: QualityScores | null | undefined
  /**
   * The portal's own audit of the answer against the cited texts. When it
   * checked anything it decides the headline; the platform score then reads
   * as the secondary signal it is, so the two never contradict each other.
   */
  audit?: AnswerAudit
  /**
   * Present only when a deep re-answer is genuinely on offer for this answer -
   * the caller owns that decision, because it turns on message state (already
   * deep, already dismissed) this component cannot see.
   */
  onReanswerDeeply?: () => void
  /**
   * Set when the answer outruns its passages but the deep re-answer is not on
   * offer (already taken, or this already is a deep answer). Same advice, no
   * action to go with it.
   */
  sparselyGrounded?: boolean
}

/**
 * The trigger plus its panel, rendered as a single inline control so it drops
 * into the answer's actions row beside copy/retry/watch with no layout of its
 * own. Entrance reuses `rp-answer-tail` (the `rp-stage-in` keyframes on the
 * shared `--rp-stage-i` stagger), so it needs no CSS of its own and honours
 * `prefers-reduced-motion` through that rule.
 *
 * Below `sm` the panel is a modal bottom sheet portalled to the body, and above
 * it an anchored dropdown - the shape the "Save to investigation" picker
 * arrived at, for the same reason: this trigger sits at the right of a row, so
 * a 20rem panel anchored to it on a phone runs off the edge and up over the
 * site header. The breakpoint comes from the shared `useCompactViewport`, which
 * matches Tailwind's own `sm` rather than guessing at a `max-width` epsilon.
 */
/** What the audit found, in one sentence, for the disclosure panel. */
export function auditSummary(
  audit: AnswerAudit | undefined,
  ui: ResearchUi = englishResearchUi,
): string | null {
  if (!audit) return null
  const parts: string[] = []
  const unsupported = audit.figuresUnsupported.length + audit.yearsUnsupported.length
  if (audit.figuresChecked > 0) {
    parts.push(
      unsupported === 0
        ? ui(
          audit.figuresChecked === 1
            ? '{count} figure found beside its claim in the cited passages'
            : '{count} figures found beside their claims in the cited passages',
          { count: audit.figuresChecked },
        )
        : ui('{unsupported} of {total} figures not found beside their claim: {figures}', {
          unsupported,
          total: audit.figuresChecked + audit.yearsUnsupported.length,
          figures: [...audit.figuresUnsupported, ...audit.yearsUnsupported].map(figureLabel).join(
            ', ',
          ),
        }),
    )
  }
  if ((audit.sentencesRemoved ?? 0) > 0) {
    const removed = audit.sentencesRemoved!
    const figures = (audit.figuresRemoved ?? []).map(figureLabel).join(', ')
    parts.push(
      ui(
        removed === 1
          ? '{count} sentence removed because no cited passage carries its figures beside the claim{figures}'
          : '{count} sentences removed because no cited passage carries their figures beside the claim{figures}',
        { count: removed, figures: figures ? ` (${figures})` : '' },
      ),
    )
  }
  if (typeof audit.sentencesChecked === 'number' && audit.sentencesChecked > 0) {
    parts.push(
      ui('{cited} of {total} sentences carry a citation', {
        cited: audit.sentencesCited ?? 0,
        total: audit.sentencesChecked,
      }),
    )
  }
  if (audit.contraindicationsUnsupported.length > 0) {
    const count = audit.contraindicationsUnsupported.length
    parts.push(
      ui(
        count === 1
          ? '{count} unsupported contraindication removed'
          : '{count} unsupported contraindications removed',
        { count },
      ),
    )
  }
  if ((audit.denominatorsMissing ?? []).length > 0) {
    parts.push(
      ui('stated without a denominator: {figures}', {
        figures: audit.denominatorsMissing!.map(figureLabel).join(', '),
      }),
    )
  }
  if ((audit.attributionsCorrected ?? []).length > 0) {
    parts.push(
      ui('attribution corrected for {figures}', {
        figures: audit.attributionsCorrected!.join(', '),
      }),
    )
  }
  if (parts.length === 0) return null
  const sentence = parts.join('; ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.'
}

export function AnswerQualityDisclosure(
  { quality, audit, onReanswerDeeply, sparselyGrounded = false }: AnswerQualityDisclosureProps,
) {
  const { ui } = usePortalLocale()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const compact = useCompactViewport()

  // Escape and outside taps dismiss. The sheet is portalled to the body, so
  // "inside" has to mean the trigger OR the panel; without the second test the
  // sheet's own taps would read as outside clicks and close it.
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus in on open, back to the trigger on close - but only when the panel
  // still held it. A click that landed on another control has already moved
  // focus deliberately and yanking it back would fight the reader; a panel that
  // closes while focused drops focus to <body>, which is the case worth
  // rescuing.
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    return () => {
      const active = document.activeElement
      if (!active || active === document.body) triggerRef.current?.focus()
    }
  }, [open])

  function trapTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = focusablesIn(panel)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const confidence = assessConfidence(quality, audit)
  const detail = confidenceDetail(confidence, audit, ui)
  const tone = TRIGGER_TONE[confidence.state]
  const loud = tone === 'warn' || tone === 'bad'
  const Glyph = loud ? AlertTriangle : confidence.state === 'high' ? ShieldCheck : Info

  const body = (
    <>
      <div className='flex items-start gap-2'>
        <span
          className='mt-px shrink-0'
          style={{ color: loud ? `var(--rp-${tone}-ink)` : 'var(--rp-ink-3)' }}
        >
          <Glyph size='md' />
        </span>
        <div className='min-w-0'>
          <p className='text-sm font-semibold text-ink'>{ui(confidence.label)}</p>
          <p className='mt-1 text-xs leading-relaxed text-ink-2'>{detail}</p>
        </div>
      </div>

      {quality
        ? (
          <div className='mt-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 px-3 py-2.5'>
            {confidence.basis === 'audit'
              ? (
                <p className='mb-2 text-xs leading-relaxed text-ink-3'>
                  {ui(
                    "The platform's self-assessment, shown for reference - it scores its own answer and can disagree with the check above, which is the portal's own audit of the figures against the cited texts.",
                  )}
                </p>
              )
              : null}
            <TrustSignals quality={quality} showLabel={false} />
          </div>
        )
        : null}

      {
        /* The remedy sits with the diagnosis that motivates it. A reader who has
        * not registered that the answer is thinly grounded has no reason to want
        * a deep re-answer, so a bare "Re-answer deeply" button out on the actions
        * row would be an action stripped of its reason. The loud trigger is what
        * keeps it from being missed: it is the alarm, this is the remedy behind
        * it. */
      }
      {onReanswerDeeply
        ? (
          <div
            className='mt-3 rounded-[var(--rp-radius)] border p-3'
            style={{ borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
          >
            <p className='text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
              {ui('This answer is thinly grounded - re-answer with full-document context?')}
            </p>
            <Button
              variant='outline'
              size='sm'
              leadingIcon={ShieldCheck}
              onClick={() => {
                setOpen(false)
                onReanswerDeeply()
              }}
              className='mt-2'
            >
              {ui('Re-answer deeply')}
            </Button>
          </div>
        )
        : sparselyGrounded
        ? (
          <p className='mt-3 text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
            {ui(
              'Parts of this answer go beyond the retrieved passages - open the retrieved sources below to check it before relying on it.',
            )}
          </p>
        )
        : null}
    </>
  )

  const panel = compact
    ? createPortal(
      <div className='fixed inset-0 z-[80]'>
        <div
          aria-hidden='true'
          className='rp-answer-tail rp-scrim absolute inset-0 touch-none'
        />
        <div
          ref={panelRef}
          tabIndex={-1}
          role='dialog'
          aria-modal='true'
          aria-label={ui('Answer quality: {value1}', { value1: ui(confidence.label) })}
          onKeyDown={trapTab}
          style={{ '--rp-stage-i': 1 } as CSSProperties}
          className='rp-answer-tail absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[var(--rp-radius)] border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] rp-shadow-lg rp-focus'
        >
          <div className='flex items-center justify-between gap-2 pb-3'>
            <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
              {ui('Answer quality')}
            </p>
            <IconButton label={ui('Close')} icon={X} onClick={() => setOpen(false)} />
          </div>
          {body}
        </div>
      </div>,
      document.body,
    )
    : (
      <div
        ref={panelRef}
        tabIndex={-1}
        role='dialog'
        aria-label={ui('Answer quality: {value1}', { value1: ui(confidence.label) })}
        onKeyDown={trapTab}
        className='rp-answer-tail absolute left-0 top-full z-50 mt-1.5 w-80 rounded-[var(--rp-radius)] border border-line bg-surface p-3.5 rp-shadow-lg rp-focus'
      >
        <p className='pb-2 text-xs font-semibold uppercase tracking-wide text-ink-3'>
          {ui('Answer quality')}
        </p>
        {body}
      </div>
    )

  return (
    <div
      ref={rootRef}
      className='rp-answer-confidence-wrap relative inline-flex'
      data-confidence={confidence.state}
    >
      <Button
        ref={triggerRef}
        variant='ghost'
        size='sm'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup='dialog'
        aria-label={ui('{value1}. Answer quality details.', { value1: ui(confidence.label) })}
        title={ui('{value1} - answer quality', { value1: ui(confidence.label) })}
        className='rp-answer-confidence border'
        style={{
          borderColor: tone === 'quiet' ? 'var(--rp-line)' : `var(--rp-${tone}-line)`,
          background: tone === 'quiet' ? 'var(--rp-surface-2)' : `var(--rp-${tone}-bg)`,
          color: tone === 'quiet' ? 'var(--rp-ink-2)' : `var(--rp-${tone}-ink)`,
        }}
      >
        <Glyph size='sm' />
        <span className='rp-answer-confidence-label'>{ui(confidence.label)}</span>
      </Button>
      {open ? panel : null}
    </div>
  )
}
