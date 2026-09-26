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

/**
 * Whether two snapshots grant exactly the same authority to the same identity. Only the claim
 * age, which grows on every read of an unchanged session, is ignored; any other difference
 * counts as a change.
 */
export function sameAuthority(a: AuthSession, b: AuthSession): boolean {
  return JSON.stringify({ ...a, claimAgeSeconds: null }) ===
    JSON.stringify({ ...b, claimAgeSeconds: null })
}

/** How long after a file input is activated its native picker may take the window's focus. */
export const FILE_PICKER_BLUR_MS = 1000

/**
 * Tells the focus a native file picker gives back apart from a person returning to the page.
 * The picker belongs to the page: activating a file input blurs the window, and choosing (or
 * cancelling) returns focus to it just before the input's change event. Treating that return
 * as an observed return would withdraw authority between the choice and its upload, unmount the
 * form and drop the file. Only the one focus that answers a picker's own blur counts; any other
 * focus, including one after an unrelated later blur, is an ordinary return.
 */
export class FilePickerFocus {
  #activatedAt: number | null = null
  #pickerHasFocus = false

  /** A file input was activated (clicked directly, through its label, or by keyboard). */
  activated(now: number): void {
    this.#activatedAt = now
  }

  /** The window lost focus. */
  blurred(now: number): void {
    this.#pickerHasFocus = this.#activatedAt !== null &&
      now - this.#activatedAt <= FILE_PICKER_BLUR_MS
    this.#activatedAt = null
  }

  /** The window regained focus: `picker` when it comes back from a file picker, once. */
  focused(): 'picker' | 'return' {
    const picker = this.#pickerHasFocus
    this.#pickerHasFocus = false
    this.#activatedAt = null
    return picker ? 'picker' : 'return'
  }
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
  #revalidation: { context: AuthorityContext; promise: Promise<void> } | null = null
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

  /**
   * Check the session again without first withdrawing the current authority, for a focus that
   * is not an observed return (see `FilePickerFocus`). A read that confirms the same identity
   * and authority keeps the generation, its requests and everything mounted under it, so the
   * upload of a file just chosen goes ahead. Any difference replaces the session exactly as
   * `setSession` does, and a failed read withdraws authority as `refresh` does. Without a ready
   * session for this page scope there is nothing to keep, so this is `refresh`.
   */
  revalidate(slug?: string): Promise<void> {
    const context = this.#context
    if (this.#status !== 'ready' || !this.#session || context.slug !== (slug ?? null)) {
      return this.refresh(slug)
    }
    if (this.#revalidation?.context === context) return this.#revalidation.promise
    const abort = new AbortController()
    // Tracked with the generation's requests, so withdrawing authority also stops this read.
    this.#requests.add(abort)
    const promise = (async () => {
      try {
        const session = await getAuthSession({ slug, signal: abort.signal })
        if (context !== this.#context) throw new StaleAuthorityError()
        if (this.#session && sameAuthority(session, this.#session)) {
          // Nothing changed: keep the generation. Only the fresher claim age is taken.
          this.#session = session
          return
        }
        this.setSession(session, slug)
      } catch (error) {
        if (context === this.#context) this.invalidate('revalidation failed')
        throw error
      } finally {
        this.#requests.delete(abort)
        // One read per context, so the entry for this context is this read's.
        if (this.#revalidation?.context === context) this.#revalidation = null
      }
    })()
    this.#revalidation = { context, promise }
    return promise
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
