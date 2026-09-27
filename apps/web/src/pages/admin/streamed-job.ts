/**
 * Following a streamed administrative job (a source sync, an enrichment run, a
 * knowledge graph implementation) to its outcome.
 *
 * Three endings are kept apart, because each means something different to the
 * curator:
 * - a well-formed `done`: the job finished, with its counts;
 * - an `error` event: the job failed and the server said why (a read-only
 *   service-account token, a portal limit, a site that refuses the crawler).
 *   That reason is reported in the server's words, with its code;
 * - anything else (no `done`, a malformed one, an event the page does not
 *   know): the page cannot tell what happened. Only this is
 *   `AdminAccessError`'s "We could not confirm the result", because the job
 *   may still have completed.
 *
 * Nothing is recorded once the authority that started the job has changed:
 * a late event after a sign-out or role change is dropped, and the result is
 * then the authority error, never the job's.
 */
import { StaleAuthorityError } from '../../api/access-lifecycle.ts'
import { AdminAccessError } from '../../api/break-glass.ts'
import { hostingErrorMessage } from '../../api/hosting-errors.ts'
import { errorMessage, type Message } from './shared.ts'

/** A streamed job the server reported as failed, in its own words and with its code. */
export class StreamFailedError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'StreamFailedError'
  }
}

/** The failure an `error` event reports: a hosting refusal in the app's words, else the server's. */
export function streamFailure(
  event: { message?: unknown; error?: unknown },
  fallback: string,
): StreamFailedError {
  const code = typeof event.error === 'string' && event.error.length > 0 ? event.error : undefined
  const stated = typeof event.message === 'string' ? event.message.trim() : ''
  return new StreamFailedError(hostingErrorMessage(event) ?? (stated || fallback), code)
}

export class StreamedJob<Done> {
  #done: Done | undefined
  #failure: StreamFailedError | undefined
  #uncertain = false

  /**
   * @param assertCurrent throws when the authority that started the job has changed.
   * @param fallback what an `error` event with no message of its own says.
   */
  constructor(
    private readonly assertCurrent: () => void,
    private readonly fallback: string,
  ) {}

  /**
   * Wrap the stream's event handler: each event is handled only while the
   * starting authority is still current.
   */
  events<Event>(handle: (event: Event) => void): (event: Event) => void {
    return (event) => {
      this.assertCurrent()
      handle(event)
    }
  }

  /** A well-formed `done`. */
  complete(done: Done): void {
    this.#done = done
  }

  /** The job's own `error` event. The first one is the reason; later ones add nothing. */
  fail(event: { message?: unknown; error?: unknown }): void {
    this.#failure ??= streamFailure(event, this.fallback)
  }

  /** A `done` or an event that cannot be trusted: the outcome is unknown. */
  uncertain(): void {
    this.#uncertain = true
  }

  /** The reason the job reported, if it reported one. */
  get failure(): StreamFailedError | undefined {
    return this.#failure
  }

  /**
   * The error the starting authority check throws now, if it is no longer current: another
   * identity or role, or a check still in progress. Undefined while it holds.
   */
  authorityError(): unknown {
    try {
      this.assertCurrent()
      return undefined
    } catch (error) {
      return error
    }
  }

  /**
   * The finished job's `done`. Throws the authority error when the authority
   * changed, the job's own failure when it reported one, and
   * `AdminAccessError` when the outcome is unknown.
   */
  result(): Done {
    this.assertCurrent()
    if (this.#failure) throw this.#failure
    if (this.#done === undefined || this.#uncertain) throw new AdminAccessError()
    return this.#done
  }
}

/**
 * What the panel shows for a job that did not finish. While the starting authority does not hold
 * (a check in progress, or the result already failed on it), that is all it says: "Access
 * changed", never the job's reason. Otherwise it is the reason the job reported, whatever became
 * of the error on its way back (the emergency prompt reports every failure as an unconfirmed
 * result), or the error itself.
 */
export function failedJobMessage(
  job: StreamedJob<unknown> | undefined,
  err: unknown,
  fallback: string,
): Message {
  const authority = job?.authorityError() ?? (err instanceof StaleAuthorityError ? err : undefined)
  return { tone: 'error', text: errorMessage(authority ?? job?.failure ?? err, fallback) }
}
