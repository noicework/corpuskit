import { createPortalLocale, type Locale, usePortalLocale } from '../lib/portal-locale.tsx'
import { useEffect, useRef, useState } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { ApiError, deleteAdminResource } from '../api/client.ts'
import { useAccess } from './AccessProvider.tsx'
import { ConfirmActionDialog } from './ConfirmActionDialog.tsx'
import { usePermissionAdminAccess } from './EmergencyAccess.tsx'

export interface DeletableDocument {
  id: string
  title: string
}

/** How a confirmed delete ended: deleted now, or already gone when it arrived. */
export type DeleteOutcome = 'deleted' | 'already-deleted'

/** What a list or page announces once a delete has ended. */
export function deletedNotice(
  title: string,
  outcome: DeleteOutcome,
  ui: Locale['ui'] = createPortalLocale('en').ui,
): string {
  return outcome === 'deleted'
    ? ui('Deleted “{title}”.', { title })
    : ui('“{title}” had already been deleted.', { title })
}

/**
 * Every cached query that may still list or count a deleted document: the manager's lists and
 * counts, the Library and its facets, the portal's usage, and the document itself.
 */
export function refreshAfterDelete(
  queryClient: QueryClient,
  slug: string,
  id: string,
  /**
   * The document's own page is showing it: its queries are only marked stale, so they are not
   * read again, and answered 404, while the page is still on screen.
   */
  onDocumentPage = false,
): Promise<unknown> {
  for (const queryKey of [['resource', slug, id], ['resource-content', slug, id]]) {
    if (onDocumentPage) void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
    else queryClient.removeQueries({ queryKey })
  }
  return Promise.all(
    [
      ['admin-recent', slug],
      ['manage-content', slug],
      ['manage-status', slug],
      ['admin-counters', slug],
      ['catalog', slug],
      ['facets', slug],
      ['counters', slug],
      ['recent-documents', slug],
      ['admin-overview'],
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}

/**
 * The confirmation's text: the document by name, that deleting it is permanent, where it stops
 * appearing, and what happens to investigations that cite it.
 */
export function DeleteDocumentDescription({ title }: { title: string }) {
  const { ui } = usePortalLocale()
  return (
    <>
      <p>{ui('Delete {title}?', { title })}</p>
      <ul className='mt-3 list-disc space-y-1.5 pl-5'>
        <li>{ui('This cannot be undone.')}</li>
        <li>{ui('It is removed from the Library, from search and from answers.')}</li>
        <li>
          {ui(
            'Investigations that cite it keep the passages people saved, shown as no longer in the Library.',
          )}
        </li>
      </ul>
    </>
  )
}

/**
 * Delete one document, after a confirmation that names it. Only a manager with content.write
 * reaches this: the delete goes through the same explicit-action path as publishing and hiding,
 * and its answer is published only while the authority that sent it is still current. A 404
 * means the document was already gone, which is reported, not treated as a failure.
 */
export function DeleteDocumentButton({
  slug,
  document,
  onDeleted,
  className,
  label = 'Delete',
  onDocumentPage = false,
  icon = false,
}: {
  slug: string
  document: DeletableDocument
  /** Called after the dialog has closed; a list moves focus away from the row it removes. */
  onDeleted(outcome: DeleteOutcome): void
  className?: string
  label?: string
  /** Shown on the document's own page, which leaves once the delete is done. */
  onDocumentPage?: boolean
  /** A trash glyph before the label, where the button sits beside Save and its bookmark. */
  icon?: boolean
}) {
  const { ui } = usePortalLocale()
  const { runExplicit } = usePermissionAdminAccess('content.write', { kind: 'portal', slug })
  const authority = useAccess()
  const context = authority.controller.context
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState<{ outcome: DeleteOutcome; sentUnder: typeof context } | null>(
    null,
  )
  // Reported once the dialog has closed and handed focus back, so the host can move focus on:
  // the row that held this control is about to go. Only under the authority the delete was sent
  // under, never one that has replaced it since.
  useEffect(() => {
    if (!ended) return
    setEnded(null)
    try {
      authority.controller.assertCurrent(ended.sentUnder)
    } catch {
      return
    }
    onDeleted(ended.outcome)
    void refreshAfterDelete(queryClient, slug, document.id, onDocumentPage)
  }, [ended])

  const confirm = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      let outcome: DeleteOutcome = 'deleted'
      try {
        const result = await runExplicit(
          ui('Delete document'),
          (access) => deleteAdminResource(slug, access, document.id),
        )
        authority.controller.assertCurrent(context)
        // Emergency access was asked for and declined: nothing was sent.
        if (result === undefined) return
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err
        authority.controller.assertCurrent(context)
        outcome = 'already-deleted'
      }
      setOpen(false)
      setEnded({ outcome, sentUnder: context })
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'The document could not be deleted. Try again.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type='button'
        aria-haspopup='dialog'
        aria-label={ui('{action} “{title}”', { action: ui(label), title: document.title })}
        data-delete-document={document.id}
        disabled={busy}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        className={className ??
          'rp-focus min-h-[44px] min-w-[44px] text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-bad-ink)]'}
      >
        {icon ? <TrashIcon className='h-4 w-4 shrink-0' /> : null}
        {ui(label)}
      </button>
      {open && (
        <ConfirmActionDialog
          title={ui('Delete document')}
          description={<DeleteDocumentDescription title={document.title} />}
          confirmLabel={error ? ui('Try again') : ui('Delete document')}
          cancelLabel={ui('Keep document')}
          busy={busy}
          busyLabel={ui('Deleting document...')}
          error={error}
          onCancel={() => {
            setOpen(false)
            setError(null)
          }}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  )
}

/** A trash can in the house stroke idiom (the bookmark on Save is its pair on the document page). */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={className}
    >
      <path d='M4.5 7h15' />
      <path d='M9.5 7V5.5a1 1 0 011-1h3a1 1 0 011 1V7' />
      <path d='M6.5 7l.8 11.6a1.5 1.5 0 001.5 1.4h6.4a1.5 1.5 0 001.5-1.4L17.5 7' />
      <path d='M10 11v5.5M14 11v5.5' />
    </svg>
  )
}
