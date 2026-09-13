import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/** Native modality makes the background inert; explicit containment includes browser Tab edges. */
export function ConfirmActionDialog(
  { title, description, confirmLabel, cancelLabel, busy = false, error, onConfirm, onCancel }: {
    title: string
    description: ReactNode
    confirmLabel: string
    cancelLabel: string
    busy?: boolean
    error?: string | null
    onConfirm(): void
    onCancel(): void
  },
) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const safe = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    safe.current?.focus()
    return () => {
      element.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
      else {
        const heading = document.querySelector<HTMLElement>('main h1, h1')
        if (heading) {
          heading.tabIndex = -1
          heading.focus()
        }
      }
    }
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = [
          ...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ]
        const first = buttons[0], last = buttons.at(-1)
        if (!first) {
          event.preventDefault()
          return
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      className='rp-card fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto bg-surface p-6 text-ink shadow-xl backdrop:bg-[color-mix(in_srgb,var(--rp-ink)_45%,transparent)]'
    >
      <h2 id={`${id}-title`} className='rp-display text-xl'>{title}</h2>
      <div id={`${id}-description`} className='mt-4 break-words text-base [overflow-wrap:anywhere]'>
        {description}
      </div>
      {error && <p role='alert' className='mt-4 text-sm text-[var(--rp-bad-ink)]'>{error}</p>}
      {busy && <p role='status' className='mt-4 text-sm'>Saving change...</p>}
      <div className='mt-6 flex flex-wrap gap-3'>
        <button
          ref={safe}
          type='button'
          className='rp-btn rp-btn-outline min-h-[44px]'
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type='button'
          className='rp-btn min-h-[44px] border border-[var(--rp-bad-line)] bg-[var(--rp-bad-bg)] text-[var(--rp-bad-ink)]'
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
