import { messageFor } from './shared.ts'
import { usePortalLocale } from '../../lib/portal-locale.tsx'
import { useAccess } from '../../components/AccessProvider.tsx'
import { AdminAccessError } from '../../api/break-glass.ts'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePermissionAdminAccess } from '../../components/EmergencyAccess.tsx'
import { addPortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'
import { ChevronDown, Plus } from '../../components/icons.tsx'
import { Button, SectionHeader } from '../../components/ui.tsx'

/**
 * Add a brand-new knowledge box portal: names the portal, then its row
 * appears below where you create a fresh box on the platform or connect an
 * existing endpoint. Collapsed to a slim button row by default so it doesn't
 * compete with the portal list for attention.
 */
function AddPortalContent() {
  const { ui } = usePortalLocale()

  const { runExplicit } = usePermissionAdminAccess('portal.create', { kind: 'platform' })
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
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [tagline, setTagline] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const result = await runExplicit(ui('Create a portal'), (access) => {
        assertCurrent()
        return addPortal(access, {
          name,
          organisation: organisation || undefined,
          tagline: tagline || undefined,
        })
      })
      assertCurrent()
      if (result === undefined) return
      setName('')
      setOrganisation('')
      setTagline('')
      setMessage(messageFor('ok', ({ ui }) =>
        ui(
          "Portal '{slug}' added - use its card below to create a fresh knowledge box on the platform or connect an existing endpoint.",
          { slug: result.slug },
        )))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      if (!current()) return
      setMessage(
        messageFor(
          'error',
          ({ error: localError }) => errorMessage(err, 'Could not add the portal.', localError),
        ),
      )
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section data-add-portal className='rp-card overflow-hidden'>
      <SectionHeader
        className='rp-admin-section-head p-5 lg:p-6'
        title={ui('Add a knowledge box')}
        description={ui('Creates a new portal')}
        actions={
          <Button
            variant='ghost'
            size='sm'
            leadingIcon={Plus}
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            aria-controls='add-portal-form'
          >
            {ui('Add portal')}
            <ChevronDown
              size='sm'
              className={`transition-transform duration-150 motion-reduce:transition-none ${
                open ? 'rotate-180' : ''
              }`}
            />
          </Button>
        }
      />

      {open && (
        <div id='add-portal-form' className='border-t border-line p-5 lg:p-6'>
          <p className='text-sm text-ink-3'>
            {ui(
              'Creates a new portal. You then either deploy a fresh knowledge box on the platform or connect an existing one from its card.',
            )}
          </p>
          <form onSubmit={onSubmit} className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3'>
            <div>
              <label htmlFor='portal-name' className='mb-1.5 block text-sm font-medium text-ink'>
                {ui('Name')}
              </label>
              <input
                id='portal-name'
                className='rp-input'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={ui('e.g. Soil Research Hub')}
                autoComplete='off'
                required
                minLength={2}
              />
            </div>
            <div>
              <label htmlFor='portal-org' className='mb-1.5 block text-sm font-medium text-ink'>
                {ui('Organisation ')}
                <span className='font-normal text-ink-3'>{ui('(optional)')}</span>
              </label>
              <input
                id='portal-org'
                className='rp-input'
                value={organisation}
                onChange={(e) => setOrganisation(e.target.value)}
                autoComplete='off'
              />
            </div>
            <div>
              <label htmlFor='portal-tagline' className='mb-1.5 block text-sm font-medium text-ink'>
                {ui('Tagline ')}
                <span className='font-normal text-ink-3'>{ui('(optional)')}</span>
              </label>
              <input
                id='portal-tagline'
                className='rp-input'
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                autoComplete='off'
              />
            </div>
            <div className='sm:col-span-3'>
              <Button type='submit' disabled={busy} leadingIcon={Plus}>
                {busy ? ui('Adding…') : ui('Add portal')}
              </Button>
            </div>
          </form>
          {message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </section>
  )
}

export function AddPortal() {
  const { generation } = useAccess()
  const { sessionAllowed, breakGlassEnabled } = usePermissionAdminAccess('portal.create', {
    kind: 'platform',
  })
  if (!sessionAllowed && !breakGlassEnabled) return null
  return <AddPortalContent key={`${generation}:${sessionAllowed}`} />
}
