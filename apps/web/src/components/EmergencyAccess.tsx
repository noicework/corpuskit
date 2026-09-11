import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { AuthSession } from '../api/auth.ts'
import {
  AdminAccessError,
  type AdminRequestAccess,
  runWithEmergencyAccess,
  sessionAccess,
} from '../api/break-glass.ts'

export interface AdminAccess {
  breakGlassEnabled: boolean
  coarseAdminEligible: boolean
  pending: boolean
  sessionAccess: AdminRequestAccess
  /** Invoke from a user event with one concrete operation, never from a query or effect. */
  runExplicit<T>(
    label: string,
    action: (access: AdminRequestAccess) => Promise<T>,
  ): Promise<T | undefined>
}

interface PendingOperation {
  label: string
  action: (access: AdminRequestAccess) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const AdminAccessContext = createContext<AdminAccess | null>(null)

export function useAdminAccess(): AdminAccess {
  const access = useContext(AdminAccessContext)
  if (!access) throw new Error('Admin access requires EmergencyAccessProvider.')
  return access
}

export function EmergencyAccessProvider({ session, children }: {
  session: AuthSession | null | undefined
  children: ReactNode
}) {
  const enabled = session?.breakGlassEnabled === true
  const eligible = session?.coarseAdminEligible === true
  const [pending, setPending] = useState<PendingOperation | null>(null)
  const pendingRef = useRef<PendingOperation | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const id = useId()

  const attachInput = useCallback((node: HTMLInputElement | null) => {
    if (!node && inputRef.current) inputRef.current.value = ''
    inputRef.current = node
  }, [])

  const clearInput = useCallback(() => {
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const cancel = useCallback(() => {
    // A dispatched side effect cannot be cancelled by closing its prompt.
    if (sendingRef.current) return
    clearInput()
    const operation = pendingRef.current
    pendingRef.current = null
    sendingRef.current = false
    setPending(null)
    setSending(false)
    setError(null)
    operation?.resolve(undefined)
  }, [clearInput])

  useEffect(() => {
    if (!enabled) {
      clearInput()
      if (sendingRef.current) {
        pendingRef.current?.reject(new AdminAccessError())
        pendingRef.current = null
        setPending(null)
      } else cancel()
    }
  }, [enabled, cancel, clearInput])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearInput()
      if (sendingRef.current) pendingRef.current?.reject(new AdminAccessError())
      else pendingRef.current?.resolve(undefined)
      pendingRef.current = null
    }
  }, [clearInput])

  useEffect(() => {
    if (sending) dialogRef.current?.focus()
    else if (error) cancelRef.current?.focus()
  }, [sending, error])

