import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SourceSyncEvent } from '../../api/client.ts'
import { AdminAccessError } from '../../api/break-glass.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { followSync } from './SourcesPanel.tsx'
import { failedJobMessage, StreamedJob, StreamFailedError } from './streamed-job.ts'

type SyncDone = Extract<SourceSyncEvent, { type: 'done' }>

const READ_ONLY =
  'The knowledge box refused the write (HTTP 403). Its service-account token can read this box ' +
  'but not add to it, so no content can be ingested until a token with write access is connected.'

/** Deliver events the way `syncSource` does: a handler's own throw never stops the stream. */
function deliver(handler: (event: SourceSyncEvent) => void, events: SourceSyncEvent[]): void {
  for (const event of events) {
    try {
      handler(event)
    } catch {
      // api/client.ts drops what a handler throws, exactly like a torn frame.
    }
  }
}

function settle(job: StreamedJob<SyncDone>): unknown {
  try {
    return job.result()
  } catch (error) {
    return error
  }
}

describe('Sources panel sync', () => {
  it('shows the reason the sync failed, keeps its log, and never calls it unconfirmed', () => {
    const job = new StreamedJob<SyncDone>(() => {}, 'Sync failed - please retry.')
    const log: SourceSyncEvent[] = []
    deliver(followSync(job, log), [
      { type: 'item', label: 'Found 12 pages via the sitemap' },
      { type: 'item', label: 'Rejected 2 unreadable pages - the site returned a login page' },
      { type: 'error', message: READ_ONLY },
    ])

    const failure = settle(job)
    expect(failure).toBeInstanceOf(StreamFailedError)
    expect((failure as Error).message).toBe(READ_ONLY)
    // The log a curator reads after the failure still says what happened before it.
    expect(log.map((event) => event.type)).toEqual(['item', 'item', 'error'])

    // Through a session the failure itself reaches the panel; through the emergency prompt it
    // arrives as an unconfirmed result, and the panel still shows the reason the sync gave.
    for (const arrived of [failure, new AdminAccessError()]) {
      const markup = renderToStaticMarkup(
        <MessagePanel message={failedJobMessage(job, arrived, 'Sync failed - please retry.')} />,
      )
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('The knowledge box refused the write (HTTP 403).')
      expect(markup).not.toContain('could not confirm')
    }
  })

  it('keeps a hosting refusal code and says it in the app words', () => {
    const job = new StreamedJob<SyncDone>(() => {}, 'Sync failed - please retry.')
    deliver(followSync(job, []), [
      { type: 'error', message: 'portal_read_only', error: 'portal_read_only' },
    ])
    const failure = settle(job) as StreamFailedError
    expect(failure.code).toBe('portal_read_only')
    expect(failure.message).toContain('This portal is read-only.')
  })

  it('reports an unconfirmed result only when the stream ends without a trustworthy finish', () => {
    for (
      const events of [
        [{ type: 'item', label: 'Found 3 pages' }],
        [{ type: 'done', added: -1 }],
        [{ type: 'unexpected' } as unknown as SourceSyncEvent, { type: 'done', added: 1 }],
      ] as SourceSyncEvent[][]
    ) {
      const job = new StreamedJob<SyncDone>(() => {}, 'Sync failed - please retry.')
      deliver(followSync(job, []), events)
      expect(settle(job)).toBeInstanceOf(AdminAccessError)
    }
    const job = new StreamedJob<SyncDone>(() => {}, 'Sync failed - please retry.')
    const log: SourceSyncEvent[] = []
    deliver(followSync(job, log), [{ type: 'done', added: 4, deferred: 2 }])
    expect(settle(job)).toEqual({ type: 'done', added: 4, deferred: 2 })
    expect(log).toEqual([{ type: 'done', added: 4, deferred: 2 }])
  })

  it('drops a late answer after the identity changed', () => {
    let current = true
    const stale = new Error('Access changed.')
    const job = new StreamedJob<SyncDone>(() => {
      if (!current) throw stale
    }, 'Sync failed - please retry.')
    const log: SourceSyncEvent[] = []
    const handler = followSync(job, log)
    deliver(handler, [{ type: 'item', label: 'Found 3 pages' }])
    current = false
    deliver(handler, [{ type: 'error', message: READ_ONLY }, { type: 'done', added: 3 }])
    expect(log).toEqual([{ type: 'item', label: 'Found 3 pages' }])
    expect(job.failure).toBeUndefined()
    expect(settle(job)).toBe(stale)
  })
})
