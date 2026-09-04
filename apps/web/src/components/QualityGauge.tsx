import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { assessConfidence, type ConfidenceState } from '../lib/confidence.ts'
import { useCompactViewport } from './useViewMode.ts'

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
    description: 'Answer relevance: how directly the answer addresses the question asked - ' +
      'scored automatically against the retrieved sources.',
  },
  {
    key: 'groundedness',
    label: 'Groundedness',
    description: 'Groundedness: how firmly the answer is supported by the retrieved material - ' +
      'scored automatically against the retrieved sources.',
  },
  {
    key: 'contextRelevance',
    label: 'Context',
    description: 'Context relevance: how well the retrieved passages match the question asked - ' +
      'scored automatically against the retrieved sources.',
  },
]

/** ok/warn/bad status band for a 0-5 REMi score. */
function bandColour(score: number): string {
  if (score >= 4) return 'var(--rp-ok-ink)'
  if (score >= 2.5) return 'var(--rp-warn-ink)'
  return 'var(--rp-bad-ink)'
}

// ---------------------------------------------------------------------------
// Icons. One 24-unit grid, round caps and joins, and a stroke that thins as the
// box grows so every size lands at about the same optical weight - the grid and
// the 1.7 stroke of the answer-action icons (`ActionIcon` in AskPage), so the
// quality trigger reads as one of that row rather than a glyph pasted in from a
// different set. The exclamation dots are zero-length strokes (`h.01`): with
// round caps a stroke draws a dot exactly one stroke-width across at any render
// size, where the filled 0.15-radius circles these replaced vanished below a
// pixel and left the triangle reading as a bare outline.
// ---------------------------------------------------------------------------

type GlyphSize = 'sm' | 'md' | 'lg'

const GLYPH_SIZE: Record<GlyphSize, { box: string; stroke: number }> = {
  sm: { box: 'h-3.5 w-3.5', stroke: 2 },
  md: { box: 'h-4 w-4', stroke: 1.8 },
  lg: { box: 'h-[1.15rem] w-[1.15rem]', stroke: 1.7 },
}

const GLYPH = {
  shieldCheck:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 011.52 0C14.51 3.81 17 5 19 5a1 1 0 011 1zM9 12l2 2 4-4',
  checkCircle: 'M22 12a10 10 0 11-20 0 10 10 0 0120 0zM9 12l2 2 4-4',
  info: 'M22 12a10 10 0 11-20 0 10 10 0 0120 0zM12 16v-4M12 8h.01',
  alertTriangle:
    'M21.73 18l-8-14a2 2 0 00-3.48 0l-8 14A2 2 0 004 21h16a2 2 0 001.73-3zM12 9v4M12 17h.01',
}

function Glyph({ d, size }: { d: string; size: GlyphSize }) {
  const { box, stroke } = GLYPH_SIZE[size]
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={stroke}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={`${box} shrink-0`}
    >
      <path d={d} />
    </svg>
  )
}

function ShieldCheckIcon({ size = 'sm' }: { size?: GlyphSize }) {
  return <Glyph d={GLYPH.shieldCheck} size={size} />
}

function CheckCircleIcon({ size = 'sm' }: { size?: GlyphSize }) {
  return <Glyph d={GLYPH.checkCircle} size={size} />
}

function InfoCircleIcon({ size = 'sm' }: { size?: GlyphSize }) {
  return <Glyph d={GLYPH.info} size={size} />
}

function AlertTriangleIcon({ size = 'sm' }: { size?: GlyphSize }) {
  return <Glyph d={GLYPH.alertTriangle} size={size} />
}

