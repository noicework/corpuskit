import type { Permission, Scope } from '@research-portal/core'
import { type AuthSession, AuthSessionError, getAuthSession, parseAuthSession } from './auth.ts'

export interface AuthorityContext {
  readonly identityKey: string | null
  readonly slug: string | null
  readonly generation: number
}

export interface AuthorityRequest {
  readonly context: AuthorityContext
  readonly signal: AbortSignal
  assertCurrent(): void
  finish(): void
}

export class StaleAuthorityError extends Error {
  constructor() {
    super('Access changed. Check access before trying again.')
    this.name = 'AbortError'
  }
}

function anonymousBrowserId(): string {
  const key = 'rp-client-id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(key, id)
  }
  return id
}

function identityOf(session: AuthSession, browserId: () => string): string | null {
  if (session.user) return JSON.stringify([session.user.tenantId, session.user.id])
  return session.portalAccess?.available ? JSON.stringify(['anonymous', browserId()]) : null
}

/** A generation owns every protected cache, request and transient UI value. */
export class AuthorityController {
  #context: AuthorityContext = Object.freeze({ identityKey: null, slug: null, generation: 0 })
  #status: 'loading' | 'ready' | 'unavailable' = 'loading'
  #session: AuthSession | null = null
  #requests = new Set<AbortController>()
  #listeners = new Set<() => void>()
  #cleanups = new Set<() => void>()
  #scopes = new Map<string, { abort: AbortController; promise: Promise<AuthSession> }>()
  constructor(private readonly browserId: () => string = anonymousBrowserId) {}

  get context(): AuthorityContext {
    return this.#context
  }
  get status() {
    return this.#status
  }
  get session(): AuthSession | null {
    return this.#session
  }

  #notify(callbacks: Set<() => void>) {
    for (const callback of [...callbacks]) {
      try {
        callback()
      } catch {
        console.error('Access lifecycle callback failed')
      }
    }
  }

  invalidate(_reason: string, status: 'loading' | 'unavailable' = 'unavailable'): void {
    this.#context = Object.freeze({ ...this.#context, generation: this.#context.generation + 1 })
    this.#status = status
    this.#session = null
    // Authority is already gone before cleanup, notification or abort listeners can run.
    this.#notify(this.#cleanups)
    this.#notify(this.#listeners)
    for (const request of this.#requests) request.abort()
    this.#requests.clear()
    for (const entry of this.#scopes.values()) entry.abort.abort()
    this.#scopes.clear()
  }

  setSession(value: unknown, slug?: string): void {
    this.invalidate('snapshot replaced')
    const session = parseAuthSession(value, slug)
    this.#context = Object.freeze({
      identityKey: identityOf(session, this.browserId),
      slug: slug ?? null,
      generation: this.#context.generation,
    })
    this.#session = session
    this.#status = 'ready'
    this.#notify(this.#listeners)
  }

  async refresh(slug?: string, signal?: AbortSignal): Promise<void> {
    this.invalidate('refresh', 'loading')
    const generation = this.#context.generation
    const abort = new AbortController()
    this.#requests.add(abort)
    try {
      const session = await getAuthSession({
        slug,
        signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
      })
      if (generation !== this.#context.generation) throw new StaleAuthorityError()
      this.setSession(session, slug)
    } catch (error) {
      if (generation === this.#context.generation) this.invalidate('refresh failed')
      throw error
    } finally {
      this.#requests.delete(abort)
    }
  }

  can(permission: Permission, scope: Scope): boolean {
    if (this.#status !== 'ready' || !this.#session) return false
    if (scope.kind === 'platform') return this.#session.platformPermissions.includes(permission)
    const portal = this.#session.portalAccess
    return !!portal?.available && portal.slug === scope.slug &&
      portal.permissions.includes(permission)
  }

  assertCurrent(context: AuthorityContext): void {
    if (this.#status !== 'ready' || context !== this.#context) throw new StaleAuthorityError()
  }

  beginRequest(signal?: AbortSignal): AuthorityRequest {
    const context = this.#context
    this.assertCurrent(context)
    signal?.throwIfAborted()
    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    this.#requests.add(abort)
    return {
      context,
      signal: abort.signal,
      assertCurrent: () => {
        signal?.throwIfAborted()
        abort.signal.throwIfAborted()
        this.assertCurrent(context)
      },
      finish: () => {
        this.#requests.delete(abort)
        signal?.removeEventListener('abort', cancel)
      },
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  registerCleanup(callback: () => void): () => void {
    this.#cleanups.add(callback)
    return () => {
      this.#cleanups.delete(callback)
    }
  }

  cancelScopeSnapshot(slug: string): void {
    this.#scopes.get(slug)?.abort.abort()
    this.#scopes.delete(slug)
  }

  readScopeSnapshot(slug: string, signal?: AbortSignal): Promise<AuthSession> {
    const cached = this.#scopes.get(slug)
    if (cached && !signal) return cached.promise
    this.cancelScopeSnapshot(slug)
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    const request = this.beginRequest(combined)
    const promise = getAuthSession({ slug, signal: request.signal }).then((session) => {
      request.assertCurrent()
      if (identityOf(session, this.browserId) !== request.context.identityKey) {
        this.invalidate('scope identity changed')
        throw new StaleAuthorityError()
      }
      return session
    }).catch((error) => {
      if (
        error instanceof AuthSessionError &&
        (error.httpStatus === 401 || error.httpStatus === 403) && request.context === this.#context
      ) this.invalidate('scope denied')
      if (this.#scopes.get(slug)?.abort === abort) this.#scopes.delete(slug)
      throw error
    }).finally(() => request.finish())
    this.#scopes.set(slug, { abort, promise })
    return promise
  }
}

let registeredAuthority: AuthorityController | undefined

/** The mounted provider supplies the authority for existing compatible API helpers. */
export function registerAuthorityController(authority: AuthorityController): () => void {
  if (registeredAuthority && registeredAuthority !== authority) {
    registeredAuthority.invalidate('provider replaced')
  }
  registeredAuthority = authority
  return () => {
    if (registeredAuthority === authority) {
      authority.invalidate('provider removed')
      registeredAuthority = undefined
    }
  }
}

export interface RequestContext {
  authority?: AuthorityController
  context?: AuthorityContext
  signal?: AbortSignal
}

export function currentAuthority(): AuthorityController | undefined {
  return registeredAuthority
}
