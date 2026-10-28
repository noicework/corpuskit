export class ComposeTimedOut extends Error {}

/** One absolute deadline, including connection, retries and reading the streamed body. */
export function composeDeadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  const timer = setTimeout(() => controller.abort(new ComposeTimedOut()), ms)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    run<T>(start: () => Promise<T>): Promise<T> {
      const signal = controller.signal
      if (signal.aborted) return Promise.reject(signal.reason)
      return new Promise<T>((resolve, reject) => {
        const stop = () => reject(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
        // The timer and abort listener are installed before any work starts.
        Promise.resolve().then(() => {
          signal.throwIfAborted()
          return start()
        }).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
      })
    },
    close() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
      controller.abort()
    },
  }
}
