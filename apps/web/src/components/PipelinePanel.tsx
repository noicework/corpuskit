import type { AskStage, ScoredResource } from '@research-portal/core'
import { type QualityScores, TrustSignals } from './QualityGauge.tsx'

// ---------------------------------------------------------------------------
// Pipeline panel - the retrieval/generation visualisation ported out of the
// old standalone Agentic surface so the single Ask surface can offer
// the same "how did we get this answer" view as a collapsible disclosure
// under a completed answer. Its per-stage timeline only makes sense while a
// question is actually streaming, so `statuses` is optional: pass it live
// from a running ask, or omit it entirely (as the Ask surface does,
// since a completed message doesn't keep per-stage timing) and the panel
// falls back to just the retrieved sources and generation numbers.
// ---------------------------------------------------------------------------

export type PipelineStageStatus = 'pending' | 'active' | 'complete'
export type PipelineStatuses = Record<AskStage, PipelineStageStatus>

export interface PipelineUsage {
  inputTokens: number
  outputTokens: number
  firstChunkSec?: number
  totalSec?: number
}

const STAGES: { key: AskStage; label: string }[] = [
  { key: 'preprocessing', label: 'Preprocess' },
  { key: 'retrieval', label: 'Retrieve' },
  { key: 'generating', label: 'Generate' },
  { key: 'validating', label: 'Validate' },
]

function StageDot({ status }: { status: PipelineStageStatus }) {
  if (status === 'complete') {
    return (
      <span
        className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--rp-ok-ink)] text-[10px] font-bold text-[var(--rp-ok-bg)]'
        aria-hidden='true'
      >
        ✓
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span className='flex h-5 w-5 shrink-0 items-center justify-center' aria-hidden='true'>
        <span
          className='h-3 w-3 animate-pulse rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
        />
      </span>
    )
  }
  return (
    <span className='flex h-5 w-5 shrink-0 items-center justify-center' aria-hidden='true'>
      <span className='h-3 w-3 rounded-full border-2 border-line bg-surface' />
    </span>
  )
}

function RetrievedSources({ sources }: { sources: ScoredResource[] }) {
  if (sources.length === 0) return null
  return (
    <div className='mt-2 space-y-2'>
      {sources.slice(0, 6).map((resource) => (
        <div
          key={resource.id}
          className='rounded-[var(--rp-radius)] border border-line bg-surface-2 px-2.5 py-2'
        >
          <p className='rp-clamp-2 text-xs font-medium text-ink-2'>{resource.title}</p>
          <div
            className='mt-1 h-1 overflow-hidden rounded-full bg-surface-3'
            role='progressbar'
            aria-valuenow={Math.round(resource.relevance * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Relevance of ${resource.title}`}
          >
            <div
              className='h-full rounded-full'
              style={{
                width: `${Math.round(resource.relevance * 100)}%`,
                backgroundColor: 'var(--rp-accent)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function GenerationStats({ usage }: { usage: PipelineUsage }) {
  return (
    <dl className='mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-3'>
      <dt>Input tokens</dt>
      <dd className='text-right font-medium text-ink-2'>{usage.inputTokens}</dd>
      <dt>Output tokens</dt>
      <dd className='text-right font-medium text-ink-2'>{usage.outputTokens}</dd>
      {usage.firstChunkSec !== undefined
        ? (
          <>
            <dt>First chunk</dt>
            <dd className='text-right font-medium text-ink-2'>
              {usage.firstChunkSec.toFixed(2)}s
            </dd>
          </>
        )
        : null}
      {usage.totalSec !== undefined
        ? (
          <>
            <dt>Total time</dt>
            <dd className='text-right font-medium text-ink-2'>{usage.totalSec.toFixed(2)}s</dd>
          </>
        )
        : null}
    </dl>
  )
}

export interface PipelinePanelProps {
  sources: ScoredResource[]
  usage?: PipelineUsage | null
  quality?: QualityScores | null
  /** Live per-stage status, when known - omit for a completed message with no stored timeline. */
  statuses?: PipelineStatuses
}

/**
 * Retrieval/generation pipeline visualisation: a per-stage timeline (when
 * `statuses` is supplied) with the retrieved sources and their relevance
 * bars nested under the retrieval stage, plus generation token/timing and
 * REMi trust signals nested under the generation stage. Without `statuses`
 * (a completed Ask answer, which doesn't keep per-stage timing) it
 * renders the same retrieved-sources and generation sections without the
 * timeline chrome around them.
 */
export function PipelinePanel({ sources, usage, quality, statuses }: PipelinePanelProps) {
  if (statuses) {
    return (
      <ol className='space-y-0'>
        {STAGES.map((stage, index) => {
          const status = statuses[stage.key]
          const isLast = index === STAGES.length - 1
          return (
            <li key={stage.key} className='flex gap-3'>
              <div className='flex flex-col items-center'>
                <StageDot status={status} />
                {!isLast
                  ? (
                    <span
                      className={`mt-0.5 w-px flex-1 ${
                        status === 'complete' ? 'bg-[var(--rp-ok-line)]' : 'bg-surface-3'
                      }`}
                      aria-hidden='true'
                    />
                  )
                  : null}
              </div>
              <div className='pb-5'>
                <p
                  className={`text-sm font-medium ${
                    status === 'pending' ? 'text-ink-3' : 'text-ink'
                  }`}
                >
                  {stage.label}
                  <span className='sr-only'>
                    {status === 'active'
                      ? ' - in progress'
                      : status === 'complete'
                      ? ' - complete'
                      : ' - pending'}
                  </span>
                </p>
                {stage.key === 'retrieval' ? <RetrievedSources sources={sources} /> : null}
                {stage.key === 'generating' && usage ? <GenerationStats usage={usage} /> : null}
                {stage.key === 'generating' && quality
                  ? (
                    <div className='mt-2.5'>
                      <TrustSignals quality={quality} />
                    </div>
                  )
                  : null}
              </div>
            </li>
          )
        })}
      </ol>
    )
  }

  // No live timeline: just the two things that are always available once an
  // answer has finished - what was retrieved, and what generating it cost.
  return (
    <div className='space-y-4'>
      {sources.length > 0
        ? (
          <div>
            <h4 className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
              Retrieved sources
            </h4>
            <RetrievedSources sources={sources} />
          </div>
        )
        : null}
      {usage || quality
        ? (
          <div>
            <h4 className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
              Generation
            </h4>
            {usage ? <GenerationStats usage={usage} /> : null}
            {quality
              ? (
                <div className='mt-2.5'>
                  <TrustSignals quality={quality} />
                </div>
              )
              : null}
          </div>
        )
        : null}
      {sources.length === 0 && !usage && !quality
        ? <p className='text-xs text-ink-3'>No pipeline detail available for this answer.</p>
        : null}
    </div>
  )
}
