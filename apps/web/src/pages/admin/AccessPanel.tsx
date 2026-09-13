import { useId, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { type AccessMode, type Permission } from '@research-portal/core'
import { useAccess } from '../../components/AccessProvider.tsx'
import {
  AssignmentSection,
  unconfirmedMessage,
  useAccessMutation,
} from '../../components/AssignmentSection.tsx'
import { ConfirmActionDialog } from '../../components/ConfirmActionDialog.tsx'
import { AssignmentError, changeAccessMode } from '../../api/access.ts'
import type { TenantOutletContext } from '../TenantLayout.tsx'
import { KeysPanel } from './KeysPanel.tsx'

export const ACCESS_SECTION_PERMISSIONS: readonly Permission[] = [
  'members.manage',
  'behaviour.write',
  'keys.manage',
]
const modes: { value: AccessMode; label: string; help: string }[] = [
  { value: 'public', label: 'Public', help: 'Anyone can browse, search and ask questions.' },
  {
    value: 'authenticated',
    label: 'Organisation sign-in',
    help: 'People signed in to this organisation can browse, search and ask questions.',
  },
  {
    value: 'restricted',
    label: 'Restricted',
    help: 'Only people with assigned access can open this portal.',
  },
]
export function AccessPanel({ slug, name }: { slug: string; name: string }) {
  const access = useAccess()
  const scope = { kind: 'portal' as const, slug }
  if (!ACCESS_SECTION_PERMISSIONS.some((permission) => access.can(permission, scope))) return null
  return (
    <section className='rp-card min-w-0 p-6' data-access-panel>
      <h2 className='rp-display break-words text-xl [overflow-wrap:anywhere]'>Access to {name}</h2>
      <p className='mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]'>Portal: {slug}</p>
      <AssignmentSection scope={scope} name={name} family='members' />
      <AssignmentSection scope={scope} name={name} family='groups' />
      {access.can('behaviour.write', scope) && (
        <AccessModeSection key={`${slug}:${access.generation}`} slug={slug} name={name} />
      )}
      <KeysPanel slug={slug} />
    </section>
  )
}
function AccessModeSection({ slug, name }: { slug: string; name: string }) {
  const { config } = useOutletContext<TenantOutletContext>()
  const current = config.slug === slug
    ? modes.find((mode) => mode.value === config.accessMode)
    : undefined
  const [selected, setSelected] = useState<AccessMode | undefined>(current?.value)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const { mutate, notice, options } = useAccessMutation(
    { kind: 'portal', slug },
    'behaviour.write',
    'mode',
  )
  const chosen = modes.find((mode) => mode.value === selected)
  const save = async () => {
    if (busy || !current || !chosen || chosen === current) return
    setBusy(true)
    setError(null)
    try {
      await mutate(() => changeAccessMode(slug, chosen.value, options))
    } catch (failure) {
      if (options.authority.context === options.context) {
        setError(failure instanceof AssignmentError ? failure.message : unconfirmedMessage)
      }
    } finally {
      if (options.authority.context === options.context) setBusy(false)
    }
  }
  return (
    <section
      className='mt-8 min-w-0 border-t border-[var(--rp-line)] pt-6'
      data-access-mode
      aria-labelledby={id}
    >
      <h3 id={id} className='rp-display text-xl'>Access mode</h3>
      {notice && (
        <p role='alert' className='mt-4 text-sm text-[var(--rp-bad-ink)]'>{unconfirmedMessage}</p>
      )}
      {!current
        ? (
          <p className='mt-4 text-base text-ink-2'>
            The current access mode could not be checked. Refresh this view.
          </p>
        )
        : (
          <>
            <p className='mt-4 text-base' data-current-access-mode>Current mode: {current.label}</p>
            <fieldset className='mt-4 min-w-0 space-y-4' disabled={busy}>
              <legend className='sr-only'>Access mode for {name}</legend>
              {modes.map((mode) => (
                <label
                  key={mode.value}
                  className='flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3'
                >
                  <input
                    className='mt-1 shrink-0'
                    type='radio'
                    name={id}
                    value={mode.value}
                    checked={selected === mode.value}
                    onChange={() => setSelected(mode.value)}
                  />
                  <span className='min-w-0 text-base'>
                    {mode.label}
                    <span className='mt-1 block text-sm text-ink-2'>{mode.help}</span>
                  </span>
                </label>
              ))}
              <button
                type='button'
                className='rp-btn rp-btn-primary min-h-[44px]'
                disabled={!chosen || chosen === current}
                onClick={() => setConfirm(true)}
              >
                Save access mode
              </button>
            </fieldset>
          </>
        )}
      {confirm && chosen && (
        <ConfirmActionDialog
          title='Change access mode'
          description={`Change ${name} to ${chosen.label}? ${
            chosen.value === 'public'
              ? 'Portal content will be accessible without sign-in.'
              : chosen.help
          }`}
          confirmLabel='Change access mode'
          cancelLabel='Keep current mode'
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirm(false)
            setError(null)
          }}
          onConfirm={() => void save()}
        />
      )}
    </section>
  )
}
