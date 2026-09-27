import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KgImplementEvent } from '@research-portal/core'
import { AdminAccessError } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { followKgImplement } from './KgPanel.tsx'
import { failedJobMessage, StreamedJob, StreamFailedError } from './streamed-job.ts'

type ImplementDone = Extract<KgImplementEvent, { type: 'done' }>

/** Deliver events the way `implementKg` does: a handler's own throw never stops the stream. */
function deliver(handler: (event: KgImplementEvent) => void, events: KgImplementEvent[]) {
  for (const event of events) {
    try {
      handler(event)
    } catch {
      // api/client.ts drops what a handler throws.
    }
  }
}

function settle(job: StreamedJob<ImplementDone>): unknown {
  try {
    return job.result()
  } catch (error) {
    return error
  }
}

describe('Knowledge graph panel implementation', () => {
  it('shows the reason the implementation failed in the message, not an unconfirmed result', () => {
    const job = new StreamedJob<ImplementDone>(() => {}, 'Implementation failed - please retry.')
    const log: KgImplementEvent[] = []
    deliver(followKgImplement(job, (event) => log.push(event)), [
      { type: 'stage', label: 'Installing extraction agents' },
      { type: 'item', label: 'Species and places', detail: 'graph agent' },
      { type: 'error', message: 'The knowledge box refused the agent configuration (HTTP 422).' },
    ])
    // The live log shows every line, the failure included.
    expect(log.map((event) => event.type)).toEqual(['stage', 'item', 'error'])
    const failure = settle(job)
    expect(failure).toBeInstanceOf(StreamFailedError)
    for (const arrived of [failure, new AdminAccessError()]) {
      const markup = renderToStaticMarkup(
        <MessagePanel
          message={failedJobMessage(job, arrived, 'Implementation failed - please retry.')}
        />,
      )
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('The knowledge box refused the agent configuration (HTTP 422).')
      expect(markup).not.toContain('could not confirm')
    }
  })

  it('finishes with the agents installed, and is unconfirmed only without a finish', () => {
    const finished = new StreamedJob<ImplementDone>(
      () => {},
      'Implementation failed - please retry.',
    )
    deliver(followKgImplement(finished, () => {}), [{ type: 'done', agents: 2 }])
    expect(settle(finished)).toEqual({ type: 'done', agents: 2 })
    const unfinished = new StreamedJob<ImplementDone>(
      () => {},
      'Implementation failed - please retry.',
    )
    deliver(followKgImplement(unfinished, () => {}), [{ type: 'stage', label: 'Installing' }])
    expect(settle(unfinished)).toBeInstanceOf(AdminAccessError)
    const blank = new StreamedJob<ImplementDone>(() => {}, 'Implementation failed - please retry.')
    deliver(followKgImplement(blank, () => {}), [{ type: 'error', message: '  ' }])
    expect((settle(blank) as Error).message).toBe('Implementation failed - please retry.')
  })

  it('drops a late answer after the identity changed', () => {
    let current = true
    const stale = new Error('Access changed.')
    const job = new StreamedJob<ImplementDone>(() => {
      if (!current) throw stale
    }, 'Implementation failed - please retry.')
    const log: KgImplementEvent[] = []
    const handler = followKgImplement(job, (event) => log.push(event))
    deliver(handler, [{ type: 'stage', label: 'Installing' }])
    current = false
    deliver(handler, [{ type: 'error', message: 'Late failure' }, { type: 'done', agents: 1 }])
    expect(log).toEqual([{ type: 'stage', label: 'Installing' }])
    expect(settle(job)).toBe(stale)
  })
})
