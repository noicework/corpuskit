import { usePortalLocale } from '../../lib/portal-locale.tsx'
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
  const { ui } = usePortalLocale()

  const access = useAccess()
  const scope = { kind: 'portal' as const, slug }
  if (!ACCESS_SECTION_PERMISSIONS.some((permission) => access.can(permission, scope))) return null
  return (
    <section className='rp-card min-w-0 p-6' data-access-panel>
      <h2 className='rp-display break-words text-xl [overflow-wrap:anywhere]'>
        {ui('Access to ')}
        {name}
      </h2>
      <p className='mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]'>{ui('Portal: ')}{slug}</p>
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
  const { ui, error: localError } = usePortalLocale()

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
      <h3 id={id} className='rp-display text-xl'>{ui('Access mode')}</h3>
      {notice && (
        <p role='alert' className='mt-4 text-sm text-[var(--rp-bad-ink)]'>
          {localError(
            unconfirmedMessage,
            'The result could not be confirmed. Refresh this view before trying again.',
          )}
        </p>
      )}
      {!current
        ? (
          <p className='mt-4 text-base text-ink-2'>
            {ui('The current access mode could not be checked. Refresh this view.')}
          </p>
        )
        : (
          <>
            <p className='mt-4 text-base' data-current-access-mode>
              {ui('Current mode: ')}
              {ui(current.label)}
            </p>
            <fieldset className='mt-4 min-w-0 space-y-4' disabled={busy}>
              <legend className='sr-only'>{ui('Access mode for ')}{name}</legend>
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
                    {ui(mode.label)}
                    <span className='mt-1 block text-sm text-ink-2'>{ui(mode.help)}</span>
                  </span>
                </label>
              ))}
              <button
                type='button'
                className='rp-btn rp-btn-primary min-h-[44px]'
                disabled={!chosen || chosen === current}
                onClick={() => setConfirm(true)}
              >
                {ui('Save access mode')}
              </button>
            </fieldset>
          </>
        )}
      {confirm && chosen && (
        <ConfirmActionDialog
          title={ui('Change access mode')}
          description={ui('Change {name} to {label}? {value3}', {
            name: name,
            label: ui(chosen.label),
            value3: chosen.value === 'public'
              ? ui('Portal content will be accessible without sign-in.')
              : ui(chosen.help),
          })}
          confirmLabel={ui('Change access mode')}
          cancelLabel={ui('Keep current mode')}
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
