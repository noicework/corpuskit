import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CorpusHealthRow } from '../../api/client.ts'
import { getCorpusHealth, setResourceHidden } from '../../api/client.ts'
import { errorMessage, type Message } from './shared.ts'
import { MessagePanel } from './MessagePanel.tsx'

/**
 * One resource that failed extraction or came back suspiciously thin - a
 * hide/publish toggle so it can be pulled out of the citable corpus without
 * deleting it (the librarian may want to investigate or re-crawl it later).
 */
function HealthRow({
  row,
  slug,
  passcode,
  onChanged,
}: {
  row: CorpusHealthRow
  slug: string
  passcode: string
  onChanged: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const toggle = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await setResourceHidden(slug, passcode, row.id, !row.hidden)
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not update that resource.') })
    } finally {
      setBusy(false)
    }
  }

  const badge = row.status === 'challenge'
    ? <span className='rp-badge rp-badge-bad'>Bot-challenge page</span>
    : row.status === 'thin'
    ? <span className='rp-badge rp-badge-warn'>Very little text</span>
    : null

  return (
    <li className='bg-surface px-4 py-3'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p className='truncate text-sm font-medium text-ink'>{row.title}</p>
          <div className='mt-1 flex flex-wrap items-center gap-2'>
            {badge}
            <span className='text-xs text-ink-3'>
              {row.words} {row.words === 1 ? 'word' : 'words'} extracted
            </span>
            {row.hidden ? <span className='rp-badge rp-badge-quiet'>Hidden</span> : null}
          </div>
        </div>
        <button
          type='button'
          disabled={busy}
          onClick={() => void toggle()}
          className='rp-btn rp-btn-outline shrink-0'
        >
          {busy ? 'Updating…' : row.hidden ? 'Publish' : 'Hide'}
        </button>
      </div>
      {message && <MessagePanel message={message} className='mt-3' />}
    </li>
  )
}

/**
 * Corpus health - a scan-on-demand audit that surfaces the failure modes that
 * make a search portal untrustworthy: bot-challenge pages and near-empty
 * extractions indexed and cited as if they were real content. Nothing runs
 * automatically - the scan reads every resource's extracted text, which is
 * slow on a large box, so the librarian triggers it deliberately.
 */
export function CorpusHealthPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<CorpusHealthRow[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [healthyOpen, setHealthyOpen] = useState(false)

  const scan = async () => {
    setScanning(true)
    setError(null)
    try {
      const result = await getCorpusHealth(slug, passcode)
      setRows(result)
    } catch (err) {
      setError(errorMessage(err, 'The scan failed - please try again.'))
    } finally {
      setScanning(false)
    }
  }

  const onChanged = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] })
    await scan()
  }

  const needsAttention = (rows ?? [])
    .filter((r) => r.status !== 'ok')
    .sort((a, b) => (a.status === 'challenge' ? -1 : 1) - (b.status === 'challenge' ? -1 : 1))
  const healthy = (rows ?? []).filter((r) => r.status === 'ok')

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <p className='text-sm font-semibold text-ink'>Corpus health</p>
          <p className='mt-0.5 max-w-md text-xs text-ink-3'>
            Pages that failed extraction (bot walls, empty pages) should be hidden so they can never
            be cited.
          </p>
        </div>
        <button
          type='button'
          disabled={scanning}
          onClick={() => void scan()}
          className='rp-btn rp-btn-primary shrink-0'
        >
          {scanning ? 'Scanning…' : rows ? 'Rescan corpus' : 'Scan corpus'}
        </button>
      </div>

      {scanning
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            Reading every resource's extracted text - this can take 10 to 20 seconds on a large
            corpus.
          </p>
        )
        : null}

      {error ? <MessagePanel message={{ tone: 'error', text: error }} className='mt-3' /> : null}

      {rows && rows.length === 0
        ? <p className='mt-4 text-sm text-ink-3'>This corpus has no resources yet.</p>
        : null}

      {rows && rows.length > 0
        ? (
          <div className='mt-4 space-y-4'>
            {needsAttention.length > 0
              ? (
                <div>
                  <p className='rp-eyebrow text-ink-3'>Needs attention ({needsAttention.length})</p>
                  <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
                    {needsAttention.map((row) => (
                      <HealthRow
                        key={row.id}
                        row={row}
                        slug={slug}
                        passcode={passcode}
                        onChanged={onChanged}
                      />
                    ))}
                  </ul>
                </div>
              )
              : (
                <p className='text-sm' style={{ color: 'var(--rp-ok-ink)' }}>
                  No extraction problems found.
                </p>
              )}

            {healthy.length > 0
              ? (
                <div>
                  <button
                    type='button'
                    onClick={() => setHealthyOpen((open) => !open)}
                    aria-expanded={healthyOpen}
                    className='rp-focus flex items-center gap-1.5 rounded-[var(--rp-radius-btn)] text-sm font-medium text-ink-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
                  >
                    <span aria-hidden='true'>{healthyOpen ? '▾' : '▸'}</span>
                    {healthy.length} healthy {healthy.length === 1 ? 'resource' : 'resources'}
                  </button>
                  {healthyOpen
                    ? (
                      <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
                        {healthy.map((row) => (
                          <HealthRow
                            key={row.id}
                            row={row}
                            slug={slug}
                            passcode={passcode}
                            onChanged={onChanged}
                          />
                        ))}
                      </ul>
                    )
                    : null}
                </div>
              )
              : null}
          </div>
        )
        : null}

      {!rows && !scanning && !error
        ? (
          <p className='mt-4 text-sm text-ink-3'>
            Run a scan to check every resource for bot-challenge pages and thin extractions.
          </p>
        )
        : null}
    </div>
  )
}
