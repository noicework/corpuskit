import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AdminTenantOverview } from '@research-portal/core'
import { removePortal, setPortalDisabled } from '../../api/client.ts'
import { useAdminAccess } from '../../components/EmergencyAccess.tsx'
import { PortalConnections } from './PortalConnections.tsx'
import { CreateKbBox } from './CreateKbBox.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { RenamePortal } from './RenamePortal.tsx'
import { type Message } from './shared.ts'

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
  expanded,
  onToggleExpanded,
}: {
  row: AdminTenantOverview
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const { runExplicit } = useAdminAccess()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-overview'] })

  const onToggleDisabled = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        `${row.disabled ? 'Enable' : 'Disable'} ${row.tenant.productName}`,
        (access) => setPortalDisabled(row.tenant.slug, access, !row.disabled),
      )
      if (result === undefined) return
      setMessage({
        tone: 'ok',
        text: `Portal ${
          row.disabled ? 'enabled' : 'disabled'
        }. Refresh the overview to see its latest state.`,
      })
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
      const result = await runExplicit(
        `Remove ${row.tenant.productName}`,
        (access) => removePortal(row.tenant.slug, access),
      )
      if (result === undefined) return
      setMessage({
        tone: 'ok',
        text: 'Portal removed. Refresh the overview to see its latest state.',
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not remove the portal.',
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

            <div className='flex min-w-0 max-w-full flex-col items-start gap-2 sm:items-end'>
              <StatusBadge status={row.knowledgeBox.status} />
              <Link
                to={`/t/${row.tenant.slug}/manage`}
                className='rp-btn rp-btn-primary max-w-full whitespace-normal text-center'
                style={{
                  height: 'auto',
                  minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
                  paddingBlock: '0.5rem',
                }}
              >
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
            <CreateKbBox row={row} onCreated={refresh} />
            <PortalConnections
              slug={row.tenant.slug}
              name={row.tenant.productName}
              knowledgeBox={row.knowledgeBox}
              resourceCount={row.resourceCount}
              onChanged={refresh}
            />

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
