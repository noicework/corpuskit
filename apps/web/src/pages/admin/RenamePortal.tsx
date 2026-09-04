import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { renamePortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Inline rename form that swaps in for a portal's name/organisation lines.
 * Saves via renamePortal and refreshes both the admin overview and the
 * public tenant list so the switcher picks up the change.
 */
export function RenamePortal({
  slug,
  passcode,
  initialName,
  initialOrganisation,
  initialTagline,
  onCancel,
  onSaved,
}: {
  slug: string
  passcode: string
  initialName: string
  initialOrganisation: string
  initialTagline: string
  onCancel: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(initialName)
  const [organisation, setOrganisation] = useState(initialOrganisation)
  const [tagline, setTagline] = useState(initialTagline)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await renamePortal(slug, passcode, {
        name: name.trim(),
        organisation: organisation.trim(),
        tagline: tagline.trim(),
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
      onSaved()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not rename the portal.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className='min-w-0 flex-1 space-y-2.5'>
      <div className='grid grid-cols-1 gap-2.5 sm:grid-cols-3'>
        <div>
          <label htmlFor={`rename-name-${slug}`} className='sr-only'>Name</label>
          <input
            id={`rename-name-${slug}`}
            className='rp-input'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Product name'
            autoComplete='off'
            required
            minLength={2}
          />
        </div>
        <div>
          <label htmlFor={`rename-org-${slug}`} className='sr-only'>Organisation</label>
          <input
            id={`rename-org-${slug}`}
            className='rp-input'
            value={organisation}
            onChange={(e) => setOrganisation(e.target.value)}
            placeholder='Organisation'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label htmlFor={`rename-tagline-${slug}`} className='sr-only'>Tagline</label>
          <input
            id={`rename-tagline-${slug}`}
            className='rp-input'
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder='Tagline'
            autoComplete='off'
            required
          />
        </div>
      </div>
      <div className='flex items-center gap-3'>
        <button type='submit' disabled={busy} className='rp-btn rp-btn-primary'>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type='button' disabled={busy} onClick={onCancel} className='rp-btn rp-btn-outline'>
          Cancel
        </button>
      </div>
      {message && <MessagePanel message={message} />}
    </form>
  )
}
