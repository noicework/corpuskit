import { useState } from 'react'
import type { AdminTenantOverview } from '@research-portal/core'
import { createAdminKb } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Provisioning affordance for a tenant's knowledge box: a prominent call to
 * action when there's no box at all, and a quieter "start fresh" option
 * when the tenant is still sitting on the shared demo box. Renders nothing
 * once a real box is connected.
 */
export function CreateKbBox({
  row,
  passcode,
  onCreated,
}: {
  row: AdminTenantOverview
  passcode: string
  onCreated: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onCreate = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await createAdminKb(row.tenant.slug, passcode)
      setMessage({
        tone: 'ok',
        text: 'Created a new knowledge box and connected this portal to it.',
      })
      await onCreated()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not create a knowledge box - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  if (row.knowledgeBox.status === 'none') {
    return (
      <div
        className='mt-4 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'
        style={{ borderStyle: 'dashed' }}
      >
        <p className='text-sm text-ink-2'>
          This portal has no knowledge box yet. Create one to start adding content.
        </p>
        <button
          type='button'
          disabled={busy}
          onClick={() => void onCreate()}
          className='rp-btn rp-btn-primary mt-3'
        >
          {busy ? 'Creating…' : 'Create a knowledge box'}
        </button>
        {message && <MessagePanel message={message} className='mt-3' />}
      </div>
    )
  }

  if (row.knowledgeBox.status === 'demo') {
    return (
      <div className='mt-4'>
        <div className='flex flex-wrap items-center gap-3'>
          <button
            type='button'
            disabled={busy}
            onClick={() => void onCreate()}
            className='rp-btn rp-btn-outline'
          >
            {busy ? 'Creating…' : 'Create new box'}
          </button>
          <p className='text-xs text-ink-3'>
            Creates a fresh box on the platform and connects this portal to it.
          </p>
        </div>
        {message && <MessagePanel message={message} className='mt-3' />}
      </div>
    )
  }

  return null
}
