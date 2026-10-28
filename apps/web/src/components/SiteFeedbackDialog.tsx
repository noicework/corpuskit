import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, sendSiteFeedback, type SiteFeedbackCategory } from '../api/client.ts'
import { usePortalLocale } from '../lib/portal-locale.tsx'
import { X } from './icons.tsx'
import { Button, IconButton } from './ui.tsx'

const MESSAGE_MAX = 4000
const EMAIL_MAX = 254
/** A plausible address; the server makes the final check. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const CATEGORIES: { value: SiteFeedbackCategory; label: string }[] = [
  { value: 'general', label: 'General feedback' },
  { value: 'answer', label: 'Answer quality' },
  { value: 'problem', label: 'A problem with the portal' },
  { value: 'suggestion', label: 'An idea for improvement' },
]

/** What the dialog's Tab cycle stops on. */
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

type Status = 'idle' | 'sending' | 'sent' | 'failed'
type FieldError = { field: 'message' | 'email'; text: string }

/**
 * Feedback to the portal team, separate from an answer's rating. It stays mounted while closed, so
 * a draft outlives closing it, and starts afresh only once a message has gone.
 */
export function SiteFeedbackDialog(
  { slug, open, onClose }: { slug: string; open: boolean; onClose(): void },
) {
  const { ui, number } = usePortalLocale()
  const id = useId()
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [category, setCategory] = useState<SiteFeedbackCategory>('general')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const [failure, setFailure] = useState('')
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const messageRef = useRef<HTMLTextAreaElement | null>(null)
  const emailRef = useRef<HTMLInputElement | null>(null)
  const doneRef = useRef<HTMLButtonElement | null>(null)
  const pagePath = useRef('')
  const sending = useRef(false)
  const close = useRef(onClose)
  close.current = onClose

  // A passive effect, so a closing phone menu has given back its scroll lock before this one
  // takes it: both effects run in the same commit, and unmounts run first.
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Only the page path: its query and fragment can hold what the reader typed elsewhere.
    pagePath.current = globalThis.location.pathname
    if (!dialog.open) dialog.showModal()
    dialog.scrollTop = 0
    messageRef.current?.focus({ preventScroll: true })
    return () => {
      if (dialog.open) dialog.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected && previous.getClientRects().length > 0) previous.focus()
    }
  }, [open])

  useEffect(() => {
    if (open && status === 'sent') doneRef.current?.focus()
  }, [open, status])

  // Once a message has gone, the next opening starts with an empty form.
  useEffect(() => {
    if (open || status !== 'sent') return
    setMessage('')
    setEmail('')
    setCategory('general')
    setWebsite('')
    setFieldError(null)
    setFailure('')
    setStatus('idle')
  }, [open, status])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current) return
    const text = message.trim()
    const address = email.trim()
    if (!text) {
      setFieldError({ field: 'message', text: ui('Add a message before you send it.') })
      messageRef.current?.focus()
      return
    }
    if (address && !EMAIL.test(address)) {
      setFieldError({
        field: 'email',
        text: ui('Enter an email address like name@example.com, or leave it empty.'),
      })
      emailRef.current?.focus()
      return
    }
    setFieldError(null)
    setFailure('')
    sending.current = true
    setStatus('sending')
    try {
      await sendSiteFeedback(slug, {
        message: text,
        ...(address ? { email: address } : {}),
        category,
        pagePath: pagePath.current || '/',
        ...(website ? { website } : {}),
      })
      setStatus('sent')
    } catch (error) {
      // The draft stays: a message that did not go must never look as if it had.
      setFailure(
        error instanceof ApiError && error.status === 429
          ? ui(
            'A lot of feedback has been sent from here just now. Your message is still here - try again in a few minutes.',
          )
          : ui('Your feedback could not be sent. Your message is still here - try again.'),
      )
      setStatus('failed')
    } finally {
      sending.current = false
    }
  }

  const busy = status === 'sending'
  const invalid = (field: FieldError['field']) => fieldError?.field === field
  const describedBy = (field: FieldError['field'], hint: string) =>
    invalid(field) ? `${id}-${field}-error ${hint}` : hint

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-site-feedback
      className='rp-dialog rp-anim-fade overscroll-contain text-ink'
      onCancel={(event) => {
        // Escape closes through state, so the page and the dialog cannot disagree.
        event.preventDefault()
        close.current()
      }}
      onClose={(event) => {
        // A browser may still close the dialog itself (a second Escape); follow it. The event
        // arrives a task later, so one from an earlier closing finds the dialog open again.
        if (open && !event.currentTarget.open) close.current()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom
        ) close.current()
      }}
      onKeyDown={(event) => {
        // The modal makes the page inert; this also keeps Tab off the browser's own controls.
        if (event.key !== 'Tab') return
        const stops = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter((element) => element.getClientRects().length > 0)
        const first = stops[0], last = stops.at(-1)
        if (!first || !last) return
        const active = document.activeElement as HTMLElement | null
        if (!active || !stops.includes(active)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <h2 id={`${id}-title`} className='rp-display text-xl text-ink'>
            {ui('Share feedback')}
          </h2>
          <p id={`${id}-description`} className='mt-2 text-sm leading-relaxed text-ink-2'>
            {ui('Tell the portal team about an answer, a problem or an idea.')}
          </p>
        </div>
        <IconButton icon={X} label={ui('Close')} onClick={() => close.current()} />
      </div>

      {status === 'sent' ? null : (
        <form
          onSubmit={submit}
          noValidate
          aria-busy={busy}
          className='mt-6 min-w-0 space-y-5'
        >
          <div>
            <label htmlFor={`${id}-message`} className='block text-sm font-semibold text-ink'>
              {ui('Your message')}{' '}
              <span className='font-normal text-ink-2'>{ui('(required)')}</span>
            </label>
            <textarea
              ref={messageRef}
              id={`${id}-message`}
              name='message'
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
                if (invalid('message')) setFieldError(null)
              }}
              readOnly={busy}
              aria-required='true'
              aria-invalid={invalid('message') || undefined}
              aria-describedby={describedBy('message', `${id}-message-hint`)}
              maxLength={MESSAGE_MAX}
              rows={5}
              className='rp-input mt-2 min-h-28 w-full min-w-0 resize-y'
            />
            {invalid('message') && (
              <p id={`${id}-message-error`} className='mt-2 text-sm text-[var(--rp-bad-ink)]'>
                {fieldError!.text}
              </p>
            )}
            <p id={`${id}-message-hint`} className='mt-2 text-xs leading-relaxed text-ink-2'>
              {ui('Up to {count} characters. The address of this page is sent with it.', {
                count: number(MESSAGE_MAX),
              })}
            </p>
          </div>

          <div>
            <label htmlFor={`${id}-category`} className='block text-sm font-semibold text-ink'>
              {ui('This is about')}
            </label>
            <select
              id={`${id}-category`}
              name='category'
              value={category}
              onChange={(event) => setCategory(event.target.value as SiteFeedbackCategory)}
              className='rp-input rp-select mt-2 w-full min-w-0'
            >
              {CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>{ui(option.label)}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={`${id}-email`} className='block text-sm font-semibold text-ink'>
              {ui('Email')} <span className='font-normal text-ink-2'>{ui('(optional)')}</span>
            </label>
            <input
              ref={emailRef}
              id={`${id}-email`}
              name='email'
              type='email'
              inputMode='email'
              autoComplete='email'
              spellCheck={false}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                if (invalid('email')) setFieldError(null)
              }}
              readOnly={busy}
              aria-invalid={invalid('email') || undefined}
              aria-describedby={describedBy('email', `${id}-email-hint`)}
              maxLength={EMAIL_MAX}
              className='rp-input mt-2 w-full min-w-0'
            />
            {invalid('email') && (
              <p id={`${id}-email-error`} className='mt-2 text-sm text-[var(--rp-bad-ink)]'>
                {fieldError!.text}
              </p>
            )}
            <p id={`${id}-email-hint`} className='mt-2 text-xs leading-relaxed text-ink-2'>
              {ui('Only if you would like a reply.')}
            </p>
          </div>

          {/* Hidden from people and assistive technology; only a form-filling bot sends it. */}
          <div hidden>
            <label htmlFor={`${id}-website`}>Website</label>
            <input
              id={`${id}-website`}
              name='website'
              tabIndex={-1}
              autoComplete='off'
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </div>

          {failure && (
            <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
              {failure}
            </p>
          )}

          <div className='flex flex-wrap items-center justify-end gap-3'>
            <Button type='submit' aria-disabled={busy || undefined}>
              {busy
                ? ui('Sending...')
                : status === 'failed'
                ? ui('Try again')
                : ui('Send feedback')}
            </Button>
          </div>
        </form>
      )}

      {/* One live region for the whole exchange, present before anything is said in it. */}
      <div role='status' className={status === 'sent' ? 'mt-6' : undefined}>
        {status === 'sent'
          ? (
            <>
              <p className='font-semibold text-ink'>
                {ui('Thank you - your feedback has been sent.')}
              </p>
              <p className='mt-2 text-sm leading-relaxed text-ink-2'>
                {ui('The portal team has been notified.')}
              </p>
            </>
          )
          : busy
          ? <span className='sr-only'>{ui('Sending your feedback.')}</span>
          : null}
      </div>
      {status === 'sent' && (
        <div className='mt-6 flex justify-end'>
          <Button ref={doneRef} onClick={() => close.current()}>{ui('Done')}</Button>
        </div>
      )}
    </dialog>,
    document.body,
  )
}
