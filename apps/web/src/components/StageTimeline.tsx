import { type CSSProperties, useEffect, useState } from 'react'
import type { AskStage } from '@research-portal/core'

export type StageStatus = 'pending' | 'active' | 'complete'
export type StageStatuses = Partial<Record<AskStage, StageStatus>>

/** The four stages an ask moves through, in order, with reader-facing labels. */
export const STAGE_STEPS: { key: AskStage; label: string }[] = [
  { key: 'preprocessing', label: 'Reading your question' },
  { key: 'retrieval', label: 'Searching the corpus' },
  { key: 'generating', label: 'Writing the answer' },
  { key: 'validating', label: 'Checking the answer' },
]

/** Everything before the active stage is finished, whether or not we saw its event. */
export function statusesFor(active: AskStage | null, seen: Set<AskStage>): StageStatuses {
  const out: StageStatuses = {}
  const activeIndex = active ? STAGE_STEPS.findIndex((s) => s.key === active) : -1
  STAGE_STEPS.forEach((step, index) => {
    out[step.key] = step.key === active
      ? 'active'
      : (activeIndex > index || seen.has(step.key))
      ? 'complete'
      : 'pending'
  })
  return out
}

function Tick() {
  return (
    <svg viewBox='0 0 20 20' fill='none' aria-hidden='true' className='h-4 w-4'>
      <path
        d='M5 10.5l3.2 3.2L15 7'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

function Spinner() {
  return (
    <svg viewBox='0 0 20 20' fill='none' aria-hidden='true' className='rp-stage-spin h-4 w-4'>
      <circle cx='10' cy='10' r='7' stroke='currentColor' strokeWidth='2' opacity='0.25' />
      <path
        d='M17 10a7 7 0 00-7-7'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
      />
    </svg>
  )
}

function Dot() {
  return (
    <svg viewBox='0 0 20 20' fill='none' aria-hidden='true' className='h-4 w-4'>
      <circle cx='10' cy='10' r='6' stroke='currentColor' strokeWidth='1.6' opacity='0.5' />
    </svg>
  )
}

/**
 * The waiting state for an answer: the real pipeline stages as a vertical
 * timeline, driven by the `stage` events the ask already streams rather than a
 * fixed script. A stage the server never reports simply stays pending, so the
 * timeline can never claim work that did not happen.
 */
/**
 * The handoff between the waiting state and the answer. Once text starts
 * arriving the timeline is held for one beat while its rows lift away, then the
 * answer takes the space. Without the hold the steps would vanish on the first
 * token and the answer would appear to jump.
 */
export type Phase = 'stages' | 'handoff' | 'answer'

export function useAnswerPhase(hasText: boolean, active: boolean): Phase {
  const [phase, setPhase] = useState<Phase>('stages')

  useEffect(() => {
    if (!active) {
      setPhase('stages')
      return
    }
    if (!hasText) return
    setPhase((prev) => (prev === 'answer' ? prev : 'handoff'))
    const timer = setTimeout(() => setPhase('answer'), 320)
    return () => clearTimeout(timer)
  }, [hasText, active])

  return phase
}

export function StageTimeline(
  { statuses, exiting = false }: { statuses: StageStatuses; exiting?: boolean },
) {
  const activeLabel = STAGE_STEPS.find((s) => statuses[s.key] === 'active')?.label

  return (
    <div className='py-1'>
      <p className='sr-only' role='status'>{activeLabel ?? 'Working'}</p>
      <ol className='space-y-0'>
        {STAGE_STEPS.map((step, index) => {
          const state = statuses[step.key] ?? 'pending'
          const last = index === STAGE_STEPS.length - 1
          return (
            <li
              key={step.key}
              className={`rp-stage-row flex gap-3 ${exiting ? 'rp-stage-row-exit' : ''}`}
              style={{ '--rp-stage-i': index } as CSSProperties}
            >
              <div className='flex flex-col items-center'>
                <span
                  className={`rp-stage-mark ${state === 'active' ? 'rp-stage-mark-active' : ''} ${
                    state === 'complete' ? 'rp-stage-mark-done' : ''
                  }`}
                >
                  {state === 'complete' ? <Tick /> : state === 'active' ? <Spinner /> : <Dot />}
                </span>
                {last ? null : (
                  <span
                    aria-hidden='true'
                    className={`rp-stage-line ${state === 'complete' ? 'rp-stage-line-done' : ''}`}
                  />
                )}
              </div>
              <span
                className={`rp-stage-pill ${state === 'pending' ? 'rp-stage-pill-idle' : ''}`}
              >
                {step.label}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
