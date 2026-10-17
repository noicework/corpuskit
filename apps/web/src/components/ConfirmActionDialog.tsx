import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { createPortal } from 'react-dom'
import { Trash } from './icons.tsx'
import { Button } from './ui.tsx'

/** Native modality makes the background inert; explicit containment includes browser Tab edges. */
export function ConfirmActionDialog(
  {
    title,
    description,
    confirmLabel,
    cancelLabel,
    busy = false,
    busyLabel = 'Saving change...',
    destructive = true,
    error,
    onConfirm,
    onCancel,
  }: {
    title: string
    description: ReactNode
    confirmLabel: string
    cancelLabel: string
    busy?: boolean
    /** What the status line says while the action runs. */
    busyLabel?: string
    /** Existing confirmations retain their destructive appearance unless opted out. */
    destructive?: boolean
    error?: string | null
    onConfirm(): void
    onCancel(): void
  },
) {
  const locale = usePortalLocale()
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
      className='rp-dialog rp-card rp-shadow-xl fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto bg-surface p-6 text-ink'
    >
      <h2 id={`${id}-title`} className='text-lg font-semibold'>{title}</h2>
      <div id={`${id}-description`} className='mt-4 break-words text-base [overflow-wrap:anywhere]'>
        {description}
      </div>
      {error && (
        <p role='alert' className='mt-4 text-sm text-[var(--rp-bad-ink)]'>
          {locale.error(error, 'Could not save the change.')}
        </p>
      )}
      {busy && <p role='status' className='mt-4 text-sm'>{locale.ui(busyLabel)}</p>}
      <div className='mt-6 flex flex-wrap justify-end gap-3'>
        <Button
          ref={safe}
          variant='outline'
          disabled={busy}
          onClick={onCancel}
        >
          {locale.ui(cancelLabel)}
        </Button>
        <Button
          variant={destructive ? 'danger-outline' : 'primary'}
          leadingIcon={destructive ? Trash : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {locale.ui(confirmLabel)}
        </Button>
      </div>
    </dialog>,
    document.body,
  )
}
