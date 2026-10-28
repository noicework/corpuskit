import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAccess } from '../../components/AccessProvider.tsx'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { Button } from '../../components/ui.tsx'
import {
  downloadOverlap,
  duplicateReason,
  getOverlap,
  refreshOverlap,
} from '../../api/duplicates.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'

export function OverlapPanel() {
  const { ui, date } = usePortalLocale()
  const authority = useAccess()
  const { sessionAccess, sessionAllowed, runExplicit } = usePermissionAdminAccess('portal.create', {
    kind: 'platform',
  })
  const [page, setPage] = useState(1)
  const client = useQueryClient()
  const key = ['collection-overlap', authority.identityKey, authority.generation, page]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getOverlap(sessionAccess, signal, page),
    enabled: sessionAllowed,
    retry: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const context = authority.controller.context
  const run = async (download = false) => {
    setBusy(true)
    setError('')
    try {
      if (download) {
        const blob = await runExplicit(
          ui('Download collection overlap'),
          (access) => downloadOverlap(access, page),
        )
        authority.controller.assertCurrent(context)
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        try {
          anchor.href = url
          anchor.download = `collection-overlap-page-${page}.csv`
          document.body.append(anchor)
          anchor.click()
          setNotice(ui('Overlap CSV downloaded.'))
        } finally {
          anchor.remove()
          URL.revokeObjectURL(url)
        }
      } else {
        const result = await runExplicit(
          ui('Refresh collection overlap'),
          (access) => refreshOverlap(access, page),
        )
        authority.controller.assertCurrent(context)
        if (result) client.setQueryData(key, result)
        setNotice(ui('Overlap report refreshed.'))
      }
    } catch {
      if (context === authority.controller.context) {
        setError(ui('Could not load the overlap report. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className='rp-card min-w-0 space-y-4 p-5 lg:p-6'
      aria-labelledby='overlap-heading'
      data-overlap-panel
    >
      <h2 id='overlap-heading' className='rp-display text-xl text-ink'>
        {ui('Collection overlap')}
      </h2>
      <p className='max-w-prose text-sm text-ink-2'>
        {ui(
          'Compare portal collections using listed metadata. Counts are resource pairs and categories can overlap. File contents have not been compared. Cached metadata expires after one day; refresh to recompute now.',
        )}
      </p>
      <div className='flex flex-wrap gap-3'>
        <Button variant='outline' disabled={busy || query.isFetching} onClick={() => void run()}>
          {ui('Refresh overlap')}
        </Button>
        <Button variant='outline' disabled={busy || !query.data} onClick={() => void run(true)}>
          {ui('Download CSV')}
        </Button>
      </div>
      <p role='status' className='text-sm text-ink-2'>
        {busy ? ui('Preparing overlap report…') : notice}
      </p>
      {(error || query.error) && (
        <p
          role='alert'
          className='rounded-[var(--rp-radius)] bg-[var(--rp-bad-bg)] p-3 text-sm text-[var(--rp-bad-ink)]'
        >
          {error || ui('Could not load the overlap report. Try again.')}
        </p>
      )}
      {query.isLoading && <p role='status'>{ui('Loading overlap report…')}</p>}
      {query.data && (
        <>
          <p className='text-sm text-ink-3'>
            {ui('Last computed')}:{' '}
            {date(query.data.generatedAt, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
          {query.data.rows.length === 0 && (
            <p>{ui('At least two portal collections are needed to compare overlap.')}</p>
          )}
          <p className='text-sm text-ink-2'>
            {ui('The CSV contains the current page of collection pairs.')}
          </p>
          <div className='flex flex-wrap items-center gap-3'>
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
                pages: Math.max(1, Math.ceil(query.data.totalRows / query.data.pageSize)),
              })}
            </p>
            <Button
              variant='outline'
              disabled={page * query.data.pageSize >= query.data.totalRows || busy}
              onClick={() => setPage(page + 1)}
            >
              {ui('Next page')}
            </Button>
          </div>
          <ul className='grid min-w-0 gap-5 2xl:grid-cols-2'>
            {query.data.rows.map((row) => (
              <li
                key={`${row.left}/${row.right}`}
                className='min-w-0 space-y-3 rounded-[var(--rp-radius)] bg-surface-2 p-4'
              >
                <h3 className='break-words font-medium text-ink'>{row.left} / {row.right}</h3>
                <p className='text-sm text-ink-3'>
                  {row.leftCount} / {row.rightCount} {ui('resources')}
                </p>
                <dl className='grid grid-cols-1 gap-3 text-sm text-ink sm:grid-cols-2'>
                  {[
                    [ui('Shared title pairs'), row.sharedTitles],
                    [ui('Shared URL pairs'), row.sharedUrls],
                    [ui('High similarity pairs'), row.highSimilarity],
                    [ui('Matching pairs'), row.matchingPairs],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className='text-ink-2'>{label}</dt>
                      <dd className='font-medium'>{value}</dd>
                    </div>
                  ))}
                </dl>
                {row.limited && (
                  <p className='rounded-[var(--rp-radius)] bg-[var(--rp-warn-bg)] p-3 text-sm text-[var(--rp-warn-ink)]'>
                    {ui(
                      'Comparison limit reached. Counts are lower bounds, not collection totals.',
                    )}
                  </p>
                )}
                {row.examples.length > 0 && (
                  <details>
                    <summary className='rp-focus min-h-11 cursor-pointer py-3 text-sm font-medium text-ink'>
                      {ui('Examples')} ({row.examples.length})
                    </summary>
                    <ul className='space-y-3 text-sm text-ink-2'>
                      {row.examples.map((pair, i) => (
                        <li key={i} className='space-y-1 break-words'>
                          <Link
                            className='rp-link-standalone max-w-full break-words'
                            to={`/t/${row.left}/library/${encodeURIComponent(pair.left.id)}`}
                          >
                            {pair.left.title}
                          </Link>
                          <span className='block'>
                            /{' '}
                            <Link
                              className='rp-link-standalone max-w-full break-words'
                              to={`/t/${row.right}/library/${encodeURIComponent(pair.right.id)}`}
                            >
                              {pair.right.title}
                            </Link>
                          </span>
                          <p>
                            {pair.reasons.map((reason) => duplicateReason(reason, ui)).join('; ')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
