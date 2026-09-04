import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AdminTenantOverview } from '@research-portal/core'
import {
  connectKnowledgeBox,
  removePortal,
  revertKnowledgeBox,
  setPortalDisabled,
} from '../../api/client.ts'
import { CreateKbBox } from './CreateKbBox.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { RenamePortal } from './RenamePortal.tsx'
import { errorMessage, type Message } from './shared.ts'

type Status = AdminTenantOverview['knowledgeBox']['status']

const STATUS_DOT: Record<Status, string> = {
  connected: 'bg-[var(--rp-ok-ink)]',
  demo: 'bg-[var(--rp-warn-ink)]',
  none: 'bg-surface-3',
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden='true'
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
    />
  )
}

function StatusBadge({ status }: { status: Status }) {
  if (status === 'connected') return <span className='rp-badge rp-badge-ok'>Connected</span>
  if (status === 'demo') return <span className='rp-badge rp-badge-warn'>Demo only</span>
  return <span className='rp-badge rp-badge-quiet'>Not connected</span>
}

/**
 * One portal in the connections accordion. Collapsed by default to a single
 * summary row; the caller controls expansion so only one portal is open at
 * a time. Expanded content is the connection form plus lifecycle controls -
 * everything else (content, appearance, analysis) lives in that portal's own
 * Manage workspace at /t/:slug/manage.
 */