function MiniMeter(
  { label, description, score }: { label: string; description: string; score: number },
) {
  const colour = bandColour(score)
  const filled = Math.round(Math.max(0, Math.min(SEGMENTS, score)))

  return (
    <span className='inline-flex items-center gap-1.5' title={description}>
      <span className='text-[10px] font-medium text-ink-3'>{label}</span>
      <span className='inline-flex items-center gap-[2px]' aria-hidden='true'>
        {Array.from({ length: SEGMENTS }).map((_, index) => (
          <span
            key={index}
            className='h-2 w-1 rounded-[var(--rp-radius)]'
            style={{ backgroundColor: index < filled ? colour : 'var(--rp-surface-3)' }}
          />
        ))}
      </span>
      <span className='text-[10px] font-semibold tabular-nums' style={{ color: colour }}>
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
            className={'inline-flex items-center gap-1 text-[10px] font-medium uppercase ' +
              'tracking-wide text-ink-3'}
          >
            <ShieldCheckIcon />
            Answer quality
          </span>
        )
        : null}
      {present.map((metric) => (
        <MiniMeter
          key={metric.key}
          label={metric.label}
          description={metric.description}
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
    'The retrieved sources only partly support this answer - check the citations before relying on it.',
  low:
    'The retrieved sources only weakly support this answer. Treat it as a lead and verify against the cited sources below.',
}

export interface ConfidenceIndicatorProps {
  quality: QualityScores | null | undefined
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
export function ConfidenceIndicator({ quality }: ConfidenceIndicatorProps) {
  const confidence = assessConfidence(quality)

  if (confidence.state === 'unscored') {
    return (
      <span className='rp-badge rp-badge-quiet inline-flex items-center gap-1'>
        <InfoCircleIcon />
        Confidence not scored for this answer
      </span>
    )
  }

  if (confidence.state === 'high') {
    return (
      <span className='rp-badge rp-badge-ok inline-flex items-center gap-1'>
        <CheckCircleIcon />
        High confidence
      </span>
    )
  }

  if (confidence.state === 'moderate') {
    return (
      <ConfidencePill
        tone='warn'
        label='Moderate confidence'
        detail={CONFIDENCE_DETAIL.moderate}
      />
    )
  }

  return (
    <ConfidencePill
      tone='bad'
      label='Low confidence'
      detail={CONFIDENCE_DETAIL.low}
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
  { tone, label, detail }: { tone: 'warn' | 'bad'; label: string; detail: string },
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
    <span ref={wrapRef} className='relative inline-flex'>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        aria-label={`${label}. ${detail}`}
        className={`rp-badge rp-focus inline-flex items-center gap-1 ${
          tone === 'bad' ? 'rp-badge-bad' : 'rp-badge-warn'
        }`}
      >
        <AlertTriangleIcon />
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
// The thing this must NOT do is hide a bad answer. A groundedness of 1.0/5 is
// an answer nobody should act on, and putting that behind a click the reader
// has no reason to make would trade a UI problem for a credibility one. So the
// TRIGGER carries the state: high and unscored collapse to a quiet icon, but
// moderate and low keep their colour, their alert glyph AND their words right
// there on the row, and the accessible name always leads with the level. The
// reader still learns "low confidence" without opening anything; what the
// popup saves them is the detail they only want once they act on it.
// ---------------------------------------------------------------------------

/** The focusable descendants of a panel, in tab order. */
function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return [
    ...panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ]
}

function CloseIcon() {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.7'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className='h-4 w-4'
    >
      <path d='M6 6l12 12M18 6L6 18' />
    </svg>
  )
}

/**
 * How loudly each confidence level announces itself on the actions row - three
 * tiers, escalating only as far as the news warrants.
 *
 * Only `low` spells itself out. That is the state a reader must not miss (a
 * groundedness in the bad band: an answer to verify, not to act on), so it
 * keeps its words and its colour out on the row. `moderate` is a caution, not
 * an alarm, so it takes the warn tone and the alert glyph but no label -
 * visibly different from quiet without shouting, and the accessible name still
 * says "Moderate confidence". Good and unscored news collapses to a plain grey
 * icon indistinguishable in weight from copy or watch.
 *
 * The tiering is also what keeps the row on one line at 390px: six controls fit
 * comfortably when at most one of them carries text.
 */
const TRIGGER_TONE: Record<
  ConfidenceState,
  { tone: 'quiet' | 'warn' | 'bad'; labelled: boolean }
> = {
  high: { tone: 'quiet', labelled: false },
  unscored: { tone: 'quiet', labelled: false },
  moderate: { tone: 'warn', labelled: false },
  low: { tone: 'bad', labelled: true },
}

export interface AnswerQualityDisclosureProps {
  quality: QualityScores | null | undefined
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
export function AnswerQualityDisclosure(
  { quality, onReanswerDeeply, sparselyGrounded = false }: AnswerQualityDisclosureProps,
) {
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

  const confidence = assessConfidence(quality)
  const detail = CONFIDENCE_DETAIL[confidence.state]
  const { tone, labelled } = TRIGGER_TONE[confidence.state]
  const loud = tone !== 'quiet'

  const glyph = (size: GlyphSize) =>
    loud
      ? <AlertTriangleIcon size={size} />
      : confidence.state === 'high'
      ? <ShieldCheckIcon size={size} />
      : <InfoCircleIcon size={size} />

  const body = (
    <>
      <div className='flex items-start gap-2'>
        <span
          className='mt-px shrink-0'
          style={{ color: loud ? `var(--rp-${tone}-ink)` : 'var(--rp-ink-3)' }}
        >
          {glyph('md')}
        </span>
        <div className='min-w-0'>
          <p className='text-sm font-semibold text-ink'>{confidence.label}</p>
          <p className='mt-1 text-xs leading-relaxed text-ink-2'>{detail}</p>
        </div>
      </div>

      {quality
        ? (
          <div className='mt-3 rounded-[var(--rp-radius)] border border-line bg-surface-2 px-3 py-2.5'>
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
              This answer is thinly grounded - re-answer with full-document context?
            </p>
            <button
              type='button'
              onClick={() => {
                setOpen(false)
                onReanswerDeeply()
              }}
              className='rp-btn rp-btn-outline mt-2 h-8 px-3 text-xs'
            >
              Re-answer deeply
            </button>
          </div>
        )
        : sparselyGrounded
        ? (
          <p className='mt-3 text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
            Parts of this answer go beyond the retrieved passages - open the retrieved sources below
            to check it before relying on it.
          </p>
        )
        : null}
    </>
  )

  const panel = compact
    ? createPortal(
      <div className='fixed inset-0 z-[90]'>
        <div
          aria-hidden='true'
          className='rp-answer-tail absolute inset-0 touch-none bg-[color-mix(in_srgb,var(--rp-ink)_45%,transparent)]'
        />
        <div
          ref={panelRef}
          tabIndex={-1}
          role='dialog'
          aria-modal='true'
          aria-label={`Answer quality: ${confidence.label}`}
          onKeyDown={trapTab}
          style={{ '--rp-stage-i': 1 } as CSSProperties}
          className='rp-answer-tail absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[var(--rp-radius)] border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] shadow-lg outline-none'
        >
          <div className='flex items-center justify-between gap-2 pb-3'>
            <p className='text-xs font-medium uppercase tracking-wide text-ink-3'>
              Answer quality
            </p>
            <button
              type='button'
              onClick={() => setOpen(false)}
              aria-label='Close'
              className='rp-focus -mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--rp-radius-btn)] text-ink-3 transition-colors duration-150 hover:text-ink'
            >
              <CloseIcon />
            </button>
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
        aria-label={`Answer quality: ${confidence.label}`}
        onKeyDown={trapTab}
        className='rp-answer-tail absolute right-0 top-full z-30 mt-1.5 w-80 rounded-[var(--rp-radius)] border border-line bg-surface p-3.5 shadow-lg outline-none'
      >
        <p className='pb-2 text-xs font-medium uppercase tracking-wide text-ink-3'>
          Answer quality
        </p>
        {body}
      </div>
    )

  return (
    <div ref={rootRef} className='relative inline-flex'>
      <button
        ref={triggerRef}
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup='dialog'
        // Leads with the level, so a screen-reader user gets the same signal a
        // sighted one takes from the colour without opening anything - and, on
        // the loud states, starts with the visible label it repeats.
        aria-label={`${confidence.label}. Answer quality details.`}
        title={`${confidence.label} - answer quality`}
        className={`rp-focus flex h-9 shrink-0 items-center justify-center gap-1 rounded-[var(--rp-radius-btn)] transition-colors duration-150 ${
          labelled ? 'px-2 text-[0.6875rem] font-semibold' : 'w-9'
        } ${loud ? 'border' : 'text-ink-3 hover:bg-[var(--rp-surface-2)] hover:text-ink'}`}
        style={loud
          ? {
            borderColor: `var(--rp-${tone}-line)`,
            background: `var(--rp-${tone}-bg)`,
            color: `var(--rp-${tone}-ink)`,
          }
          : undefined}
      >
        {glyph('lg')}
        {labelled ? <span>{confidence.label}</span> : null}
      </button>
      {open ? panel : null}
    </div>
  )
}
