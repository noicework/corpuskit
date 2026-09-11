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
    return await fetch(input, { ...init, headers: requestHeaders(input, init) })
  },
})

export async function adminFetch(
  access: AdminRequestAccess,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return await access.request(input, init)
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
        const response = await fetch(input, { ...init, headers, redirect: 'error' })
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
