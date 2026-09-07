import { type CSSProperties, useState } from 'react'
import { Link } from 'react-router-dom'

// ---------------------------------------------------------------------------
// Shared interactive quiz renderer for the "assessment" generated-artefact
// kind. A thin, standalone copy of the renderer in GeneratePage.tsx (which
// has its own inline copy for the Generate surface) - kept separate rather
// than extracted-and-shared so neither page's behaviour can drift from a
// change made for the other.
// ---------------------------------------------------------------------------

export type AssessmentQuestion = {
  question: string
  options: string[]
  correct_index: number
  explanation: string
  topic: string
  /** The retrieved resource the question was written from, when the server could resolve it. */
  source_resource_id?: string | null
  source_title?: string | null
}

export type AssessmentObject = {
  questions: AssessmentQuestion[]
  /** Questions the server withheld because they were written from a reference list. */
  omitted_questions?: number
  omitted_secondhand?: number
  omitted_unsourced?: number
  /** How many questions were asked for, when fewer survived the source checks. */
  requested?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function isAssessment(value: unknown): value is AssessmentObject {
  if (!isRecord(value) || !Array.isArray(value.questions)) return false
  return value.questions.every(
    (q) =>
      isRecord(q) &&
      typeof q.question === 'string' &&
      isStringArray(q.options) &&
      typeof q.correct_index === 'number' &&
      typeof q.explanation === 'string' &&
      typeof q.topic === 'string' &&
      (q.source_resource_id === undefined || q.source_resource_id === null ||
        typeof q.source_resource_id === 'string') &&
      (q.source_title === undefined || q.source_title === null ||
        typeof q.source_title === 'string'),
  )
}

/** Short, honest read on a score - never harsh, never empty praise. */
function scoreVerdict(score: number, total: number): string {
  if (total === 0) return ''
  const pct = score / total
  if (pct === 1) return 'Perfect score.'
  if (pct >= 0.8) return 'Strong result.'
  if (pct >= 0.5) return 'A reasonable start - the explanations below fill the gaps.'
  return 'Worth another pass once you have reviewed the explanations below.'
}

/**
 * Interactive quiz - pick an answer per question, submit reveals correct and
 * incorrect answers plus each explanation, then a results summary. `onRetake`
 * is optional; when supplied a "Try another" action is shown alongside the
 * score once the quiz has been submitted.
 */
export function AssessmentQuiz({
  data,
  onRetake,
  slug,
}: {
  data: AssessmentObject
  onRetake?: () => void
  /** Portal slug for the per-question source links; without it the source shows as text. */
  slug?: string
}) {
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState(false)

  const total = data.questions.length
  const score = data.questions.reduce(
    (acc, q, i) => acc + (selected[i] === q.correct_index ? 1 : 0),
    0,
  )
  const answeredCount = Object.keys(selected).length

  return (
    <div>
      {submitted && (
        <div className='rp-card mb-6 p-5' role='status'>
          <div className='flex flex-wrap items-baseline justify-between gap-3'>
            <div>
              <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
                Your result
              </p>
              <p className='mt-1 text-2xl font-semibold tracking-tight text-ink'>
                {score} / {total}
              </p>
              <p className='mt-1 text-sm text-ink-2'>{scoreVerdict(score, total)}</p>
            </div>
            {onRetake && (
              <button type='button' onClick={onRetake} className='rp-btn rp-btn-outline shrink-0'>
                Try another
              </button>
            )}
          </div>
        </div>
      )}

      {(data.requested ?? 0) > data.questions.length
        ? (
          <p className='mb-4 text-xs leading-relaxed text-ink-3' role='note'>
            {data.questions.length === 1 ? 'One' : data.questions.length} of the {data.requested}
            {' '}
            questions asked for survived the source check.
          </p>
        )
        : null}
      {(data.omitted_questions ?? 0) > 0
        ? (
          <p className='mb-4 text-xs leading-relaxed text-ink-3' role='note'>
            {data.omitted_questions === 1
              ? 'One question was left out'
              : `${data.omitted_questions} questions were left out`} because{' '}
            {data.omitted_questions === 1 ? 'it was' : 'they were'}{' '}
            written from a reference list rather than from what a source reports.
          </p>
        )
        : null}
      {(data.omitted_secondhand ?? 0) > 0
        ? (
          <p className='mb-4 text-xs leading-relaxed text-ink-3' role='note'>
            {data.omitted_secondhand === 1
              ? 'One question was left out'
              : `${data.omitted_secondhand} questions were left out`} because{' '}
            {data.omitted_secondhand === 1 ? 'its' : 'their'}{' '}
            answer key was a figure the source paper only quotes from earlier studies, not its own
            result.
          </p>
        )
        : null}
      {(data.omitted_unsourced ?? 0) > 0
        ? (
          <p className='mb-4 text-xs leading-relaxed text-ink-3' role='note'>
            {data.omitted_unsourced === 1
              ? 'One question was left out'
              : `${data.omitted_unsourced} questions were left out`} because{' '}
            {data.omitted_unsourced === 1 ? 'the sentence it quoted' : 'the sentences they quoted'}
            {' '}
            could not be found in any of the papers retrieved for this topic.
          </p>
        )
        : null}

      <div className='space-y-6'>
        {data.questions.map((q, qi) => (
          <div
            key={qi}
            className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'
          >
            {q.topic && (
              <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
                {q.topic}
              </p>
            )}
            <p className='mt-1 text-sm font-medium text-ink'>
              {qi + 1}. {q.question}
            </p>
            <div className='mt-3 space-y-2'>
              {q.options.map((opt, oi) => {
                const isChosen = selected[qi] === oi
                const isCorrect = oi === q.correct_index
                let cls = 'border-line hover:border-[var(--rp-ink-3)]'
                let optStyle: CSSProperties | undefined
                if (submitted) {
                  if (isCorrect) {
                    cls = 'text-[var(--rp-ok-ink)]'
                    optStyle = { borderColor: 'var(--rp-ok-line)', background: 'var(--rp-ok-bg)' }
                  } else if (isChosen) {
                    cls = 'text-[var(--rp-bad-ink)]'
                    optStyle = { borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }
                  }
                } else if (isChosen) {
                  cls = ''
                  optStyle = { borderColor: 'var(--rp-ink)' }
                }
                const answerHint = submitted
                  ? isChosen && isCorrect
                    ? ' - your answer, correct'
                    : isChosen
                    ? ' - your answer, incorrect'
                    : isCorrect
                    ? ' - correct answer'
                    : null
                  : null
                return (
                  <button
                    key={oi}
                    type='button'
                    disabled={submitted}
                    aria-pressed={isChosen}
                    onClick={() => setSelected((prev) => ({ ...prev, [qi]: oi }))}
                    style={optStyle}
                    className={`rp-focus block w-full rounded-[var(--rp-radius)] border px-4 py-2.5 text-left text-sm text-ink transition-colors duration-150 disabled:cursor-default ${cls}`}
                  >
                    {opt}
                    {answerHint && <span className='sr-only'>{answerHint}</span>}
                  </button>
                )
              })}
            </div>
            {submitted && q.explanation && (
              <p className='mt-3 text-sm leading-relaxed text-ink-2'>{q.explanation}</p>
            )}
            {submitted && (
              <p className='mt-2 text-xs text-ink-3'>
                {q.source_resource_id && q.source_title
                  ? (
                    <>
                      Source: {slug
                        ? (
                          <Link
                            to={`/t/${slug}/library/${encodeURIComponent(q.source_resource_id)}`}
                            className='rp-focus font-medium underline-offset-2 hover:underline'
                            style={{ color: 'var(--rp-accent-fg)' }}
                          >
                            {q.source_title}
                          </Link>
                        )
                        : <span className='font-medium text-ink-2'>{q.source_title}</span>}
                    </>
                  )
                  : 'Source: not attributed - the question could not be tied to one retrieved document.'}
              </p>
            )}
          </div>
        ))}
      </div>

      {!submitted && total > 0 && (
        <div className='mt-6 flex items-center gap-3'>
          <button
            type='button'
            disabled={answeredCount < total}
            onClick={() => setSubmitted(true)}
            className='rp-btn rp-btn-primary'
          >
            Submit answers
          </button>
          <p className='text-xs text-ink-3'>
            {answeredCount} / {total} answered
          </p>
        </div>
      )}
    </div>
  )
}
