import type { CSSProperties } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import {
  type AgentAskStatus,
  type AgentPhase,
  type AgentStep,
  durationLabel,
  PHASE_ORDER,
} from '../lib/agent-ask-state.ts'
import { AlertCircle, Check } from './icons.tsx'

const PHASE_LABELS: Record<AgentPhase, string> = {
  preparing: 'Preparing',
  searching: 'Searching',
  summarising: 'Summarising',
  checking: 'Checking',
  writing: 'Writing',
}

/**
 * The steps by phase, phases in the order the work happens and steps in arrival order within
 * each, so a second search of a source sits with the searches rather than after the summaries.
 * A phase with no step yet is left out: nothing is claimed that has not started.
 */
export function phaseGroups(
  steps: readonly AgentStep[],
): { phase: AgentPhase; steps: AgentStep[] }[] {
  return PHASE_ORDER.flatMap((phase) => {
    const own = steps.filter((step) => step.phase === phase)
    return own.length > 0 ? [{ phase, steps: own }] : []
  })
}

/**
 * The step timeline: every step the agent has opened, in arrival order, with the time it took
 * (or has taken so far), and the agent's reason where it gave one. A step still running
 * counts up each second; a failed one is marked as such. Steps are never invented: a step the
 * agent never reports never appears.
 */
export function AgentSteps(
  { steps, status, now, total }: {
    steps: readonly AgentStep[]
    status: AgentAskStatus
    now: number
    /** The steps expected in all (`stepTotal`), never fewer than `steps.length`. */
    total: number
  },
) {
  const { ui } = usePortalLocale()
  const units = { seconds: ui('s'), minutes: ui('min') }
  const finished = steps.filter((step) => step.status !== 'started').length
  const runs = phaseGroups(steps)
  let index = 0

  return (
    <section aria-labelledby='agent-steps-heading' data-agent-steps>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 id='agent-steps-heading' className='rp-eyebrow text-ink-3'>{ui('Steps')}</h2>
        {total > 0
          ? (
            <span className='text-xs tabular-nums text-ink-2' data-agent-step-count>
              {status === 'streaming'
                ? ui('{done} of about {total} done', {
                  done: finished,
                  total: Math.max(total, steps.length),
                })
                : steps.length === 1
                ? ui('1 step')
                : ui('{count} steps', { count: steps.length })}
            </span>
          )
          : null}
      </div>
      {steps.length === 0
        ? (
          <p className='mt-2 text-sm leading-relaxed text-ink-2'>
            {status === 'streaming'
              ? ui('Waiting for the first step.')
              : ui('Each step appears here as the portal works on your question.')}
          </p>
        )
        : runs.map((run, runIndex) => (
          <div key={`${run.phase}-${runIndex}`} className={runIndex === 0 ? 'mt-3' : 'mt-1'}>
            <h3 className='rp-agent-phase text-2xs font-semibold uppercase tracking-wider text-ink-3'>
              {ui(PHASE_LABELS[run.phase])}
            </h3>
            <ol className='mt-1.5'>
              {run.steps.map((step, stepIndex) => {
                const order = index++
                const last = stepIndex === run.steps.length - 1
                const running = step.status === 'started' && status === 'streaming'
                const elapsed = step.status === 'started'
                  ? Math.max(0, now - step.startedAt)
                  : step.elapsedMs ?? 0
                const mark = step.status === 'completed'
                  ? 'rp-stage-mark-done'
                  : step.status === 'failed'
                  ? 'rp-agent-mark-failed'
                  : running
                  ? 'rp-stage-mark-active'
                  : ''
                return (
                  <li
                    key={step.id}
                    className='rp-stage-row flex gap-3'
                    style={{ '--rp-stage-i': Math.min(order, 4) } as CSSProperties}
                    aria-current={running ? 'step' : undefined}
                    data-step-status={step.status}
                  >
                    <div className='flex flex-col items-center'>
                      <span className={`rp-stage-mark ${mark}`}>
                        {step.status === 'completed'
                          ? <Check size='sm' />
                          : step.status === 'failed'
                          ? <AlertCircle size='sm' />
                          : running
                          ? (
                            <span
                              aria-hidden='true'
                              className='rp-stage-spin h-4 w-4 rounded-full border-2 border-current border-t-transparent'
                            />
                          )
                          : (
                            <span
                              aria-hidden='true'
                              className='h-3 w-3 rounded-full border-2 border-current'
                            />
                          )}
                      </span>
                      {last ? null : (
                        <span
                          aria-hidden='true'
                          className={`rp-stage-line ${
                            step.status === 'completed' ? 'rp-stage-line-done' : ''
                          }`}
                        />
                      )}
                    </div>
                    <div className='min-w-0 flex-1 pb-2.5'>
                      <div className='flex min-h-8 items-center justify-between gap-3'>
                        <span
                          className={`text-sm leading-snug ${
                            running ? 'font-semibold text-ink' : 'font-medium text-ink'
                          }`}
                        >
                          {step.title}
                          {step.status === 'failed'
                            ? <span className='sr-only'>{ui('(failed)')}</span>
                            : running
                            ? <span className='sr-only'>{ui('(running)')}</span>
                            : null}
                        </span>
                        <span className='shrink-0 text-xs tabular-nums text-ink-2'>
                          {running
                            ? ui('{seconds} s', { seconds: Math.floor(elapsed / 1000) })
                            : durationLabel(elapsed, units)}
                        </span>
                      </div>
                      {step.reason
                        ? (
                          <p className='mt-0.5 text-xs leading-relaxed text-ink-2'>
                            {step.reason}
                          </p>
                        )
                        : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        ))}
    </section>
  )
}
