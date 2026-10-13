import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnalyseEvent } from '@research-portal/core'
import { AdminAccessError } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { followAnalysis } from './AnalysePanel.tsx'
import { failedJobMessage, StreamedJob, StreamFailedError } from './streamed-job.ts'

type AnalyseDone = Extract<AnalyseEvent, { type: 'done' }>

const FALLBACK = 'Analysis failed - please retry.'

/** Deliver events the way `analysePortal` does: a handler's own throw never stops the stream. */
function deliver(handler: (event: AnalyseEvent) => void, events: AnalyseEvent[]) {
  for (const event of events) {
    try {
      handler(event)
    } catch {
      // api/client.ts drops what a handler throws.
    }
  }
}

function settle(job: StreamedJob<AnalyseDone>): unknown {
  try {
    return job.result()
  } catch (error) {
    return error
  }
}

const REFUSAL = "This knowledge box already has a 'topic' label set that this portal did not " +
  'create. Running analysis would replace it. Rename or remove it in the knowledge box first.'

describe('Analyse panel', () => {
  it('shows the refusal to replace a label set in the message, with its code', () => {
    const job = new StreamedJob<AnalyseDone>(() => {}, FALLBACK)
    const log: AnalyseEvent[] = []
    deliver(followAnalysis(job, (event) => log.push(event)), [
      { type: 'stage', label: 'Reading the corpus' },
      { type: 'item', label: 'Found 12 indexed resources' },
      { type: 'error', error: 'labelset_exists', message: REFUSAL },
    ])
    // The live log shows every line, the refusal included.
    expect(log.map((event) => event.type)).toEqual(['stage', 'item', 'error'])
    const failure = settle(job)
    expect(failure).toBeInstanceOf(StreamFailedError)
    expect((failure as StreamFailedError).code).toBe('labelset_exists')
    // Whatever became of the error on its way back, the admin reads the reason.
    for (const arrived of [failure, new AdminAccessError()]) {
      const markup = renderToStaticMarkup(
        <MessagePanel message={failedJobMessage(job, arrived, FALLBACK)} />,
      )
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('label set that this portal did not create')
      expect(markup).not.toContain('could not confirm')
    }
  })

  it('finishes with its counts, and is unconfirmed only without a finish', () => {
    const finished = new StreamedJob<AnalyseDone>(() => {}, FALLBACK)
    const done: AnalyseDone = { type: 'done', topics: 5, kinds: 3, labelled: 40, questions: 6 }
    deliver(followAnalysis(finished, () => {}), [done])
    expect(settle(finished)).toEqual(done)
    const unfinished = new StreamedJob<AnalyseDone>(() => {}, FALLBACK)
    deliver(followAnalysis(unfinished, () => {}), [{ type: 'stage', label: 'Reading the corpus' }])
    expect(settle(unfinished)).toBeInstanceOf(AdminAccessError)
  })
})
