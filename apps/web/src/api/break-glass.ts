import { currentAuthority, type RequestContext } from './access-lifecycle.ts'

interface ResponseLifecycle {
  assertCurrent(): void
  finish(): void
  signal?: AbortSignal
}
const lifecycles = new WeakMap<Response, ResponseLifecycle>()
const resultLifecycles = new WeakMap<object, ResponseLifecycle>()

/** Follow parsed objects through synchronous validation in a later promise callback. */
export function assertResultCurrent(value: unknown): void {
  if (value !== null && typeof value === 'object') resultLifecycles.get(value)?.assertCurrent()
}

export function assertResponseCurrent(response: Response): void {
  lifecycles.get(response)?.assertCurrent()
}

export function finishResponse(response: Response): void {
  lifecycles.get(response)?.finish()
}

/** Preserve native response parsing while checking both byte reads and publication. */
function guardResponse(response: Response, lifecycle: ResponseLifecycle): Response {
  const guardedBody = response.body && new Proxy(response.body, {
    get(target, property) {
      if (property === 'getReader') {
        return () => {
          lifecycle.assertCurrent()
          const reader = target.getReader()
          const cancel = () => {
            void reader.cancel().catch(() => {})
            lifecycle.finish()
          }
          lifecycle.signal?.addEventListener('abort', cancel, { once: true })
          const finish = () => {
            lifecycle.signal?.removeEventListener('abort', cancel)
            lifecycle.finish()
          }
          return new Proxy(reader, {
            get(target, property) {
              if (property === 'read') {
                return async () => {
                  try {
                    lifecycle.assertCurrent()
                    const chunk = await target.read()
                    lifecycle.assertCurrent()
                    if (chunk.done) finish()
                    return chunk
                  } catch (error) {
                    cancel()
                    finish()
                    throw error
                  }
                }
              }
              if (property === 'cancel') {
                return async () => {
                  try {
                    await target.cancel()
                  } finally {
                    finish()
                  }
                }
              }
              if (property === 'releaseLock') {
                return () => {
                  finish()
                  target.releaseLock()
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
      }
      if (property === 'cancel') {
        return async () => {
          try {
            await target.cancel()
          } finally {
            lifecycle.finish()
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const guarded = new Proxy(response, {
    get(target, property) {
      if (property === 'body') return guardedBody
      if (['json', 'text', 'blob', 'arrayBuffer', 'formData'].includes(String(property))) {
        return async () => {
          try {
            lifecycle.assertCurrent()
            const result = await Reflect.get(target, property, target).call(target)
            lifecycle.assertCurrent()
            if (result !== null && typeof result === 'object') {
              resultLifecycles.set(result, lifecycle)
            }
            return result
          } finally {
            lifecycle.finish()
          }
        }
      }
      if (property === 'clone') {
        return () => {
          lifecycle.assertCurrent()
          return guardResponse(target.clone(), lifecycle)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  lifecycles.set(guarded, lifecycle)
  if (!response.body) lifecycle.finish()
  return guarded
}

/** Shared boundary for all session and explicit single-request emergency transports. */
export async function authorityFetch(
  input: string,
  init?: RequestInit,
  options: RequestContext = {},
  dispatch: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<Response> {
  if (new Headers(init?.headers).has('x-admin-passcode') && !input.startsWith('/api/admin/')) {
    throw new AdminAccessError()
  }
  const authority = options.authority ?? currentAuthority()
  if (options.context) {
    if (!authority) throw new Error('No current access context')
    authority.assertCurrent(options.context)
  }
  const signals = [init?.signal, options.signal].filter((signal): signal is AbortSignal => !!signal)
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  signal?.throwIfAborted()
  const request = authority?.beginRequest(signal)
  const lifecycle: ResponseLifecycle = request ?? {
    signal,
    assertCurrent: () => signal?.throwIfAborted(),
    finish: () => {},
  }
  try {
    const response = await dispatch(input, { ...init, signal: lifecycle.signal })
    try {
      lifecycle.assertCurrent()
    } catch (error) {
      void response.body?.cancel().catch(() => {})
      throw error
    }
    if (response.status === 401 || response.status === 403) {
      authority?.invalidate('request denied')
      const seconds = Number(response.headers.get('retry-after'))
      void response.body?.cancel().catch(() => {})
      throw new AdminAccessError(
        response.status,
        Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined,
      )
    }
    return guardResponse(response, lifecycle)
  } catch (error) {
    lifecycle.finish()
    throw error
  }
}

/** An operation can dispatch a request, but can never read its credential. */
export interface AdminRequestAccess {
  request(input: string, init?: RequestInit): Promise<Response>
}

export class AdminAccessError extends Error {
  constructor(
    readonly status = 0,
    readonly retryAfter?: number,
  ) {
    super(
      status === 401 || status === 403
        ? 'Emergency access was not accepted. Check the passcode before trying again.'
        : status === 429
        ? 'Emergency access is temporarily locked.'
        : 'We could not confirm the result. Check whether the action completed before trying again.',
    )
    this.name = 'AdminAccessError'
  }
}

function requestHeaders(input: string, init?: RequestInit): Headers {
  if (
    !input.startsWith('/api/admin/') || input.includes('\\') || input.includes('#') ||
    !new URL(input, 'https://local.invalid').pathname.startsWith('/api/admin/')
  ) {
    throw new Error('Admin access requires a local administration request.')
  }
  const headers = new Headers(init?.headers)
  if (headers.has('x-admin-passcode')) {
    throw new Error('Use explicit emergency access for this action.')
  }
  return headers
}

/** Ordinary session requests never prompt or accept a passcode header. */
export const sessionAccess: AdminRequestAccess = Object.freeze({
  async request(input: string, init?: RequestInit): Promise<Response> {
    return await authorityFetch(input, { ...init, headers: requestHeaders(input, init) })
  },
})

export async function adminFetch(
  access: AdminRequestAccess,
  input: string,
  init?: RequestInit,
  options?: RequestContext,
): Promise<Response> {
  return await authorityFetch(input, init, options, (input, init) => access.request(input, init))
}

/**
 * Called only by explicit form confirmation. Dispatch must begin in the callback's
 * synchronous part. Neither delayed callbacks nor a retained handle keep a lease.
 */
export async function runWithEmergencyAccess<T>(
  credential: string,
  action: (access: AdminRequestAccess) => Promise<T>,
): Promise<T> {
  let available = true
  const access: AdminRequestAccess = Object.freeze({
    async request(input: string, init?: RequestInit): Promise<Response> {
      if (!available) throw new Error('This action has already used its request access.')
      available = false
      try {
        const headers = requestHeaders(input, init)
        if (!credential || init?.signal?.aborted) throw new AdminAccessError()
        headers.set('x-admin-passcode', credential)
        credential = ''
        const response = await authorityFetch(input, { ...init, headers, redirect: 'error' })
        if (!response.ok) {
          const seconds = Number(response.headers.get('retry-after'))
          await response.body?.cancel()
          throw new AdminAccessError(
            response.status,
            Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined,
          )
        }
        return response
      } catch (error) {
        throw error instanceof AdminAccessError ? error : new AdminAccessError()
      } finally {
        credential = ''
      }
    },
  })
  try {
    const result = action(access)
    credential = ''
    available = false
    return await result
  } catch (error) {
    throw error instanceof AdminAccessError ? error : new AdminAccessError()
  } finally {
    credential = ''
    available = false
  }
}
