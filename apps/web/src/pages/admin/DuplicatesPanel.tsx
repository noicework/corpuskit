import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { DuplicateDecision, DuplicateItem } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import {
  deletedNotice,
  DeleteDocumentButton,
  type DeleteOutcome,
} from '../../components/DeleteDocument.tsx'
import { Button } from '../../components/ui.tsx'
import {
  duplicateReason,
  getDuplicates,
  refreshDuplicates,
  reviewDuplicate,
} from '../../api/duplicates.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'

function Item(
  { item, slug, onDeleted }: {
    item: DuplicateItem
    slug: string
    onDeleted(outcome: DeleteOutcome): void
  },
) {
  const { ui } = usePortalLocale()
  return (
    <div className='min-w-0 space-y-2 rounded-[var(--rp-radius)] bg-surface-2 p-4'>
      <h4 className='break-words font-medium text-ink'>
        <Link
          className='rp-link-standalone max-w-full break-words'
          to={`/t/${slug}/library/${encodeURIComponent(item.id)}`}
        >
          {item.title}
        </Link>
      </h4>
      <p className='break-words text-sm text-ink-2'>{item.summary}</p>
      {item.published && <p className='text-sm text-ink-3'>{ui('Published')}: {item.published}</p>}
      {item.sourceName && <p className='break-all text-sm text-ink-3'>{item.sourceName}</p>}
      {item.originUrl && <p className='break-all text-sm text-ink-3'>{item.originUrl}</p>}
      <DeleteDocumentButton
        slug={slug}
        document={item}
        label='Retire one'
        className='rp-btn rp-btn-ghost min-h-11 max-w-full'
        onDeleted={onDeleted}
      />
    </div>
  )
}

