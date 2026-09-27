import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { StaleAuthorityError } from '../../api/access-lifecycle.ts'
import { AdminAccessError } from '../../api/break-glass.ts'
import { failedJobMessage, StreamedJob } from './streamed-job.ts'

type Done = { type: 'done'; added: number }

function failedJob(isCurrent: () => boolean) {
  const job = new StreamedJob<Done>(() => {
    if (!isCurrent()) throw new StaleAuthorityError()
  }, 'Sync failed - please retry.')
  job.events((event: { type: string; message: string }) => job.fail(event))({
    type: 'error',
    message: 'The knowledge box refused the write (HTTP 403).',
  })
  return job
}

describe('failedJobMessage', () => {
  it('says only that access changed while the starting authority is being checked', () => {
    let current = true
    const job = failedJob(() => current)
    // An access check starts after the failure arrived: the result fails on the authority.
    current = false
    let err: unknown
    try {
      job.result()
    } catch (error) {
      err = error
    }
    expect(err).toBeInstanceOf(StaleAuthorityError)
    expect(job.authorityError()).toBeInstanceOf(StaleAuthorityError)
    expect(failedJobMessage(job, err, 'Sync failed - please retry.')).toEqual({
      tone: 'error',
      text: 'Access changed. Check access before trying again.',
    })
    // Whatever error came back, the job's reason is not shown while authority is in doubt.
    expect(failedJobMessage(job, new AdminAccessError(), 'Sync failed - please retry.').text)
      .toBe('Access changed. Check access before trying again.')
  })

  it('says access changed when the result failed on the authority, even once it holds again', () => {
    const job = failedJob(() => true)
    expect(job.authorityError()).toBeUndefined()
    expect(failedJobMessage(job, new StaleAuthorityError(), 'Sync failed - please retry.').text)
      .toBe('Access changed. Check access before trying again.')
  })

  it("shows the job's own reason under an authority that holds", () => {
    const job = failedJob(() => true)
    expect(failedJobMessage(job, new AdminAccessError(), 'Sync failed - please retry.').text)
      .toBe('The knowledge box refused the write (HTTP 403).')
  })
})
