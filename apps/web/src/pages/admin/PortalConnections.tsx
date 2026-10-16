import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { type ComponentProps, type FormEvent, useEffect, useRef, useState } from 'react'
import type { KnowledgeBoxStatus } from '@research-portal/core'
import { connectKnowledgeBox, revertKnowledgeBox } from '../../api/client.ts'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/** Portal connection controls require only this portal's binding permission. */
function PortalConnectionsContent({ slug, name, knowledgeBox, resourceCount, onChanged }: {
  slug: string
  name: string
  knowledgeBox: KnowledgeBoxStatus
  resourceCount: number | null
  onChanged: () => Promise<unknown>
}) {
  const { ui, error: localError } = usePortalLocale()

  const { sessionAllowed, breakGlassEnabled, runExplicit, pending } = usePermissionAdminAccess(
    'bindings.write',
    { kind: 'portal', slug },
  )
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
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

  if (!sessionAllowed && !breakGlassEnabled) {
    return <p className='text-sm text-ink-2'>{ui('Connection management is unavailable.')}</p>
  }

  async function onConnect(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await runExplicit(
        ui('Connect the knowledge box for {name}', { name: name }),
        (access) => {
          assertCurrent()
          return connectKnowledgeBox(slug, { url, token }, access)
        },
      )
      assertCurrent()
      if (outcome === undefined) return
      setUrl('')
      setToken('')
      setMessage({
        tone: 'ok',
        text: ui(
          outcome.resourceCount === 1
            ? 'Connected - the knowledge box responded with {count} resource.'
            : 'Connected - the knowledge box responded with {count} resources.',
          { count: outcome.resourceCount },
        ),
      })
      await onChanged()
    } catch (error) {
      if (!current()) return
      setMessage({
        tone: 'error',
        text: errorMessage(error, 'Connection failed - please try again.', localError),
      })
    } finally {
      if (current()) setBusy(false)
    }
  }

  async function onRevert() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(
        ui('Revert {name} to its demo knowledge box', { name: name }),
        (access) => {
          assertCurrent()
          return revertKnowledgeBox(slug, access)
        },
      )
      assertCurrent()
      if (result === undefined) return
      setMessage({ tone: 'ok', text: ui('Reverted to the demo knowledge box.') })
      await onChanged()
    } catch (error) {
      if (!current()) return
      setMessage({
        tone: 'error',
        text: errorMessage(error, 'Could not revert - please try again.', localError),
      })
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section data-portal-connections className='min-w-0'>
      <h2 className='text-sm font-semibold text-ink'>{ui('Connection')}</h2>
      <dl className='mt-3 grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2'>
        <div className='min-w-0 rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
          <dt className='rp-eyebrow text-ink-3'>{ui('Knowledge box')}</dt>
          <dd className='mt-1 break-all font-mono text-ink'>
            {knowledgeBox.kbId ?? ui('Not connected')}
          </dd>
        </div>
        <div className='rounded-[var(--rp-radius)] bg-surface-2 px-4 py-3'>
          <dt className='rp-eyebrow text-ink-3'>{ui('Documents')}</dt>
          <dd className='mt-1 text-ink'>{resourceCount ?? ui('Unavailable')}</dd>
        </div>
      </dl>
      <form onSubmit={onConnect} className='mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2'>
        <div className='min-w-0'>
          <label htmlFor={`kb-id-${slug}`} className='mb-1.5 block text-sm font-medium text-ink'>
            {knowledgeBox.status === 'connected' || knowledgeBox.status === 'unavailable'
              ? ui('Replace with knowledge box endpoint')
              : ui('Knowledge box API endpoint')}
          </label>
          <input
            id={`kb-id-${slug}`}
            className='rp-input w-full min-w-0'
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={ui('https://<region>.rag.progress.cloud/api/v1/kb/<box-id>')}
            autoComplete='off'
            required
          />
        </div>
        <div className='min-w-0'>
          <label htmlFor={`kb-token-${slug}`} className='mb-1.5 block text-sm font-medium text-ink'>
            {ui('Service account API key')}
          </label>
          <input
            id={`kb-token-${slug}`}
            type='password'
            className='rp-input w-full min-w-0'
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={ui('Paste the service account key')}
            autoComplete='off'
            required
          />
        </div>
        <div className='flex min-w-0 flex-wrap items-center gap-3 sm:col-span-2'>
          <button
            type='submit'
            disabled={busy || pending}
            className='rp-btn rp-btn-primary'
            style={{
              height: 'auto',
              minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
              paddingBlock: '0.5rem',
              whiteSpace: 'normal',
              maxWidth: '100%',
            }}
          >
            {busy ? ui('Working...') : ui('Verify and connect')}
          </button>
          {(knowledgeBox.status === 'connected' || knowledgeBox.status === 'unavailable') && (
            <button
              type='button'
              disabled={busy || pending}
              onClick={() => void onRevert()}
              className='rp-btn rp-btn-outline'
              style={{
                height: 'auto',
                minHeight: 'calc(2.25rem * var(--rp-density-ctl, 1))',
                paddingBlock: '0.5rem',
                whiteSpace: 'normal',
                maxWidth: '100%',
              }}
            >
              {knowledgeBox.status === 'unavailable' ? ui('Disconnect') : ui('Revert to demo box')}
            </button>
          )}
        </div>
      </form>
      <p className='mt-2 text-xs text-ink-3'>
        {ui(
          'The connection is verified against the live platform before it is saved. Tokens are stored server-side only.',
        )}
      </p>
      {message && <MessagePanel message={message} className='mt-4' />}
    </section>
  )
}

export function PortalConnections(props: ComponentProps<typeof PortalConnectionsContent>) {
  const { generation } = useAccess()
  const { sessionAllowed, breakGlassEnabled } = usePermissionAdminAccess('bindings.write', {
    kind: 'portal',
    slug: props.slug,
  })
  if (!sessionAllowed && !breakGlassEnabled) return null
  return (
    <PortalConnectionsContent key={`${generation}:${props.slug}:${sessionAllowed}`} {...props} />
  )
}