  const open = pending !== null && enabled
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    const background = [...document.body.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node !== overlayRef.current
    )
    const inert = background.map((element) => element.inert)
    background.forEach((element) => {
      element.inert = true
    })
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()
    const focusable = () => {
      const elements = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
        ) ?? []),
      ]
      return elements.length ? elements : dialogRef.current ? [dialogRef.current] : []
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    const onFocus = () => {
      if (!dialogRef.current?.contains(document.activeElement)) focusable()[0]?.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      clearInput()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
      background.forEach((element, index) => {
        element.inert = inert[index]!
      })
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open, cancel, clearInput])

  const runExplicit = useCallback(<T,>(
    label: string,
    action: (access: AdminRequestAccess) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!label.trim() || pendingRef.current || sendingRef.current) {
      return Promise.reject(new Error('An action is already pending or unnamed.'))
    }
    if (eligible) return action(sessionAccess)
    if (!enabled) return Promise.reject(new Error('Emergency access is unavailable.'))
    return new Promise<T | undefined>((resolve, reject) => {
      const operation: PendingOperation = {
        label,
        action,
        resolve: (value) => resolve(value as T | undefined),
        reject,
      }
      pendingRef.current = operation
      setError(null)
      setPending(operation)
    })
  }, [eligible, enabled])

  async function confirm() {
    const operation = pendingRef.current
    if (!enabled || !operation || sendingRef.current || error || !inputRef.current?.value) return
    sendingRef.current = true
    setSending(true)
    let credential = inputRef.current.value
    clearInput()
    try {
      const result = runWithEmergencyAccess(credential, operation.action)
      credential = ''
      const value = await result
      if (pendingRef.current !== operation) return
      pendingRef.current = null
      setPending(null)
      operation.resolve(value)
    } catch (failure) {
      if (pendingRef.current !== operation) return
      const safe = failure instanceof AdminAccessError ? failure : new AdminAccessError()
      setError(
        safe.status === 429 || (safe.status === 403 && safe.retryAfter !== undefined)
          ? `Emergency access is temporarily locked. Try again in ${
            Math.ceil((safe.retryAfter ?? 600) / 60)
          } minutes.`
          : safe.message,
      )
      operation.reject(safe)
    } finally {
      credential = ''
      clearInput()
      if (mountedRef.current && (pendingRef.current === operation || pendingRef.current === null)) {
        sendingRef.current = false
        setSending(false)
      }
    }
  }

  return (
    <AdminAccessContext.Provider
      value={{
        breakGlassEnabled: enabled,
        coarseAdminEligible: eligible,
        pending: pending !== null,
        sessionAccess,
        runExplicit,
      }}
    >
      {children}
      {open && pending
        ? createPortal(
          <div
            ref={overlayRef}
            className='rp-tenant fixed inset-0 z-[100] flex items-center justify-center p-4 text-ink'
            style={{ backgroundColor: 'color-mix(in srgb, var(--rp-ink) 40%, transparent)' }}
          >
            <div
              ref={dialogRef}
              role='dialog'
              tabIndex={-1}
              aria-modal='true'
              aria-labelledby={`${id}-title`}
              aria-describedby={`${id}-description ${id}-action`}
              aria-busy={sending}
              className='rp-card rp-focus w-full min-w-0 max-w-md overflow-y-auto p-6'
              style={{ maxHeight: 'calc(100dvh - 2rem)' }}
            >
              <h2 id={`${id}-title`} className='rp-display text-xl'>Emergency access</h2>
              <p id={`${id}-description`} className='mt-4 text-sm leading-relaxed text-ink-2'>
                Enter the passcode for this action. You will need to enter it again for another
                action.
              </p>
              <p id={`${id}-action`} className='my-4 min-w-0 break-words text-sm font-semibold'>
                {pending.label}
              </p>
              <form
                className='flex min-w-0 flex-col gap-4'
                onSubmit={(event) => {
                  event.preventDefault()
                  void confirm()
                }}
              >
                <div className='min-w-0'>
                  <label htmlFor={`${id}-passcode`} className='mb-2 block text-sm'>Passcode</label>
                  <input
                    ref={attachInput}
                    id={`${id}-passcode`}
                    type='password'
                    autoComplete='off'
                    spellCheck={false}
                    required
                    disabled={sending || error !== null}
                    className='rp-input w-full min-w-0'
                  />
                </div>
                {error
                  ? (
                    <p
                      role='alert'
                      className='p-4 text-sm leading-relaxed'
                      style={{
                        background: 'var(--rp-bad-bg)',
                        color: 'var(--rp-bad-ink)',
                        borderRadius: 'var(--rp-radius)',
                      }}
                    >
                      {error}
                    </p>
                  )
                  : null}
                {sending
                  ? <p role='status' className='text-sm text-ink-2'>Sending request...</p>
                  : null}
                <div className='flex min-w-0 flex-wrap gap-2'>
                  <button
                    type='submit'
                    disabled={sending || error !== null}
                    className='rp-btn rp-btn-primary min-w-0 whitespace-normal'
                    style={{
                      height: 'auto',
                      minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
                      paddingBlock: '0.5rem',
                    }}
                  >
                    Continue with this action
                  </button>
                  <button
                    ref={cancelRef}
                    type='button'
                    data-emergency-cancel
                    disabled={sending}
                    onClick={cancel}
                    className='rp-btn rp-btn-ghost'
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )
        : null}
    </AdminAccessContext.Provider>
  )
}
