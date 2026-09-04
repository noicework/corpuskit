import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { addPortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Add a brand-new knowledge box portal: names the portal, then its row
 * appears below where you create a fresh box on the platform or connect an
 * existing endpoint. Collapsed to a slim button row by default so it doesn't
 * compete with the portal list for attention.
 */
export function AddPortal({ passcode }: { passcode: string }) {
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
      const result = await addPortal(passcode, {
        name,
        organisation: organisation || undefined,
        tagline: tagline || undefined,
      })
      setName('')
      setOrganisation('')
      setTagline('')
      setMessage({
        tone: 'ok',
        text:
          `Portal '${result.slug}' added - use its card below to create a fresh knowledge box ` +
          'on the platform or connect an existing endpoint.',
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not add the portal.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='rp-card overflow-hidden' style={{ borderStyle: 'dashed' }}>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className='flex w-full items-center justify-between gap-3 px-6 py-4 text-left'
      >
        <span className='flex items-center gap-2'>
          <span aria-hidden='true' className='text-ink-3'>{open ? '▾' : '▸'}</span>
          <span className='text-sm font-semibold text-ink'>Add a knowledge box</span>
        </span>
        {!open && <span className='hidden text-xs text-ink-3 sm:inline'>Creates a new portal</span>}
      </button>

      {open && (
        <div className='border-t border-line px-6 py-5'>
          <p className='text-sm text-ink-3'>
            Creates a new portal. You then either deploy a fresh knowledge box on the platform or
            connect an existing one from its card.
          </p>
          <form onSubmit={onSubmit} className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3'>
            <div>
              <label htmlFor='portal-name' className='mb-1.5 block text-sm font-medium text-ink'>
                Name
              </label>
              <input
                id='portal-name'
                className='rp-input'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. AgriFutures Research Hub'
                autoComplete='off'
                required
                minLength={2}
              />
            </div>
            <div>
              <label htmlFor='portal-org' className='mb-1.5 block text-sm font-medium text-ink'>
                Organisation <span className='font-normal text-ink-3'>(optional)</span>
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
                Tagline <span className='font-normal text-ink-3'>(optional)</span>
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
              <button type='submit' disabled={busy} className='rp-btn rp-btn-primary'>
                {busy ? 'Adding…' : 'Add portal'}
              </button>
            </div>
          </form>
          {message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </section>
  )
}
