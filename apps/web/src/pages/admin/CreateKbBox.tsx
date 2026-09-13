import { useAccess } from '../../components/AccessProvider.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { type ComponentProps, useEffect, useRef, useState } from 'react'
import type { AdminTenantOverview } from '@research-portal/core'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { createAdminKb } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Provisioning affordance for a tenant's knowledge box: a prominent call to
 * action when there's no box at all, and a quieter "start fresh" option
 * when the tenant is still sitting on the shared demo box. Renders nothing
 * once a real box is connected.
 */
function CreateKbBoxContent({
  row,
  onCreated,
}: {
  row: AdminTenantOverview
  onCreated: () => Promise<unknown>
}) {
  const { runExplicit } = usePermissionAdminAccess('bindings.write', {
    kind: 'portal',
    slug: row.tenant.slug,
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const authority = useAccess()
  const context = authority.controller.context
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const current = () => mounted.current && context === authority.controller.context
  const assertCurrent = () => {
    authority.controller.assertCurrent(context)
    if (!mounted.current) throw new AdminAccessError()
  }

  const onCreate = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        `Create a knowledge box for ${row.tenant.productName}`,
        (access) => {
          assertCurrent()
          return createAdminKb(row.tenant.slug, access)
        },
      )
      assertCurrent()
      if (result === undefined) return
      setMessage({
        tone: 'ok',
        text: 'Created a new knowledge box and connected this portal to it.',
      })
      await onCreated()
    } catch (err) {
      if (!current()) return
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not create a knowledge box - please try again.'),
      })
    } finally {
      if (current()) setBusy(false)
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
          style={{
            height: 'auto',
            minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
            paddingBlock: '0.5rem',
            whiteSpace: 'normal',
            maxWidth: '100%',
          }}
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
            style={{
              height: 'auto',
              minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
              paddingBlock: '0.5rem',
              whiteSpace: 'normal',
              maxWidth: '100%',
            }}
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

export function CreateKbBox(props: ComponentProps<typeof CreateKbBoxContent>) {
  const { generation } = useAccess()
  const { sessionAllowed, breakGlassEnabled } = usePermissionAdminAccess('bindings.write', {
    kind: 'portal',
    slug: props.row.tenant.slug,
  })
  if (props.row.disabled || (!sessionAllowed && !breakGlassEnabled)) return null
  return (
    <CreateKbBoxContent
      key={`${generation}:${props.row.tenant.slug}:${sessionAllowed}`}
      {...props}
    />
  )
}
