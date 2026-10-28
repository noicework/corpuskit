import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { Button } from '../../components/ui.tsx'
import { updateDocumentText } from '../../api/document-update.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { errorMessage } from './shared.ts'

/** A text replacement uses the existing reingest and lifecycle boundary on both runtimes. */
export function UpdateDocument({
  slug,
  document,
  onUpdated,
}: {
  slug: string
  document: { id: string; title: string }
  onUpdated(): void
}) {
  const { ui, error: localError } = usePortalLocale()
  const { runExplicit } = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await runExplicit(
        ui('Update and re-index'),
        (access) => updateDocumentText(slug, access, document.id, text),
      )
      authority.controller.assertCurrent(context)
      if (result === undefined) return
      setOpen(false)
      setText('')
      onUpdated()
    } catch (err) {
      setError(
        errorMessage(err, 'Could not update the document. Check recent additions before retrying.'),
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className='min-w-0' data-update-document={document.id}>
      <Button
        ref={trigger}
        variant='ghost'
        size='sm'
        className='min-h-11'
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ui('Update and re-index “{title}”', { title: document.title })}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        {ui('Update and re-index')}
      </Button>
      {open && (
        <form id={id} onSubmit={submit} aria-busy={busy} className='mt-3 space-y-3'>
          <p id={`${id}-help`} className='text-sm text-ink-2'>
            {ui(
              'Paste the full replacement text (at least 80 words). A new text document is indexed and the original is removed. The title, source address and draft status are kept. Saved citations still refer to the original document.',
            )}
          </p>
          <label htmlFor={`${id}-text`} className='block text-sm font-medium text-ink'>
            {ui('Updated content')}
          </label>
          <textarea
            ref={field}
            id={`${id}-text`}
            aria-describedby={`${id}-help`}
            className='rp-input min-h-40 w-full'
            required
            disabled={busy}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {error && (
            <p role='alert' className='text-sm text-[var(--rp-bad-ink)]'>
              {localError(error, 'Could not update the document.')}
            </p>
          )}
          <p role='status' className='text-sm text-ink-2'>
            {busy ? ui('Updating and requesting indexing...') : ''}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Button type='submit' className='min-h-11' disabled={busy}>
              {ui('Replace text and re-index')}
            </Button>
            <Button
              type='button'
              variant='outline'
              className='min-h-11'
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setError(null)
                trigger.current?.focus()
              }}
            >
              {ui('Cancel update')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
