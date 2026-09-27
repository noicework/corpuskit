import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { EnrichmentRunEvent } from '@research-portal/core'
import { AdminAccessError } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { enrichmentDoneMessage, followEnrichmentRun } from './EnrichmentsPanel.tsx'
import { failedJobMessage, StreamedJob, StreamFailedError } from './streamed-job.ts'

type RunDone = Extract<EnrichmentRunEvent, { type: 'done' }>
type Progress = { done: number; total: number; errors: number } | null

/** Deliver events the way `runEnrichment` does: a handler's own throw never stops the stream. */
function deliver(handler: (event: EnrichmentRunEvent) => void, events: EnrichmentRunEvent[]) {
  for (const event of events) {
    try {
      handler(event)
    } catch {
      // api/client.ts drops what a handler throws.
    }
  }
}

function settle(job: StreamedJob<RunDone>): unknown {
  try {
    return job.result()
  } catch (error) {
    return error
  }
}

function tracker() {
  let progress: Progress = null
  return {
    onProgress: (update: (previous: Progress) => Progress) => {
      progress = update(progress)
    },
    get progress() {
      return progress
    },
  }
}

describe('Enrichments panel run', () => {
  it('shows the reason the run stopped instead of an unconfirmed result', () => {
    const job = new StreamedJob<RunDone>(() => {}, 'Enrichment run failed - please retry.')
    const progress = tracker()
    deliver(followEnrichmentRun(job, progress.onProgress), [
      { type: 'start', total: 3 },
      { type: 'item', id: 'res-1', title: 'Evidence', outcome: 'enriched' },
      {
        type: 'error',
        message: 'The generation model is not available on this knowledge box.',
      },
    ])
    expect(progress.progress).toEqual({ done: 1, total: 3, errors: 0 })
    const failure = settle(job)
    expect(failure).toBeInstanceOf(StreamFailedError)
    for (const arrived of [failure, new AdminAccessError()]) {
      const markup = renderToStaticMarkup(
        <MessagePanel
          message={failedJobMessage(job, arrived, 'Enrichment run failed - please retry.')}
        />,
      )
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('The generation model is not available on this knowledge box.')
      expect(markup).not.toContain('could not confirm')
    }
  })

  it('names a hosting stop in the app words and keeps its code', () => {
    const job = new StreamedJob<RunDone>(() => {}, 'Enrichment run failed - please retry.')
    deliver(followEnrichmentRun(job, tracker().onProgress), [
      { type: 'error', message: 'Agents are disabled', error: 'agents_disabled' },
    ])
    const failure = settle(job) as StreamFailedError
    expect(failure.code).toBe('agents_disabled')
    expect(failure.message).toBe(
      'Agents are disabled for this portal. Contact your portal administrator to enable them.',
    )
  })

  it('finishes with its counts, and is unconfirmed only without a finish', () => {
    const finished = new StreamedJob<RunDone>(() => {}, 'Enrichment run failed - please retry.')
    deliver(followEnrichmentRun(finished, tracker().onProgress), [
      { type: 'done', enriched: 2, errors: 1 },
    ])
    expect(enrichmentDoneMessage(settle(finished) as RunDone)).toEqual({
      tone: 'error',
      text: 'Enriched 2 resources, 1 could not be generated.',
    })
    const unfinished = new StreamedJob<RunDone>(() => {}, 'Enrichment run failed - please retry.')
    deliver(followEnrichmentRun(unfinished, tracker().onProgress), [{ type: 'start', total: 2 }])
    expect(settle(unfinished)).toBeInstanceOf(AdminAccessError)
  })

  it('drops a late answer after the identity changed', () => {
    let current = true
    const stale = new Error('Access changed.')
    const job = new StreamedJob<RunDone>(() => {
      if (!current) throw stale
    }, 'Enrichment run failed - please retry.')
    const progress = tracker()
    const handler = followEnrichmentRun(job, progress.onProgress)
    deliver(handler, [{ type: 'start', total: 2 }])
    current = false
    deliver(handler, [
      { type: 'item', id: 'res-1', title: 'Evidence', outcome: 'enriched' },
      { type: 'error', message: 'Late failure' },
    ])
    expect(progress.progress).toEqual({ done: 0, total: 2, errors: 0 })
    expect(settle(job)).toBe(stale)
  })
})