export function PortalRow({
  row,
  passcode,
  expanded,
  onToggleExpanded,
}: {
  row: AdminTenantOverview
  passcode: string
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-overview'] })

  const onConnect = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await connectKnowledgeBox(row.tenant.slug, { url, token, passcode })
      setUrl('')
      setToken('')
      setMessage({
        tone: 'ok',
        text: `Connected - the knowledge box responded with ${outcome.resourceCount} ${
          outcome.resourceCount === 1 ? 'resource' : 'resources'
        }.`,
      })
      await refresh()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Connection failed - please try again.',
      })
    } finally {
      setBusy(false)
    }
  }

  const onToggleDisabled = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await setPortalDisabled(row.tenant.slug, passcode, !row.disabled)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not update the portal.',
      })
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async () => {
    if (!globalThis.confirm(`Remove the '${row.tenant.productName}' portal from the app?`)) return
    setBusy(true)
    setMessage(null)
    try {
      await removePortal(row.tenant.slug, passcode)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not remove the portal.',
      })
      setBusy(false)
    }
  }

  const onRevert = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await revertKnowledgeBox(row.tenant.slug, passcode)
      setMessage({ tone: 'ok', text: 'Reverted to the demo knowledge box.' })
      await refresh()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not revert - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='rp-card overflow-hidden'>
      <button
        type='button'
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className='flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-6 py-4 text-left transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        <span className='flex min-w-0 flex-1 items-center gap-3'>
          <StatusDot status={row.knowledgeBox.status} />
          <span className='min-w-0 truncate'>
            <span className='font-semibold text-ink'>{row.tenant.productName}</span>
            <span className='ml-2 text-sm text-ink-3'>{row.tenant.organisation}</span>
          </span>
        </span>
        <span className='flex shrink-0 items-center gap-2'>
          <StatusBadge status={row.knowledgeBox.status} />
          {row.disabled && <span className='rp-badge rp-badge-quiet'>Hidden</span>}
        </span>
        <span className='flex shrink-0 items-center gap-2'>
          <span className='text-sm text-ink-3'>
            {row.resourceCount === null
              ? 'unreachable'
              : `${row.resourceCount} ${row.resourceCount === 1 ? 'document' : 'documents'}`}
          </span>
          <span
            aria-hidden='true'
            className={`text-ink-3 transition-transform duration-150 ${
              expanded ? 'rotate-180' : ''
            }`}
          >
            &#9662;
          </span>
        </span>
      </button>

      {expanded && (
        <div className='border-t border-line'>
          <div className='flex flex-wrap items-start justify-between gap-4 px-6 py-5'>
            {renaming
              ? (
                <RenamePortal
                  slug={row.tenant.slug}
                  passcode={passcode}
                  initialName={row.tenant.productName}
                  initialOrganisation={row.tenant.organisation}
                  initialTagline={row.tenant.tagline}
                  onCancel={() => setRenaming(false)}
                  onSaved={() => setRenaming(false)}
                />
              )
              : (
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <h3 className='truncate text-lg font-semibold tracking-tight text-ink'>
                      {row.tenant.productName}
                    </h3>
                    <button
                      type='button'
                      onClick={() => setRenaming(true)}
                      className='text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-ink)]'
                    >
                      Rename
                    </button>
                  </div>
                  <p className='mt-0.5 text-sm text-ink-3'>{row.tenant.organisation}</p>
                </div>
              )}

            <div className='flex shrink-0 flex-col items-end gap-2'>
              <StatusBadge status={row.knowledgeBox.status} />
              <Link to={`/t/${row.tenant.slug}/manage`} className='rp-btn rp-btn-primary'>
                Open portal management &rarr;
              </Link>
              <Link
                to={`/t/${row.tenant.slug}`}
                className='text-sm font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-ink)]'
              >
                View portal
              </Link>
            </div>
          </div>

          <div className='px-6 pb-6'>
            <h4 className='text-sm font-semibold text-ink'>Connection</h4>
            <dl className='mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2'>
              <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
                <dt className='rp-eyebrow text-ink-3'>Knowledge box</dt>
                <dd className='mt-1 font-mono text-ink'>{row.knowledgeBox.kbId ?? 'none'}</dd>
              </div>
              <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
                <dt className='rp-eyebrow text-ink-3'>Documents</dt>
                <dd className='mt-1 text-ink'>
                  {row.resourceCount === null ? 'unreachable' : row.resourceCount}
                </dd>
              </div>
            </dl>

            <CreateKbBox row={row} passcode={passcode} onCreated={refresh} />

            <form onSubmit={onConnect} className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <div>
                <label
                  htmlFor={`kb-id-${row.tenant.slug}`}
                  className='mb-1.5 block text-sm font-medium text-ink'
                >
                  {row.knowledgeBox.status === 'connected'
                    ? 'Replace with knowledge box endpoint'
                    : 'Knowledge box API endpoint'}
                </label>
                <input
                  id={`kb-id-${row.tenant.slug}`}
                  className='rp-input'
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder='https://<region>.rag.progress.cloud/api/v1/kb/<box-id>'
                  autoComplete='off'
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={`kb-token-${row.tenant.slug}`}
                  className='mb-1.5 block text-sm font-medium text-ink'
                >
                  Service account API key
                </label>
                <input
                  id={`kb-token-${row.tenant.slug}`}
                  type='password'
                  className='rp-input'
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder='Paste the service account key'
                  autoComplete='off'
                  required
                />
              </div>
              <div className='flex flex-wrap items-center gap-3 sm:col-span-2'>
                <button type='submit' disabled={busy} className='rp-btn rp-btn-primary'>
                  {busy ? 'Working…' : 'Verify and connect'}
                </button>
                {row.knowledgeBox.status === 'connected' && (
                  <button
                    type='button'
                    disabled={busy}
                    onClick={() => void onRevert()}
                    className='rp-btn rp-btn-outline'
                  >
                    Revert to demo box
                  </button>
                )}
              </div>
            </form>
            <p className='mt-2 text-xs text-ink-3'>
              The connection is verified against the live platform before it is saved. Tokens are
              stored server-side only.
            </p>

            <div className='mt-4 flex flex-wrap items-center gap-4 border-t border-line pt-3'>
              <button
                type='button'
                disabled={busy}
                onClick={() => void onToggleDisabled()}
                className='text-sm font-medium text-ink-3 transition-colors duration-150 hover:text-[var(--rp-ink)] disabled:opacity-60'
                title={row.disabled
                  ? 'Show this portal in the switcher and portal list again'
                  : 'Hide this portal from the switcher and portal list'}
              >
                {row.disabled ? 'Enable' : 'Disable'}
              </button>
              {row.custom && (
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => void onRemove()}
                  className='rp-btn rp-btn-danger'
                  title='Removes this portal from the app - the knowledge box itself is untouched'
                >
                  Remove
                </button>
              )}
            </div>

            {message && <MessagePanel message={message} className='mt-4' />}
          </div>
        </div>
      )}
    </section>
  )
}
