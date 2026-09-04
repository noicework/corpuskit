import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AdminTenantOverview, MigrationEvent } from '@research-portal/core'
import { migrateKb } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

type ItemEvent = Extract<MigrationEvent, { type: 'item' }>
type DoneEvent = Extract<MigrationEvent, { type: 'done' }>

const OUTCOME_LABEL: Record<ItemEvent['outcome'], string> = {
  copied: 'Copied',
  'skipped-exists': 'Skipped',
  'skipped-unsupported': 'Skipped',
  error: 'Error',
}

const OUTCOME_BADGE: Record<ItemEvent['outcome'], string> = {
  copied: 'rp-badge-ok',
  'skipped-exists': 'rp-badge-warn',
  'skipped-unsupported': 'rp-badge-warn',
  error: 'rp-badge-bad',
}

/**
 * Copies every resource from one portal's knowledge box into another's,
 * streaming live progress from the server as it goes. Sits at the bottom of
 * the connections page, its own card, independent of any single tenant.
 */
export function MigratePanel(
  { rows, passcode }: { rows: AdminTenantOverview[]; passcode: string },
) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [running, setRunning] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [items, setItems] = useState<ItemEvent[]>([])
  const [summary, setSummary] = useState<DoneEvent | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const options = rows.map((r) => ({ slug: r.tenant.slug, label: r.tenant.productName }))
  const canRun = from.length > 0 && to.length > 0 && from !== to && !running

  const onRun = async () => {
    setRunning(true)
    setMessage(null)
    setTotal(null)
    setItems([])
    setSummary(null)
    try {
      await migrateKb(from, to, passcode, (event) => {
        if (event.type === 'start') setTotal(event.total)
        else if (event.type === 'item') setItems((prev) => [...prev, event])
        else if (event.type === 'done') setSummary(event)
        else if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-recent'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-counters'] }),
      ])
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Migration failed - please try again.') })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className='rp-card overflow-hidden'>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className='flex w-full items-center justify-between gap-3 px-6 py-4 text-left'
      >
        <span className='flex items-center gap-2'>
          <span aria-hidden='true' className='text-ink-3'>{open ? '▾' : '▸'}</span>
          <span className='text-sm font-semibold text-ink'>Migrate resources</span>
        </span>
        {!open && (
          <span className='hidden text-xs text-ink-3 sm:inline'>
            Copy resources between portals
          </span>
        )}
      </button>

      {open && (
        <div className='border-t border-line px-6 py-5'>
          <p className='text-sm text-ink-3'>
            Copy every resource from one portal's knowledge box into another's.
          </p>

          <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <div>
              <label htmlFor='migrate-from' className='mb-1.5 block text-sm font-medium text-ink'>
                From portal
              </label>
              <select
                id='migrate-from'
                className='rp-input'
                value={from}
                disabled={running}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value=''>Choose a portal</option>
                {options.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor='migrate-to' className='mb-1.5 block text-sm font-medium text-ink'>
                To portal
              </label>
              <select
                id='migrate-to'
                className='rp-input'
                value={to}
                disabled={running}
                onChange={(e) => setTo(e.target.value)}
              >
                <option value=''>Choose a portal</option>
                {options.filter((o) => o.slug !== from).map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type='button'
            disabled={!canRun}
            onClick={() => void onRun()}
            className='rp-btn rp-btn-primary mt-4'
          >
            {running ? 'Migrating…' : 'Run migration'}
          </button>

          {total !== null && (
            <div className='mt-5'>
              <p className='text-sm text-ink-2'>{items.length} of {total} processed</p>
              <ul className='mt-2 max-h-64 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
                {items.map((item) => (
                  <li key={item.id} className='flex items-center justify-between gap-3 text-sm'>
                    <span className='truncate text-ink-2'>{item.title}</span>
                    <span title={item.detail} className={`rp-badge ${OUTCOME_BADGE[item.outcome]}`}>
                      {OUTCOME_LABEL[item.outcome]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary && (
            <p className='mt-3 text-sm text-ink-2'>
              Copied {summary.copied}, skipped {summary.skipped}, {summary.errors} errors.
            </p>
          )}

          {message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </section>
  )
}