export function DuplicatesPanel({ slug }: { slug: string }) {
  const { ui, date } = usePortalLocale()
  const authority = useAccess()
  const { sessionAccess, sessionAllowed, runExplicit } = usePermissionAdminAccess(
    'content.write',
    { kind: 'portal', slug },
  )
  const [reviewed, setReviewed] = useState(false)
  const [page, setPage] = useState(1)
  const client = useQueryClient()
  const key = ['duplicates', slug, authority.identityKey, authority.generation, page, reviewed]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDuplicates(slug, sessionAccess, signal, page, reviewed),
    enabled: sessionAllowed,
    retry: false,
  })
  const heading = useRef<HTMLHeadingElement>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const context = authority.controller.context
  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await runExplicit(
        ui('Refresh duplicate candidates'),
        (access) => refreshDuplicates(slug, access, page, reviewed),
      )
      authority.controller.assertCurrent(context)
      if (result) {
        client.setQueryData(key, result)
        setNotice(ui('Duplicate candidates refreshed.'))
      }
    } catch {
      if (context === authority.controller.context) {
        setError(ui('Could not refresh duplicate candidates. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }
  const decide = async (pair: string, decision: DuplicateDecision) => {
    setBusy(true)
    setError('')
    try {
      const result = await runExplicit(
        ui('Review duplicate candidate'),
        (access) => reviewDuplicate(slug, access, pair, decision),
      )
      authority.controller.assertCurrent(context)
      if (!result) return
      setNotice(ui('Review decision saved.'))
      heading.current?.focus()
      await client.invalidateQueries({ queryKey: ['duplicates', slug] })
    } catch {
      if (context === authority.controller.context) {
        setError(ui('Could not save the review decision. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }
  const candidates = query.data?.candidates.filter((pair) => reviewed || !pair.decision) ?? []
  return (
    <section
      className='rp-card min-w-0 space-y-5 p-5 lg:p-6'
      aria-labelledby='duplicates-heading'
      data-duplicates-panel
    >
      <div className='flex flex-wrap items-start justify-between gap-4'>
        <div className='min-w-0 max-w-prose'>
          <h2
            id='duplicates-heading'
            className='rp-display rp-focus text-xl text-ink'
            tabIndex={-1}
            ref={heading}
          >
            {ui('Duplicates and versions')}
          </h2>
          <p className='mt-2 text-sm text-ink-2'>
            {ui(
              'Metadata signals suggest pairs for human review. Scores are heuristics, not proof of identical content. Nothing is retired automatically.',
            )}
          </p>
          <p className='mt-2 text-sm text-ink-2'>
            {ui(
              'To retire one, choose the document below and confirm its permanent deletion. Saved research keeps its cited passages.',
            )}
          </p>
        </div>
        <Button
          className='max-w-full'
          variant='outline'
          disabled={busy || query.isFetching}
          onClick={() => void refresh()}
        >
          {ui('Refresh candidates')}
        </Button>
      </div>
      <p role='status' className='text-sm text-ink-2'>
        {busy ? ui('Updating duplicate review…') : notice}
      </p>
      {(error || query.error) && (
        <p
          role='alert'
          className='rounded-[var(--rp-radius)] bg-[var(--rp-bad-bg)] p-3 text-sm text-[var(--rp-bad-ink)]'
        >
          {error || ui('Could not load duplicate candidates. Try refreshing.')}
        </p>
      )}
      {query.isLoading && <p role='status'>{ui('Loading duplicate candidates…')}</p>}
      {query.data && (
        <>
          <p className='text-sm text-ink-3'>
            {ui('Resources checked')}: {query.data.resourceCount}. {ui('Last computed')}:{' '}
            {date(query.data.generatedAt, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
          {query.data.limited && (
            <p
              role='status'
              className='rounded-[var(--rp-radius)] bg-[var(--rp-warn-bg)] p-3 text-sm text-[var(--rp-warn-ink)]'
            >
              {ui(
                'This report reached its comparison limit. It shows part of the collection and may miss other matches.',
              )}
            </p>
          )}
          <label className='flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm text-ink'>
            <input
              type='checkbox'
              className='rp-focus size-5'
              checked={reviewed}
              onChange={(event) => {
                setReviewed(event.target.checked)
                setPage(1)
              }}
            />
            {ui('Show reviewed pairs')}
          </label>
          <div className='flex flex-wrap items-center gap-3' aria-label={ui('Candidate pages')}>
            <Button
              variant='outline'
              disabled={page <= 1 || busy}
              onClick={() => setPage(page - 1)}
            >
              {ui('Previous page')}
            </Button>
            <p className='text-sm text-ink-2'>
              {ui('Page {page} of {pages}', {
                page,
                pages: Math.max(1, Math.ceil(query.data.totalCandidates / query.data.pageSize)),
              })}
            </p>
            <Button
              variant='outline'
              disabled={page * query.data.pageSize >= query.data.totalCandidates || busy}
              onClick={() => setPage(page + 1)}
            >
              {ui('Next page')}
            </Button>
          </div>
          {candidates.length === 0 && (
            <p className='text-sm text-ink-2'>
              {ui('No unreviewed candidate pairs. Refresh after changing the collection.')}
            </p>
          )}
          <ul className='space-y-5'>
            {candidates.map((pair) => (
              <li
                key={pair.id}
                className='min-w-0 space-y-4 border-t border-line pt-5'
                data-duplicate-pair={pair.id}
              >
                <h3 className='font-medium text-ink'>
                  {ui('Evidence score')}: {Math.round(pair.score * 100)}%
                </h3>
                <ul className='list-disc space-y-1 pl-5 text-sm text-ink-2'>
                  {pair.reasons.map((reason) => (
                    <li key={reason}>{duplicateReason(reason, ui)}</li>
                  ))}
                </ul>
                {pair.decision && (
                  <p className='rp-badge rp-badge-quiet'>
                    {pair.decision === 'keep-both' ? ui('Keep both') : ui('Not a duplicate')} -{' '}
                    {ui('Reviewed')}
                  </p>
                )}
                <div className='grid min-w-0 gap-4 xl:grid-cols-2'>
                  {[pair.left, pair.right].map((item) => (
                    <Item
                      key={item.id}
                      item={item}
                      slug={slug}
                      onDeleted={(outcome) => {
                        heading.current?.focus()
                        setNotice(deletedNotice(item.title, outcome, ui))
                        void refresh()
                      }}
                    />
                  ))}
                </div>
                <div className='flex flex-wrap gap-3'>
                  <Button
                    variant='outline'
                    disabled={busy}
                    onClick={() => void decide(pair.id, 'not-duplicate')}
                  >
                    {ui('Not a duplicate')}
                  </Button>
                  <Button
                    variant='outline'
                    disabled={busy}
                    onClick={() => void decide(pair.id, 'keep-both')}
                  >
                    {ui('Keep both')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
